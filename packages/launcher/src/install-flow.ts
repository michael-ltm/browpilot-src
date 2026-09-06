import { buildLaunchFlags, loadExtensionFlagSupported, manualInstallSteps } from './launch.js';
import {
  loadUnpackedOverCdp,
  nodeProcessControl,
  quitProcesses,
  waitForDevTools,
  type ProcessControl,
} from './relaunch.js';
import type { DetectReport } from './report.js';

export type InstallOutcome =
  /** Nothing to do — the extension is already enabled. */
  | { kind: 'already-installed'; detail: string }
  /** No automated path exists; the user has to load it once themselves. */
  | { kind: 'manual'; steps: string[]; detail: string }
  /** The browser was relaunched and the extension loaded over CDP. */
  | { kind: 'loaded'; pid: number | null; port: number; extensionId: string; ephemeral: true }
  /** The automated path was attempted and failed; fall back to the steps. */
  | { kind: 'failed'; error: string; steps: string[] };

export interface InstallOptions {
  /** Absolute path to the unpacked extension directory. */
  extensionDir: string;
  /** Profile directory to open; defaults to whatever the browser reopens. */
  profileDirectory?: string;
  /** Set false to refuse closing a running browser (report and stop instead). */
  allowRestart?: boolean;
  /** Extra command-line flags for the relaunch. */
  extraFlags?: string[];
}

/**
 * Bring one browser to the point where our extension is loaded.
 *
 * Detect-first: an already-enabled extension short-circuits before anything is
 * closed or started. Only the `cdp-load` verdict relaunches, and only after the
 * caller has opted in via `allowRestart` — quitting someone's browser is not
 * something to do behind their back.
 */
export async function installExtension(
  report: DetectReport,
  opts: InstallOptions,
  ctrl: ProcessControl = nodeProcessControl(),
): Promise<InstallOutcome> {
  if (report.verdict.path === 'already-installed') {
    return { kind: 'already-installed', detail: report.verdict.reason };
  }
  const steps = manualInstallSteps(report, opts.extensionDir);
  if (report.verdict.path === 'manual-only') {
    return { kind: 'manual', steps, detail: report.verdict.reason };
  }
  if (report.running.length > 0 && opts.allowRestart !== true) {
    return {
      kind: 'failed',
      error:
        `${report.name} is running on ${report.userDataDir} and has to be closed to load the ` +
        `extension. Re-run with restart allowed, or follow the manual steps.`,
      steps,
    };
  }

  if (report.running.length > 0) {
    await quitProcesses(
      report.running.map((p) => p.pid),
      ctrl,
    );
  }

  const port = await ctrl.freePort();
  const flags = buildLaunchFlags({
    extensionDir: opts.extensionDir,
    userDataDir: report.userDataDir,
    ...(opts.profileDirectory ? { profileDirectory: opts.profileDirectory } : {}),
    remoteDebuggingPort: port,
    useLoadExtensionFlag: loadExtensionFlagSupported(report.version),
    ...(opts.extraFlags ? { extraFlags: opts.extraFlags } : {}),
  });
  const pid = ctrl.spawnDetached(report.executablePath, flags);

  const wsUrl = await waitForDevTools(port, ctrl);
  if (!wsUrl) {
    return {
      kind: 'failed',
      error: `${report.name} restarted but never opened its DevTools endpoint on port ${port}.`,
      steps,
    };
  }

  const loaded = await loadUnpackedOverCdp(wsUrl, opts.extensionDir, ctrl);
  if (!loaded.ok) return { kind: 'failed', error: loaded.error, steps };
  // Chrome drops a CDP-loaded extension when the browser exits, so this is not
  // an install in the way "Load unpacked" is; say so rather than implying it.
  return { kind: 'loaded', pid, port, extensionId: loaded.extensionId, ephemeral: true };
}
