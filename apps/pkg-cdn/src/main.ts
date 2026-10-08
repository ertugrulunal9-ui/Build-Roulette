/**
 * Entry point: `pnpm --filter @br/pkg-cdn dev` (tsx) or `start` (after `build`).
 * Configuration: see ENV_DOCS in ./config.ts and the README. With `SENTRY_DSN` set, the
 * server's own 500/502 failures and a crash are reported to Sentry (reporting.ts).
 */
import { loadConfig } from './config';
import { cdnReporter, reportServerErrors } from './reporting';
import { startCdnServer } from './server';

const reporter = cdnReporter();
const crash = (e: unknown) => {
  console.error(e);
  reporter.captureException(e, { level: 'fatal' });
  void reporter.flush(5_000).finally(() => process.exit(1));
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

const config = loadConfig();
const server = await startCdnServer(config, {
  log: (line) => {
    console.log(line);
  },
  onServerError: reportServerErrors(reporter),
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
console.log(
  `  errors   ${reporter.enabled ? 'reported to Sentry' : 'not reported (no SENTRY_DSN)'}`,
);

const stop = () => {
  void server
    .close()
    .then(() => reporter.flush(5_000))
    .then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
