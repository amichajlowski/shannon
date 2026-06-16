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
}

const prefix = (): string => (getMode() === 'local' ? './shannon' : 'npx @keygraph/shannon');

export function parseCaptureAuthArgs(argv: string[]): CaptureAuthArgs {
  let loginUrl: string | undefined;
  let targetOrigin: string | undefined;
  let headerName = 'authorization';
  let output = './auth-header.txt';
  let fromHar: string | undefined;

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
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return {
    headerName,
    output,
    ...(loginUrl && { loginUrl }),
    ...(targetOrigin && { targetOrigin }),
    ...(fromHar && { fromHar }),
  };
}

export function captureAuth(args: CaptureAuthArgs): void {
  if (!args.targetOrigin) {
    console.error('ERROR: --target-origin <origin> is required (the API origin whose request header to capture).');
    console.error(`  e.g. ${prefix()} capture-auth --login-url https://app.example.com/login \\`);
    console.error('         --target-origin https://api.example.com');
    process.exit(1);
  }
  const targetOrigin = normalizeOrigin(args.targetOrigin);

  // 1. Obtain a HAR — either an operator-supplied one, or by driving a browser.
  const harPath = args.fromHar ? path.resolve(args.fromHar) : captureHarInteractively(args.loginUrl, targetOrigin);

  // 2. Parse the HAR for the named header sent to the target origin.
  const headerValue = extractHeaderFromHar(harPath, args.headerName, targetOrigin);
  if (!headerValue) {
    console.error(`ERROR: No "${args.headerName}" header to ${targetOrigin} was found in the captured traffic.`);
    console.error('  Possible causes: you did not complete login; the token is not sent as a request header;');
    console.error('  or --target-origin does not match the API the frontend calls. Check the API origin and retry.');
    process.exit(1);
  }

  // 3. Write the single header line, readable only by the current user.
  const outPath = path.resolve(args.output);
  const canonicalName = canonicalHeaderName(args.headerName);
  fs.writeFileSync(outPath, `${canonicalName}: ${headerValue}\n`, { encoding: 'utf-8', mode: 0o600 });

  console.log(`\nCaptured "${canonicalName}" header → ${outPath} (treat as a secret; delete after the scan).`);
  console.log('\nNext:');
  console.log(`  ${prefix()} start -u ${targetOrigin} -r <repo> --auth-header-file ${args.output}`);
}

/** Drive `npx playwright open --save-har` and return the temp HAR path. */
function captureHarInteractively(loginUrl: string | undefined, targetOrigin: string): string {
  if (!loginUrl) {
    console.error('ERROR: --login-url <url> is required (unless --from-har is given).');
    process.exit(1);
  }

  const harPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shannon-capture-')), 'auth.har');

  console.log('Opening a browser. Log in (Google SSO, MFA, consent), then CLOSE the browser window to finish.');
  console.log(`Recording requests to ${targetOrigin} ...\n`);

  // `--save-har-glob` keeps only target-origin traffic in the HAR, so SSO-provider
  // tokens (e.g. accounts.google.com) are never written to disk.
  const result = spawnSync(
    'npx',
    ['playwright', 'open', `--save-har=${harPath}`, `--save-har-glob=${targetOrigin}/**`, loginUrl],
    { stdio: 'inherit' },
  );

  if (result.error || result.status !== 0) {
    console.error('\nERROR: failed to run `npx playwright open`. Ensure Playwright and a browser are installed:');
    console.error('  npx playwright install chromium');
    console.error('Alternatively, export a HAR from your browser DevTools and pass --from-har <file>.');
    process.exit(1);
  }

  if (!fs.existsSync(harPath)) {
    console.error('ERROR: no HAR was written — the browser closed before any target traffic was recorded.');
    process.exit(1);
  }
  return harPath;
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
