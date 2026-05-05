# CLAUDE.md

AI-powered penetration testing agent for defensive security analysis. Automates vulnerability assessment by combining reconnaissance tools with AI-powered code analysis.

## Commands

**Prerequisites:** Docker, AI provider credentials (`.env` for local, `shn setup` or env vars for npx)

### Dual CLI

Shannon supports two CLI modes, auto-detected based on the current working directory:

| | **npx** (`npx @keygraph/shannon`) | **Local** (`./shannon`) |
|---|---|---|
| **Install** | Zero-install via npm | Clone the repo |
| **Image** | Pulled from Docker Hub (`keygraph/shannon:latest`) | Built locally (`shannon-worker`) |
| **State** | `~/.shannon/` | Project directory |
| **Credentials** | `~/.shannon/config.toml` (via `shn setup`) or env vars | `./.env` |
| **Config** | `~/.shannon/config.toml` (via `shn setup`) | N/A |
| **Prompts** | Bundled in Docker image | Mounted from `./apps/worker/prompts/` (live-editable) |

Mode auto-detection: local mode activates when env var `SHANNON_LOCAL=1` is set by the `./shannon` entry point (`apps/cli/src/mode.ts`). Otherwise npx mode.

### npx Quick Start

```bash
# Configure credentials (interactive wizard)
npx @keygraph/shannon setup

# Or export env vars directly (non-interactive / CI)
export ANTHROPIC_API_KEY=your-key

# Run
npx @keygraph/shannon start -u <url> -r /path/to/repo
```

### Local (Development) Quick Start

```bash
# Setup
echo "ANTHROPIC_API_KEY=your-key" > .env

# Build (auto-runs if image missing)
./shannon build

# Run
./shannon start -u <url> -r my-repo
./shannon start -u <url> -r my-repo -c ./apps/worker/configs/my-config.yaml
./shannon start -u <url> -r /any/path/to/repo

# Interactive authentication (for SSO/OAuth/Google Sign-In apps)
./shannon auth -c configs/my-config.yaml -w my-audit
./shannon start -u <url> -r my-repo -c configs/my-config.yaml -w my-audit
```

### Common Commands

```bash
# Setup (npx mode only — one-time credential configuration)
npx @keygraph/shannon setup

# Workspaces & Resume
./shannon start -u <url> -r my-repo -w my-audit    # New named workspace
./shannon start -u <url> -r my-repo -w my-audit    # Resume (same command)
./shannon workspaces                                 # List all workspaces

# Monitor
./shannon logs <workspace>            # Tail workflow log
./shannon status                      # Show running workers
# Temporal Web UI: http://localhost:8233

# Stop
./shannon stop                        # Preserves workflow data
./shannon stop --clean                # Full cleanup including volumes (confirms first)

# Image management
./shannon build [--no-cache]          # Local mode: build worker image
npx @keygraph/shannon uninstall             # npx mode: remove ~/.shannon/ (confirms first)

# Build TypeScript (development)
pnpm run build                       # Build all packages via Turborepo
pnpm run check                       # Type-check all packages
pnpm biome                           # Biome lint + format + import sorting check
pnpm biome:fix                       # Auto-fix lint, format, and import sorting
```

**Monorepo tooling:** pnpm workspaces, Turborepo for task orchestration, Biome for linting/formatting. TypeScript compiler options shared via `tsconfig.base.json` at the root. All packages extend it, overriding only `rootDir` and `outDir`. Shared devDependencies (`typescript`, `@types/node`, `turbo`, `@biomejs/biome`) are hoisted to the root workspace.

**Options:** `-c <file>` (YAML config), `-o <path>` (output directory), `-w <name>` (named workspace; auto-resumes if exists), `--pipeline-testing` (minimal prompts, 10s retries), `--debug` (preserve worker container after exit for log inspection)

## Fork Maintenance Workflow (MANDATORY)

> **This repository is a fork of `KeygraphHQ/shannon`.** All AI agents and humans working on this codebase MUST follow this workflow. Deviating causes merge chaos on upstream syncs.

### Remotes

- `origin` → `amichajlowski/shannon` (this fork)
- `upstream` → `KeygraphHQ/shannon` (source of truth)

If `upstream` is missing: `git remote add upstream https://github.com/KeygraphHQ/shannon.git`

### Branch Structure (Soft-Fork Pattern)

- **`main`** — mirror of `upstream/main`. **NEVER commit directly here.** Ever.
- **`feat/*`** — each local customization lives on its own feature branch, rooted on `main`.
- **`local/integration`** — merges `main` + all active `feat/*` branches. This is the deployment/working branch.

Current feature branches (update as new ones are created):
- `feat/interactive-auth` — `shannon auth` command, Playwright session capture, INTERACTIVE login type
- `feat/screenshot-evidence` — mandatory pre/post screenshot protocol for exploit agents
- `feat/preflight-dns-fallback` — DNS multi-address fallback in preflight URL check

### Rules for AI Agents and Humans

1. **NEVER commit directly to `main`.** Main exists solely to mirror `upstream/main`.
2. **Every local change goes on a `feat/*` branch.** Bug fix, docs update, config tweak — all branch-scoped.
3. **Before starting any work:** `git checkout feat/<existing>` or `git checkout -b feat/<new> main`.
4. **Related fixes live on the same feature branch**, not scattered across main.
5. **Always use `--force-with-lease`** (not `--force`) when pushing rebased branches. Ask the user before force-pushing any shared branch.
6. **Keep `git rerere` enabled:** `git config rerere.enabled true`. It memorizes conflict resolutions across rebases — huge time-saver.
7. **If a feature is broadly useful** (not GridDynamics-specific config), open an upstream PR to `KeygraphHQ/shannon` instead of keeping it forked. Zero long-term maintenance burden.

### Syncing with Upstream

When `upstream/main` has new commits, follow this sequence exactly:

```bash
# 1. Reset main to upstream (main is a mirror — no commits of our own)
git checkout main
git fetch upstream
git reset --hard upstream/main
git push origin main --force-with-lease

# 2. Rebase each feature branch onto the new main
for branch in feat/interactive-auth feat/screenshot-evidence feat/preflight-dns-fallback; do
  git checkout "$branch"
  git rebase main
  # Resolve conflicts (scoped to this feature only — small blast radius)
  git push origin "$branch" --force-with-lease
done

# 3. Rebuild local/integration from scratch
git checkout local/integration
git reset --hard main
git merge --no-ff feat/interactive-auth feat/screenshot-evidence feat/preflight-dns-fallback
git push origin local/integration --force-with-lease
```

### Starting a New Feature

```bash
git checkout main
git fetch upstream && git reset --hard upstream/main  # always start from fresh main
git checkout -b feat/<feature-name>
# ... make changes, commit ...
git push -u origin feat/<feature-name>
# Later: merge into local/integration via the sync workflow above
```

### Why This Pattern

- Conflicts localize to the feature that touches the same files upstream changed → small, reviewable resolutions
- Dropping a feature = removing one merge, not surgery
- Each `feat/*` branch is upstream-PR-ready at any time
- Clear mental model: "main = theirs, feat/* = ours, local/integration = what we deploy"
- `git log main` stays readable forever — it's just upstream's history

## Architecture

### Monorepo Layout

```
apps/cli/        — @keygraph/shannon (published to npm, bundled with tsdown)
apps/worker/     — @shannon/worker (private, Temporal worker + pipeline logic)
```

### CLI Package (`apps/cli/`)
Published as `@keygraph/shannon` on npm. Contains only Docker orchestration logic — no Temporal SDK, business logic, or prompts. Bundled with tsdown for single-file ESM output.

- `apps/cli/src/index.ts` — CLI dispatcher (`setup`, `start`, `stop`, `logs`, `workspaces`, `status`, `build`, `uninstall`, `info`, `auth`)
- `apps/cli/src/mode.ts` — Auto-detection: local mode if `SHANNON_LOCAL=1` env var is set
- `apps/cli/src/docker.ts` — Compose lifecycle, image pull/build, ephemeral `docker run` worker spawning
- `apps/cli/src/home.ts` — State directory management (`~/.shannon/` for npx, `./` for local)
- `apps/cli/src/env.ts` — `.env` loading, TOML fallback (npx only) via `apps/cli/src/config/resolver.ts`, credential validation, env flag building
- `apps/cli/src/config/resolver.ts` — Cascading config (npx only): env vars → `~/.shannon/config.toml` (parsed with `smol-toml`)
- `apps/cli/src/config/writer.ts` — TOML serialization and secure file persistence (0o600)
- `apps/cli/src/commands/setup.ts` — Interactive TUI wizard (`@clack/prompts`) for provider credential setup (npx only)
- `apps/cli/src/commands/auth.ts` — Interactive pre-authentication for SSO/OAuth apps. Opens a headed browser, captures session state after manual login
- `apps/cli/src/auth/pre-auth.ts` — Playwright-based session capture (storage state, cookies, localStorage)
- `apps/cli/src/paths.ts` — Repo/config path resolution (bare name → `./repos/<name>`, or any absolute/relative path)
- `apps/cli/src/commands/` — Command handlers
- `apps/cli/infra/compose.yml` — Bundled Temporal compose file for npx mode
- `apps/cli/tsdown.config.ts` — tsdown bundler config
- `shannon` — Node.js entry point (`#!/usr/bin/env node`) that delegates to `apps/cli/dist/index.mjs`

### Docker Architecture
Infra (Temporal) runs via `docker-compose.yml`. Workers are ephemeral `docker run --rm` containers, one per scan, each with a unique task queue and isolated volume mounts.

- `docker-compose.yml` — Infra only: `shannon-temporal` (port 7233/8233). Network: `shannon-net`
- `Dockerfile` — 2-stage build (builder + Chainguard Wolfi runtime). Uses pnpm. Entrypoint: `CMD ["node", "apps/worker/dist/temporal/worker.js"]`
- No `docker-compose.docker.yml` — host gateway handled via `--add-host` flag in CLI

### Worker Package (`apps/worker/`)
- `apps/worker/src/paths.ts` — Centralized path constants (`PROMPTS_DIR`, `CONFIGS_DIR`, `WORKSPACES_DIR`)
- `apps/worker/src/session-manager.ts` — Agent definitions (`AGENTS` record). Agent types in `apps/worker/src/types/agents.ts`
- `apps/worker/src/config-parser.ts` — YAML config parsing with JSON Schema validation
- `apps/worker/src/ai/claude-executor.ts` — Claude Agent SDK integration with retry logic
- `apps/worker/src/services/` — Business logic layer (Temporal-agnostic). Activities delegate here. Key: `agent-execution.ts`, `error-handling.ts`, `container.ts`
- `apps/worker/src/types/` — Consolidated types: `Result<T,E>`, `ErrorCode`, `AgentName`, `ActivityLogger`, etc.
- `apps/worker/src/utils/` — Shared utilities (file I/O, formatting, concurrency)

### Temporal Orchestration
Durable workflow orchestration with crash recovery, queryable progress, intelligent retry, and parallel execution (5 concurrent agents in vuln/exploit phases).

- `apps/worker/src/temporal/workflows.ts` — Main workflow (`pentestPipelineWorkflow`)
- `apps/worker/src/temporal/activities.ts` — Thin wrappers — heartbeat loop, error classification, container lifecycle. Business logic delegated to `apps/worker/src/services/`
- `apps/worker/src/temporal/activity-logger.ts` — `TemporalActivityLogger` implementation of `ActivityLogger` interface
- `apps/worker/src/temporal/summary-mapper.ts` — Maps `PipelineSummary` to `WorkflowSummary`
- `apps/worker/src/temporal/worker.ts` — Combined worker + client entry point (per-invocation task queue, submits workflow, waits for result)
- `apps/worker/src/temporal/shared.ts` — Types, interfaces, query definitions
### Five-Phase Pipeline

1. **Pre-Recon** (`pre-recon`) — Source code analysis to build the architectural baseline
2. **Recon** (`recon`) — Attack surface mapping from initial findings
3. **Vulnerability Analysis** (5 parallel agents) — injection, xss, auth, authz, ssrf
4. **Exploitation** (5 parallel agents, conditional) — Exploits confirmed vulnerabilities
5. **Reporting** (`report`) — Executive-level security report

### Supporting Systems
- **Configuration** — YAML configs in `apps/worker/configs/` with JSON Schema validation (`config-schema.json`). Supports auth settings (form, SSO, API, basic, interactive; MFA/TOTP), URL/code rule scoping (`rules.avoid`/`rules.focus`), run-scope steering (`vuln_classes`, `exploit`), free-form `rules_of_engagement`, and post-hoc `report` filters (`min_severity`, `min_confidence`, `guidance`). `code_path` avoid rules are written into `~/.claude/settings.json` `permissions.deny` (`Read`/`Edit`) once per workflow by `apps/worker/src/temporal/activities.ts:syncCodePathDenyRules` so the SDK enforces them at the tool layer even in `bypassPermissions` mode. `vuln_classes`/`exploit` scope is locked into `session.json` on first run; resumes with a different scope fail fast (`persistOrValidateRunScope`). Credential resolution — local mode: env vars → `./.env`; npx mode: env vars → `~/.shannon/config.toml` (via `shn setup`)
- **Prompts** — Per-phase templates in `apps/worker/prompts/` with variable substitution (`{{TARGET_URL}}`, `{{CONFIG_CONTEXT}}`, `{{LOGIN_INSTRUCTIONS}}`, `{{PLAYWRIGHT_SESSION}}`). Shared partials in `apps/worker/prompts/shared/` via `apps/worker/src/services/prompt-manager.ts`, including `_code-path-rules.txt` (focus/avoid `[FILE]`/`[GLOB]` routing), `_rules-of-engagement.txt` (free-text engagement rules), and `_exploit-scope.txt` (exploitation constraints + screenshot evidence protocol). When `exploit: false`, `apps/worker/src/services/findings-renderer.ts` deterministically converts each `*_exploitation_queue.json` into a `*_findings.md` for report assembly — no LLM in the loop
- **SDK Integration** — Uses `@anthropic-ai/claude-agent-sdk` with `maxTurns: 10_000` and `bypassPermissions` mode. Adaptive thinking is enabled by default on Opus 4.6/4.7 (`supportsAdaptiveThinking` in `apps/worker/src/ai/models.ts`); disable per-scan via `CLAUDE_ADAPTIVE_THINKING=false` (env) or `core.adaptive_thinking = false` (npx TOML). Browser automation via `playwright-cli` with session isolation (`-s=<session>`). TOTP generation via `generate-totp` CLI tool. Login flow template at `apps/worker/prompts/shared/login-instructions.txt` supports form, SSO, API, basic, and interactive auth
- **Interactive Authentication** — `shannon auth` command opens a headed browser for manual pre-authentication (Google Sign-In, Okta, SAML, etc.). Captures `context.storageState()` to `auth-state.json` in the workspace. Agents receive the session via `{{PLAYWRIGHT_SESSION}}`. See `docs/interactive-auth.md`
- **Audit System** — Crash-safe append-only logging in `workspaces/{hostname}_{sessionId}/`. Tracks session metrics, per-agent logs, prompts, and deliverables. WorkflowLogger (`apps/worker/src/audit/workflow-logger.ts`) provides unified human-readable per-workflow logs, backed by LogStream (`apps/worker/src/audit/log-stream.ts`) shared stream primitive
- **Deliverables** — Saved to `deliverables/` in the target repo via the `save-deliverable` CLI script (`apps/worker/src/scripts/save-deliverable.ts`). Includes markdown evidence reports and screenshot evidence
- **Screenshot Evidence** — Exploit agents capture mandatory pre/post/anomaly screenshots during browser-based exploitation. Saved to `deliverables/screenshots/` with naming convention `{agent}_{VULN-ID}_{pre|post|anomaly}_{NNN}_{YYYYMMDD-HHmmss}.png`. Protocol defined in `apps/worker/prompts/shared/_exploit-scope.txt`, referenced in each exploit prompt's mandatory checklist and conclusion trigger. Screenshots are copied to the workspace audit trail alongside markdown deliverables
- **Workspaces & Resume** — Named workspaces via `-w <name>` or auto-named from URL+timestamp. Resume detects completed agents via `session.json`. `loadResumeState()` in `apps/worker/src/temporal/activities.ts` validates deliverable existence, restores git checkpoints, and cleans up incomplete deliverables. Workspace listing via `apps/worker/src/temporal/workspaces.ts`

## Development Notes

### Adding a New Agent
1. Define agent in `apps/worker/src/session-manager.ts` (add to `AGENTS` record). `ALL_AGENTS`/`AgentName` types live in `apps/worker/src/types/agents.ts`
2. Create prompt template in `apps/worker/prompts/` (e.g., `vuln-newtype.txt`)
3. Two-layer pattern: add a thin activity wrapper in `apps/worker/src/temporal/activities.ts` (heartbeat + error classification). `AgentExecutionService` in `apps/worker/src/services/agent-execution.ts` handles the agent lifecycle automatically via the `AGENTS` registry
4. Register activity in `apps/worker/src/temporal/workflows.ts` within the appropriate phase

### Modifying Prompts
- Variable substitution: `{{TARGET_URL}}`, `{{CONFIG_CONTEXT}}`, `{{LOGIN_INSTRUCTIONS}}`, `{{PLAYWRIGHT_SESSION}}`
- Shared partials in `apps/worker/prompts/shared/` included via `apps/worker/src/services/prompt-manager.ts`
- Screenshot protocol in `apps/worker/prompts/shared/_exploit-scope.txt` — auto-included by all exploit prompts via `@include`
- Test with `--pipeline-testing` for fast iteration

### Key Design Patterns
- **Configuration-Driven** — YAML configs with JSON Schema validation
- **Progressive Analysis** — Each phase builds on previous results
- **SDK-First** — Claude Agent SDK handles autonomous analysis
- **Modular Error Handling** — `ErrorCode` enum, `Result<T,E>` for explicit error propagation, automatic retry (3 attempts per agent)
- **Services Boundary** — Activities are thin Temporal wrappers; `apps/worker/src/services/` owns business logic, accepts `ActivityLogger`, returns `Result<T,E>`. No Temporal imports in services
- **DI Container** — Per-workflow in `apps/worker/src/services/container.ts`. `AuditSession` excluded (parallel safety)
- **Ephemeral Workers** — Each scan runs in its own `docker run --rm` container with a per-invocation task queue. Temporal routes activities by queue name, so per-scan queues ensure activities never land on a worker with the wrong repo mounted

### Security
Defensive security tool only. Use only on systems you own or have explicit permission to test.

## Code Style Guidelines

### Formatting
Biome handles formatting and linting. Run `pnpm biome:fix` to auto-fix. Config in `biome.json`: single quotes, semicolons, trailing commas, 2-space indent, 120 char line width.

### Clarity Over Brevity
- Optimize for readability, not line count — three clear lines beat one dense expression
- Use descriptive names that convey intent
- Prefer explicit logic over clever one-liners

### Structure
- Keep functions focused on a single responsibility
- Use early returns and guard clauses instead of deep nesting
- Never use nested ternary operators — use if/else or switch
- Extract complex conditions into well-named boolean variables

### TypeScript Conventions
- Use `function` keyword for top-level functions (not arrow functions)
- Explicit return type annotations on exported/top-level functions
- Prefer `readonly` for data that shouldn't be mutated
- `exactOptionalPropertyTypes` is enabled — use spread for optional props, not direct `undefined` assignment

### Avoid
- Combining multiple concerns into a single function to "save lines"
- Dense callback chains when sequential logic is clearer
- Sacrificing readability for DRY — some repetition is fine if clearer
- Abstractions for one-time operations
- Backwards-compatibility shims, deprecated wrappers, or re-exports for removed code — delete the old code, don't preserve it

### Comments
Comments must be **timeless** — no references to this conversation, refactoring history, or the AI.

**Patterns used in this codebase:**
- `/** JSDoc */` — file headers (after license) and exported functions/interfaces
- `// N. Description` — numbered sequential steps inside function bodies. Use when a
  function has 3+ distinct phases where at least one isn't immediately obvious from the
  code. Each step marks the start of a logical phase. Reference: `AgentExecutionService.execute`
  (steps 1-9) and `injectModelIntoReport` (steps 1-5)
- `// === Section ===` — high-level dividers between groups of functions in long files,
  or to label major branching/classification blocks (e.g., `// === SPENDING CAP SAFEGUARD ===`).
  Not for sequential steps inside function bodies — use numbered steps for that
- `// NOTE:` / `// WARNING:` / `// IMPORTANT:` — gotchas and constraints

**Never:** obvious comments, conversation references ("as discussed"), history ("moved from X")

## Key Files

**CLI:** `shannon` (entry point), `apps/cli/src/index.ts` (dispatcher), `apps/cli/src/docker.ts` (orchestration), `apps/cli/src/mode.ts` (auto-detection)

**Entry Points:** `apps/worker/src/temporal/workflows.ts`, `apps/worker/src/temporal/activities.ts`, `apps/worker/src/temporal/worker.ts`

**Core Logic:** `apps/worker/src/session-manager.ts`, `apps/worker/src/ai/claude-executor.ts`, `apps/worker/src/ai/settings-writer.ts` (writes `code_path` deny rules to `~/.claude/settings.json`), `apps/worker/src/config-parser.ts`, `apps/worker/src/services/` (incl. `preflight.ts`, `findings-renderer.ts`, `reporting.ts`), `apps/worker/src/audit/`

**Config:** `docker-compose.yml`, `apps/cli/infra/compose.yml`, `apps/worker/configs/`, `apps/worker/prompts/`, `tsconfig.base.json` (shared compiler options), `turbo.json`, `biome.json`

**Auth:** `apps/cli/src/commands/auth.ts` (CLI command), `apps/cli/src/auth/pre-auth.ts` (session capture), `apps/worker/prompts/shared/login-instructions.txt` (agent login guidance)

**Screenshot Evidence:** `apps/worker/prompts/shared/_exploit-scope.txt` (protocol), `apps/worker/src/audit/utils.ts` (workspace copy)

**CI/CD:** `.github/workflows/release.yml` (Docker Hub push + npm publish + GitHub release, manual dispatch)

## Package Installation

Package managers are configured with a minimum release age (7 days). Requires pnpm >= 10.16.0. If `pnpm install` fails due to a package being too new, **do not attempt to bypass it** — report the blocked package to the user and stop.

## Troubleshooting

- **"Repository not found"** — Pass a bare name (`-r my-repo`) for `./repos/my-repo`, or a path (`-r /path/to/repo`) for any directory
- **"Temporal not ready"** — Wait for health check or `docker compose logs temporal`
- **Worker not processing** — Check `docker ps --filter "name=shannon-worker-"`
- **Reset state** — `./shannon stop --clean`
- **Local apps unreachable** — Use `host.docker.internal` instead of `localhost`
- **Container permissions** — On Linux, may need `sudo` for docker commands
- **Interactive auth: "Playwright is required"** — Run `npm install -g playwright && npx playwright install chromium`
- **Interactive auth: session expired** — Re-run `./shannon auth -c <config> -w <workspace>`, then resume the scan
- **Screenshots missing from workspace** — Screenshots are saved to `repos/<name>/deliverables/screenshots/` during the scan and copied to the workspace on completion. If a scan fails mid-run, check the repo directory directly
- **Target URL unreachable from Docker** — If the hostname resolves to multiple IPs where some are unreachable, Shannon's preflight tries each IP sequentially. Increase `TARGET_URL_TIMEOUT_MS` in `apps/worker/src/services/preflight.ts` if needed
