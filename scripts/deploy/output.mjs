// Output of the deploy (T-042): log lines, GitHub Actions workflow commands, the job summary.
//
// Secrets: `addSecret(value)` registers a value before anything can print it. On GitHub
// Actions it emits `::add-mask::<value>` at once (the runner then hides the value in every
// later log line, including the child processes' output); everywhere, `redact()` replaces it
// with `***` in everything this module writes: log lines, annotations, the summary, and the
// child processes' output that the runner pipes through it.

/** GitHub's escaping of a workflow command's data (what @actions/core does). */
export function escapeData(s) {
  return String(s).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * @param {object} io
 * @param {(s: string) => void} io.stdout
 * @param {(s: string) => void} io.stderr
 * @param {boolean} io.github         running on GitHub Actions (GITHUB_ACTIONS=true)
 * @param {(path: string, text: string) => void} io.appendFile
 * @param {string | undefined} io.summaryPath  $GITHUB_STEP_SUMMARY
 * @param {string | undefined} io.outputPath   $GITHUB_OUTPUT
 */
export function createOutput({ stdout, stderr, github, appendFile, summaryPath, outputPath }) {
  const secrets = new Set();
  let sorted = [];

  const redact = (text) => {
    let s = String(text);
    for (const v of sorted) s = s.split(v).join('***');
    return s;
  };

  const out = {
    github,
    /** Registers a secret value; idempotent. Values shorter than 4 characters are refused. */
    addSecret(value) {
      if (typeof value !== 'string' || value === '' || secrets.has(value)) return;
      if (value.length < 4)
        throw new Error('refusing to register a secret shorter than 4 characters');
      secrets.add(value);
      sorted = [...secrets].sort((a, b) => b.length - a.length);
      if (github) stdout(`::add-mask::${escapeData(value)}\n`);
    },
    redact,
    /** Is any registered secret in this text? (tests, and a last guard before writing) */
    leaks(text) {
      return sorted.some((v) => String(text).includes(v));
    },
    log(line = '') {
      stdout(`${redact(line)}\n`);
    },
    /** Child process output (already line-split by the runner). */
    passthrough(chunk, stream = 'stdout') {
      (stream === 'stderr' ? stderr : stdout)(redact(chunk));
    },
    notice(title, message) {
      if (github)
        stdout(`::notice title=${escapeData(redact(title))}::${escapeData(redact(message))}\n`);
      else stdout(`NOTICE  ${redact(title)}: ${redact(message)}\n`);
    },
    warn(title, message) {
      if (github)
        stdout(`::warning title=${escapeData(redact(title))}::${escapeData(redact(message))}\n`);
      else stderr(`WARNING ${redact(title)}: ${redact(message)}\n`);
    },
    error(title, message) {
      if (github)
        stdout(`::error title=${escapeData(redact(title))}::${escapeData(redact(message))}\n`);
      else stderr(`ERROR   ${redact(title)}: ${redact(message)}\n`);
    },
    group(title) {
      if (github) stdout(`::group::${escapeData(redact(title))}\n`);
      else stdout(`\n== ${redact(title)} ==\n`);
    },
    endGroup() {
      if (github) stdout('::endgroup::\n');
    },
    /** Appends Markdown to the job summary (GitHub Actions only). */
    summary(markdown) {
      if (summaryPath) appendFile(summaryPath, `${redact(markdown)}\n`);
    },
    /** A step output (`steps.<id>.outputs.<name>`); single-line values only. */
    setOutput(name, value) {
      if (!outputPath) return;
      const v = redact(value);
      if (/[\r\n]/.test(v)) throw new Error(`step output ${name} must be one line`);
      appendFile(outputPath, `${name}=${v}\n`);
    },
  };
  return out;
}
