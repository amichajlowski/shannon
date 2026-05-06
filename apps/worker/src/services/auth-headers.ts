// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Auth header validation, masking, and API success-condition evaluation.
 *
 * Pure functions. No I/O. Used by the config parser (validation), the
 * preflight verifier (mask + evaluate), and the prompt manager (mask).
 *
 * NOTE: header values appear verbatim in agent prompts (and prompt audit
 * logs) by design — agents need the values to operate. Masking applies to
 * operational logs (preflight, errors, status output), never to the
 * rendered agent prompt itself.
 */

import type { AuthHeaders, SuccessCondition } from '../types/config.js';
import { ErrorCode } from '../types/errors.js';
import { PentestError } from './error-handling.js';

const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
const FORBIDDEN_HEADER_NAMES = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie']);
const MAX_HEADER_NAME_LENGTH = 64;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_HEADER_COUNT = 20;

export function validateHeaderName(name: string, fieldPath: string): void {
  if (!name || name.length > MAX_HEADER_NAME_LENGTH) {
    throw new PentestError(
      `${fieldPath}: header name length must be 1..${MAX_HEADER_NAME_LENGTH}`,
      'config',
      false,
      { field: fieldPath, name },
      ErrorCode.CONFIG_VALIDATION_FAILED,
    );
  }
  if (!HEADER_NAME_PATTERN.test(name)) {
    throw new PentestError(
      `${fieldPath}: header name "${name}" must match ${HEADER_NAME_PATTERN.source}`,
      'config',
      false,
      { field: fieldPath, name },
      ErrorCode.CONFIG_VALIDATION_FAILED,
    );
  }
  if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
    throw new PentestError(
      `${fieldPath}: header name "${name}" is forbidden (reserved for transport layer)`,
      'config',
      false,
      { field: fieldPath, name },
      ErrorCode.CONFIG_VALIDATION_FAILED,
    );
  }
}

export function validateHeaderValue(value: string, fieldPath: string): void {
  if (!value || value.length > MAX_HEADER_VALUE_LENGTH) {
    throw new PentestError(
      `${fieldPath}: header value length must be 1..${MAX_HEADER_VALUE_LENGTH}`,
      'config',
      false,
      { field: fieldPath },
      ErrorCode.CONFIG_VALIDATION_FAILED,
    );
  }
  if (/[\r\n\0]/.test(value)) {
    throw new PentestError(
      `${fieldPath}: header value contains forbidden control character (CR/LF/NUL — request smuggling risk)`,
      'config',
      false,
      { field: fieldPath },
      ErrorCode.CONFIG_VALIDATION_FAILED,
    );
  }
}

export function validateAuthHeaders(headers: AuthHeaders, fieldPath: string): void {
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    throw new PentestError(
      `${fieldPath}: at least one header is required`,
      'config',
      false,
      { field: fieldPath },
      ErrorCode.CONFIG_VALIDATION_FAILED,
    );
  }
  if (entries.length > MAX_HEADER_COUNT) {
    throw new PentestError(
      `${fieldPath}: at most ${MAX_HEADER_COUNT} headers allowed`,
      'config',
      false,
      { field: fieldPath, count: entries.length },
      ErrorCode.CONFIG_VALIDATION_FAILED,
    );
  }
  for (const [name, value] of entries) {
    validateHeaderName(name, `${fieldPath}.${name}`);
    validateHeaderValue(value, `${fieldPath}.${name}`);
  }
}

/**
 * Mask a secret value for safe logging. Short values become "<hidden>";
 * long values become "abcd…wxyz" (first 4 + ellipsis + last 4 chars).
 */
export function maskSecret(value: string): string {
  if (!value || value.length <= 8) return '<hidden>';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Mask all values in a header map for log output. Header names stay visible.
 */
export function maskAuthHeaders(headers: AuthHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, maskSecret(v)]));
}

export interface ApiConditionResult {
  ok: boolean;
  reason: string;
}

/**
 * Evaluate an API success condition against an HTTP response.
 *
 * Supports:
 *   - status_code:    "200" | "2xx" | comma-list "200,204"
 *   - body_contains:  substring match (case-sensitive)
 *   - text_contains:  alias for body_contains
 *
 * Browser-only types (url_contains, element_present, url_equals_exactly)
 * return a clear failure — agents check those at the page level instead.
 */
export function evaluateApiSuccessCondition(status: number, body: string, cond: SuccessCondition): ApiConditionResult {
  switch (cond.type) {
    case 'status_code':
      return matchStatusCode(status, cond.value);
    case 'body_contains':
    case 'text_contains':
      return body.includes(cond.value)
        ? { ok: true, reason: `body contains "${cond.value}"` }
        : { ok: false, reason: `body does not contain "${cond.value}" (status ${status})` };
    default:
      return {
        ok: false,
        reason: `success_condition.type "${cond.type}" is browser-only and cannot be evaluated for login_type=api; use status_code or body_contains`,
      };
  }
}

function matchStatusCode(status: number, expected: string): ApiConditionResult {
  const trimmed = expected.trim().toLowerCase();
  const tokens = trimmed
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (token.endsWith('xx')) {
      const prefix = token.slice(0, -2);
      if (prefix.length === 1 && status >= Number(prefix) * 100 && status < (Number(prefix) + 1) * 100) {
        return { ok: true, reason: `status ${status} matches ${token}` };
      }
    } else if (Number(token) === status) {
      return { ok: true, reason: `status ${status} matches ${token}` };
    }
  }
  return { ok: false, reason: `status ${status} does not match expected "${expected}"` };
}
