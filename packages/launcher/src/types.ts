/** Chromium-family browsers we know how to find and inspect. */
export type BrowserFamily = 'chrome' | 'edge' | 'brave' | 'chromium';

/** One browser installation found on this machine. */
export interface BrowserInstall {
  /** Display name, e.g. "Google Chrome". */
  name: string;
  family: BrowserFamily;
  /** Absolute path to the launchable binary. */
  executablePath: string;
  /** The *root* user data dir (holds Local State + the profile dirs). */
  userDataDir: string;
  /** `<exe> --version` output, or the Application\<version> dir on Windows. */
  version: string | null;
  /**
   * True when `userDataDir` is the browser's stock location. Chrome >= 136
   * refuses `--remote-debugging-port` for the default data dir, which rules out
   * the CDP install path for these — see docs/extension-install.md.
   */
  isDefaultUserDataDir: boolean;
}

/** One browser profile inside a user data dir ("Default", "Profile 1", ...). */
export interface BrowserProfile {
  /** Directory name relative to the user data dir. */
  dir: string;
  /** Human label from Local State's profile.info_cache, else the dir name. */
  name: string;
  /** Absolute path to the profile directory. */
  path: string;
}

/**
 * Chromium's Manifest::Location enum, for the values we can actually observe.
 * UNPACKED (4) is what both "Load unpacked" and CDP Extensions.loadUnpacked
 * record; COMMAND_LINE (8) is the (now defunct) --load-extension path.
 */
export const ManifestLocation = {
  INTERNAL: 1,
  EXTERNAL_PREF: 2,
  EXTERNAL_REGISTRY: 3,
  UNPACKED: 4,
  COMPONENT: 5,
  EXTERNAL_PREF_DOWNLOAD: 6,
  EXTERNAL_POLICY_DOWNLOAD: 7,
  COMMAND_LINE: 8,
  EXTERNAL_POLICY: 9,
  EXTERNAL_COMPONENT: 10,
} as const;

/** Three-state answer to "is our connector extension in this profile?". */
export type ExtensionState = 'enabled' | 'disabled' | 'absent';

/** What a profile's preference files say about one extension id. */
export interface ExtensionStatus {
  state: ExtensionState;
  /** Which preferences file the record came from (null when absent). */
  source: 'Secure Preferences' | 'Preferences' | null;
  /** Manifest::Location value, when recorded. */
  location: number | null;
  /** On-disk directory for unpacked installs; lets us spot a stale dist path. */
  path: string | null;
  /** Raw disable_reasons (modern Chrome) — non-empty means the user turned it off. */
  disableReasons: unknown[];
}

/** A profile plus the extension verdict for it. */
export interface ProfileExtensionStatus extends BrowserProfile {
  extension: ExtensionStatus;
}

/** A browser plus per-profile extension verdicts. */
export interface BrowserReport extends BrowserInstall {
  profiles: ProfileExtensionStatus[];
  /** Set when the user data dir could not be enumerated (permissions, absent). */
  error?: string;
}
