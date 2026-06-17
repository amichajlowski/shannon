// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Writes <sourceDir>/.playwright/cli.config.json with stealth defaults so
 * `playwright-cli open` auto-loads them from the agent's cwd. Skipped when a
 * config already exists so user-provided files are never clobbered — unless an
 * auth header is supplied, in which case the header is merged into whatever
 * config is present (the header is load-bearing for authenticated scans).
 *
 * NOTE: Playwright's MCP browser config treats `initScript` entries as file
 * paths, not inline source. The stealth script is written alongside the config
 * and referenced by absolute path. Inline strings silently fail the daemon.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const STEALTH_INIT_SCRIPT = `delete Object.getPrototypeOf(navigator).webdriver;

Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const arr = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ];
    arr.__proto__ = PluginArray.prototype;
    return arr;
  },
});

window.chrome = window.chrome || {};
window.chrome.runtime = window.chrome.runtime || {
  PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
  PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
  PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
  RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
  OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
  OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
};
`;

/**
 * An operator-supplied auth header to attach to every browser request, plus the
 * sole origin the browser may talk to so the header never leaks cross-origin.
 */
export interface InjectedAuthHeader {
  readonly name: string;
  readonly value: string;
  readonly origin: string;
}

/**
 * A forward proxy that injects an (auto-refreshed) auth header per request, plus
 * the sole origin the browser may talk to. Mutually exclusive with a static header.
 */
export interface AuthProxy {
  readonly url: string;
  readonly origin: string;
}

/** Auth augmentations layered onto the stealth config. At most one of header/proxy. */
export interface StealthAuthOptions {
  readonly authHeader?: InjectedAuthHeader;
  readonly proxy?: AuthProxy;
}

/** The single origin the browser is confined to, if any auth augmentation is set. */
function confinedOrigin(opts: StealthAuthOptions): string | undefined {
  return opts.authHeader?.origin ?? opts.proxy?.origin;
}

function buildStealthConfig(initScriptPath: string, opts: StealthAuthOptions) {
  const origin = confinedOrigin(opts);
  return {
    browser: {
      browserName: 'chromium',
      launchOptions: {
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
        ...(opts.proxy && { proxy: { server: opts.proxy.url } }),
      },
      contextOptions: {
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          ...(opts.authHeader && { [opts.authHeader.name]: opts.authHeader.value }),
        },
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      initScript: [initScriptPath],
    },
    // Confine the browser to the target origin so the credential is never sent to
    // a third party on a cross-origin redirect or resource load.
    ...(origin && { network: { allowedOrigins: [origin] } }),
  };
}

/**
 * Merge auth augmentations into a config that already exists on disk, without
 * disturbing the rest of it.
 */
function mergeAuthOptions(config: Record<string, unknown>, opts: StealthAuthOptions): Record<string, unknown> {
  const browser = { ...((config.browser as Record<string, unknown>) ?? {}) };
  const contextOptions = { ...((browser.contextOptions as Record<string, unknown>) ?? {}) };
  if (opts.authHeader) {
    const extraHTTPHeaders = { ...((contextOptions.extraHTTPHeaders as Record<string, string>) ?? {}) };
    extraHTTPHeaders[opts.authHeader.name] = opts.authHeader.value;
    contextOptions.extraHTTPHeaders = extraHTTPHeaders;
  }
  if (opts.proxy) {
    const launchOptions = { ...((browser.launchOptions as Record<string, unknown>) ?? {}) };
    launchOptions.proxy = { server: opts.proxy.url };
    browser.launchOptions = launchOptions;
  }
  browser.contextOptions = contextOptions;
  const origin = confinedOrigin(opts);
  return { ...config, browser, ...(origin && { network: { allowedOrigins: [origin] } }) };
}

export type StealthConfigWriteResult = 'wrote' | 'skipped-existing' | 'merged-auth';

export async function writePlaywrightStealthConfig(
  sourceDir: string,
  authOptions: StealthAuthOptions = {},
): Promise<{ result: StealthConfigWriteResult; configPath: string }> {
  const playwrightDir = path.join(sourceDir, '.playwright');
  const configPath = path.join(playwrightDir, 'cli.config.json');
  const hasAuth = Boolean(authOptions.authHeader || authOptions.proxy);

  if (await pathExists(configPath)) {
    // A config exists. Leave it untouched unless we must inject auth, which is
    // load-bearing — then merge the auth augmentation into the existing config.
    if (!hasAuth) {
      return { result: 'skipped-existing', configPath };
    }
    const existing = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(configPath, JSON.stringify(mergeAuthOptions(existing, authOptions), null, 2));
    return { result: 'merged-auth', configPath };
  }

  const initScriptPath = path.join(playwrightDir, 'scripts', 'stealth.js');
  await fs.mkdir(path.dirname(initScriptPath), { recursive: true });
  await fs.writeFile(initScriptPath, STEALTH_INIT_SCRIPT);
  await fs.writeFile(configPath, JSON.stringify(buildStealthConfig(initScriptPath, authOptions), null, 2));
  return { result: 'wrote', configPath };
}
