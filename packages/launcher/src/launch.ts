import { majorVersion } from './detect.js';
import { LOAD_EXTENSION_REMOVED_IN } from './report.js';
import type { BrowserReport } from './types.js';

export interface LaunchFlagOptions {
  /** Absolute path to the unpacked extension directory. */
  extensionDir: string;
  /** The *root* user data dir, never a single profile directory. */
  userDataDir: string;
  /** Profile directory name, e.g. "Default" or "Profile 1". */
  profileDirectory?: string;
  /** When set, enables DevTools on 127.0.0.1 and the extension-loading domain. */
  remoteDebuggingPort?: number;
  /**
   * Pass --load-extension too. Only meaningful below Chrome 137, which stopped
   * honouring the switch entirely — see docs/extension-install.md.
   */
  useLoadExtensionFlag?: boolean;
  /** Anything the caller wants appended verbatim. */
  extraFlags?: string[];
}

/**
 * True when this browser build still honours --load-extension. Chrome/Edge 137
 * removed it; with no version at hand, assume it does not.
 */
export function loadExtensionFlagSupported(version: string | null): boolean {
  const major = majorVersion(version);
  return major !== null && major < LOAD_EXTENSION_REMOVED_IN;
}

/**
 * Command-line flags for a controlled launch of the user's *real* profile.
 *
 * Deliberately absent: --disable-extensions-except, which would switch off
 * every other extension the user has installed, and any flag that would put the
 * browser into a throwaway state — the whole point is to keep them logged in.
 */
export function buildLaunchFlags(opts: LaunchFlagOptions): string[] {
  const flags = [`--user-data-dir=${opts.userDataDir}`];
  if (opts.profileDirectory) flags.push(`--profile-directory=${opts.profileDirectory}`);
  if (opts.useLoadExtensionFlag) flags.push(`--load-extension=${opts.extensionDir}`);
  if (opts.remoteDebuggingPort !== undefined) {
    flags.push(
      `--remote-debugging-port=${opts.remoteDebuggingPort}`,
      '--remote-debugging-address=127.0.0.1',
      // Required from Chrome 137 on for Extensions.loadUnpacked to be exposed.
      '--enable-unsafe-extension-debugging',
    );
  }
  flags.push('--no-first-run', '--no-default-browser-check');
  return [...flags, ...(opts.extraFlags ?? [])];
}

/**
 * The steps a user has to perform by hand when no automated path is available.
 * Returned as lines so the MCP tool and the installer can print the same text.
 */
export function manualInstallSteps(report: BrowserReport, extensionDir: string): string[] {
  const disabled = report.profiles.filter((p) => p.extension.state === 'disabled');
  if (disabled.length > 0) {
    return [
      `The extension is installed in ${report.name} but switched off.`,
      `  1. Open  ${extensionsPageUrl(report)}`,
      `  2. Switch "browpilot" back on.`,
      ...disabled.map((p) => `     (affected profile: ${p.name})`),
    ];
  }
  return [
    `${report.name} has to load the extension once, by hand:`,
    `  1. Open  ${extensionsPageUrl(report)}`,
    `  2. Turn on "Developer mode" (top right).`,
    `  3. Click "Load unpacked" and choose:`,
    `       ${extensionDir}`,
    `It stays loaded across restarts, and browpilot will never ask again.`,
  ];
}

/** The extensions page URL for a browser family (Edge uses its own scheme). */
export function extensionsPageUrl(report: Pick<BrowserReport, 'family'>): string {
  return report.family === 'edge' ? 'edge://extensions' : 'chrome://extensions';
}
