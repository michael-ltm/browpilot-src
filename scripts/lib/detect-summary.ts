import { describeProfile, manualInstallSteps, type DetectReport } from '@claude-browser/launcher';

/**
 * Render the installer's detect-first summary.
 *
 * The installer is non-interactive, so it never closes anyone's browser: it
 * reports what it found and, when the extension is missing, prints the one
 * manual step that is left. `browser_install_extension` is the interactive
 * counterpart that can actually relaunch.
 */
export function summarizeDetection(reports: DetectReport[], extensionDist: string): string[] {
  if (reports.length === 0) {
    return [
      'No Chromium-family browser was found on this machine.',
      'claude-browser needs Chrome, Edge, Brave or Chromium.',
    ];
  }

  const ready = reports.filter((r) => r.verdict.installed);
  const lines: string[] = [];

  for (const report of reports) {
    const where = `${report.name} — ${report.userDataDir}`;
    lines.push(report.verdict.installed ? `  [ok]    ${where}` : `  [todo]  ${where}`);
    for (const profile of report.profiles) lines.push(`            ${describeProfile(profile)}`);
  }

  if (ready.length > 0) {
    lines.push('', `The extension is already loaded — nothing else to do.`);
    return lines;
  }

  const target = reports[0];
  lines.push('', ...(target ? manualInstallSteps(target, extensionDist) : []));
  lines.push('', 'Or, from a Claude Code session: run browser_detect, then browser_install_extension.');
  return lines;
}
