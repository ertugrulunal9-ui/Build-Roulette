/**
 * Entry point: `pnpm --filter @br/pkg-cdn dev` (tsx) or `start` (after `build`).
 * Configuration: see ENV_DOCS in ./config.ts and the README.
 */
import { loadConfig } from './config';
import { startCdnServer } from './server';

const config = loadConfig();
const server = await startCdnServer(config, {
  log: (line) => {
    console.log(line);
  },
});
console.log(`@br/pkg-cdn listening on ${server.url}`);
console.log(`  registry ${config.registryUrl}`);
console.log(
  `  cache    ${config.cacheDir} (${(server.cdn.index.bytes / 1048576).toFixed(0)} MB of ${config.cacheQuotaBytes > 0 ? `${(config.cacheQuotaBytes / 1048576).toFixed(0)} MB` : 'unlimited'})`,
);
console.log(
  `  limits   ${config.fetches.concurrent.toString()} fetches, ${config.extractions.concurrent.toString()} extractions, ${config.builds.concurrent.toString()} builds; request timeout ${config.requestTimeoutMs.toString()} ms`,
);
console.log(
  `  denylist ${config.denylistFile ?? 'none'} (${server.cdn.denylist.size.toString()} packages)`,
);

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
