/**
 * `shannon verify-auth` command — verify auth_headers against the live target.
 *
 * Spawns the worker container with the user's config mounted read-only and
 * runs the verify-auth script. Same egress path as a real scan, so DNS, TLS
 * trust, and proxy behavior all match production.
 *
 * Usage:
 *   shannon verify-auth -c <config.yaml>
 *   shannon verify-auth --config <config.yaml>
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureImage, getWorkerImage } from '../docker.js';

export interface VerifyAuthArgs {
  config: string;
  version: string;
}

export function verifyAuth(args: VerifyAuthArgs): void {
  const configPath = path.resolve(args.config);
  if (!fs.existsSync(configPath)) {
    console.error(`ERROR: Config file not found: ${configPath}`);
    process.exit(1);
  }

  ensureImage(args.version);

  const image = getWorkerImage(args.version);
  const containerConfigPath = `/app/apps/worker/configs/${path.basename(configPath)}`;

  const dockerArgs = ['run', '--rm', '-v', `${configPath}:${containerConfigPath}:ro`];

  if (os.platform() !== 'linux') {
    dockerArgs.push('--add-host', 'host.docker.internal:host-gateway');
  }

  dockerArgs.push(image);
  dockerArgs.push('node', '/app/apps/worker/dist/scripts/verify-auth.js', '-c', containerConfigPath);

  try {
    execFileSync('docker', dockerArgs, { stdio: 'inherit' });
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'status' in error ? Number((error as { status: number }).status) : 1;
    process.exit(code || 1);
  }
}
