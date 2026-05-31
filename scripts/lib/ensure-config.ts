import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_PORT, type Config } from '@claude-browser/shared';

export interface EnsureConfigResult {
  created: boolean;
  config: Config;
}

/**
 * Ensure the config file exists with {port, token, extensionId}. Fresh installs
 * get DEFAULT_PORT and a freshly generated 32-byte hex token. Re-installs keep
 * the existing token+port (so running agents keep authenticating) but always
 * refresh the pinned extensionId to match the currently built extension.
 * Written 0600 so only the user's processes can read the token (spec §9).
 */
export async function ensureConfig(
  configFile: string,
  extensionId: string,
): Promise<EnsureConfigResult> {
  let existing: Partial<Config> | undefined;
  try {
    existing = JSON.parse(await readFile(configFile, 'utf8')) as Partial<Config>;
  } catch {
    existing = undefined;
  }

  const created = existing === undefined;
  const config: Config = {
    port: existing?.port ?? DEFAULT_PORT,
    token: existing?.token ?? randomBytes(32).toString('hex'),
    extensionId,
  };

  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });

  return { created, config };
}
