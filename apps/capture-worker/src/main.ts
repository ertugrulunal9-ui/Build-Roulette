/**
 * The worker process.
 *
 *   node dist/main.js           run the capture, destroy and takedown loops until SIGINT/SIGTERM
 *   node dist/main.js --once    drain the three queues once, then exit (cron-style runs, tests)
 *
 * Configuration: environment variables, see .env.example. Exit codes: 0 ok, 1 runtime error,
 * 2 configuration error. With `SENTRY_DSN` set, error log lines and a crash are reported to
 * Sentry (reporting.ts); without it nothing is sent.
 */
import { disabledReporter, type ErrorReporter } from '@br/telemetry';
import { loadConfig, describeConfig, ConfigError } from './config';
import { sharpImaging } from './image';
import { createLogger, errorMessage } from './log';
import { PlaywrightRenderer } from './playwright-renderer';
import { reportLogErrors, workerReporter } from './reporting';
import { WorkerRunner } from './runner';
import { SupabaseBackend } from './supabase';

let reporter: ErrorReporter = disabledReporter;

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
  reporter = workerReporter(config.telemetry);
  const log = createLogger({
    level: config.logLevel,
    base: { svc: 'capture-worker' },
    onError: reportLogErrors(reporter),
  });
  const backend = new SupabaseBackend({ url: config.supabaseUrl, serviceKey: config.serviceKey });
  const renderer = new PlaywrightRenderer({ log });
  const runner = new WorkerRunner(
    { backend, renderer, imaging: sharpImaging, capture: config.capture, log },
    config.runner,
  );
  log.info('worker.config', describeConfig(config));

  if (process.argv.includes('--once')) {
    try {
      const captures = await runner.drain('capture');
      const destroys = await runner.drain('destroy');
      const takedowns = await runner.drain('takedown');
      log.info('worker.once_done', {
        captures: captures.length,
        destroys: destroys.length,
        takedowns: takedowns.length,
      });
    } finally {
      await renderer.close();
      await reporter.flush(5_000);
    }
    return 0;
  }

  runner.start();
  log.info('worker.started');
  await new Promise<void>((resolve) => {
    let signals = 0;
    const onSignal = (sig: string) => {
      signals++;
      if (signals > 1) {
        log.warn('worker.forced_exit', { signal: sig });
        process.exit(1);
      }
      log.info('worker.signal', { signal: sig });
      void runner
        .stop()
        .then(() => renderer.close())
        .then(() => reporter.flush(5_000))
        .then(
          () => {
            resolve();
          },
          (e: unknown) => {
            log.error('worker.stop_failed', { error: errorMessage(e) });
            resolve();
          },
        );
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  async (e: unknown) => {
    process.stderr.write(`capture-worker: ${errorMessage(e)}\n`);
    process.exitCode = 1;
    reporter.captureException(e, { level: 'fatal' });
    await reporter.flush(5_000);
  },
);
