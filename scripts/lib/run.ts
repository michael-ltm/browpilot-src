import { execFile } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  /** When true, a non-zero exit resolves (with the code) instead of rejecting. */
  allowFailure?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Promise wrapper over execFile that captures output and respects allowFailure. */
export function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
          ? ((err as unknown as { code: number }).code)
          : err
            ? 1
            : 0;
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Command not found: ${cmd}`));
        return;
      }
      const result: RunResult = { code, stdout: stdout ?? '', stderr: stderr ?? '' };
      if (err && !opts.allowFailure) {
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(result);
    });
  });
}
