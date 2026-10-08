/**
 * Prints the cost tables of docs/07 from a load-test report:
 *
 *   pnpm --filter @br/loadtest cost path/to/report.json
 */
import { readFileSync } from 'node:fs';
import { ASSUMPTIONS, PRICES, deriveUsage, monthly, quotaLimits } from './cost';
import type { Report } from './report';

const file = process.argv.slice(2).find((a) => a !== '--');
if (!file) {
  process.stderr.write('usage: cost <report.json>\n');
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, 'utf8')) as Report;
const u = deriveUsage(report);
const $ = (n: number) => `$${n.toFixed(2)}`;
const out: string[] = [];

out.push(
  `Report ${report.meta.runId} (${String(report.meta.config.rooms)} rooms × ${String(report.meta.config.players)} players)`,
  '',
);
out.push('## Usage of one real battle', '');
out.push('| Quantity | Per battle | Source |', '|---|---|---|');
out.push(`| Online minutes per player | ${u.onlineMin.toFixed(1)} | assumed timeline |`);
out.push(
  `| Realtime messages | ${Math.round(u.realtimeMessages).toLocaleString('en-US')} | ${u.sources['realtimeMessages'] ?? ''} |`,
);
out.push(
  `| Realtime connection-minutes | ${u.realtimeConnMinutes.toFixed(0)} | players × online minutes |`,
);
out.push(
  `| Supabase egress | ${(u.egressGB * 1000).toFixed(1)} MB | ${u.sources['egressGB'] ?? ''} |`,
);
out.push(
  `| HTTP API calls (Supabase) | ${Math.round(u.apiRequests).toLocaleString('en-US')} | ${u.sources['apiRequests'] ?? ''} |`,
);
out.push(
  `| Screenshot storage added | ${(u.storageGBAdded * 1000).toFixed(2)} MB | assumed size × final builds |`,
);
out.push(
  `| Browser Rendering | ${u.browserSeconds.toFixed(0)} s | ${u.sources['browserSeconds'] ?? ''} |`,
);
out.push(
  `| Worker requests / CPU | ${String(u.workerRequests)} / ${String(u.workerCpuMs)} ms | assumed |`,
);
out.push('');

out.push('## Monthly cost', '');
const volumes = [100, 1000, 10_000, 100_000];
const runs = volumes.map((n) => monthly(u, n));
out.push(`| Item | ${volumes.map((n) => `${n.toLocaleString('en-US')} battles`).join(' | ')} |`);
out.push(`|---|${volumes.map(() => '---').join('|')}|`);
const first = runs[0];
if (first) {
  first.items.forEach((it, i) => {
    out.push(
      `| ${it.item} | ${runs.map((r) => `${$(r.items[i]?.cost ?? 0)} (${r.items[i]?.usage ?? ''})`).join(' | ')} |`,
    );
  });
}
out.push(`| **Total per month** | ${runs.map((r) => `**${$(r.total)}**`).join(' | ')} |`);
out.push(
  `| **Per 1,000 battles (all-in)** | ${runs.map((r, i) => $((r.total / (volumes[i] ?? 1)) * 1000)).join(' | ')} |`,
);
const marginal = (monthly(u, 1_000_000).total - monthly(u, 500_000).total) / 500;
out.push('', `Marginal cost per 1,000 battles once every quota is used up: ${$(marginal)}`, '');

out.push('## Quotas, first exhausted first', '');
out.push('| Quota | Battles per month |', '|---|---|');
for (const q of quotaLimits(u))
  out.push(`| ${q.quota} | ${Math.round(q.battlesPerMonth).toLocaleString('en-US')} |`);
out.push('');
out.push('## Parameters', '');
out.push('| Price / quota | Value | Unit | Note |', '|---|---|---|---|');
for (const [k, p] of Object.entries(PRICES))
  out.push(`| ${k} | ${String(p.value)} | ${p.unit} | ${p.note} |`);
out.push('', '| Assumption | Value | Note |', '|---|---|---|');
for (const [k, a] of Object.entries(ASSUMPTIONS))
  out.push(`| ${k} | ${String(a.value)} | ${a.note} |`);
process.stdout.write(`${out.join('\n')}\n`);
