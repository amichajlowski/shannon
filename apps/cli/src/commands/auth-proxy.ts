/**
 * `auth-proxy` — keep a short-lived auth token fresh across a long scan.
 *
 * Many SPAs mint a short-lived (e.g. 1h) access token from a refresh token that
 * rotates on each use. A multi-hour authenticated scan would otherwise die when
 * the access token expires. This host-side process does two things:
 *
 *   1. Refresh loop: periodically POSTs the refresh token to the app's refresh
 *      endpoint, stores the new access + (rotated) refresh token, and persists
 *      the rotated refresh token back to the session file.
 *   2. Forward proxy: a local HTTP proxy that stamps `Authorization: Bearer
 *      <current access token>` on every request to the target origin and
 *      forwards it. The worker's browser is pointed here (start --auth-proxy),
 *      so it always sends a live token without ever holding one.
 *
 * HTTP targets only: the header is injected in cleartext, no TLS interception.
 * HTTPS CONNECT tunnels are passed through unmodified (no injection).
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';

export interface AuthProxyArgs {
  session: string;
  port: number;
  bind: string;
  intervalMin?: number;
}

interface RefreshSession {
  refreshUrl: string;
  refreshToken: string;
  targetOrigin: string;
}

// Request/response field names, matching the observed app refresh contract.
const REFRESH_REQUEST_FIELD = 'refreshToken';
const ACCESS_RESPONSE_FIELD = 'accessToken';
const REFRESH_RESPONSE_FIELD = 'refreshToken';

const DEFAULT_PORT = 8899;
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh this long before expiry
const FALLBACK_INTERVAL_MS = 50 * 60 * 1000; // when token expiry can't be read

// Bounded retry for a failed scheduled refresh: keep serving the last token,
// retry with exponential backoff, give up after MAX attempts and wait for the
// next scheduled cycle (the reactive 401/403 path remains the safety net).
const SCHEDULED_REFRESH_MAX_RETRIES = 4;
const SCHEDULED_REFRESH_BASE_BACKOFF_MS = 2 * 1000;
const SCHEDULED_REFRESH_MAX_BACKOFF_MS = 60 * 1000;

/** Timestamped stdout/stderr so the log reflects when each event actually happened. */
function logLine(message: string): void {
  console.log(`[auth-proxy ${new Date().toISOString()}] ${message}`);
}
function errLine(message: string): void {
  console.error(`[auth-proxy ${new Date().toISOString()}] ${message}`);
}

export function parseAuthProxyArgs(argv: string[]): AuthProxyArgs {
  let session = './auth-session.json';
  let port = DEFAULT_PORT;
  let bind = '0.0.0.0';
  let intervalMin: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    const take = (): string | undefined => {
      if (next && !next.startsWith('-')) {
        i++;
        return next;
      }
      return undefined;
    };
    switch (arg) {
      case '--session':
        session = take() ?? session;
        break;
      case '--port':
        port = Number(take() ?? port);
        break;
      case '--bind':
        bind = take() ?? bind;
        break;
      case '--interval':
        intervalMin = Number(take());
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }
  return { session, port, bind, ...(intervalMin && { intervalMin }) };
}

export async function authProxy(args: AuthProxyArgs): Promise<void> {
  const sessionPath = path.resolve(args.session);
  const session = loadSession(sessionPath);
  const targetOrigin = normalizeOrigin(session.targetOrigin);

  const tokens = createTokenManager(session, sessionPath, args.intervalMin);

  // 1. Do the first refresh before serving, so the proxy never serves a stale seed.
  try {
    await tokens.refreshNow();
  } catch (err) {
    errLine(`initial refresh failed: ${errMsg(err)}`);
    errLine('  The seed refresh token is likely expired/invalid — re-run `capture-auth --with-refresh`.');
    process.exit(1);
  }
  tokens.scheduleNext();

  // 2. Start the forward proxy. On a 401/403 from the target it triggers a
  //    deduplicated refresh and retries the request once with the new token.
  const server = createProxyServer(targetOrigin, tokens);
  server.listen(args.port, args.bind, () => {
    logLine(`listening on ${args.bind}:${args.port}`);
    logLine(`injecting Authorization for ${targetOrigin} (other origins pass through)`);
    logLine(`point the scan at it:  --auth-proxy http://host.docker.internal:${args.port}`);
    logLine('keep this process running for the whole scan. Ctrl-C to stop.');
  });

  const shutdown = (): void => {
    tokens.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** The proxy's view of the token lifecycle: read the current token, force a refresh. */
interface TokenManager {
  getToken: () => string;
  /** Refresh immediately (used for the seed and the reactive 401/403 path). */
  refreshNow: () => Promise<void>;
  /** Arm the next scheduled (proactive) refresh based on the current token's expiry. */
  scheduleNext: () => void;
  /** Cancel the scheduled refresh (shutdown). */
  stop: () => void;
}

/**
 * Owns the live token state and every path that can change it. A single
 * `inFlight` promise deduplicates concurrent refreshes, so a burst of parallel
 * 401s (and an overlapping scheduled refresh) collapse into one refresh call —
 * no thundering herd on the refresh endpoint.
 */
function createTokenManager(session: RefreshSession, sessionPath: string, intervalMin?: number): TokenManager {
  // Live, in-memory token state — never written anywhere the scan can read.
  let accessToken = '';
  let refreshToken = session.refreshToken;
  let refreshTimer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  async function doRefresh(): Promise<void> {
    const result = await postRefresh(session.refreshUrl, refreshToken);
    accessToken = result.accessToken;
    if (result.refreshToken) {
      refreshToken = result.refreshToken;
      // Persist the rotated refresh token so a restart continues the chain.
      persistSession(sessionPath, { ...session, refreshToken });
    }
  }

  function refreshNow(): Promise<void> {
    // Coalesce concurrent callers onto one in-flight refresh.
    if (!inFlight) {
      inFlight = doRefresh().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  }

  function scheduleNext(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    const nextMs = nextRefreshDelayMs(accessToken, intervalMin);
    refreshTimer = setTimeout(() => {
      runScheduledRefresh().catch(() => {
        // runScheduledRefresh handles its own logging; never let it reject unhandled.
      });
    }, nextMs);
    logLine(`token refreshed; next refresh in ~${Math.round(nextMs / 60000)} min`);
  }

  // Proactive refresh with bounded exponential backoff. Keeps serving the last
  // token throughout; after MAX attempts it gives up this cycle and re-arms the
  // normal schedule (the reactive 401/403 path is the remaining safety net).
  async function runScheduledRefresh(): Promise<void> {
    for (let attempt = 1; attempt <= SCHEDULED_REFRESH_MAX_RETRIES; attempt++) {
      try {
        await refreshNow();
        scheduleNext();
        return;
      } catch (err) {
        const backoff = Math.min(
          SCHEDULED_REFRESH_BASE_BACKOFF_MS * 2 ** (attempt - 1),
          SCHEDULED_REFRESH_MAX_BACKOFF_MS,
        );
        const last = attempt === SCHEDULED_REFRESH_MAX_RETRIES;
        errLine(
          `scheduled refresh failed (attempt ${attempt}/${SCHEDULED_REFRESH_MAX_RETRIES}): ${errMsg(err)}` +
            (last ? ' — serving last token; reactive 401/403 retry remains active' : `; retrying in ${backoff}ms`),
        );
        if (last) {
          scheduleNext();
          return;
        }
        await delay(backoff);
      }
    }
  }

  return {
    getToken: () => accessToken,
    refreshNow,
    scheduleNext,
    stop: () => {
      if (refreshTimer) clearTimeout(refreshTimer);
    },
  };
}

/** Build the forward proxy: inject the header for the target origin, tunnel HTTPS. */
function createProxyServer(targetOrigin: string, tokens: TokenManager): http.Server {
  const server = http.createServer((clientReq, clientRes) => {
    let target: URL;
    try {
      target = new URL(clientReq.url ?? '');
    } catch {
      clientRes.writeHead(400);
      clientRes.end('auth-proxy: expected absolute-form proxy request');
      return;
    }

    // Buffer the request body so the request can be replayed after a token
    // refresh. Proxied API calls are small; this is bounded by the client.
    const bodyChunks: Buffer[] = [];
    clientReq.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    clientReq.on('end', () => {
      const body = Buffer.concat(bodyChunks);
      void forwardWithRetry(target, clientReq, clientRes, body, targetOrigin, tokens);
    });
    clientReq.on('error', () => {
      if (!clientRes.headersSent) clientRes.writeHead(400);
      clientRes.end('auth-proxy: client request error');
    });
  });

  // HTTPS: plain TCP tunnel, no injection (cannot read an encrypted stream).
  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(portStr) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  return server;
}

/**
 * Forward one buffered request to the target. If the target rejects the injected
 * token with 401/403, refresh once (deduplicated) and replay the request a single
 * time with the new token. A second rejection is passed through to the client —
 * the token genuinely cannot authenticate and looping would only hammer the API.
 */
async function forwardWithRetry(
  target: URL,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  body: Buffer,
  targetOrigin: string,
  tokens: TokenManager,
): Promise<void> {
  const isTarget = target.origin === targetOrigin;
  try {
    const first = await forwardOnce(target, clientReq, body, isTarget ? tokens.getToken() : undefined);

    // Only the target origin carries an injected token worth refreshing.
    if (isTarget && (first.statusCode === 401 || first.statusCode === 403)) {
      // Capture the rejection's status/headers, then drain its body — once
      // resumed it cannot be piped, so any pass-through below is synthesized.
      const rejectedStatus = first.statusCode;
      const rejectedHeaders = first.res.headers;
      first.res.resume();
      errLine(`target returned HTTP ${first.statusCode} for ${target.pathname} — refreshing token and retrying once`);
      try {
        await tokens.refreshNow();
        tokens.scheduleNext();
      } catch (err) {
        errLine(`reactive refresh failed: ${errMsg(err)} — passing the original ${rejectedStatus} through`);
        clientRes.writeHead(rejectedStatus, rejectedHeaders);
        clientRes.end();
        return;
      }
      const retry = await forwardOnce(target, clientReq, body, tokens.getToken());
      if (retry.statusCode === 401 || retry.statusCode === 403) {
        errLine(`still HTTP ${retry.statusCode} after refresh for ${target.pathname} — token cannot authenticate`);
      } else {
        logLine(`retry after refresh succeeded for ${target.pathname} (HTTP ${retry.statusCode})`);
      }
      pipeResponse(retry.res, clientRes);
      return;
    }

    pipeResponse(first.res, clientRes);
  } catch {
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end('auth-proxy: upstream error');
  }
}

interface ForwardResult {
  statusCode: number;
  res: http.IncomingMessage;
}

/** Send the buffered request once with the given token; resolve with the upstream response. */
function forwardOnce(
  target: URL,
  clientReq: http.IncomingMessage,
  body: Buffer,
  token: string | undefined,
): Promise<ForwardResult> {
  return new Promise<ForwardResult>((resolve, reject) => {
    const headers = { ...clientReq.headers };
    delete headers['proxy-connection'];
    headers.host = target.host;
    // Inject the live token only for the target origin; never leak it elsewhere.
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    // Body is buffered and re-sent, so set an exact length and drop chunked
    // encoding. Always overwrite content-length so a stale client value (e.g.
    // on a retried request) can never disagree with the buffered body.
    delete headers['transfer-encoding'];
    delete headers['content-length'];
    if (body.length > 0) {
      headers['content-length'] = String(body.length);
    }

    const lib = target.protocol === 'https:' ? https : http;
    const upstream = lib.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: clientReq.method,
        headers,
      },
      (upstreamRes) => resolve({ statusCode: upstreamRes.statusCode ?? 502, res: upstreamRes }),
    );
    upstream.on('error', reject);
    upstream.end(body);
  });
}

/** Pipe an upstream response back to the waiting client. */
function pipeResponse(upstreamRes: http.IncomingMessage, clientRes: http.ServerResponse): void {
  clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
  upstreamRes.pipe(clientRes);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
}

/** POST the refresh token to the app's refresh endpoint and parse the new tokens. */
async function postRefresh(refreshUrl: string, refreshToken: string): Promise<RefreshResult> {
  const res = await fetch(refreshUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [REFRESH_REQUEST_FIELD]: refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`refresh endpoint returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const access = body[ACCESS_RESPONSE_FIELD];
  if (typeof access !== 'string' || !access) {
    throw new Error(`refresh response had no "${ACCESS_RESPONSE_FIELD}" string`);
  }
  const rotated = body[REFRESH_RESPONSE_FIELD];
  return { accessToken: access, ...(typeof rotated === 'string' && rotated && { refreshToken: rotated }) };
}

/** Schedule the next refresh: token expiry minus a margin, or a fixed fallback. */
function nextRefreshDelayMs(accessToken: string, intervalMinOverride?: number): number {
  if (intervalMinOverride) {
    return Math.max(60_000, intervalMinOverride * 60_000);
  }
  const exp = jwtExpMs(accessToken);
  if (exp) {
    return Math.max(60_000, exp - Date.now() - REFRESH_MARGIN_MS);
  }
  return FALLBACK_INTERVAL_MS;
}

/** Read only the `exp` claim (ms) from a JWT; null if not decodable. */
function jwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from((parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
    );
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function loadSession(sessionPath: string): RefreshSession {
  if (!fs.existsSync(sessionPath)) {
    console.error(`ERROR: session file not found: ${sessionPath}`);
    console.error('  Create one with: shannon capture-auth --with-refresh --refresh-url <url> ...');
    process.exit(1);
  }
  let parsed: Partial<RefreshSession>;
  try {
    parsed = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
  } catch (error) {
    console.error(`ERROR: session file is not valid JSON: ${errMsg(error)}`);
    process.exit(1);
  }
  if (!parsed.refreshUrl || !parsed.refreshToken || !parsed.targetOrigin) {
    console.error('ERROR: session file must contain refreshUrl, refreshToken, and targetOrigin.');
    process.exit(1);
  }
  return { refreshUrl: parsed.refreshUrl, refreshToken: parsed.refreshToken, targetOrigin: parsed.targetOrigin };
}

function persistSession(sessionPath: string, session: RefreshSession): void {
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    console.error(`ERROR: targetOrigin in the session file is not a valid URL: ${value}`);
    process.exit(1);
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
