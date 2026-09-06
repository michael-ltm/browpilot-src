import type { HostEnv } from './env.js';
import { nodeEnv, readJson } from './env.js';
import { joinPath } from './pathutil.js';
import type { ExtensionStatus } from './types.js';

interface PrefsFile {
  extensions?: {
    settings?: Record<string, ExtensionRecord>;
  };
}

interface ExtensionRecord {
  /** Legacy (pre-M127) enabled flag: 1 = enabled, 0 = disabled. */
  state?: number;
  /** Modern replacement for `state`: empty/absent means enabled. */
  disable_reasons?: unknown;
  location?: number;
  path?: string;
}

/** Chromium's Extension::State value for an enabled extension. */
const STATE_ENABLED = 1;

/**
 * Preference files in priority order. Store installs are recorded in the
 * MAC-protected "Secure Preferences"; unpacked ones (both "Load unpacked" and
 * CDP Extensions.loadUnpacked) land in plain "Preferences" — check both.
 */
const PREF_FILES = ['Secure Preferences', 'Preferences'] as const;

const ABSENT: ExtensionStatus = {
  state: 'absent',
  source: null,
  location: null,
  path: null,
  disableReasons: [],
};

/**
 * Decide whether an extension record describes an enabled extension.
 *
 * Chrome moved from a single `state` int to a `disable_reasons` list around
 * M127; current Chrome (verified on 151) writes neither key for a freshly
 * loaded unpacked extension, so "no signal at all" must read as enabled.
 */
export function isRecordEnabled(record: ExtensionRecord): boolean {
  if (typeof record.state === 'number') return record.state === STATE_ENABLED;
  const reasons = record.disable_reasons;
  if (Array.isArray(reasons)) return reasons.length === 0;
  if (typeof reasons === 'number') return reasons === 0;
  return true;
}

function toReasons(record: ExtensionRecord): unknown[] {
  const reasons = record.disable_reasons;
  if (Array.isArray(reasons)) return reasons;
  if (typeof reasons === 'number' && reasons !== 0) return [reasons];
  return [];
}

/**
 * Look up one extension id in a profile's preference files.
 *
 * The id is pinned by the manifest `key`, so a store install, a "Load unpacked"
 * install and a CDP load all register under the same id — matching on id is the
 * one check that survives every install path.
 */
export function readExtensionStatus(
  profilePath: string,
  extensionId: string,
  env: HostEnv = nodeEnv(),
): ExtensionStatus {
  for (const file of PREF_FILES) {
    const prefs = readJson<PrefsFile>(env, joinPath(env.platform, profilePath, file));
    const record = prefs?.extensions?.settings?.[extensionId];
    if (!record) continue;
    return {
      state: isRecordEnabled(record) ? 'enabled' : 'disabled',
      source: file,
      location: typeof record.location === 'number' ? record.location : null,
      path: typeof record.path === 'string' ? record.path : null,
      disableReasons: toReasons(record),
    };
  }
  return ABSENT;
}
