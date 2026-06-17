/**
 * `capture-auth` — interactively capture an Authorization (or other) header for
 * Bearer/header-authenticated APIs.
 *
 * Stateless APIs authenticate via a request header (e.g. `Authorization: Bearer
 * <jwt>`), not browser cookies — so `--auth-state` does not help. This launches
 * a real browser at the frontend login URL via the host's `npx playwright open
 * --save-har`, the operator logs in (Google SSO, MFA, consent all by hand), and
 * the recorded HAR is parsed for the header the frontend sends to the API
 * origin. The result is written as a single `Name: Value` line for
 * `shannon start --auth-header-file <file>`.
 *
 * The browser auto-launch is a thin convenience over native Playwright; for
 * environments without it, `--from-har <file>` parses a HAR the operator
 * exported from their own browser's DevTools.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMode } from '../mode.js';

export interface CaptureAuthArgs {
  loginUrl?: string;
  targetOrigin?: string;
  headerName: string;
  output: string;
  fromHar?: string;
  // --with-refresh: also capture the rotating refresh token so `auth-proxy` can
  // keep the access token fresh across a long scan without re-login.
  withRefresh: boolean;
  refreshUrl?: string;
  refreshTokenKey: string;
  sessionOutput: string;
}

const prefix = (): string => (getMode() === 'local' ? './shannon' : 'npx @keygraph/shannon');

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

export function parseCaptureAuthArgs(argv: string[]): CaptureAuthArgs {
  let loginUrl: string | undefined;
  let targetOrigin: string | undefined;
  let headerName = 'authorization';
  let output = './auth-header.txt';
  let fromHar: string | undefined;
  let withRefresh = false;
  let refreshUrl: string | undefined;
  let refreshTokenKey = 'refreshToken';
  let sessionOutput = './auth-session.json';

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
      case '--login-url':
        loginUrl = take();
        break;
      case '--target-origin':
        targetOrigin = take();
        break;
      case '--header-name':
        headerName = (take() ?? headerName).toLowerCase();
        break;
      case '-o':
      case '--output':
        output = take() ?? output;
        break;
      case '--from-har':
        fromHar = take();
        break;
      case '--with-refresh':
        withRefresh = true;
        break;
      case '--refresh-url':
        refreshUrl = take();
        break;
      case '--refresh-token-key':
        refreshTokenKey = take() ?? refreshTokenKey;
        break;
      case '--session-output':
        sessionOutput = take() ?? sessionOutput;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return {
    headerName,
    output,
    withRefresh,
    refreshTokenKey,
    sessionOutput,
    ...(loginUrl && { loginUrl }),
    ...(targetOrigin && { targetOrigin }),
    ...(fromHar && { fromHar }),
    ...(refreshUrl && { refreshUrl }),
  };
}

export async function captureAuth(args: CaptureAuthArgs): Promise<void> {
  if (args.withRefresh && args.fromHar) {
    console.error('ERROR: --with-refresh needs an interactive capture (it reads cookies/localStorage); ');
    console.error('  it cannot be combined with --from-har.');
    process.exit(1);
  }
  if (!args.loginUrl && !args.fromHar) {
    console.error('ERROR: --login-url <url> is required (the website you log into).');
    process.exit(1);
  }
  const loginOrigin = args.loginUrl ? normalizeOrigin(args.loginUrl) : '';

  // Auto-detect mode: nothing about the auth plumbing is required from the
  // operator. We record the whole login session and read it back.
  const autoDetect = !args.targetOrigin || (args.withRefresh && !args.refreshUrl);

  // 1. Capture the login session. In auto mode record the FULL HAR (all origins)
  //    so the API and auth-service traffic are visible; it is deleted after parse.
  const capture: InteractiveCapture = args.fromHar
    ? { harPath: path.resolve(args.fromHar) }
    : captureInteractively(args.loginUrl, args.targetOrigin, { fullHar: autoDetect, withStorage: args.withRefresh });

  try {
    // 2. Resolve the refresh endpoint (auto: from the SPA's config.json) and the
    //    auth service host (so we don't mistake it for the API).
    let refreshUrl = args.refreshUrl;
    if (args.withRefresh && !refreshUrl) {
      refreshUrl = await detectRefreshUrl(loginOrigin);
      if (!refreshUrl) {
        die(
          'could not auto-detect the token refresh endpoint from the site config. ' +
            'Pass it explicitly with --refresh-url <url>.',
        );
      }
    }
    const authHost = refreshUrl ? new URL(refreshUrl).host : '';

    // 3. Resolve the API origin + the auth header it carries (auto: from the HAR).
    let targetOrigin = args.targetOrigin ? normalizeOrigin(args.targetOrigin) : '';
    const detected = detectApiAuth(capture.harPath, args.headerName, {
      loginOrigin,
      excludeHosts: [authHost],
      preferOrigin: targetOrigin || loginOrigin,
    });
    if (!targetOrigin) {
      if (!detected) {
        die(
          `could not auto-detect an API carrying a "${args.headerName}" header during login. ` +
            'The app may not use a request-header token, or you did not exercise it. ' +
            'You can set the API origin explicitly with --target-origin.',
        );
      }
      targetOrigin = detected.origin;
    }

    const headerValue = detected?.value ?? extractHeaderFromHar(capture.harPath, args.headerName, targetOrigin);
    if (!headerValue) {
      die(
        `no "${args.headerName}" header to ${targetOrigin} was found in the captured traffic — ` +
          'complete login and exercise the app, or check the API origin.',
      );
    }

    // 4. Write the header line (0600).
    const outPath = path.resolve(args.output);
    const canonicalName = canonicalHeaderName(args.headerName);
    fs.writeFileSync(outPath, `${canonicalName}: ${headerValue}\n`, { encoding: 'utf-8', mode: 0o600 });

    console.log('\nDetected:');
    console.log(`  API origin     : ${targetOrigin}`);
    console.log(`  Auth header    : ${canonicalName}`);
    if (detected?.sampleUrl) console.log(`  Sample API call: ${detected.sampleUrl}`);
    if (refreshUrl) console.log(`  Refresh endpoint: ${refreshUrl}`);
    console.log(`\nCaptured "${canonicalName}" header → ${outPath} (treat as a secret; delete after the scan).`);

    // 5. Seed the refresh session so `auth-proxy` can keep the token fresh.
    if (args.withRefresh && refreshUrl) {
      const scanUrl = detected?.sampleUrl ?? `${targetOrigin}/`;
      writeRefreshSession(
        capture.storagePath,
        args.refreshTokenKey,
        refreshUrl,
        targetOrigin,
        scanUrl,
        args.sessionOutput,
      );
    }

    console.log('\nNext:');
    if (args.withRefresh) {
      console.log(`  ${prefix()} auth-proxy --session ${args.sessionOutput}        # leave running`);
      console.log(`  ${prefix()} start -u ${targetOrigin} -r <repo> --auth-proxy http://host.docker.internal:8899`);
    } else {
      console.log(`  ${prefix()} start -u ${targetOrigin} -r <repo> --auth-header-file ${args.output}`);
    }
  } finally {
    // The full HAR + storageState hold live tokens (incl. the SSO provider's) —
    // delete the temp capture directory now that we've extracted what we need.
    if (!args.fromHar && capture.tempDir) {
      fs.rmSync(capture.tempDir, { recursive: true, force: true });
    }
  }
}

interface StorageState {
  cookies?: Array<{ name: string; value: string }>;
  origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
}

/** Extract the refresh token from the captured storageState and write the session file. */
function writeRefreshSession(
  storagePath: string | undefined,
  refreshTokenKey: string,
  refreshUrl: string,
  targetOrigin: string,
  scanUrl: string,
  sessionOutput: string,
): void {
  if (!storagePath) {
    console.error('ERROR: no browser storage was captured, so the refresh token could not be read.');
    console.error('  Re-run the interactive capture (do not use --from-har) and complete login.');
    process.exit(1);
  }

  let state: StorageState;
  try {
    state = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
  } catch (error) {
    console.error(`ERROR: could not read captured storage: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const fromCookie = (state.cookies ?? []).find((c) => c.name === refreshTokenKey)?.value;
  const fromLocalStorage = (state.origins ?? [])
    .flatMap((o) => o.localStorage ?? [])
    .find((e) => e.name === refreshTokenKey)?.value;
  const refreshToken = fromCookie ?? fromLocalStorage;

  if (!refreshToken) {
    console.error(`ERROR: no "${refreshTokenKey}" found in the captured cookies or localStorage.`);
    console.error('  Confirm the refresh-token key (--refresh-token-key) and that you completed login.');
    process.exit(1);
  }

  const session = { refreshUrl, refreshToken, targetOrigin, scanUrl };
  const sessionPath = path.resolve(sessionOutput);
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  console.log(`Seeded refresh session → ${sessionPath} (holds a live refresh token; treat as a secret).`);
}

/**
 * Auto-detect the token refresh endpoint from the SPA's runtime config. The
 * convention across the platform is `<origin>/assets/config/config.json` with an
 * `authUrl` pointing at the auth service; the refresh endpoint is `authUrl/auth/token`.
 * Returns undefined if no config/authUrl is found.
 */
async function detectRefreshUrl(loginOrigin: string): Promise<string | undefined> {
  if (!loginOrigin) return undefined;
  const candidates = ['/assets/config/config.json', '/assets/config.json', '/config.json'];
  for (const pathSuffix of candidates) {
    try {
      const res = await fetch(`${loginOrigin}${pathSuffix}`);
      if (!res.ok) continue;
      const cfg = (await res.json()) as { authUrl?: unknown };
      if (typeof cfg.authUrl === 'string' && cfg.authUrl) {
        return `${cfg.authUrl.replace(/\/+$/, '')}/auth/token`;
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

interface DetectedApiAuth {
  origin: string;
  value: string;
  sampleUrl?: string;
}

/**
 * Scan the HAR for requests carrying the auth header (e.g. `Authorization`) and
 * infer the API origin, the live header value, and a sample protected URL.
 * Excludes the auth-service and SSO-provider hosts.
 */
function detectApiAuth(
  harPath: string,
  headerName: string,
  opts: { loginOrigin: string; excludeHosts: string[]; preferOrigin: string },
): DetectedApiAuth | null {
  let har: { log?: { entries?: HarEntry[] } };
  try {
    har = JSON.parse(fs.readFileSync(harPath, 'utf-8'));
  } catch {
    return null;
  }

  const ssoNoise = /(^|\.)(google|googleapis|gstatic|accounts\.google)\.com$/i;
  const byOrigin = new Map<string, { value: string; sampleUrl?: string; count: number }>();

  for (const entry of har.log?.entries ?? []) {
    const url = entry.request?.url;
    if (!url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (ssoNoise.test(parsed.host) || opts.excludeHosts.includes(parsed.host)) continue;

    const header = (entry.request?.headers ?? []).find((h) => h.name.toLowerCase() === headerName && h.value.trim());
    if (!header) continue;

    const prev = byOrigin.get(parsed.origin) ?? { value: header.value.trim(), count: 0 };
    prev.value = header.value.trim(); // latest wins
    prev.count += 1;
    // Prefer a sample URL that looks like an API call.
    if (!prev.sampleUrl || /\/api(\/|$)/.test(parsed.pathname)) {
      prev.sampleUrl = `${parsed.origin}${parsed.pathname}`;
    }
    byOrigin.set(parsed.origin, prev);
  }

  if (byOrigin.size === 0) return null;

  // Prefer the requested/login origin if it carries the header, else the busiest.
  const preferred = byOrigin.get(opts.preferOrigin);
  let chosenOrigin = opts.preferOrigin;
  let chosen = preferred;
  if (!chosen) {
    for (const [origin, info] of byOrigin) {
      if (!chosen || info.count > chosen.count) {
        chosen = info;
        chosenOrigin = origin;
      }
    }
  }
  if (!chosen) return null;
  return { origin: chosenOrigin, value: chosen.value, ...(chosen.sampleUrl && { sampleUrl: chosen.sampleUrl }) };
}

interface InteractiveCapture {
  harPath: string;
  /** Playwright storageState (cookies + localStorage), written when withStorage. */
  storagePath?: string;
  /** Temp dir holding the capture; the caller deletes it after parsing. */
  tempDir?: string;
}

/** Drive `npx playwright open`, capturing a HAR and (optionally) storageState. */
function captureInteractively(
  loginUrl: string | undefined,
  targetOrigin: string | undefined,
  opts: { fullHar: boolean; withStorage: boolean },
): InteractiveCapture {
  if (!loginUrl) {
    die('--login-url <url> is required (unless --from-har is given).');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shannon-capture-'));
  const harPath = path.join(dir, 'auth.har');
  const storagePath = path.join(dir, 'storage.json');

  console.log('Opening a browser. Log in (Google SSO, MFA, consent), then CLOSE the browser window to finish.');
  console.log('Tip: after you land in the app, click around for a few seconds so it makes authenticated calls.\n');

  // In auto-detect mode we need cross-origin traffic (the API + auth service), so
  // the full HAR is recorded — and deleted by the caller right after parsing. When
  // the target origin is known, scope the HAR to it so SSO-provider tokens (e.g.
  // accounts.google.com) are never written. `--save-storage` seeds the refresh token.
  const cmd = ['playwright', 'open', `--save-har=${harPath}`];
  if (!opts.fullHar && targetOrigin) {
    cmd.push(`--save-har-glob=${targetOrigin}/**`);
  }
  if (opts.withStorage) {
    cmd.push(`--save-storage=${storagePath}`);
  }
  cmd.push(loginUrl);
  const result = spawnSync('npx', cmd, { stdio: 'inherit' });

  if (result.error || result.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.error('\nERROR: failed to run `npx playwright open`. Ensure Playwright and a browser are installed:');
    console.error('  npx playwright install chromium');
    console.error('Alternatively, export a HAR from your browser DevTools and pass --from-har <file>.');
    process.exit(1);
  }

  if (!fs.existsSync(harPath)) {
    fs.rmSync(dir, { recursive: true, force: true });
    die('no HAR was written — the browser closed before any traffic was recorded.');
  }
  return { harPath, tempDir: dir, ...(opts.withStorage && fs.existsSync(storagePath) && { storagePath }) };
}

interface HarHeader {
  name: string;
  value: string;
}
interface HarEntry {
  request?: { url?: string; headers?: HarHeader[] };
}

/** Return the last value of `headerName` sent to `targetOrigin`, or undefined. */
function extractHeaderFromHar(harPath: string, headerName: string, targetOrigin: string): string | undefined {
  let har: { log?: { entries?: HarEntry[] } };
  try {
    har = JSON.parse(fs.readFileSync(harPath, 'utf-8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: could not read HAR file ${harPath}: ${detail}`);
    process.exit(1);
  }

  const entries = har.log?.entries ?? [];
  let found: string | undefined;
  for (const entry of entries) {
    const url = entry.request?.url;
    if (!url || !sameOrigin(url, targetOrigin)) {
      continue;
    }
    for (const header of entry.request?.headers ?? []) {
      if (header.name.toLowerCase() === headerName && header.value.trim()) {
        found = header.value.trim(); // keep the last occurrence
      }
    }
  }
  return found;
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    console.error(`ERROR: --target-origin is not a valid URL/origin: ${value}`);
    process.exit(1);
  }
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Title-case a known header name for the output line (cosmetic). */
function canonicalHeaderName(lower: string): string {
  if (lower === 'authorization') return 'Authorization';
  return lower
    .split('-')
    .map((part) => (part ? part[0]?.toUpperCase() + part.slice(1) : part))
    .join('-');
}
