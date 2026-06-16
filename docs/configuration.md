# Configuration

Shannon Lite can run without a configuration file, but configuration enables authenticated testing, scope guidance, rules of engagement, report filtering, and rate-limit tuning.

## Credential Precedence

Source-build mode resolves credentials from:

1. Environment variables, such as `export ANTHROPIC_API_KEY=...`
2. `./.env`

`npx` mode resolves credentials from:

1. Environment variables
2. `~/.shannon/config.toml`, created by `npx @keygraph/shannon setup`

Environment variables always win, so you can override saved config for a single session without editing files.

## Create a Configuration File

Copy and modify the example configuration:

```bash
cp configs/example-config.yaml ./my-app-config.yaml
```

Run with:

```bash
npx @keygraph/shannon start -u https://example.com -r /path/to/repo -c ./my-app-config.yaml
```

Source-build equivalent:

```bash
./shannon start -u https://example.com -r /path/to/repo -c ./my-app-config.yaml
```

## Basic Configuration Structure

```yaml
# Describe your target environment.
description: "Next.js e-commerce app on PostgreSQL. Local dev environment; .env files contain local-only credentials."

# Limit which vulnerability classes run end-to-end.
# vuln_classes: [injection, xss, auth, authz, ssrf]

# Skip the exploitation phase.
# exploit: "false"

# Free-form rules of engagement.
# rules_of_engagement: |
#   - No password brute-force; cap login attempts at 5 per account.
#   - Throttle to under 5 requests per second per endpoint; back off 60s on any 429.
#   - Use placeholders like [order_id] in deliverables; no real data values.

authentication:
  login_type: form
  login_url: "https://your-app.com/login"
  credentials:
    username: "test@example.com"
    password: "yourpassword"
    totp_secret: "LB2E2RX7XFHSTGCK"

    # Optional mailbox credentials for magic-link or email-OTP flows.
    # email_login:
    #   address: "inbox@example.com"
    #   password: "mailbox-password"
    #   totp_secret: "JBSWY3DPEHPK3PXP"

  login_flow:
    - "Type $username into the email field"
    - "Type $password into the password field"
    - "Click the 'Sign In' button"

  success_condition:
    type: url_contains
    value: "/dashboard"

rules:
  avoid:
    - description: "AI should avoid testing logout functionality"
      type: url_path
      value: "/logout"

    # code_path values are repo-relative file paths or globs.
    # - description: "Out-of-scope vendored libraries"
    #   type: code_path
    #   value: "src/vendor/**"

  focus:
    - description: "AI should emphasize testing API endpoints"
      type: url_path
      value: "/api"

# Filters applied by the report agent when assembling the final report.
# report:
#   min_severity: low
#   min_confidence: low
#   guidance: |
#     Drop findings about missing security headers and rate-limit gaps.
```

Supported rule types include `url_path`, `subdomain`, `domain`, `method`, `header`, `parameter`, and `code_path`.

## Writing Login Flow

Log in once in a fresh private browser window. Write the steps in the same order you perform them:

- When typing into a field, reference the field by its exact label or placeholder.
- When clicking a button, reference the exact button text.

Supported placeholders:

- `$username`
- `$password`
- `$totp`
- `$email_address`
- `$email_password`
- `$email_totp`

At runtime, Shannon Lite replaces these placeholders with the credentials passed in the config.

```yaml
login_flow:
  - "Type $username in <exact email field label or placeholder>"
  - "Click <exact button text>"
  - "Type $password in <exact password field label or placeholder>"
  - "Click <exact button text>"
  - "If prompted for 2FA, type $totp in <exact code field label or placeholder>"
  - "Click <exact button text>"
```

## Pre-Authenticated Sessions (No Stored Credentials)

If you cannot store login credentials in a config file — for example, a Google SSO account, or a security policy that forbids plaintext credentials on disk — you can log in yourself in a real browser and hand Shannon Lite the resulting session instead. Shannon Lite never sees your username or password; it reuses the cookies and tokens your browser already obtained.

This is driven by the `--auth-state <file>` flag (short form `-a`), which accepts a [Playwright `storageState`](https://playwright.dev/docs/auth) JSON export (cookies + origin local/session storage).

### 1. Capture the session interactively

Use Playwright's built-in recorder to open a browser, log in by hand (including SSO, MFA, and consent screens), and save the session on exit:

```bash
npx playwright codegen --save-storage=auth-state.json https://your-app.com/login
```

Log in fully, confirm you land on an authenticated page, then close the browser window. Playwright writes `auth-state.json` containing the authenticated cookies and storage. No credentials are written — only the session.

### 2. Provide an authentication block

`--auth-state` still requires an `authentication` block in your config so the agents know which URL to verify against and how to detect a valid session. Credentials are **not** required in this mode — omit them entirely:

```yaml
authentication:
  login_type: sso
  login_url: "https://your-app.com/login"
  # No credentials block — the session is supplied via --auth-state.
  success_condition:
    type: url_contains
    value: "/dashboard"
```

### 3. Run with the captured session

```bash
npx @keygraph/shannon start -u https://your-app.com -r /path/to/repo -c ./my-config.yaml -a ./auth-state.json
```

Source-build equivalent:

```bash
./shannon start -u https://your-app.com -r /path/to/repo -c ./my-config.yaml -a ./auth-state.json
```

Shannon Lite mounts the file read-only, skips the interactive login preflight, and adopts your session as the shared authenticated state for every downstream agent.

### Verification

The session is checked at two points before the pipeline commits to expensive work:

1. **On the host, before the container starts** — the file must be valid JSON and contain at least one cookie or origin. A junk file fails immediately.
2. **Live, in the preflight** — Shannon Lite restores the session in a real browser, navigates to your `login_url`, and evaluates your `success_condition`. If the session does not actually authenticate against the target (expired, wrong domain, or a `success_condition` that does not match an authenticated page), the run **fails fast** with a clear message instead of burning hours before the failure surfaces downstream.

If the live check is unreliable in your environment (e.g. no browser available), set `SHANNON_SKIP_AUTH_STATE_VERIFY=1` to fall back to host-side structural validation only. The supplied session is then adopted unverified.

### Notes and limitations

- **Treat `auth-state.json` as a secret.** It carries live session cookies and tokens, equivalent to being logged in. Store it like a credential and delete it after the scan. Shannon Lite removes its in-workspace copy when the workflow ends.
- **The session must be fresh.** Shannon Lite does not (and cannot) re-login in this mode — there are no credentials to fall back on. If the session expires mid-scan, downstream agents lose authentication. Capture the session immediately before starting, and prefer targets with long-lived sessions. The preflight verifies the session is valid *at the start* of the run; it cannot prevent expiry partway through.
- **`--auth-state` requires `-c` with an `authentication` block.** Without it, agents have nothing to verify the session against and the run fails fast.
- **`--auth-state` takes precedence over `credentials`.** If the config also contains a `credentials` block, the supplied session is injected and the interactive login preflight is skipped. Stale-session re-login by downstream agents only works if the config also defines a `login_flow` — that is what carries the credentials into the agent's login steps. With credentials but no `login_flow`, agents cannot re-login and will stop if the session goes stale.
- **Auth-class coverage is reduced.** The `vuln-auth` and `exploit-auth` agents test login and session-management flows, which normally require exercising the real login. In `--auth-state` mode (no credentials) they restore the supplied session but cannot drive an interactive login, so authentication-class testing is limited to what the supplied session already reaches.

## Bearer / Header-Authenticated APIs (`--auth-header-file`)

Stateless APIs (e.g. Spring Security `STATELESS`, OAuth2/SSO resource servers) authenticate with an **`Authorization: Bearer <token>`** request header on every call — they keep no session cookie. A captured browser session (`--auth-state`) is useless against these: the API ignores cookies and the browser never auto-attaches the token as a header.

For these targets, use `--auth-header-file`. You capture the header the real frontend sends, and Shannon Lite injects it into **every** browser request the agents make.

> **Choosing between the two:** `--auth-state` for cookie-session apps; `--auth-header-file` for stateless Bearer/header APIs. They are mutually exclusive.

> **You need a frontend.** This flow assumes a frontend app that performs the (Google SSO) login and then calls the API with a Bearer header. The login URL (frontend) and the scan target (the API origin) are usually **different hosts**. If there is no such frontend, or the token is not sent as a request header, there is nothing to capture.

### 1. Capture the header interactively

```bash
# One-time: ensure host Playwright + a browser are available.
npx playwright install chromium

# Opens a browser at the frontend login page; log in with Google SSO, then close the window.
npx @keygraph/shannon capture-auth \
  --login-url https://app.example.com/login \
  --target-origin https://api.example.com
```

Shannon Lite records only traffic to `--target-origin` (so SSO-provider tokens are never written to disk), parses the recorded HAR for the `Authorization` header sent to the API, and writes `auth-header.txt` (mode `0600`). Capture a different header with `--header-name`. If your environment cannot launch the browser, export a HAR from your browser's DevTools and pass `--from-har <file>`.

### 2. Scan with the captured header

```bash
npx @keygraph/shannon start -u https://api.example.com -r /path/to/repo --auth-header-file ./auth-header.txt
```

Shannon Lite mounts the file read-only, injects the header into the browser's `extraHTTPHeaders`, and **restricts the browser to the target origin** so the token never leaks on a cross-origin redirect or resource load.

### Verification

In the preflight, Shannon Lite fetches the target with the header set and reads the HTTP status. A `401`/`403` means the token is not accepted (expired/wrong) and the run **fails fast**. The check only catches outright rejection, so point `-u` at a protected endpoint (e.g. `…/api/…`) for it to be meaningful. Disable with `SHANNON_SKIP_AUTH_HEADER_VERIFY=1`.

### Notes and limitations

- **Treat `auth-header.txt` as a secret** — it holds a live token. Delete it after the scan; it is git-ignored by default.
- **Static token, no refresh.** If the token expires mid-scan, authenticated requests start failing. Capture immediately before the scan and prefer long-lived tokens. The probe only confirms validity *at the start*.
- **Origin-confined.** The browser is restricted to the scan target's origin while a header is injected, so the agents will not follow links off-target.

## Adaptive Thinking

Claude decides when and how deeply to reason on Opus 4.6, 4.7, and 4.8. This is enabled by default whenever a tier resolves to one of these models.

- `npx` mode: `npx @keygraph/shannon setup` prompts you during the wizard.
- Source-build mode: set `CLAUDE_ADAPTIVE_THINKING=false` in `.env` or export it in your shell.

## Subscription Plan Rate Limits

Anthropic subscription plans reset usage on a rolling 5-hour window. The default retry strategy may exhaust retries before the window resets. Add this to your config:

```yaml
pipeline:
  retry_preset: subscription
  max_concurrent_pipelines: 2
```

`max_concurrent_pipelines` controls how many vulnerability pipelines run simultaneously. Supported values are 1-5, with a default of 5. Lower values reduce burst API usage but increase wall-clock time.
