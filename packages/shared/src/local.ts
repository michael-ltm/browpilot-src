export type LocalBrowserFamily = 'chrome' | 'edge' | 'chromium';

export interface LocalBrowserProfile {
  id: string;
  browser: LocalBrowserFamily;
  executable: string;
  userDataDir: string;
  profileDirectory: string;
  label: string;
  extension: { state: 'enabled' | 'disabled' | 'installed' | 'absent' | 'unknown'; id?: string };
  browserId?: string;
  connected: boolean;
}
