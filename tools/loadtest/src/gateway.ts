/**
 * The local stack's API gateway (Kong 2.8, one nginx worker) has no `worker_connections`
 * in its generated nginx.conf, so nginx's default of 512 applies. Every Realtime WebSocket
 * holds two of them (client side + upstream), so the gateway refuses connections
 * ("512 worker_connections are not enough") from about 200–250 simulated clients on:
 * measured in the first full run (docs/07). Hosted Supabase does not run this gateway, so
 * for the load test the limit is raised inside the running container and nginx reloaded
 * (test-only; `supabase stop`/`start` recreates the container with the default).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const KONG = 'supabase_kong_build-roulette';

export async function raiseGatewayConnections(n: number): Promise<string> {
  const script =
    `f=/usr/local/kong/nginx.conf; ` +
    `if grep -q 'worker_connections' $f; then sed -i 's/worker_connections [0-9]*;/worker_connections ${String(n)};/' $f; ` +
    `else sed -i 's/^    multi_accept on;$/    multi_accept on;\\n    worker_connections ${String(n)};/' $f; fi; ` +
    `grep -q 'worker_connections ${String(n)};' $f && nginx -p /usr/local/kong -c nginx.conf -s reload`;
  await run('docker', ['exec', KONG, 'sh', '-c', script], { timeout: 20_000 });
  return `Local API gateway (Kong) worker_connections raised from nginx's default 512 to ${String(n)} for this run (test-only).`;
}
