import type { HostEnv } from './env.js';
import { nodeEnv, readJson, safeExists, safeReadDir } from './env.js';
import { joinPath } from './pathutil.js';
import type { BrowserProfile } from './types.js';

interface LocalState {
  profile?: {
    info_cache?: Record<string, { name?: string }>;
    last_used?: string;
    profiles_order?: string[];
  };
}

/** A directory Chromium would recognise as a profile: "Default" or "Profile N". */
function looksLikeProfileDir(name: string): boolean {
  return name === 'Default' || /^Profile \d+$/.test(name);
}

/**
 * List the profiles inside a user data dir.
 *
 * `Local State`'s profile.info_cache is authoritative (it carries the display
 * names shown in the avatar menu); scanning the directory is the fallback for a
 * user data dir whose Local State is missing or unparsable.
 */
export function readProfiles(userDataDir: string, env: HostEnv = nodeEnv()): BrowserProfile[] {
  const state = readJson<LocalState>(env, joinPath(env.platform, userDataDir, 'Local State'));
  const cache = state?.profile?.info_cache;
  const dirs =
    cache && Object.keys(cache).length > 0
      ? Object.keys(cache)
      : safeReadDir(env, userDataDir).filter(looksLikeProfileDir);

  const profiles = dirs
    .map((dir) => ({
      dir,
      name: cache?.[dir]?.name ?? dir,
      path: joinPath(env.platform, userDataDir, dir),
    }))
    // info_cache can outlive a deleted profile directory.
    .filter((p) => safeExists(env, p.path));

  return sortProfiles(profiles, state?.profile?.profiles_order);
}

/** "Default" first, then the order Chromium itself uses, then alphabetical. */
function sortProfiles(profiles: BrowserProfile[], order?: string[]): BrowserProfile[] {
  const rank = (dir: string): number => {
    if (dir === 'Default') return -1;
    const idx = order?.indexOf(dir) ?? -1;
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };
  return [...profiles].sort((a, b) => rank(a.dir) - rank(b.dir) || a.dir.localeCompare(b.dir));
}

/** The profile Chromium would open by default, if we can tell. */
export function lastUsedProfile(userDataDir: string, env: HostEnv = nodeEnv()): string | null {
  const state = readJson<LocalState>(env, joinPath(env.platform, userDataDir, 'Local State'));
  return state?.profile?.last_used ?? null;
}
