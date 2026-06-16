// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Live verification for an operator-supplied (`--auth-state`) browser session.
 *
 * Injecting a storage-state file is structurally validated elsewhere (it parses
 * and carries cookies/origins), but that says nothing about whether the session
 * still authenticates against the live target. A stale or wrong-domain export
 * would otherwise sail through preflight and fail hours into the pipeline.
 *
 * This drives the same `playwright-cli` browser the downstream agents use:
 * open a throwaway session, restore the supplied state, navigate to the login
 * URL (a valid session redirects to the authenticated landing page), then
 * evaluate the configured `success_condition` in the page. A clean "condition
 * not met" verdict fails the preflight fast and non-retryably; transient
 * browser/network problems are retryable so Temporal can re-attempt.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ActivityLogger } from '../types/activity-logger.js';
import type { SuccessCondition } from '../types/config.js';
import { ErrorCode } from '../types/errors.js';
import { err, ok, type Result } from '../types/result.js';
import { PentestError } from './error-handling.js';

const execFileAsync = promisify(execFile);

/** Throwaway, non-concurrent session name — preflight runs before any agent. */
const VERIFY_SESSION = 'auth-verify';

// Per-command timeouts (ms). `goto` gets the most headroom for slow targets;
// the rest are local browser operations.
const OPEN_TIMEOUT_MS = 60_000;
const STATE_LOAD_TIMEOUT_MS = 30_000;
const GOTO_TIMEOUT_MS = 90_000;
const EVAL_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 20_000;

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SKIP_ENV_VAR = 'SHANNON_SKIP_AUTH_STATE_VERIFY';

export interface VerifyInjectedSessionInput {
  readonly stateFile: string;
  readonly loginUrl: string;
  readonly successCondition: SuccessCondition;
  /**
   * Working directory for `playwright-cli` so it loads the stealth config at
   * `<sourceDir>/.playwright/cli.config.json` — the same one the agents inherit.
   */
  readonly sourceDir: string;
  readonly logger: ActivityLogger;
}

/** True when live verification is disabled via the escape-hatch env var. */
export function isLiveVerificationDisabled(): boolean {
  const raw = process.env[SKIP_ENV_VAR];
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/**
 * Restore the supplied session in a real browser and confirm it authenticates
 * against the target by evaluating the configured `success_condition`.
 */
export async function verifyInjectedSessionLive(
  input: VerifyInjectedSessionInput,
): Promise<Result<void, PentestError>> {
  const { stateFile, loginUrl, successCondition, sourceDir, logger } = input;
  const sessionFlag = `-s=${VERIFY_SESSION}`;

  logger.info('Verifying injected session against live target...', {
    loginUrl,
    conditionType: successCondition.type,
  });

  try {
    // 1. Start a throwaway browser session.
    const opened = await runPlaywrightCli([sessionFlag, 'open'], sourceDir, OPEN_TIMEOUT_MS);
    if (opened.failed) {
      return infraError('Could not start a browser to verify the supplied session', opened, { loginUrl });
    }

    // 2. Restore the operator-supplied storage state into the browser context.
    const loaded = await runPlaywrightCli([sessionFlag, 'state-load', stateFile], sourceDir, STATE_LOAD_TIMEOUT_MS);
    if (loaded.failed || containsDaemonError(loaded.stdout)) {
      return infraError('Could not restore the supplied session into a browser', loaded, { stateFile });
    }

    // 3. Navigate to the login URL. With a valid session the app redirects to
    //    the authenticated landing page — the same frame success_condition was
    //    authored against in the credential-driven flow.
    const navigated = await runPlaywrightCli([sessionFlag, 'goto', loginUrl], sourceDir, GOTO_TIMEOUT_MS);
    if (navigated.failed || containsDaemonError(navigated.stdout)) {
      return infraError(`Could not reach ${loginUrl} to verify the supplied session`, navigated, { loginUrl });
    }

    // 4. Evaluate the configured success_condition inside the page.
    const probe = buildSuccessConditionProbe(successCondition);
    const evaluated = await runPlaywrightCli([sessionFlag, 'eval', probe], sourceDir, EVAL_TIMEOUT_MS);
    const verdict = parseProbeResult(evaluated.stdout);
    if (verdict === null) {
      return infraError('Could not evaluate the success condition while verifying the supplied session', evaluated, {
        conditionType: successCondition.type,
      });
    }

    // 5. A clean false verdict means the session is not authenticated. This is a
    //    real configuration/staleness problem — fail fast and do not retry.
    if (!verdict.ok) {
      const observed = verdict.url ? ` (observed URL: ${verdict.url})` : '';
      return err(
        new PentestError(
          `The supplied --auth-state session is not authenticated against the target. After restoring it and ` +
            `navigating to ${loginUrl}, the configured success_condition (${successCondition.type} = ` +
            `"${successCondition.value}") was not met${observed}. The session has likely expired — re-capture it ` +
            'immediately before the scan — or the success_condition does not match an authenticated page.',
          'validation',
          false,
          {
            loginUrl,
            conditionType: successCondition.type,
            conditionValue: successCondition.value,
            ...(verdict.url !== undefined && { observedUrl: verdict.url }),
          },
          ErrorCode.CONFIG_VALIDATION_FAILED,
        ),
      );
    }

    logger.info('Injected session verified against live target', {
      loginUrl,
      ...(verdict.url !== undefined && { observedUrl: verdict.url }),
    });
    return ok(undefined);
  } finally {
    // Always tear down the throwaway session, even on failure.
    await runPlaywrightCli([sessionFlag, 'close'], sourceDir, CLOSE_TIMEOUT_MS).catch(() => undefined);
  }
}

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly failed: boolean;
  readonly reason?: string;
}

/**
 * Run `playwright-cli` with an argument array (no shell, so values are never
 * interpolated into a command line). Process-level failures (non-zero exit,
 * timeout, spawn error) are captured as `failed` rather than thrown.
 */
async function runPlaywrightCli(args: readonly string[], cwd: string, timeoutMs: number): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync('playwright-cli', [...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return { stdout, stderr, failed: false };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    const reason = e.killed ? `timed out after ${timeoutMs}ms` : (e.message ?? 'playwright-cli failed');
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', failed: true, reason };
  }
}

/**
 * Build a no-argument probe whose returned object `playwright-cli eval`
 * serializes to JSON. The success_condition value is embedded via
 * JSON.stringify so it is always a valid, safely-quoted JS string literal.
 */
function buildSuccessConditionProbe(condition: SuccessCondition): string {
  const value = JSON.stringify(condition.value);
  switch (condition.type) {
    case 'url_contains':
      return `() => ({ ok: location.href.includes(${value}), url: location.href })`;
    case 'url_equals_exactly':
      return `() => ({ ok: location.href === ${value}, url: location.href })`;
    case 'element_present':
      return (
        `() => { try { return { ok: !!document.querySelector(${value}), url: location.href }; } ` +
        `catch (e) { return { ok: false, url: location.href }; } }`
      );
    case 'text_contains':
      return `() => ({ ok: ((document.body && document.body.innerText) || '').includes(${value}), url: location.href })`;
  }
}

interface ProbeResult {
  readonly ok: boolean;
  readonly url?: string;
}

/**
 * Extract the JSON object printed under the `### Result` section of
 * `playwright-cli eval` output. Returns null when the section is missing or
 * unparseable (treated by the caller as an inconclusive/transient failure).
 */
function parseProbeResult(stdout: string): ProbeResult | null {
  const marker = '### Result';
  const start = stdout.indexOf(marker);
  if (start === -1) {
    return null;
  }

  const afterMarker = stdout.slice(start + marker.length);
  const nextSection = afterMarker.indexOf('\n### ');
  const body = (nextSection === -1 ? afterMarker : afterMarker.slice(0, nextSection)).trim();

  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { ok?: unknown }).ok !== 'boolean') {
      return null;
    }
    const url = (parsed as { url?: unknown }).url;
    return { ok: (parsed as { ok: boolean }).ok, ...(typeof url === 'string' && { url }) };
  } catch {
    return null;
  }
}

/** The daemon prints an `### Error` section when a command fails server-side. */
function containsDaemonError(stdout: string): boolean {
  return /^### Error$/m.test(stdout);
}

/** Build a retryable error for transient browser/network problems. */
function infraError(message: string, run: CliRun, context: Record<string, unknown>): Result<void, PentestError> {
  const stderr = run.stderr.trim();
  return err(
    new PentestError(
      `${message}: ${run.reason ?? 'unexpected playwright-cli output'}. This is usually transient or ` +
        `environmental; set ${SKIP_ENV_VAR}=1 to skip live session verification if it persists.`,
      'network',
      true,
      { ...context, ...(stderr && { stderr: stderr.slice(0, 500) }) },
      ErrorCode.AGENT_EXECUTION_FAILED,
    ),
  );
}
