#!/usr/bin/env node

// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * verify-auth CLI
 *
 * Standalone preflight check that issues one HTTP request to the configured
 * login_url with the configured auth_headers and asserts the success_condition.
 *
 * Runs inside the worker container so DNS, TLS trust, and egress match a real
 * scan. Used by `shannon verify-auth -c <config>` from the CLI side.
 *
 * Exit codes:
 *   0 — auth verified
 *   1 — verification failed (config invalid, network error, headers rejected)
 */

import { parseConfig } from '../config-parser.js';
import { verifyAuthHeaders } from '../services/preflight.js';
import type { ActivityLogger } from '../types/activity-logger.js';
import type { Config } from '../types/config.js';

function parseArgs(argv: string[]): { config: string } {
  let config = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === '-c' || arg === '--config') && next) {
      config = next;
      i++;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  if (!config) {
    console.error('ERROR: --config <path> is required');
    printHelp();
    process.exit(1);
  }
  return { config };
}

function printHelp(): void {
  console.log(
    `verify-auth — verify that auth_headers in a Shannon config are accepted by the target.

Usage:
  verify-auth --config <path>
  verify-auth -h | --help

The config must declare login_type: api with auth_headers.`,
  );
}

const consoleLogger: ActivityLogger = {
  info: (msg, attrs) => {
    if (attrs) console.log(`[info] ${msg}`, JSON.stringify(attrs));
    else console.log(`[info] ${msg}`);
  },
  warn: (msg, attrs) => {
    if (attrs) console.warn(`[warn] ${msg}`, JSON.stringify(attrs));
    else console.warn(`[warn] ${msg}`);
  },
  error: (msg, attrs) => {
    if (attrs) console.error(`[error] ${msg}`, JSON.stringify(attrs));
    else console.error(`[error] ${msg}`);
  },
};

async function main(): Promise<void> {
  const { config: configPath } = parseArgs(process.argv.slice(2));

  let config: Config;
  try {
    config = await parseConfig(configPath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`✗ Config invalid: ${msg}`);
    process.exit(1);
  }

  const auth = config.authentication;
  if (!auth || auth.login_type !== 'api') {
    console.error('✗ Config must declare authentication.login_type: api');
    process.exit(1);
  }
  if (!auth.auth_headers || Object.keys(auth.auth_headers).length === 0) {
    console.error('✗ Config must declare authentication.auth_headers');
    process.exit(1);
  }

  const result = await verifyAuthHeaders(auth, consoleLogger);
  if (!result.ok) {
    console.error(`✗ ${result.error.message}`);
    if (result.error.context) {
      console.error('  details:', JSON.stringify(result.error.context));
    }
    process.exit(1);
  }

  console.log('✓ Auth headers verified');
  process.exit(0);
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`✗ Unexpected error: ${msg}`);
  process.exit(1);
});
