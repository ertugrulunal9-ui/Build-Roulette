/**
 * Container CPU and memory of the local stack, from `docker stats --no-stream`. One sample
 * takes 1–2 s (docker measures over an interval), so the sampler runs back to back in the
 * background. CPU% is docker's: 100% = one core.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface DockerSample {
  t: number;
  /** By container name (the stack's prefix removed): CPU % and memory MiB. */
  containers: Record<string, { cpu: number; memMiB: number }>;
}

function parseMem(s: string): number {
  const m = /([\d.]+)\s*([KMGT]?i?B)/.exec(s);
  if (!m) return 0;
  const v = Number(m[1]);
  const unit = m[2] ?? 'B';
  const f: Record<string, number> = {
    B: 1 / 1048576,
    KiB: 1 / 1024,
    kB: 1 / 1024,
    MiB: 1,
    MB: 1,
    GiB: 1024,
    GB: 1024,
  };
  return v * (f[unit] ?? 1);
}

export function parseDockerStats(out: string): DockerSample['containers'] {
  const containers: DockerSample['containers'] = {};
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { Name: string; CPUPerc: string; MemUsage: string };
      const name = j.Name.replace(/^supabase_/, '').replace(/_build-roulette$/, '');
      containers[name] = {
        cpu: Number(j.CPUPerc.replace('%', '')) || 0,
        memMiB: Math.round(parseMem(j.MemUsage.split('/')[0] ?? '') * 10) / 10,
      };
    } catch {
      // skip malformed lines
    }
  }
  return containers;
}

export class DockerSampler {
  readonly samples: DockerSample[] = [];
  private stopped = false;
  private loop: Promise<void> | null = null;
  available = true;

  start(): void {
    this.loop = (async () => {
      while (!this.stopped) {
        try {
          const { stdout } = await run(
            'docker',
            ['stats', '--no-stream', '--format', '{{json .}}'],
            {
              timeout: 15_000,
            },
          );
          this.samples.push({ t: Date.now(), containers: parseDockerStats(stdout) });
        } catch {
          this.available = false;
          return;
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}
