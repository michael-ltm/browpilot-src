import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PORT,
  CONFIG_DIR,
  CONFIG_FILE,
  type Config,
} from '@claude-browser/shared';

/** Parse the on-disk config JSON into a Config, applying the default port. */
export function parseConfig(raw: string): Config {
  let obj: Partial<Config>;
  try {
    obj = JSON.parse(raw) as Partial<Config>;
  } catch {
    throw new Error('claude-browser: config.json is not valid JSON');
  }
  if (typeof obj.token !== 'string' || obj.token.length === 0) {
    throw new Error('claude-browser: config is missing "token"');
  }
  if (typeof obj.extensionId !== 'string' || obj.extensionId.length === 0) {
    throw new Error('claude-browser: config is missing "extensionId"');
  }
  return {
    port: typeof obj.port === 'number' ? obj.port : DEFAULT_PORT,
    token: obj.token,
    extensionId: obj.extensionId,
    ...(Array.isArray(obj.extensionIds) ? { extensionIds: obj.extensionIds.filter((id): id is string => typeof id === 'string' && /^[a-p]{32}$/.test(id)) } : {}),
    ...(obj.storeUrls ? { storeUrls: obj.storeUrls } : {}),
  };
}

/** Absolute path to ~/.claude-browser/config.json. */
export function configPath(): string {
  return join(homedir(), CONFIG_DIR, CONFIG_FILE);
}

/** Read + parse the config from disk. */
export function loadConfig(): Config {
  return parseConfig(readFileSync(configPath(), 'utf8'));
}
