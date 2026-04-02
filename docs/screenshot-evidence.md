# Screenshot Evidence

Exploit agents automatically capture screenshots as visual proof during browser-based exploitation. Screenshots are mandatory for every browser-based exploit attempt and are included in the final security assessment report.

## How It Works

1. Each exploit agent receives the **Screenshot Evidence Protocol** via the shared partial `apps/worker/prompts/shared/_exploit-scope.txt`
2. Before each browser-based exploit, the agent captures a **pre** screenshot (baseline state)
3. After successful exploitation, the agent captures a **post** screenshot (impact proof)
4. When unexpected behavior is observed, the agent captures an **anomaly** screenshot
5. Screenshots are referenced inline in the evidence deliverable markdown files
6. On workflow completion, screenshots are copied to the workspace audit trail

## Screenshot Location

| Location | When |
|----------|------|
| `repos/<name>/deliverables/screenshots/` | During the scan (agents write here) |
| `workspaces/<name>/deliverables/screenshots/` | After completion (copied by audit system) |

## Naming Convention

```
{agent}_{VULN-ID}_{phase}_{NNN}_{YYYYMMDD-HHmmss}.png
```

| Segment | Values | Example |
|---------|--------|---------|
| `{agent}` | `auth`, `xss`, `injection`, `ssrf`, `authz` | `auth` |
| `{VULN-ID}` | Exact ID from the exploitation queue | `AUTH-VULN-01` |
| `{phase}` | `pre`, `post`, `anomaly` | `pre` |
| `{NNN}` | Sequential number per vulnerability, starting at `001` | `001` |
| `{YYYYMMDD-HHmmss}` | Timestamp when taken | `20260402-143022` |

**Examples:**
- `auth_AUTH-VULN-01_pre_001_20260402-143022.png` — baseline before exploit
- `auth_AUTH-VULN-01_post_002_20260402-143145.png` — impact proof after exploit
- `xss_XSS-VULN-03_anomaly_001_20260402-151200.png` — unexpected behavior

## Agent Coverage

| Agent | Screenshots Required |
|-------|---------------------|
| auth | Mandatory for all browser exploits + session state screenshot on account takeover |
| xss | Mandatory for all exploits (XSS is inherently browser-based) |
| injection | Required only for browser-based exploits (not for curl/sqlmap) |
| ssrf | Required only for browser-based exploits (not for curl/scripts) |
| authz | Mandatory for all exploits, per vulnerability type (horizontal, vertical, workflow) |

## Where Screenshots Are Referenced

- **Mandatory Evidence Checklist** — each exploit prompt's checklist includes a screenshot item
- **Deliverable template** — the `**Screenshots:**` field in each vulnerability entry lists filenames
- **Potential Vulnerabilities** — anomaly screenshots can be attached to potential/blocked findings
- **Conclusion trigger** — agents must verify screenshots exist before announcing completion
- **Report** — the report-executive prompt preserves screenshot references and adds an Evidence Artifacts note to the executive summary

## Modifying the Protocol

The screenshot protocol is defined once in `apps/worker/prompts/shared/_exploit-scope.txt` and auto-included by all 5 exploit prompts via `@include(shared/_exploit-scope.txt)`. Changes to the shared partial propagate to all agents automatically.

Per-agent customizations (checklist items, deliverable template fields) live in each exploit prompt file:
- `apps/worker/prompts/exploit-auth.txt`
- `apps/worker/prompts/exploit-xss.txt`
- `apps/worker/prompts/exploit-injection.txt`
- `apps/worker/prompts/exploit-ssrf.txt`
- `apps/worker/prompts/exploit-authz.txt`
