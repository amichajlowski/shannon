#!/usr/bin/env bash
#
# start_shannon_audit.sh — one-shot wrapper for an authenticated Shannon scan
# against an SSO/Bearer API that uses short-lived, auto-refreshed tokens.
#
# It walks the whole flow so you never run the individual commands:
#   1. interactive login (browser opens; you do Google SSO by hand)
#   2. confirms the access + refresh tokens were captured
#   3. starts the auth-proxy (auto-refreshes the token for the whole scan)
#   4. ensures Docker infra and launches Shannon through the proxy

set -euo pipefail

cd "$(dirname "$0")"

SELF="./$(basename "$0")"

# --- defaults (override via flags or the interactive prompts) ---
PROXY_PORT="8899"
SESSION_FILE="./auth-session.json"
HEADER_FILE="./auth-header.txt"
PID_FILE="./.shannon-auth-proxy.pid"
PROXY_LOG="./.shannon-auth-proxy.log"

SCAN_URL=""
REPO=""
CONFIG=""
LOGIN_URL=""
TARGET_ORIGIN=""
REFRESH_URL=""
LAUNCHED=0

log()  { printf '\033[1;36m[audit]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[audit] ERROR:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

origin_of() { node -e 'process.stdout.write(new URL(process.argv[1]).origin)' "$1" 2>/dev/null || true; }

show_help() {
  cat <<EOF
start_shannon_audit.sh — run an authenticated Shannon scan with auto-refreshed tokens.

It handles the full flow: interactive SSO login -> confirm token capture ->
start the auto-refresh proxy -> ensure Docker -> launch Shannon through the proxy.

USAGE:
  $SELF                    Interactive mode (recommended): asks for the URL,
                           repo path, and refresh endpoint, then runs everything.
  $SELF run [options]      Non-interactive: provide values as flags (prompts for
                           anything omitted).
  $SELF stop [--clean]     Stop the auth-proxy. --clean also deletes captured tokens.
  $SELF help               Show this help.

TIP: just run '$SELF' with no flags to be guided through it interactively.

OPTIONS (for 'run'; you are prompted for any required value you omit):
  -u, --url <url>            Target API URL to scan. Point at a PROTECTED path
                             (e.g. https://app.example.com/api/...) so the auth
                             check is meaningful.                        [required]
  -r, --repo <path>         Repository folder for whitebox source analysis. [required]
      --refresh-url <url>    Endpoint the app calls to mint a fresh token
                             (e.g. https://sso.example.com/auth/token).  [required]
      --login-url <url>      Frontend login page to open for SSO.
                             [default: the scan URL's origin + "/"]
      --target-origin <orig> API origin to authenticate.
                             [default: the scan URL's origin]
  -c, --config <yaml>        Optional Shannon config file.
      --port <n>             Local proxy port.                      [default: 8899]

NOTES:
  - Requires host Playwright + a browser once:  npx playwright install chromium
  - The auth-proxy keeps running after launch (the scan needs it). Stop it with
    '$SELF stop' once the scan has finished.
  - Per-app value is the refresh URL (no default — it differs per application).
    For an app whose token field/header differs from the platform norm, capture
    separately with 'shannon capture-auth --refresh-token-key/--header-name'.

EXAMPLE:
  $SELF run \\
    -u https://app.example.com/api/resource \\
    -r /path/to/repo \\
    --refresh-url https://sso.example.com/auth/token
EOF
}

# ============================ stop subcommand ============================
stop_proxy() {
  if [ -f "$PID_FILE" ]; then
    local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      log "stopped auth-proxy (pid $pid)"
    else
      log "no running auth-proxy for pid in $PID_FILE"
    fi
    rm -f "$PID_FILE"
  else
    log "no proxy pid file; nothing to stop"
  fi
  if [ "${1:-}" = "--clean" ]; then
    rm -f "$SESSION_FILE" "$HEADER_FILE" "$PROXY_LOG"
    log "removed captured tokens ($SESSION_FILE, $HEADER_FILE)"
  fi
}

# ============================ dispatch ============================
# No options at all → interactive mode: fall through to the prompts below.
case "${1:-}" in
  help|-h|--help)
    show_help
    exit 0
    ;;
  stop)
    shift
    stop_proxy "${1:-}"
    exit 0
    ;;
  run)
    # Explicit start verb; remaining args are options (any missing are prompted).
    shift
    ;;
esac

# ============================ parse flags ============================
while [ $# -gt 0 ]; do
  case "$1" in
    -u|--url)            SCAN_URL="$2"; shift 2 ;;
    -r|--repo)           REPO="$2"; shift 2 ;;
    -c|--config)         CONFIG="$2"; shift 2 ;;
    --login-url)         LOGIN_URL="$2"; shift 2 ;;
    --target-origin)     TARGET_ORIGIN="$2"; shift 2 ;;
    --refresh-url)       REFRESH_URL="$2"; shift 2 ;;
    --port)              PROXY_PORT="$2"; shift 2 ;;
    -h|--help)           show_help; exit 0 ;;
    *) die "unknown option: $1 (run '$SELF help' for usage)" ;;
  esac
done

# ============================ gather inputs ============================
if [ -z "$SCAN_URL" ]; then
  read -r -p "Target API URL to scan (point at a protected path, e.g. .../api/...): " SCAN_URL
fi
[ -n "$SCAN_URL" ] || die "a target URL is required"

if [ -z "$REPO" ]; then
  read -r -p "Repository folder (source for whitebox analysis): " REPO
fi
[ -n "$REPO" ] || die "a repository folder is required"
[ -d "$REPO" ] || die "repository folder not found: $REPO"

# Sensible defaults derived from the scan URL; confirm/override interactively.
DEF_ORIGIN="$(origin_of "$SCAN_URL")"
[ -n "$DEF_ORIGIN" ] || die "could not parse an origin from: $SCAN_URL"

if [ -z "$TARGET_ORIGIN" ]; then
  read -r -p "API origin to authenticate [$DEF_ORIGIN]: " TARGET_ORIGIN
  TARGET_ORIGIN="${TARGET_ORIGIN:-$DEF_ORIGIN}"
fi
if [ -z "$LOGIN_URL" ]; then
  read -r -p "Frontend login URL to open [$DEF_ORIGIN/]: " LOGIN_URL
  LOGIN_URL="${LOGIN_URL:-$DEF_ORIGIN/}"
fi
if [ -z "$REFRESH_URL" ]; then
  read -r -p "Token refresh endpoint (the URL the app calls to mint a new token): " REFRESH_URL
fi
[ -n "$REFRESH_URL" ] || die "a token refresh endpoint is required (no default — it differs per application)"

# ============================ preflight ============================
[ -x "./shannon" ] || die "./shannon entrypoint not found — run from the Shannon repo root"

log "checking Docker..."
if ! docker info >/dev/null 2>&1; then
  if [ "$(uname)" = "Darwin" ]; then
    log "Docker not running; launching Docker Desktop..."
    open -a Docker 2>/dev/null || true
    n=0
    while ! docker info >/dev/null 2>&1; do
      n=$((n + 1)); [ "$n" -le 60 ] || die "Docker did not start within 120s — start it and retry"
      sleep 2
    done
  else
    die "Docker is not running — start it and retry"
  fi
fi
log "Docker is up."

# ============================ 1. interactive capture ============================
log "opening a browser for interactive login — complete SSO, then CLOSE the window."
./shannon capture-auth \
  --with-refresh \
  --refresh-url   "$REFRESH_URL" \
  --login-url     "$LOGIN_URL" \
  --target-origin "$TARGET_ORIGIN" \
  --output        "$HEADER_FILE" \
  --session-output "$SESSION_FILE"

# ============================ 2. confirm capture ============================
[ -f "$SESSION_FILE" ] || die "capture did not produce $SESSION_FILE"
node -e '
  const fs=require("fs");
  const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!s.refreshUrl||!s.refreshToken||!s.targetOrigin){console.error("session file missing required fields");process.exit(1);}
  const rt=s.refreshToken, seg=rt.split(".");
  if(seg.length===3){try{const p=JSON.parse(Buffer.from(seg[1].replace(/-/g,"+").replace(/_/g,"/"),"base64").toString());
    if(typeof p.exp==="number"&&p.exp*1000<Date.now()){console.error("the captured refresh token is already expired");process.exit(1);}}catch{}}
  process.exit(0);
' "$SESSION_FILE" || die "captured session is invalid — re-run and complete login"
log "tokens captured and validated ($SESSION_FILE)."

# ============================ 3. start the auth-proxy ============================
# Replace any proxy we previously started (rotates the session file safely).
stop_proxy >/dev/null 2>&1 || true
log "starting auth-proxy on port $PROXY_PORT (auto-refreshes the token for the whole scan)..."
nohup ./shannon auth-proxy --session "$SESSION_FILE" --port "$PROXY_PORT" >"$PROXY_LOG" 2>&1 &
PROXY_PID=$!
echo "$PROXY_PID" >"$PID_FILE"

# Kill the proxy if we fail before the scan is launched.
cleanup_on_fail() { [ "$LAUNCHED" = 0 ] && stop_proxy >/dev/null 2>&1 || true; }
trap cleanup_on_fail EXIT

n=0
while ! grep -q "listening on" "$PROXY_LOG" 2>/dev/null; do
  if grep -qiE "initial refresh failed|error" "$PROXY_LOG" 2>/dev/null; then
    cat "$PROXY_LOG" >&2; die "auth-proxy failed to start (see above)"
  fi
  n=$((n + 1)); [ "$n" -le 30 ] || { cat "$PROXY_LOG" >&2; die "auth-proxy did not come up within 60s"; }
  sleep 2
done
kill -0 "$PROXY_PID" 2>/dev/null || die "auth-proxy exited unexpectedly"
log "auth-proxy is live (pid $PROXY_PID). $(grep 'next refresh' "$PROXY_LOG" | tail -1)"

# ============================ 4. launch Shannon ============================
log "launching Shannon against $SCAN_URL ..."
set +e
./shannon start \
  -u "$SCAN_URL" \
  -r "$REPO" \
  ${CONFIG:+-c "$CONFIG"} \
  --auth-proxy "http://host.docker.internal:$PROXY_PORT"
START_RC=$?
set -e

if [ "$START_RC" -ne 0 ]; then
  die "shannon start failed (exit $START_RC) — auth-proxy stopped"
fi

LAUNCHED=1
trap - EXIT
echo
log "scan launched. The auth-proxy (pid $PROXY_PID) MUST stay running until the scan finishes."
log "  stop it when done:   $SELF stop          (add --clean to delete captured tokens)"
log "  proxy log:           $PROXY_LOG"
