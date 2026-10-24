import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR } from '@browpilot/shared';

export const LAUNCHD_LABEL = 'com.browpilot.broker';

export interface LaunchdOptions {
  nodePath: string;
  scriptPath: string;
  label?: string;
  home?: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Render a launchd plist string for the always-on broker daemon. */
export function renderLaunchdPlist(opts: LaunchdOptions): string {
  const label = opts.label ?? LAUNCHD_LABEL;
  const home = opts.home ?? homedir();
  const logDir = join(home, CONFIG_DIR);
  const stdout = join(logDir, 'broker.out.log');
  const stderr = join(logDir, 'broker.err.log');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(opts.nodePath)}</string>
    <string>${xmlEscape(opts.scriptPath)}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderr)}</string>
</dict>
</plist>
`;
}
