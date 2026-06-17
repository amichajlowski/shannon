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

  // Live, in-memory token state — never written anywhere the scan can read.
  let accessToken = '';
  let refreshToken = session.refreshToken;
  let refreshTimer: NodeJS.Timeout | undefined;

  async function refresh(): Promise<void> {
    const result = await postRefresh(session.refreshUrl, refreshToken);
    accessToken = result.accessToken;
    if (result.refreshToken) {
      refreshToken = result.refreshToken;
      // Persist the rotated refresh token so a restart continues the chain.
      persistSession(sessionPath, { ...session, refreshToken });
    }
    const nextMs = nextRefreshDelayMs(accessToken, args.intervalMin);
    refreshTimer = setTimeout(() => {
      refresh().catch((err) => console.error(`[auth-proxy] refresh failed: ${errMsg(err)} (serving last token)`));
    }, nextMs);
    console.log(`[auth-proxy] token refreshed; next refresh in ~${Math.round(nextMs / 60000)} min`);
  }

  // 1. Do the first refresh before serving, so the proxy never serves a stale seed.
  try {
    await refresh();
  } catch (err) {
    console.error(`[auth-proxy] initial refresh failed: ${errMsg(err)}`);
    console.error('  The seed refresh token is likely expired/invalid — re-run `capture-auth --with-refresh`.');
    process.exit(1);
  }

  // 2. Start the forward proxy.
  const server = createProxyServer(targetOrigin, () => accessToken);
  server.listen(args.port, args.bind, () => {
    console.log(`\n[auth-proxy] listening on ${args.bind}:${args.port}`);
    console.log(`[auth-proxy] injecting Authorization for ${targetOrigin} (other origins pass through)`);
    console.log('[auth-proxy] point the scan at it:');
    console.log(`    --auth-proxy http://host.docker.internal:${args.port}`);
    console.log('[auth-proxy] keep this process running for the whole scan. Ctrl-C to stop.\n');
  });

  const shutdown = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Build the forward proxy: inject the header for the target origin, tunnel HTTPS. */
function createProxyServer(targetOrigin: string, getToken: () => string): http.Server {
  const server = http.createServer((clientReq, clientRes) => {
    let target: URL;
    try {
      target = new URL(clientReq.url ?? '');
    } catch {
      clientRes.writeHead(400);
      clientRes.end('auth-proxy: expected absolute-form proxy request');
      return;
    }

    const headers = { ...clientReq.headers };
    delete headers['proxy-connection'];
    headers.host = target.host;
    // Inject the live token only for the target origin; never leak it elsewhere.
    if (target.origin === targetOrigin) {
      headers.authorization = `Bearer ${getToken()}`;
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
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );
    upstream.on('error', () => {
      if (!clientRes.headersSent) clientRes.writeHead(502);
      clientRes.end('auth-proxy: upstream error');
    });
    clientReq.pipe(upstream);
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
