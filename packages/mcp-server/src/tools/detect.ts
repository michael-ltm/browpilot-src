import { z } from 'zod';
import {
  detectAll,
  describeProfile,
  installExtension,
  manualInstallSteps,
  type BrowserReport,
  type DetectReport,
  type InstallOutcome,
} from '@browpilot/launcher';
import { defineTool, textResult, type ToolDef, type ToolResult } from './types.js';
import type { ToolContext } from '../context.js';

/** Everything the detect tools need from the session, or an explanation why not. */
function requirements(ctx: ToolContext): { extensionId: string; extensionDir: string } | string {
  if (!ctx.extensionId) return 'browpilot has no pinned extension id (is ~/.browpilot/config.json present?)';
  if (!ctx.extensionDir) return 'the bundled extension directory could not be located next to this MCP server';
  return { extensionId: ctx.extensionId, extensionDir: ctx.extensionDir };
}

function renderReport(report: DetectReport, index: number): string {
  const lines = [
    `[${index}] ${report.name} ${report.version ?? '(version unknown)'}`,
    `    binary:   ${report.executablePath}`,
    `    profiles: ${report.userDataDir}${report.isDefaultUserDataDir ? ' (default)' : ' (custom)'}`,
    `    running:  ${report.running.length > 0 ? report.running.map((p) => p.pid).join(', ') : 'no'}`,
    `    verdict:  ${report.verdict.path} — ${report.verdict.reason}`,
  ];
  if (report.error) lines.push(`    error:    ${report.error}`);
  for (const profile of report.profiles) lines.push(`      ${describeProfile(profile)}`);
  return lines.join('\n');
}

/**
 * The browser_detect body. The index in front of each entry is what
 * browser_install_extension takes, so the two tools stay in step.
 */
export function renderDetectReports(reports: DetectReport[], extensionDir: string): string {
  const body = reports.map(renderReport).join('\n');
  const installed = reports.filter((r) => r.verdict.installed);
  const footer =
    installed.length > 0
      ? `\n\nThe extension is already loaded in ${installed.length} of ${reports.length} entries — nothing to install there.`
      : `\n\nNo profile has the extension yet. Extension directory to load:\n  ${extensionDir}`;
  return `${body}${footer}`;
}

/** Turn an install outcome into agent-facing text; isError marks a dead end. */
export function renderInstallOutcome(
  target: BrowserReport,
  outcome: InstallOutcome,
  extensionDir: string,
): ToolResult {
  switch (outcome.kind) {
    case 'already-installed':
      return textResult(`${target.name}: nothing to do — ${outcome.detail}`);
    case 'manual':
      return textResult([`${target.name}: ${outcome.detail}`, '', ...outcome.steps].join('\n'));
    case 'loaded':
      return textResult(
        [
          `${target.name} restarted on ${target.userDataDir} and loaded ${outcome.extensionId}.`,
          'It should connect to the broker within a few seconds — check browser_list_profiles.',
          '',
          'This load lasts only for the current browser session. To make it permanent:',
          ...manualInstallSteps(target, extensionDir).slice(1),
        ].join('\n'),
      );
    default:
      return {
        ...textResult([`${target.name}: ${outcome.error}`, '', ...outcome.steps].join('\n')),
        isError: true,
      };
  }
}

const browser_detect = defineTool({
  name: 'browser_detect',
  description:
    'List the Chromium-family browsers installed on this machine and, for each profile, whether the browpilot ' +
    'extension is installed, enabled or missing. Read-only: it never starts, closes or changes a browser. Use it ' +
    'before browser_install_extension, and whenever the browser tools report no connected profile.',
  inputSchema: {
    family: z.enum(['chrome', 'edge', 'brave', 'chromium']).optional(),
  },
  async handler({ family }, ctx): Promise<ToolResult> {
    const needs = requirements(ctx);
    if (typeof needs === 'string') return { ...textResult(needs), isError: true };

    const reports = detectAll(needs.extensionId).filter((r) => !family || r.family === family);
    if (reports.length === 0) {
      return textResult(
        family
          ? `no ${family} installation found on this machine`
          : 'no Chromium-family browser found on this machine (browpilot needs Chrome, Edge, Brave or Chromium)',
      );
    }
    return textResult(renderDetectReports(reports, needs.extensionDir));
  },
});

/** Controlled-relaunch install for one detect entry, chosen by index/family or by user data dir. */
export async function launcherInstall(
  ctx: ToolContext,
  pick: { index?: number; family?: BrowserReport['family']; userDataDir?: string },
  opts: { profileDirectory?: string; allowRestart?: boolean },
): Promise<ToolResult> {
  const needs = requirements(ctx);
  if (typeof needs === 'string') return { ...textResult(needs), isError: true };

  const reports = detectAll(needs.extensionId);
  const target =
    pick.userDataDir !== undefined
      ? reports.find((r) => samePath(r.userDataDir, pick.userDataDir!))
      : pick.index !== undefined
        ? reports[pick.index]
        : reports.find((r) => !pick.family || r.family === pick.family);
  if (!target) {
    const what = pick.userDataDir ?? (pick.index !== undefined ? `index ${pick.index}` : (pick.family ?? 'any browser'));
    return { ...textResult(`no browser matched ${what}; run browser_detect first`), isError: true };
  }

  const outcome = await installExtension(target, {
    extensionDir: needs.extensionDir,
    ...(opts.profileDirectory ? { profileDirectory: opts.profileDirectory } : {}),
    ...(opts.allowRestart !== undefined ? { allowRestart: opts.allowRestart } : {}),
  });
  return renderInstallOutcome(target, outcome, needs.extensionDir);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

export const detectTools: ToolDef[] = [browser_detect] as unknown as ToolDef[];
