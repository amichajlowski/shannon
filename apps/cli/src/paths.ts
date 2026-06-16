/**
 * Path resolution for --repo and --config arguments.
 *
 * Local mode supports bare repo names (e.g. "my-repo" → ./repos/my-repo).
 * Both modes resolve relative paths against CWD.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isLocal } from './mode.js';

export interface MountPair {
  hostPath: string;
  containerPath: string;
}

/**
 * Resolve --repo to absolute path and container mount.
 * Dev mode: bare names (no / or . prefix) check ./repos/<name> first.
 */
export function resolveRepo(repoArg: string): MountPair {
  let hostPath: string;

  if (isLocal() && !repoArg.startsWith('/') && !repoArg.startsWith('.')) {
    // Bare name — check ./repos/<name> for backward compatibility
    const barePath = path.resolve('repos', repoArg);
    if (fs.existsSync(barePath)) {
      hostPath = barePath;
    } else {
      console.error(`ERROR: Repository not found at ./repos/${repoArg}`);
      console.error('');
      console.error('Place your target repository under the ./repos/ directory,');
      console.error('or pass an absolute/relative path: -r /path/to/repo');
      process.exit(1);
    }
  } else {
    hostPath = path.resolve(repoArg);
  }

  if (!fs.existsSync(hostPath)) {
    console.error(`ERROR: Repository not found: ${hostPath}`);
    process.exit(1);
  }

  if (!fs.statSync(hostPath).isDirectory()) {
    console.error(`ERROR: Not a directory: ${hostPath}`);
    process.exit(1);
  }

  const basename = path.basename(hostPath);
  return {
    hostPath,
    containerPath: `/repos/${basename}`,
  };
}

/**
 * Resolve --config to absolute path and container mount.
 */
export function resolveConfig(configArg: string): MountPair {
  const hostPath = path.resolve(configArg);

  if (!fs.existsSync(hostPath)) {
    console.error(`ERROR: Config file not found: ${hostPath}`);
    process.exit(1);
  }

  if (!fs.statSync(hostPath).isFile()) {
    console.error(`ERROR: Not a file: ${hostPath}`);
    process.exit(1);
  }

  const basename = path.basename(hostPath);
  return {
    hostPath,
    containerPath: `/app/configs/${basename}`,
  };
}

/**
 * Resolve --auth-state to an absolute path and container mount.
 *
 * The file is a Playwright storage-state export (cookies + origins) produced by
 * a human logging in interactively (e.g. `playwright codegen --save-storage`).
 * Validated here on the host so misconfiguration fails before a container spawns.
 */
export function resolveAuthState(authStateArg: string): MountPair {
  const hostPath = path.resolve(authStateArg);

  if (!fs.existsSync(hostPath)) {
    console.error(`ERROR: Auth-state file not found: ${hostPath}`);
    process.exit(1);
  }

  if (!fs.statSync(hostPath).isFile()) {
    console.error(`ERROR: Auth-state path is not a file: ${hostPath}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(hostPath, 'utf-8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: Auth-state file is not valid JSON: ${hostPath}`);
    console.error(`  ${detail}`);
    console.error('  Expected a Playwright storageState export (e.g. from `playwright codegen --save-storage`).');
    process.exit(1);
  }

  const cookieCount = countArray(parsed, 'cookies');
  const originCount = countArray(parsed, 'origins');
  if (cookieCount === 0 && originCount === 0) {
    console.error(`ERROR: Auth-state file has no cookies or origins: ${hostPath}`);
    console.error('  It does not hold a logged-in session. Log in first, then re-export it:');
    console.error('  npx playwright codegen --save-storage=auth-state.json <login-url>');
    process.exit(1);
  }

  return {
    hostPath,
    containerPath: '/app/auth-state/state.json',
  };
}

/**
 * Resolve --auth-header-file to an absolute path and container mount.
 *
 * The file holds a single HTTP header line (`Name: Value`, e.g.
 * `Authorization: Bearer <jwt>`) captured by `shannon capture-auth`. The worker
 * injects it into every browser request so a stateless Bearer/header API can be
 * scanned authenticated. Validated here so a malformed file fails before a
 * container spawns.
 */
export function resolveAuthHeaderFile(authHeaderArg: string): MountPair {
  const hostPath = path.resolve(authHeaderArg);

  if (!fs.existsSync(hostPath)) {
    console.error(`ERROR: Auth-header file not found: ${hostPath}`);
    process.exit(1);
  }

  if (!fs.statSync(hostPath).isFile()) {
    console.error(`ERROR: Auth-header path is not a file: ${hostPath}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(hostPath, 'utf-8').trim();
  // A single header line: header name, colon, then a non-empty value.
  if (!/^[A-Za-z0-9-]+:[ \t]*\S.*$/.test(contents.split('\n')[0] ?? '')) {
    console.error(`ERROR: Auth-header file is not a valid "Name: Value" header line: ${hostPath}`);
    console.error('  Expected something like: Authorization: Bearer <token>');
    console.error('  Capture one with: shannon capture-auth --login-url <url> --target-origin <origin>');
    process.exit(1);
  }

  return {
    hostPath,
    containerPath: '/app/auth-header/header.txt',
  };
}

/** Count entries in a top-level array field of a parsed storage-state object. */
function countArray(parsed: unknown, key: 'cookies' | 'origins'): number {
  if (typeof parsed !== 'object' || parsed === null) return 0;
  const value = (parsed as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.length : 0;
}
