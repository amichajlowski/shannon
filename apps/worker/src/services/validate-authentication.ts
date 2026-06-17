// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Authentication validation service.
 *
 * Drives a real browser via the playwright-cli skill to confirm
 * user-supplied credentials log in successfully, before the pentest
 * pipeline burns hours on broken auth.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import type { JsonSchemaOutputFormat } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { runClaudePrompt } from '../ai/claude-executor.js';
import type { AuditSession } from '../audit/index.js';
import { authStateFile } from '../audit/utils.js';
import type { ActivityLogger } from '../types/activity-logger.js';
import type { AgentEndResult } from '../types/audit.js';
import type { DistributedConfig, ProviderConfig } from '../types/config.js';
import { ErrorCode } from '../types/errors.js';
import { err, ok, type Result } from '../types/result.js';
import { PentestError } from './error-handling.js';
import { loadPrompt } from './prompt-manager.js';
import { isLiveVerificationDisabled, verifyInjectedSessionLive } from './verify-injected-session.js';

const FAILURE_POINTS = ['username_or_password', 'totp_secret', 'out_of_band'] as const;
type AuthFailurePoint = (typeof FAILURE_POINTS)[number];

function isAuthFailurePoint(v: unknown): v is AuthFailurePoint {
  return typeof v === 'string' && (FAILURE_POINTS as readonly string[]).includes(v);
}

// NOTE: SDK's AJV validator expects draft-07; Zod defaults to draft-2020-12,
// which causes the SDK to silently skip structured output.
const AuthValidationSchema = z.object({
  login_success: z.boolean(),
  failure_point: z.enum(FAILURE_POINTS).optional(),
  failure_detail: z
    .string()
    .max(250)
    .optional()
    .describe(
      'Free-form 1-2 sentence diagnostic of what the page showed (error messages, page state) when login failed. Required when login_success is false. Mask any sensitive values.',
    ),
});

type AuthValidationVerdict = z.infer<typeof AuthValidationSchema>;

const VALIDATION_SCHEMA: JsonSchemaOutputFormat = {
  type: 'json_schema',
  schema: z.toJSONSchema(AuthValidationSchema, { target: 'draft-07' }) as Record<string, unknown>,
};

const AGENT_NAME = 'validate-authentication';

export interface ValidateAuthInput {
  readonly distributedConfig: DistributedConfig | null;
  readonly repoPath: string;
  readonly webUrl: string;
  readonly logger: ActivityLogger;
  readonly auditSession: AuditSession;
  readonly attemptNumber: number;
  readonly apiKey?: string;
  readonly providerConfig?: ProviderConfig;
  readonly deliverablesSubdir?: string;
  readonly promptDir?: string;
  readonly pipelineTestingMode?: boolean;
  /**
   * Path to a pre-authenticated Playwright storage-state JSON. When set, the
   * preflight skips the interactive login entirely and injects this session as
   * the shared auth state for downstream agents.
   */
  readonly authStatePath?: string;
}

export async function validateAuthentication(input: ValidateAuthInput): Promise<Result<void, PentestError>> {
  const {
    distributedConfig,
    repoPath,
    webUrl,
    logger,
    auditSession,
    attemptNumber,
    apiKey,
    providerConfig,
    deliverablesSubdir,
    promptDir,
    pipelineTestingMode,
    authStatePath,
  } = input;

  const authentication = distributedConfig?.authentication ?? null;
  if (!authentication) {
    // A supplied auth-state file is meaningless without an authentication block:
    // downstream agents only restore/verify the session when authentication is configured.
    if (authStatePath) {
      return err(
        new PentestError(
          "--auth-state requires an 'authentication' block in your config (at least login_url and " +
            'success_condition) so agents can restore and verify the supplied session.',
          'config',
          false,
          { authStatePath },
          ErrorCode.CONFIG_VALIDATION_FAILED,
        ),
      );
    }
    return ok(undefined);
  }

  const stateFile = authStateFile(auditSession.sessionMetadata);
  await rm(stateFile, { force: true });

  // === Pre-authenticated session injection ===
  // The operator logged in via their own browser and exported the storage state.
  // Inject it as the shared auth state and skip the interactive login (no LLM, no credentials).
  if (authStatePath) {
    return injectProvidedAuthState({
      authStatePath,
      stateFile,
      logger,
      auditSession,
      attemptNumber,
      authentication,
      sourceDir: repoPath,
    });
  }

  // === Credential-driven login validation ===
  if (!authentication.credentials) {
    return err(
      new PentestError(
        'Authentication is configured but has no credentials and no --auth-state was provided. ' +
          'Add credentials to the config, or supply a pre-authenticated session with --auth-state <file>.',
        'config',
        false,
        { loginUrl: authentication.login_url },
        ErrorCode.CONFIG_VALIDATION_FAILED,
      ),
    );
  }

  logger.info('Validating authentication credentials with live browser...', {
    loginUrl: authentication.login_url,
    loginType: authentication.login_type,
  });

  const prompt = await loadPrompt(
    AGENT_NAME,
    { webUrl, repoPath, AUTH_STATE_FILE: stateFile },
    distributedConfig,
    pipelineTestingMode ?? false,
    logger,
    promptDir,
  );

  await auditSession.startAgent(AGENT_NAME, prompt, attemptNumber);
  const startTime = Date.now();

  const result = await runClaudePrompt(
    prompt,
    repoPath,
    '',
    'Authentication validation',
    AGENT_NAME,
    auditSession,
    logger,
    'medium',
    VALIDATION_SCHEMA,
    apiKey,
    deliverablesSubdir,
    providerConfig,
  );

  let classification = classifyResult(result, authentication);

  if (classification.ok) {
    const sessionCheck = await verifySavedAuthState(stateFile, logger);
    if (!sessionCheck.ok) {
      classification = sessionCheck;
    }
  }

  const endResult: AgentEndResult = {
    attemptNumber,
    duration_ms: Date.now() - startTime,
    cost_usd: result.cost || 0,
    success: classification.ok,
    ...(result.model !== undefined && { model: result.model }),
    ...(!classification.ok && { error: classification.error.message }),
  };
  await auditSession.endAgent(AGENT_NAME, endResult);

  return classification;
}

interface InjectAuthStateInput {
  readonly authStatePath: string;
  readonly stateFile: string;
  readonly logger: ActivityLogger;
  readonly auditSession: AuditSession;
  readonly attemptNumber: number;
  readonly authentication: NonNullable<DistributedConfig['authentication']>;
  readonly sourceDir: string;
}

/**
 * Install an operator-supplied Playwright storage-state file as the shared auth
 * state, then confirm it actually authenticates against the live target.
 *
 * Structural validation (parses, carries cookies/origins) catches a junk file
 * cheaply, but only a live check catches the common case of an expired or
 * wrong-domain session. The live check restores the state in a real browser and
 * evaluates the configured success_condition; it can be disabled via
 * SHANNON_SKIP_AUTH_STATE_VERIFY for environments where the browser is
 * unavailable. No LLM, no credentials.
 */
async function injectProvidedAuthState(input: InjectAuthStateInput): Promise<Result<void, PentestError>> {
  const { authStatePath, stateFile, logger, auditSession, attemptNumber, authentication, sourceDir } = input;
  const loginUrl = authentication.login_url;

  logger.info('Injecting pre-authenticated browser session (skipping interactive login)...', {
    authStatePath,
    loginUrl,
  });

  await auditSession.startAgent(AGENT_NAME, `Inject pre-authenticated session from ${authStatePath}`, attemptNumber);
  const startTime = Date.now();

  const result = await adoptAndVerifyAuthState({ authStatePath, stateFile, authentication, sourceDir, logger });

  await auditSession.endAgent(AGENT_NAME, {
    attemptNumber,
    duration_ms: Date.now() - startTime,
    cost_usd: 0,
    success: result.ok,
    ...(!result.ok && { error: result.error.message }),
  });

  return result;
}

interface AdoptAndVerifyInput {
  readonly authStatePath: string;
  readonly stateFile: string;
  readonly authentication: NonNullable<DistributedConfig['authentication']>;
  readonly sourceDir: string;
  readonly logger: ActivityLogger;
}

/**
 * Adopt the supplied storage state, then verify it live unless verification is
 * disabled. Adoption must succeed before verification — the live check restores
 * from the written stateFile.
 */
async function adoptAndVerifyAuthState(input: AdoptAndVerifyInput): Promise<Result<void, PentestError>> {
  const { authStatePath, stateFile, authentication, sourceDir, logger } = input;

  const adopted = await readAndAdoptAuthState(authStatePath, stateFile, logger);
  if (!adopted.ok) {
    return adopted;
  }

  if (isLiveVerificationDisabled()) {
    logger.warn(
      'Live session verification disabled (SHANNON_SKIP_AUTH_STATE_VERIFY) — adopting the supplied session ' +
        'without confirming it authenticates against the target.',
      { stateFile, loginUrl: authentication.login_url },
    );
    return ok(undefined);
  }

  return verifyInjectedSessionLive({
    stateFile,
    loginUrl: authentication.login_url,
    successCondition: authentication.success_condition,
    sourceDir,
    logger,
  });
}

async function readAndAdoptAuthState(
  authStatePath: string,
  stateFile: string,
  logger: ActivityLogger,
): Promise<Result<void, PentestError>> {
  let contents: string;
  try {
    contents = await readFile(authStatePath, 'utf8');
  } catch {
    return err(
      new PentestError(
        `--auth-state file not found or unreadable inside the worker: ${authStatePath}. ` +
          'Confirm the host path exists and is readable. The worker runs as a non-root user, so a file with ' +
          'restrictive permissions (e.g. chmod 600) owned by a different host user may be unreadable once mounted — ' +
          'make it readable by the mounting user, or relax its permissions.',
        'config',
        false,
        { authStatePath },
        ErrorCode.CONFIG_VALIDATION_FAILED,
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return err(
      new PentestError(
        `--auth-state file is not valid JSON (${authStatePath}): ${detail}. ` +
          'It must be a Playwright storageState export (e.g. from `playwright codegen --save-storage`).',
        'config',
        false,
        { authStatePath, parseError: detail },
        ErrorCode.CONFIG_VALIDATION_FAILED,
      ),
    );
  }

  const cookieCount = countStorageEntries(parsed, 'cookies');
  const originCount = countStorageEntries(parsed, 'origins');
  if (cookieCount === 0 && originCount === 0) {
    return err(
      new PentestError(
        `--auth-state file ${authStatePath} contains no cookies or origins — it does not hold a logged-in ` +
          'session. Re-export it after logging in (e.g. `playwright codegen --save-storage=state.json <login-url>`).',
        'config',
        false,
        { authStatePath, cookieCount, originCount },
        ErrorCode.CONFIG_VALIDATION_FAILED,
      ),
    );
  }

  try {
    // 0o600: the file holds live session cookies/tokens. stateFile was rm'd by the
    // caller, so this is a fresh create and the mode is applied.
    await writeFile(stateFile, contents, { encoding: 'utf8', mode: 0o600 });
  } catch (writeErr) {
    const detail = writeErr instanceof Error ? writeErr.message : String(writeErr);
    return err(
      new PentestError(
        `Failed to install the supplied auth-state into ${stateFile}: ${detail}`,
        'filesystem',
        true,
        { authStatePath, stateFile, writeError: detail },
        ErrorCode.AGENT_EXECUTION_FAILED,
      ),
    );
  }

  logger.info('Pre-authenticated session adopted', { stateFile, cookieCount, originCount });
  return ok(undefined);
}

async function verifySavedAuthState(stateFile: string, logger: ActivityLogger): Promise<Result<void, PentestError>> {
  let contents: string;
  try {
    contents = await readFile(stateFile, 'utf8');
  } catch {
    return err(
      new PentestError(
        `Preflight reported login success but did not save the authenticated session to ${stateFile}.`,
        'validation',
        true,
        { stateFile },
        ErrorCode.AGENT_EXECUTION_FAILED,
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return err(
      new PentestError(
        `Preflight saved an authenticated session to ${stateFile}, but the file is not valid JSON: ${detail}`,
        'validation',
        true,
        { stateFile, parseError: detail },
        ErrorCode.AGENT_EXECUTION_FAILED,
      ),
    );
  }

  const cookieCount = countStorageEntries(parsed, 'cookies');
  const originCount = countStorageEntries(parsed, 'origins');
  if (cookieCount === 0 && originCount === 0) {
    return err(
      new PentestError(
        `Preflight saved an authenticated session to ${stateFile}, but it contains no cookies or origins — the browser was not actually logged in.`,
        'validation',
        true,
        { stateFile, cookieCount, originCount },
        ErrorCode.AGENT_EXECUTION_FAILED,
      ),
    );
  }

  logger.info('Preflight authenticated session saved', { stateFile, cookieCount, originCount });
  return ok(undefined);
}

function countStorageEntries(parsed: unknown, key: 'cookies' | 'origins'): number {
  if (typeof parsed !== 'object' || parsed === null) return 0;
  const value = (parsed as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.length : 0;
}

function classifyResult(
  result: import('../ai/claude-executor.js').ClaudePromptResult,
  authentication: NonNullable<DistributedConfig['authentication']>,
): Result<void, PentestError> {
  if (!result.success) {
    const detail = result.error ?? 'Validator agent terminated unexpectedly.';
    return err(
      new PentestError(
        `Authentication validator failed to run: ${detail}`,
        'validation',
        result.retryable ?? true,
        { originalError: detail, errorType: result.errorType, cost: result.cost },
        ErrorCode.AGENT_EXECUTION_FAILED,
      ),
    );
  }

  if (!result.structuredOutput || typeof result.structuredOutput !== 'object') {
    return err(
      new PentestError(
        'Authentication validator did not return a structured verdict.',
        'validation',
        true,
        { cost: result.cost },
        ErrorCode.AGENT_EXECUTION_FAILED,
      ),
    );
  }

  const verdict = result.structuredOutput as Partial<AuthValidationVerdict>;

  if (verdict.login_success === true) {
    return ok(undefined);
  }

  const failurePoint: AuthFailurePoint = isAuthFailurePoint(verdict.failure_point)
    ? verdict.failure_point
    : 'out_of_band';
  const failureDetail =
    verdict.failure_detail?.trim() || 'Login failed without a specific diagnostic from the validator agent.';

  return err(
    new PentestError(
      `Authentication failed at "${failurePoint}": ${failureDetail}`,
      'config',
      false,
      {
        failurePoint,
        failureDetail,
        loginUrl: authentication.login_url,
        loginType: authentication.login_type,
        cost: result.cost,
      },
      ErrorCode.AUTH_LOGIN_FAILED,
    ),
  );
}
