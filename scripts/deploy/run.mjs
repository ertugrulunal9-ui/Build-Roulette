// Runs the deploy's commands (T-042): the Supabase CLI, pnpm builds, wrangler, deploy-check.
// No shell: the program and its arguments are passed as an array. The child's output is
// piped through the output's redaction, line by line, so a registered secret never reaches
// the log even outside GitHub Actions (where ::add-mask:: does it too).

import { spawn } from 'node:child_process';

const KEEP = 16_384; // the tail of stderr kept for an error message

/**
 * @param {ReturnType<import('./output.mjs').createOutput>} out
 * @returns {(cmd: string, args: string[], opts?: {env?: object, cwd?: string, input?: string, capture?: boolean}) => Promise<{code: number, stdout: string, stderr: string}>}
 */
export function createRunner(out) {
  return (cmd, args, { env, cwd, input, capture = false } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const pipe = (stream, name) => {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          if (name === 'stdout' && capture) {
            stdout += chunk;
            return;
          }
          if (name === 'stderr') stderr = (stderr + chunk).slice(-KEEP);
          pending += chunk;
          const end = pending.lastIndexOf('\n');
          if (end >= 0) {
            out.passthrough(pending.slice(0, end + 1), name);
            pending = pending.slice(end + 1);
          }
        });
        stream.on('end', () => {
          if (pending) out.passthrough(`${pending}\n`, name);
        });
      };
      pipe(child.stdout, 'stdout');
      pipe(child.stderr, 'stderr');
      child.on('error', reject);
      child.on('close', (code, signal) =>
        resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }),
      );
      child.stdin.on('error', () => {}); // a child that never reads stdin
      child.stdin.end(input ?? '');
    });
}
