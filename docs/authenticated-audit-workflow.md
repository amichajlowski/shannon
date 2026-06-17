# Authenticated Audit Workflow (`start_shannon_audit.sh`)

`start_shannon_audit.sh` (in the repo root) is the single operator entry point for
running an **authenticated** Shannon scan against an SSO-protected app whose access
token is short-lived. It ties together the three building blocks documented in
[configuration.md](./configuration.md) — `capture-auth`, the `auth-proxy`, and the
`--auth-proxy` scan flag — into one guided flow so the operator only has to log in
once, by hand, in a real browser.

It is the recommended way to scan apps on the internal SSO platform (a custom
RS256 Bearer JWT, refreshed via a config-declared refresh endpoint). For other
auth shapes, drive the underlying flags directly (see
[configuration.md](./configuration.md)).

## What it does

A single invocation runs the full pipeline end to end:

1. **Ensure Docker** is running (launches Docker Desktop if needed).
2. **Build the worker image** (`./shannon build`) by default, so the scan never
   runs against a stale image that predates the auth features. Skip with
   `--no-build` only when the image is known-current.
3. **Interactive login** — opens a browser via `capture-auth`. The operator
   completes the SSO login (e.g. Google), clicks around briefly, then **closes the
   browser** to continue. The script prints a prominent capitalised banner at this
   step because the flow blocks until the browser window is closed.
4. **Auto-detect the auth plumbing** from the login session: the refresh endpoint
   (from the SPA's runtime config), the API origin, the auth header, a sample
   protected URL, and the refresh token (from the captured `storageState`). The
   operator supplies only the website URL and repo path.
5. **Confirm token capture** — validates that `auth-session.json` and
   `auth-header.txt` were written and the captured refresh token is not already
   expired.
6. **Start the auth-proxy** on a local port (default `8899`). The proxy refreshes
   the access token just before each expiry and injects the current token into
   every request to the target origin.
7. **Launch Shannon** through the proxy (`--auth-proxy http://host.docker.internal:<port>`).
   All agent browser traffic to the target routes through the proxy and stays
   authenticated across token-expiry boundaries.

## Usage

```bash
# Interactive (recommended): prompts for website URL + repo, detects everything else
./start_shannon_audit.sh

# Non-interactive: pass values as flags (still prompts for anything omitted)
./start_shannon_audit.sh run \
  -u http://your-app.example.net \
  -r /path/to/whitebox-repo

# Skip the image rebuild when the worker image is already current
./start_shannon_audit.sh run -u <url> -r <repo> --no-build

# Stop the proxy when the scan has finished
./start_shannon_audit.sh stop

# Stop and delete the captured tokens
./start_shannon_audit.sh stop --clean
```

### Options (for `run`)

| Flag | Purpose | Default |
|---|---|---|
| `-u, --url <url>` | Website URL you log into | required |
| `-r, --repo <path>` | Repo folder for whitebox source analysis | required |
| `-c, --config <yaml>` | Optional Shannon config file | — |
| `--port <n>` | Local proxy port | `8899` |
| `--no-build` | Skip rebuilding the worker image | rebuilds by default |
| `--login-url <url>` | Login page to open (advanced override) | the website URL |
| `--target-origin <orig>` | API origin to authenticate (advanced override) | auto-detected |
| `--refresh-url <url>` | Token refresh endpoint (advanced override) | auto-detected |

## Operating notes

- **Close the browser to proceed.** The capture step blocks until the login
  browser window is closed. The script prints a capitalised banner so this is
  obvious; the scan will appear to hang if the window is left open.
- **Keep the proxy running** for the whole scan. It is a host-side process; if it
  stops, the token is no longer refreshed and agent traffic loses auth. Stop it
  with `./start_shannon_audit.sh stop` only once the scan has finished.
- **Requires host Playwright + a browser once:** `npx playwright install chromium`.
- **Captured files are secrets.** `auth-session.json` (refresh token) and
  `auth-header.txt` (Bearer token) are written `0600` and git-ignored. Delete them
  after the scan with `stop --clean`.
- **Refresh token has its own server-side lifetime.** When it is finally rejected,
  re-run the script (a fresh login). Fine for multi-hour scans.

## Preflight verification in proxy mode

In proxy mode the in-browser `verifyAuthHeader` preflight probe is **skipped by
default**. The proxy already validates the credential by performing a live token
refresh at startup — if that refresh fails, the proxy never comes up and the scan
does not launch — so the additional in-browser probe is redundant. Re-enable it by
setting `SHANNON_SKIP_AUTH_HEADER_VERIFY=0` in the environment before running.

The skip-verify environment variables (`SHANNON_SKIP_AUTH_HEADER_VERIFY`,
`SHANNON_SKIP_AUTH_STATE_VERIFY`) are forwarded to the worker container, so they
take effect inside the Docker-based pipeline, not just on the host.

## Verifying the scan is authenticated

After launch, confirm agent traffic is reaching the target authenticated:

```bash
# Find the worker container
docker ps --filter name=shannon-worker-

# Look for the proxy/auth confirmation and check API responses are not 401
docker logs <worker-name> 2>&1 | grep -iE "auth proxy configured|auth header verification"
```

A healthy run shows `Auth proxy configured for all browser requests` and
`Auth header verification passed`, and recon/agent requests to protected endpoints
(`/api/**`) return non-`401` responses. A `404` through the proxy is fine — it
means the token was accepted but the path has no route. Persistent `401`s mean the
proxy is not authenticating the agent traffic.

## See also

- [configuration.md](./configuration.md) — the underlying `--auth-state`,
  `--auth-header-file`, and `--auth-proxy` flags and `capture-auth` reference.
