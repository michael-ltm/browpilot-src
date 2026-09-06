import type { HostEnv } from './env.js';
import { nodeEnv, safeExists } from './env.js';
import { detectBrowsers, majorVersion, type DetectOptions } from './detect.js';
import { readProfiles } from './profiles.js';
import { readExtensionStatus } from './extension-state.js';
import { listRunningBrowsers, processesForUserDataDir, runningUserDataDirs, type RunningBrowser } from './running.js';
import { ManifestLocation, type BrowserInstall, type BrowserReport, type ProfileExtensionStatus } from './types.js';

/**
 * Chrome 137 stopped honouring --load-extension, and Chrome 136 stopped
 * honouring --remote-debugging-port for the stock user data dir. Both gates
 * shape what an installer can and cannot automate — see docs/extension-install.md.
 */
export const LOAD_EXTENSION_REMOVED_IN = 137;
export const REMOTE_DEBUGGING_RESTRICTED_IN = 136;

/** What we can do about a browser+profile that lacks the extension. */
export type InstallPath = 'already-installed' | 'cdp-load' | 'manual-only';

export interface Verdict {
  /** True when at least one profile has the extension enabled. */
  installed: boolean;
  path: InstallPath;
  /** Human-readable justification, safe to show the user verbatim. */
  reason: string;
}

/** Inspect one browser install: its profiles and the extension state in each. */
export function inspectBrowser(
  install: BrowserInstall,
  extensionId: string,
  env: HostEnv = nodeEnv(),
): BrowserReport {
  if (!safeExists(env, install.userDataDir)) {
    return { ...install, profiles: [], error: `user data dir not found: ${install.userDataDir}` };
  }
  const profiles: ProfileExtensionStatus[] = readProfiles(install.userDataDir, env).map((profile) => ({
    ...profile,
    extension: readExtensionStatus(profile.path, extensionId, env),
  }));
  return { ...install, profiles };
}

/**
 * Decide the install path for a browser, detect-first: an enabled extension in
 * any profile means do nothing at all.
 */
export function verdictFor(report: BrowserReport, env: HostEnv = nodeEnv()): Verdict {
  const enabled = report.profiles.filter((p) => p.extension.state === 'enabled');
  if (enabled.length > 0) {
    const where = enabled.map((p) => p.name).join(', ');
    return { installed: true, path: 'already-installed', reason: `extension enabled in: ${where}` };
  }
  const disabled = report.profiles.filter((p) => p.extension.state === 'disabled');
  if (disabled.length > 0) {
    const where = disabled.map((p) => p.name).join(', ');
    return {
      installed: false,
      path: 'manual-only',
      reason: `extension present but turned off in: ${where} — re-enable it on the extensions page`,
    };
  }
  const major = majorVersion(report.version);
  if (major !== null && major >= REMOTE_DEBUGGING_RESTRICTED_IN && report.isDefaultUserDataDir) {
    return {
      installed: false,
      path: 'manual-only',
      reason:
        `${report.name} ${major} refuses remote debugging for its default user data dir, and ` +
        `--load-extension is ignored from ${LOAD_EXTENSION_REMOVED_IN} on, so the extension has to be ` +
        `loaded once by hand on the extensions page`,
    };
  }
  void env;
  return {
    installed: false,
    path: 'cdp-load',
    reason: 'extension absent; it can be loaded over the DevTools protocol on a controlled relaunch',
  };
}

export interface DetectReport extends BrowserReport {
  verdict: Verdict;
  /** Live processes for this user data dir; a relaunch has to close these. */
  running: RunningBrowser[];
}

/**
 * Full detect-first sweep: every installed browser, every profile, the
 * extension verdict, and whether the browser is currently running.
 */
export function detectAll(
  extensionId: string,
  env: HostEnv = nodeEnv(),
  opts: DetectOptions = {},
): DetectReport[] {
  const running = listRunningBrowsers(env);
  const installs = detectBrowsers(env, {
    ...opts,
    extraUserDataDirs: mergeDirs(runningUserDataDirs(env, running), opts.extraUserDataDirs),
  });
  return installs.map((install) => {
    const report = inspectBrowser(install, extensionId, env);
    return { ...report, verdict: verdictFor(report, env), running: processesForUserDataDir(install, env, running) };
  });
}

function mergeDirs(
  a: DetectOptions['extraUserDataDirs'],
  b: DetectOptions['extraUserDataDirs'],
): DetectOptions['extraUserDataDirs'] {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  for (const [family, dirs] of Object.entries(b)) {
    const key = family as keyof typeof out;
    out[key] = [...(out[key] ?? []), ...(dirs ?? [])];
  }
  return out;
}

/** Human-readable one-liner for a profile's extension state. */
export function describeProfile(profile: ProfileExtensionStatus): string {
  const ext = profile.extension;
  if (ext.state === 'absent') return `${profile.dir} [${profile.name}]  not installed`;
  const how =
    ext.location === ManifestLocation.UNPACKED
      ? 'unpacked'
      : ext.location === ManifestLocation.COMMAND_LINE
        ? 'command-line'
        : ext.location === ManifestLocation.INTERNAL
          ? 'from web store'
          : `location ${ext.location ?? '?'}`;
  const from = ext.path ? ` <- ${ext.path}` : '';
  return `${profile.dir} [${profile.name}]  ${ext.state} (${how})${from}`;
}
