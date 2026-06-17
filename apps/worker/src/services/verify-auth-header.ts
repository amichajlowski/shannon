// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Live verification for an operator-supplied auth header (`--auth-header-file`).
 *
 * The header is already injected into the browser's `extraHTTPHeaders` by the
 * stealth-config writer. This confirms it actually authenticates against the
 * target before the pipeline commits: drive the same `playwright-cli` the agents
 * use to `fetch` the target and read the HTTP status. An outright `401`/`403`
 * means the token is missing/expired/wrong — fail the preflight fast and
 * non-retryably. Transient browser/network problems stay retryable so Temporal
 * can re-attempt. The probe only catches outright rejection, so it is most
 * meaningful when the scan URL points at a protected endpoint.
 */

import type { ActivityLogger } from '../types/activity-logger.js';
import { ErrorCode } from '../types/errors.js';
import { err, ok, type Result } from '../types/result.js';
import { PentestError } from './error-handling.js';
import { type CliRun, containsDaemonError, extractEvalResult, runPlaywrightCli } from './verify-injected-session.js';

/** Throwaway, non-concurrent session name — preflight runs before any agent. */
const VERIFY_SESSION = 'auth-verify';

const OPEN_TIMEOUT_MS = 60_000;
const GOTO_TIMEOUT_MS = 90_000;
const EVAL_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 20_000;

const SKIP_ENV_VAR = 'SHANNON_SKIP_AUTH_HEADER_VERIFY';

export interface VerifyAuthHeaderInput {
  /** The scan target URL; the probe navigates to and fetches this. */
  readonly webUrl: string;
  /** Working directory for `playwright-cli` so it loads the injected-header config. */
  readonly sourceDir: string;
  readonly logger: ActivityLogger;
}

/** True when live header verification is disabled via the escape-hatch env var. */
export function isAuthHeaderVerificationDisabled(): boolean {
  const raw = process.env[SKIP_ENV_VAR];
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/**
 * Confirm the injected auth header is accepted by the target by issuing a
 * same-origin `fetch` from a throwaway browser session and inspecting the
 * status code.
 */
export async function verifyAuthHeaderLive(input: VerifyAuthHeaderInput): Promise<Result<void, PentestError>> {
  const { webUrl, sourceDir, logger } = input;
  const sessionFlag = `-s=${VERIFY_SESSION}`;

  logger.info('Verifying injected auth header against live target...', { webUrl });

  try {
    // 1. Start a throwaway browser session (inherits the injected header + origin allowlist).
    const opened = await runPlaywrightCli([sessionFlag, 'open'], sourceDir, OPEN_TIMEOUT_MS);
    if (opened.failed) {
      return infraError('Could not start a browser to verify the auth header', opened, { webUrl });
    }

    // 2. Navigate to the target origin so the probe fetch is same-origin.
    const navigated = await runPlaywrightCli([sessionFlag, 'goto', webUrl], sourceDir, GOTO_TIMEOUT_MS);
    if (navigated.failed || containsDaemonError(navigated.stdout)) {
      return infraError(`Could not reach ${webUrl} to verify the auth header`, navigated, { webUrl });
    }

    // 3. Fetch the target and read the HTTP status. The injected header rides the
    //    request via context-level extraHTTPHeaders. A thrown fetch yields status 0.
    const probe =
      `() => fetch(${JSON.stringify(webUrl)}, { method: 'GET' })` +
      `.then(r => ({ status: r.status })).catch(() => ({ status: 0 }))`;
    const evaluated = await runPlaywrightCli([sessionFlag, 'eval', probe], sourceDir, EVAL_TIMEOUT_MS);
    const status = readStatus(evaluated.stdout);
    if (status === null) {
      return infraError('Could not read a status code while verifying the auth header', evaluated, { webUrl });
    }

    // 4. status 0 means the fetch threw (network/CORS/aborted cross-origin) — transient.
    if (status === 0) {
      return infraError('Auth-header probe fetch failed before returning a status', evaluated, { webUrl });
    }

    // 5. Outright rejection means the header is not accepted — fail fast, no retry.
    if (status === 401 || status === 403) {
      return err(
        new PentestError(
          `The supplied auth header is not accepted by the target (HTTP ${status} from ${webUrl}). ` +
            'The token is likely expired, wrong, or not the credential this endpoint expects — re-capture it ' +
            '(shannon capture-auth) immediately before the scan. If the scan URL is an unprotected path, point ' +
            '-u at a protected endpoint so this check is meaningful.',
          'validation',
          false,
          { webUrl, status },
          ErrorCode.CONFIG_VALIDATION_FAILED,
        ),
      );
    }

    logger.info('Auth header verified against live target', { webUrl, status });
    return ok(undefined);
  } finally {
    await runPlaywrightCli([sessionFlag, 'close'], sourceDir, CLOSE_TIMEOUT_MS).catch(() => undefined);
  }
}

/** Read the numeric `status` field from an eval result shaped like `{ status: number }`. */
function readStatus(stdout: string): number | null {
  const parsed = extractEvalResult(stdout);
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { status?: unknown }).status !== 'number') {
    return null;
  }
  return (parsed as { status: number }).status;
}

/** Build a retryable error for transient browser/network problems. */
function infraError(message: string, run: CliRun, context: Record<string, unknown>): Result<void, PentestError> {
  const stderr = run.stderr.trim();
  return err(
    new PentestError(
      `${message}: ${run.reason ?? 'unexpected playwright-cli output'}. This is usually transient or ` +
        `environmental; set ${SKIP_ENV_VAR}=1 to skip live auth-header verification if it persists.`,
      'network',
      true,
      { ...context, ...(stderr && { stderr: stderr.slice(0, 500) }) },
      ErrorCode.AGENT_EXECUTION_FAILED,
    ),
  );
}
