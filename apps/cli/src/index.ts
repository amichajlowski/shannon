/**
 * Shannon CLI — AI Penetration Testing Framework
 *
 * Unified CLI supporting two modes:
 *   Local mode: Run from cloned repo — builds locally, mounts prompts, uses ./workspaces/
 *   NPX mode:   Run via npx — pulls from Docker Hub, uses ~/.shannon/
 *
 * Mode is auto-detected based on presence of Dockerfile + docker-compose.yml + prompts/
 * in the current working directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authProxy, parseAuthProxyArgs } from './commands/auth-proxy.js';
import { build } from './commands/build.js';
import { captureAuth, parseCaptureAuthArgs } from './commands/capture-auth.js';
import { logs } from './commands/logs.js';
import { setup } from './commands/setup.js';
import { start } from './commands/start.js';
import { status } from './commands/status.js';
import { stop } from './commands/stop.js';
import { uninstall } from './commands/uninstall.js';
import { workspaces } from './commands/workspaces.js';
import { getMode } from './mode.js';
import { displaySplash } from './splash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function blockSudo(): void {
  const isSudo = !!process.env.SUDO_USER;
  const isRoot = process.geteuid?.() === 0;
  if (!isSudo && !isRoot) return;

  if (isSudo) {
    console.error('ERROR: Shannon must not be run with sudo.');
    console.error('Re-run this command as your normal user.');
  } else {
    console.error('ERROR: Shannon must not be run as the root user.');
    console.error('Switch to a regular user account and re-run this command.');
  }
  if (process.platform === 'linux') {
    console.error('Configure Docker to run without sudo first:');
    console.error('https://docs.docker.com/engine/install/linux-postinstall');
  }
  process.exit(1);
}

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function showHelp(): void {
  const mode = getMode();
  const prefix = mode === 'local' ? './shannon' : 'npx @keygraph/shannon';

  console.log(`
Shannon - AI Penetration Testing Framework

Usage:${
    mode === 'local'
      ? ''
      : `
  ${prefix} setup                                       Configure credentials`
  }
  ${prefix} start --url <url> --repo <path> [options]   Start a pentest scan
  ${prefix} stop [--clean]                               Stop all containers
  ${prefix} workspaces                                   List all workspaces
  ${prefix} logs <workspace>                             Tail workflow log
  ${prefix} status                                       Show running workers${
    mode === 'local'
      ? `
  ${prefix} build [--no-cache]                           Build worker image`
      : `
  ${prefix} uninstall                                    Remove ~/.shannon/ and all data`
  }
  ${prefix} info                                         Show splash screen
  ${prefix} help                                         Show this help

Options for 'start':
  -u, --url <url>           Target URL (required)
  -r, --repo <path>         Repository path${mode === 'local' ? ' or bare name' : ''} (required)
  -c, --config <path>       Configuration file (YAML)
  -o, --output <path>       Copy deliverables to this directory after run
  -w, --workspace <name>    Named workspace (auto-resumes if exists)
  -a, --auth-state <path>   Pre-authenticated Playwright session (skips login;
                            requires an 'authentication' block in the config)
      --auth-header-file <path>  Header line (e.g. Authorization: Bearer ...) injected
                            on every request, for Bearer/header-authenticated APIs
      --auth-proxy <url>    Proxy (from 'auth-proxy') that injects an auto-refreshed
                            token per request — for long scans on short-lived tokens
      --pipeline-testing    Use minimal prompts for fast testing
      --debug               Preserve worker container after exit for log inspection

Options for 'capture-auth' (capture a request header for Bearer/header APIs):
      --login-url <url>      Frontend login page to open for interactive SSO
      --target-origin <origin>  API origin whose request header to capture (required)
      --header-name <name>   Header to capture (default: authorization)
  -o, --output <path>        Output file (default: ./auth-header.txt)
      --from-har <file>      Parse a DevTools-exported HAR instead of opening a browser
      --with-refresh         Also seed a refresh token (for 'auth-proxy' auto-refresh)
      --refresh-url <url>    Refresh endpoint (required with --with-refresh)
      --session-output <path>  Refresh session file (default: ./auth-session.json)

Options for 'auth-proxy' (keep a short-lived token fresh during a long scan):
      --session <path>       Refresh session file from capture-auth (default: ./auth-session.json)
      --port <n>             Listen port (default: 8899)
      --bind <addr>          Bind address (default: 0.0.0.0, so the container can reach it)

Examples:
  ${prefix} start -u https://example.com -r ${mode === 'local' ? 'my-repo' : './my-repo'}
  ${prefix} start -u https://example.com -r /path/to/repo -c config.yaml -w q1-audit
  ${prefix} start -u https://example.com -r /path/to/repo -c config.yaml -a auth-state.json
  ${prefix} logs q1-audit
  ${prefix} stop --clean

Pre-authenticated sessions (e.g. Google SSO) — log in yourself, no stored credentials:
  npx playwright codegen --save-storage=auth-state.json https://example.com/login
  ${prefix} start -u https://example.com -r /path/to/repo -c config.yaml -a auth-state.json

Bearer/header-authenticated APIs (stateless; token sent as a request header):
  # Requires host Playwright + a browser: npx playwright install chromium
  ${prefix} capture-auth --login-url https://app.example.com/login --target-origin https://api.example.com
  ${prefix} start -u https://api.example.com -r /path/to/repo --auth-header-file auth-header.txt

Long scans on short-lived tokens (auto-refresh — no manual re-login mid-scan):
  ${prefix} capture-auth --with-refresh --refresh-url https://sso.example.com/auth/token \\
      --login-url https://app.example.com/login --target-origin https://api.example.com
  ${prefix} auth-proxy --session auth-session.json     # leave running in another terminal
  ${prefix} start -u https://api.example.com -r /path/to/repo --auth-proxy http://host.docker.internal:8899
${
  mode === 'local'
    ? `
State directory: ./workspaces/`
    : `
State directory: ~/.shannon/`
}
Monitor workflows at http://localhost:8233
`);
}

interface ParsedStartArgs {
  url: string;
  repo: string;
  config?: string;
  workspace?: string;
  output?: string;
  authState?: string;
  authHeaderFile?: string;
  authProxy?: string;
  pipelineTesting: boolean;
  debug: boolean;
}

function parseStartArgs(argv: string[]): ParsedStartArgs {
  let url = '';
  let repo = '';
  let config: string | undefined;
  let workspace: string | undefined;
  let output: string | undefined;
  let authState: string | undefined;
  let authHeaderFile: string | undefined;
  let authProxy: string | undefined;
  let pipelineTesting = false;
  let debug = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '-u':
      case '--url':
        if (next && !next.startsWith('-')) {
          url = next;
          i++;
        }
        break;
      case '-r':
      case '--repo':
        if (next && !next.startsWith('-')) {
          repo = next;
          i++;
        }
        break;
      case '-c':
      case '--config':
        if (next && !next.startsWith('-')) {
          config = next;
          i++;
        }
        break;
      case '-w':
      case '--workspace':
        if (next && !next.startsWith('-')) {
          workspace = next;
          i++;
        }
        break;
      case '-o':
      case '--output':
        if (next && !next.startsWith('-')) {
          output = next;
          i++;
        }
        break;
      case '-a':
      case '--auth-state':
        if (next && !next.startsWith('-')) {
          authState = next;
          i++;
        }
        break;
      case '--auth-header-file':
        if (next && !next.startsWith('-')) {
          authHeaderFile = next;
          i++;
        }
        break;
      case '--auth-proxy':
        if (next && !next.startsWith('-')) {
          authProxy = next;
          i++;
        }
        break;
      case '--pipeline-testing':
        pipelineTesting = true;
        break;
      case '--debug':
        debug = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        console.error(`Run "${getMode() === 'local' ? './shannon' : 'npx @keygraph/shannon'} help" for usage`);
        process.exit(1);
    }
  }

  if (!url || !repo) {
    console.error('ERROR: --url and --repo are required');
    console.error(`Usage: ${getMode() === 'local' ? './shannon' : 'npx @keygraph/shannon'} start -u <url> -r <path>`);
    process.exit(1);
  }

  return {
    url,
    repo,
    pipelineTesting,
    debug,
    ...(config && { config }),
    ...(workspace && { workspace }),
    ...(output && { output }),
    ...(authState && { authState }),
    ...(authHeaderFile && { authHeaderFile }),
    ...(authProxy && { authProxy }),
  };
}

// === Main Dispatch ===

blockSudo();

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'start': {
    const parsed = parseStartArgs(args.slice(1));
    await start({ ...parsed, version: getVersion() });
    break;
  }
  case 'stop':
    stop(args.includes('--clean'));
    break;
  case 'logs': {
    const workspaceId = args[1];
    if (!workspaceId) {
      console.error('ERROR: Workspace ID is required');
      console.error(`Usage: ${getMode() === 'local' ? './shannon' : 'npx @keygraph/shannon'} logs <workspace>`);
      process.exit(1);
    }
    logs(workspaceId);
    break;
  }
  case 'workspaces':
    workspaces(getVersion());
    break;
  case 'capture-auth':
    captureAuth(parseCaptureAuthArgs(args.slice(1)));
    break;
  case 'auth-proxy':
    await authProxy(parseAuthProxyArgs(args.slice(1)));
    break;
  case 'status':
    status();
    break;
  case 'setup':
    if (getMode() === 'local') {
      console.error('ERROR: setup is only available in npx mode. In local mode, use .env');
      process.exit(1);
    }
    setup();
    break;
  case 'build':
    build(args.includes('--no-cache'));
    break;
  case 'uninstall':
    if (getMode() === 'local') {
      console.error('ERROR: uninstall is only available in npx mode.');
      process.exit(1);
    }
    uninstall();
    break;
  case 'info':
    displaySplash(getMode() === 'local' ? undefined : getVersion());
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    showHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
}
