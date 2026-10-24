/**
 * The English catalog (T-050): every player-facing word of the web app. English is the
 * default and the source of truth: the Turkish catalog (tr.ts) is typed as `Messages`, so
 * TypeScript refuses a missing or an extra key, and a function must take the same arguments.
 *
 * Conventions (README "Languages"):
 * - Backticks mark code (`CodeText` / `Rich` render them as `<code>`).
 * - `**bold**` and `{slot}` are for `Rich` (components/i18n/Rich.tsx): a slot is filled with a
 *   React node (a name, a time), never parsed as markup.
 * - Plurals and interpolation are functions (`files: (n) => …`).
 * - Numbers come from the game's own limits (`@br/game`, `@br/site`), never typed in twice.
 *
 * Not here (README "What stays English"): server content (challenge cards, names), the
 * sandbox console, `/admin`, link previews, telemetry event names.
 */
import {
  BUILD_TIME_LIMITS_MINUTES,
  PHASE_LABELS,
  REPORT_REASON_LABELS,
  ROOM_LIMITS,
  VOTE_CATEGORIES,
  type BattlePhase,
  type BuildStatus,
  type CaptureStatus,
  type CastVoteError,
  type ReportReason,
  type VoteCategory,
} from '@br/game';
import { IMPORT_URL_HOSTS, SITE_LIMITS, describeImportError, type ImportErrorCode } from '@br/site';
import type { LinkErrorCode } from '../../site/link-import';
import { BATTLE_TITLE_EN } from '../../solo/battle-meta';
import type { ErrorCode } from '../../solo/errors';
import {
  AUTO_AWARDS_EN,
  CAPTURE_TEXT,
  MINUTES_EN,
  MOST_VOTES_EN,
  SECONDS_EN,
  STATUS_TEXT,
} from '../../solo/format';

const MIN_MINUTES = Math.min(...BUILD_TIME_LIMITS_MINUTES);
const MAX_MINUTES = Math.max(...BUILD_TIME_LIMITS_MINUTES);
const MAX_MB = Math.round(SITE_LIMITS.maxPackBytes / (1024 * 1024));
const MAX_FILES = SITE_LIMITS.maxFiles;

const s = String;
const plural = (n: number, one: string, many: string) => `${s(n)} ${n === 1 ? one : many}`;

/** One title and hint per import error, from `@br/site` (its English is the source). */
const IMPORT_ERROR_CODES = [
  'empty',
  'no-index',
  'not-built',
  'nextjs-not-exported',
  'too-many-files',
  'too-large',
  'path-too-long',
  'bad-zip',
  'too-many-entries',
  'read-failed',
] as const satisfies readonly ImportErrorCode[];

type ImportErrorText = (detail?: string) => { title: string; hint: string };

const importErrors = Object.fromEntries(
  IMPORT_ERROR_CODES.map((code): [ImportErrorCode, ImportErrorText] => [
    code,
    (detail) => describeImportError(detail === undefined ? { code } : { code, detail }),
  ]),
) as Record<ImportErrorCode, ImportErrorText>;

/** `*.lovable.app, *.netlify.app, …`: the hosts a link may be on (`@br/site`). */
const LINK_HOSTS = IMPORT_URL_HOSTS.map((h) => `*.${h}`).join(', ');

/** A wait in seconds as people say it: `45 s`, `3 min`. */
const waitEn = (seconds: number) =>
  seconds <= 90 ? `${s(seconds)} s` : `${s(Math.ceil(seconds / 60))} min`;

/** A status code worth showing (`404`), from a copy error's detail. */
const statusOf = (detail?: string) => (detail && /^\d{3}$/.test(detail) ? detail : null);

/** What went wrong with the server itself: the same words for each such code. */
const serverDown = () => ({
  title: "Couldn't reach the game's server",
  hint: 'Check your connection and try again in a moment, or drop the built folder instead.',
});

/**
 * One title and what to do per link error (docs/10): the copy's codes (`@br/site`), the
 * `import-url` function's own and `network`. Typed by `LinkErrorCode`, so a new code fails
 * to compile until it is worded here and in tr.ts.
 */
const linkErrors: Record<LinkErrorCode, (detail?: string) => { title: string; hint: string }> = {
  'url-invalid': () => ({
    title: "That link can't be used",
    hint: 'Paste the full address of your published site, starting with https://, like `https://my-app.lovable.app`.',
  }),
  'url-host-not-allowed': () => ({
    title: "That site's host isn't supported",
    hint: `Links work for sites published on ${LINK_HOSTS}. Publish it there and paste that link, or download the code, build it and drop the \`dist\` folder.`,
  }),
  'url-unreachable': (detail) => {
    const status = statusOf(detail);
    return {
      title: "That site couldn't be loaded",
      hint: `${status ? `It answered ${status}. ` : ''}Check that the link opens in your browser and that the site is published, then try again.`,
    };
  },
  'url-not-html': () => ({
    title: "That link isn't a web page",
    hint: 'Paste the link of the published site itself (the page that opens in your browser), not a file or an API.',
  }),
  'url-private': () => ({
    title: 'That site is private',
    hint: 'Make the site public in your builder and publish again, then paste the link.',
  }),
  'url-timeout': () => ({
    title: 'The site took too long',
    hint: 'It answered too slowly to copy in time. Try again in a moment, or drop the built folder instead.',
  }),
  'rate-limited': (detail) => {
    const seconds = Number(detail);
    return {
      title: 'Too many imports',
      hint:
        Number.isFinite(seconds) && seconds > 0
          ? `Try again in ${waitEn(Math.ceil(seconds))}, or drop the built folder instead.`
          : 'Try again in a few minutes, or drop the built folder instead.',
    };
  },
  'too-large': () => ({
    title: 'The site is too large',
    hint: `A site can be at most ${s(MAX_MB)} MB. Shrink big images, videos or fonts, publish again and paste the link.`,
  }),
  'too-many-files': () => ({
    title: 'Too many files',
    hint: `A site can have at most ${s(MAX_FILES)} files. Publish a smaller site, or download the code, build it and drop the \`dist\` folder.`,
  }),
  unauthenticated: serverDown,
  'origin-not-allowed': serverDown,
  'method-not-allowed': serverDown,
  internal: serverDown,
  network: serverDown,
};

const phases: Record<BattlePhase, string> = { ...PHASE_LABELS };

const voteCategories = Object.fromEntries(
  VOTE_CATEGORIES.map((c) => [c.slug, { label: c.label, description: c.description }]),
) as Record<VoteCategory, { label: string; description: string }>;

const reportReasons: Record<ReportReason, { label: string; hint: string }> = {
  ...REPORT_REASON_LABELS,
};

const errors: Record<ErrorCode, string> = {
  not_authenticated: 'Your session has expired. Reload the page to sign in again.',
  not_on_roster: 'You are not a player in this battle.',
  not_a_member: 'You are not in this room anymore. Join it again first.',
  not_a_player: 'Spectators cannot do that. Wait for a free player slot.',
  not_host: 'Only the host can do that.',
  kicked: 'The host removed you from this room. You cannot rejoin it.',
  battle_not_found: 'This battle does not exist, or it is not yours.',
  room_not_found: 'No room has this code. Check it, or create a new room.',
  member_not_found: 'That player is no longer in the room.',
  invalid_time_limit: 'That time limit is not allowed.',
  invalid_display_name: 'Your name must be 1 to 24 characters.',
  invalid_name: 'The build name must be 1 to 48 characters.',
  invalid_stats: 'The server rejected the build stats. This is a bug; shipping without them.',
  stats_too_large: 'The server rejected the build stats. This is a bug; shipping without them.',
  invalid_version: 'The game got out of sync. Reload the page.',
  invalid_ready: 'Ready must be on or off.',
  invalid_settings: 'Those room settings are not allowed.',
  wrong_phase: 'Too late: the battle has already moved on.',
  wrong_room_state: 'Not now: a battle is running in this room.',
  deadline_passed: 'Time is up: the deadline and its grace period are over.',
  already_shipped: 'Already shipped. Ship is final.',
  disqualified: 'Your build was disqualified.',
  files_missing: 'The upload did not finish. Try shipping again.',
  battle_in_progress: 'You already have a battle running.',
  deck_empty: 'No challenge cards are available right now. Try again in a moment.',
  room_closed: 'This room is closed. Create a new one to play again.',
  room_full: 'This room is full: every player and spectator slot is taken.',
  room_busy: 'The room is busy right now. Try again in a moment.',
  too_many_rooms: 'You already host 3 open rooms. Leave one of them first.',
  not_enough_players: 'At least 2 players must be ready (and online) to start.',
  cannot_kick_self: 'You cannot kick yourself. Leave the room instead.',
  not_implemented: 'That is not available yet.',
  not_a_voter: 'You cannot vote in this battle.',
  build_not_found: 'That build is not part of this battle.',
  invalid_category: 'That vote category does not exist.',
  self_vote: 'You cannot vote for your own build.',
  not_votable: 'That build cannot get votes: it was not shipped.',
  name_not_allowed: 'That name is not allowed here. Pick another one.',
  invalid_reason: 'Pick a reason for the report.',
  invalid_details: 'The details are too long (500 characters at most).',
  own_build: 'You cannot report your own build.',
  already_reported: 'You already reported this build. Thanks, a moderator will look at it.',
  upload_refused: 'The server refused the upload: the deadline may have passed.',
  file_too_large: 'Your site is over the 5 MB limit. Shrink big images, videos or fonts.',
  nothing_built: 'Import your built site first, then ship it.',
  network: 'Cannot reach the server. Check your connection and try again.',
  rate_limited: 'Too many requests right now. Wait a few minutes and try again.',
  unknown: 'Something went wrong. Try again.',
};

const voteErrors: Record<CastVoteError, string> = {
  battle_not_found: 'This battle is gone. Reload the page.',
  not_on_roster: 'Only the players of this battle vote. Spectators watch the results.',
  kicked: 'The host removed you from this room, so you cannot vote.',
  not_a_member: 'You left the room. Join it again to vote before the time is up.',
  not_a_voter: 'You cannot vote in this battle.',
  wrong_phase: 'Voting is over: the results are in.',
  deadline_passed: 'Too late: voting just closed.',
  invalid_category: 'That vote category does not exist any more. Reload the page.',
  build_not_found: 'That build is not part of this battle.',
  self_vote: 'Nice try: you cannot vote for your own build.',
  not_votable: 'That build cannot get votes: it was not shipped.',
};

// The words the link-preview Worker needs too live next to their code (lib/solo/format.ts,
// battle-meta.ts), which does not load the catalogs.
const status: Record<BuildStatus, string> = { ...STATUS_TEXT };
const capture: Record<CaptureStatus, string> = { ...CAPTURE_TEXT };

export const en = {
  language: {
    label: 'Language',
  },

  common: {
    dismiss: 'Dismiss',
    tryAgain: 'Try again',
    cancel: 'Cancel',
    close: 'Close',
    ok: 'OK',
    home: 'Home',
    loading: 'Loading…',
    loadingBattle: 'Loading the battle…',
    you: '(you)',
    someone: 'Someone',
    host: 'Host',
    newTab: '(opens in a new tab)',
    howItWorks: 'How it works',
    yourName: 'Your name',
    anotherName: 'Another random name',
    myHistory: 'Your battle history',
    by: (name: string) => `by ${name}`,
    /** The name of a build that has none (an auto-shipped autosave). */
    buildOf: (name: string) => `${name}'s build`,
    screenshotOf: (name: string) => `Screenshot of ${name}`,
    theBuild: 'the build',
    didNotFinish: 'Did not finish',
    fullResults: 'Full results →',
    winner: '🏆 Winner',
    roomCode: (code: string) => `Room ${code}`,
    /** A link that names a build for people, e.g. in the report dialog. */
    buildLabel: (name: string | null, builder: string) =>
      `${name ? `“${name}”` : 'A build'} by ${builder}`,
  },

  /** `document.title` of the pages whose static metadata is English (README). */
  titles: {
    play: 'Play solo',
    try: 'Try an import',
    guide: 'How it works',
    notFound: 'Page not found',
  },

  units: {
    minutes: MINUTES_EN,
    seconds: SECONDS_EN,
    files: (n: number) => plural(n, 'file', 'files'),
    /** "10, 15 or 20". */
    orList: (items: readonly string[]) => items.join(', ').replace(/, ([^,]+)$/, ' or $1'),
    andList: (items: readonly string[]) =>
      items.length <= 1
        ? (items[0] ?? '')
        : `${items.slice(0, -1).join(', ')} and ${s(items.at(-1))}`,
  },

  phases,

  cards: {
    build: 'BUILD',
    rule: 'RULE',
    style: 'STYLE',
    timeLimit: 'TIME LIMIT',
    timeLimitSr: (t: string) => `Time limit: ${t}`,
  },

  home: {
    title: 'Build Roulette',
    pitch: 'A party game for vibe coders: same challenge, your own AI tools, different builds.',
    tryImport: 'Try an import',
    stepsTitle: 'How a battle works',
    phasesLabel: 'The phases of a battle',
    guide: 'Read the full guide',
    tagline: 'Builds are temporary. Results are permanent.',
    roomsAndSolo: `Create a room and send the link to up to ${s(ROOM_LIMITS.max_players - 1)} friends (and ${s(ROOM_LIMITS.max_spectators)} spectators), or race the clock on your own. No account needed.`,
    playSolo: 'Play solo',
    createRoom: 'Create room',
    joinWithCode: 'Join with code',
    creating: 'Creating…',
    create: 'Create',
    roomCode: 'Room code',
    join: 'Join',
    codeError: 'A room code has 5 letters and digits, like K7QXM.',
  },

  steps: {
    spin: {
      title: 'Spin',
      text: `Everyone in the room gets the same random BUILD, RULE, STYLE and TIME LIMIT (${s(MIN_MINUTES)} to ${s(MAX_MINUTES)} minutes).`,
    },
    build: {
      title: 'Build it your way',
      text: "Use your own AI tool on your own computer: Cursor, Claude Code, Windsurf, Copilot, Lovable, Bolt, v0… or plain HTML. Your prompts, your tricks. That's the game.",
    },
    drop: {
      title: 'Build & drop',
      text: "Run your project's build (`npm run build`), then drop the `dist` folder (or a .zip) into the game, or paste your published link. Import again as often as you like; the last import before time runs out counts.",
    },
    ship: {
      title: 'Ship, reveal, vote',
      text: "Ship it. Everyone's builds are revealed one by one, you vote, and the results stay forever. The builds themselves are deleted after the battle.",
    },
  },

  stepArt: {
    timeLabel: 'TIME',
    terminalResult: '✓ built in dist/',
    dropTarget: 'Drop `dist` here',
    ship: 'Ship',
    reveal: 'Reveal',
    vote: 'Vote',
    results: 'Results',
    endNote: 'Builds deleted · results stay',
  },

  welcome: {
    /** `{brand}`: the game's name (kept in English capitals under `lang="en"`). */
    title: 'Welcome to {brand}',
    stepOf: (n: number, total: number) => `Step ${s(n)} of ${s(total)}`,
    steps: 'Steps',
    goToStep: (n: number) => `Go to step ${s(n)}`,
    next: 'Next',
    back: 'Back',
    skip: 'Skip',
    practice: 'Practice first',
    play: "Let's play",
    guide: 'Read the full guide',
  },

  lobbyHints: {
    newHereTitle: 'New here?',
    newHereText:
      'See how a battle works in four short steps, then practice an import before the host spins.',
    newHereShow: 'Show me',
    newHerePractice: 'Practice an import',
    reminder:
      "You'll build on your computer with your own AI tool. Have it open before the host spins.",
  },

  phone: {
    guideText: 'On this phone you watch and vote. Next time, join from a computer to build.',
    guideLink: 'How the game works',
  },

  importHelp: {
    summary: 'How do I import?',
    steps: [
      'Ask your AI tool to "run the production build" (or run `npm run build` yourself).',
      'Drop the folder the build wrote here, or press Choose folder. A .zip works too.',
      'Changed something? Build again and drop again: the last drop counts.',
    ],
    link: 'Built in Lovable, Bolt, v0 or Replit? Publish it, copy its public link and paste it under the drop zone. Published again? Import the same link again.',
    whereTitle: 'Where is my build?',
    where: [
      'Vite (React, Vue, Svelte…) → `dist`',
      'Create React App → `build`',
      "Next.js → `out` (needs `output: 'export'`)",
      'Plain HTML → the folder itself',
    ],
    webBuildersTitle: 'Lovable, Bolt, v0?',
    webBuilders:
      'Paste the published link. No public link? Download the project as a .zip, unzip it, run `npm install` and `npm run build` in that folder, then drop `dist`.',
    guide: 'Full guide',
    howToFix: 'How do I fix this?',
  },

  guide: {
    title: 'How Build Roulette works',
    intro:
      'Everyone gets the same random challenge. You build it on your own computer with your own AI tools, run the build, and drop the result into the game. Then everyone sees everyone’s build and votes.',
    home: 'Home',
    play: 'Play solo',
    practice: 'Try an import',
    contents: 'On this page',

    oneMinuteTitle: 'The game in one minute',

    rulesTitle: 'The rules for your site',
    rules: [
      'It is a static site that runs in the browser: HTML, CSS, JavaScript, images, fonts, audio.',
      'It may call public APIs and load scripts from CDNs.',
      'No server of its own and no secrets. Never put API keys in it: everyone can see the built site.',
      `At most ${s(MAX_MB)} MB and ${s(MAX_FILES)} files.`,
      `The TIME LIMIT card gives you ${s(MIN_MINUTES)} to ${s(MAX_MINUTES)} minutes.`,
      "Drop as often as you want. The last import counts, and it is shipped for you at the deadline if you didn't ship.",
    ],

    checklistTitle: 'Before your first battle',
    checklist: {
      tool: 'Your AI tool is installed and signed in.',
      folder: 'An empty folder for the new project.',
      node: 'Node.js installed, if your tool makes an npm project (most do):',
      practice: 'Practice one import:',
    },

    toolsTitle: 'Tool guides',
    toolsIntro: 'Pick the kind of tool you use.',
    toolsLabel: 'Kind of tool',
    tools: {
      editor: {
        tab: 'Editor agents',
        tools: 'Cursor, Windsurf, VS Code + Copilot, Zed',
        steps: [
          'Open an empty folder in your editor.',
          'Ask the agent for the app: paste the cards, plus the line below.',
          'When it works, ask the agent to "run the production build".',
          'Drop the `dist` folder into the game.',
        ],
      },
      terminal: {
        tab: 'Terminal agents',
        tools: 'Claude Code, Codex CLI, Gemini CLI, Aider',
        steps: [
          'Make an empty folder and start the agent in it.',
          'Ask for the app: paste the cards, plus the line below.',
          'End with "build it for production when you\'re done".',
          'Drop the `dist` folder into the game.',
        ],
      },
      web: {
        tab: 'Web builders',
        tools: 'Lovable, Bolt, v0, Replit',
        steps: [
          'Build the app in the browser as usual.',
          'Publish your app in the builder (its Publish or Deploy button) and copy its public link, like `https://my-app.lovable.app`.',
          'Paste the link into the game, under the drop zone, and press Import. Changed something? Publish again and import the same link again.',
        ],
        note: `Links work for sites published on ${LINK_HOSTS}. No public link, or a site that needs its own server? Download the project as a .zip, run \`npm install\` and \`npm run build\` in that folder (this needs Node.js on your computer), then drop the \`dist\` folder.`,
      },
      plain: {
        tab: 'No framework',
        tools: 'Plain HTML, CSS and JavaScript',
        steps: [
          'Write an `index.html`, with your CSS and JS files next to it.',
          'Drop the folder. No build needed.',
        ],
      },
    },

    promptTitle: 'A line to add to your prompt',
    promptIntro: 'Paste it after the cards, so your tool makes something the game can run:',
    prompt:
      'Make it a static site that runs entirely in the browser (no server, no API keys). When you’re done, run the production build.',
    copy: 'Copy',
    copied: 'Copied!',
    copyFailed: "Couldn't copy. Select the text and copy it yourself.",

    foldersTitle: 'Where the build ends up',
    foldersProject: 'Your project',
    foldersDrop: 'Drop this folder',
    folders: [
      {
        project: 'Vite (React, Vue, Svelte, Preact, Solid)',
        how: '`npm run build`',
        folder: '`dist/`',
      },
      { project: 'Create React App', how: '`npm run build`', folder: '`build/`' },
      {
        project: 'Next.js',
        how: "add `output: 'export'` to next.config, then `npm run build`",
        folder: '`out/`',
      },
      { project: 'Astro', how: '`npm run build`', folder: '`dist/`' },
      { project: 'Nuxt', how: '`npm run generate`', folder: '`.output/public/`' },
      {
        project: 'SvelteKit',
        how: 'use `adapter-static`, then `npm run build`',
        folder: '`build/`',
      },
      { project: 'Angular', how: '`npm run build`', folder: '`dist/<project>/browser/`' },
      { project: 'Plain HTML', how: 'nothing to build', folder: 'the folder itself' },
    ],
    foldersNote:
      'You can also drop the whole project folder: the game finds the build folder in it and skips `node_modules`.',

    troubleTitle: 'Troubleshooting',
    trouble: [
      {
        problem: '"This is source code, not the built site"',
        fix: 'You dropped the project before building it. Run `npm run build` (or ask your AI tool to "run the production build"), then drop the `dist` folder.',
      },
      {
        problem: '"Next.js needs a static export"',
        fix: "Add `output: 'export'` to next.config, build again, and drop the `out` folder.",
      },
      {
        problem: '"No index.html found"',
        fix: 'Drop the whole folder your build wrote, not a single file.',
      },
      {
        problem: 'A blank page',
        fix: "Open Problems under the preview: your site's console errors show up there. Paste them into your AI tool and ask it to fix them, then build and drop again.",
      },
      {
        problem: '"The site is too large"',
        fix: `A site can be at most ${s(MAX_MB)} MB. Shrink big images and videos, then build again.`,
      },
      {
        problem: 'A feature needs a server (a database, a login, a secret API key)',
        fix: 'Fake it in the browser: keep data in `localStorage`, use mock data, or call a public API that needs no key.',
      },
      {
        problem: '"That site is private"',
        fix: 'The link asks for a sign-in. Make the site public in your builder (anyone with the link can open it), publish again, then paste the link.',
      },
      {
        problem: '"That site\'s host isn\'t supported"',
        fix: `Links work for sites published on ${LINK_HOSTS}. Publish it there, or download the code, build it and drop the \`dist\` folder.`,
      },
      {
        problem: '"That site couldn\'t be loaded" or "That link isn\'t a web page"',
        fix: 'Open the link in your browser: it must show your site. Paste the address of the published site itself, not the editor’s or a file’s.',
      },
      {
        problem: 'A copied site is blank or breaks when you click around',
        fix: 'It needs its own server (server rendering, API routes), which a copy cannot bring along. Ask your builder for a static site, or download the code, build it and drop the `dist` folder.',
      },
      {
        problem: '"Too many imports"',
        fix: 'Many links were imported in a few minutes. Wait the time it says, or drop the built folder instead.',
      },
      {
        problem: 'The preview never starts in a Firefox private window',
        fix: 'Private windows in Firefox turn off service workers, which the preview needs. Use a normal window.',
      },
    ],

    faqTitle: 'FAQ',
    faq: [
      {
        q: 'Who sees my build?',
        a: "The room's players and spectators, during the reveal. Your build is deleted after the battle; a screenshot and the results stay.",
      },
      {
        q: 'Can I prepare before the battle?',
        a: 'The cards are random, so you can’t know what to build. Building something before the spin is against the spirit of the game. Getting your tools ready is fine.',
      },
      {
        q: 'Can I play on a phone?',
        a: 'You can watch and vote from a phone. Building needs a computer.',
      },
      {
        q: 'Can I play alone?',
        a: 'Yes: Play solo spins a challenge just for you. Race the clock with the same flow, then see your results.',
      },
    ],
    ready: 'Ready?',
    readyText: 'Practice an import first, or jump straight in.',
  },

  importUi: {
    panelLabel: 'Import your built site',
    dropTitle: 'Drop your built site here',
    dropSub: 'the `dist` folder (or your whole project folder) or a .zip',
    chooseFolder: 'Choose folder',
    chooseZip: 'Choose .zip',
    dropOverlay: 'Drop to import your site',
    reading: 'Reading files…',
    restoring: 'Bringing back your last import…',
    stepsTitle: 'In three steps',
    steps: [
      'Build it with your own AI tool on your computer.',
      'Run its build (`npm run build`) — plain HTML needs none.',
      'Drop the `dist` folder here.',
    ],
    importAgain: 'Import again',
    importedFrom: 'Imported',
    droppedFolder: 'the folder you dropped',
    locked: 'Imports are closed for this build.',
    problems: 'Problems',
    console: 'Console',
    noProblems: 'No problems.',
    consoleEmpty: 'Console output from your site shows up here.',
    clear: 'Clear',
    skipped: (n: number) => `${s(n)} skipped`,
    frameTitle: 'Preview of your site',
    loadFailed: 'Your site could not be loaded',
    couldNotStart: 'The preview could not start',
    crashed: 'The preview crashed',
    noAnswer:
      'The sandbox shell at {url} did not answer. Check your connection, then restart the preview.',
    frozeLoading: (seconds: number) =>
      `Your site didn’t finish starting: it stopped responding for ${s(seconds)} s while it loaded, probably an infinite loop in code that runs at startup. Fix it, build again and import it, or restart the preview.`,
    froze: (seconds: number) =>
      `Your site stopped responding for ${s(seconds)} s, probably an infinite loop. Fix it, build again and import it, or restart the preview.`,
    restart: 'Restart preview',
    or: 'or',
    linkLabel: '…or paste the link of your published site',
    linkPlaceholder: 'https://my-app.lovable.app',
    linkImport: 'Import',
    linkCopying: 'Copying your site…',
    linkCancel: 'Cancel',
    linkHint: 'Works with sites published on Lovable, Netlify, Vercel, GitHub Pages, Replit, Bolt…',
    linkHostsShow: 'Show the list',
    linkHostsHide: 'Hide the list',
    linkHostsTitle: 'Links work for sites on',
    copiedFrom: 'Copied from',
    copyAgainFrom: (host: string) => `Copy again from ${host}`,
    pasteLink: 'Paste a link…',
  },

  importErrors,
  linkErrors,

  try: {
    title: 'Try an import',
    intro:
      'Practice before a battle: drop a site you built and see it run. Nothing is uploaded; it stays in this tab.',
    home: 'Home',
  },

  solo: {
    loadingGame: 'Loading the game…',
    stillRunning: 'This battle is still running. Its results will be public soon.',
    player: 'Player',
    title: 'Solo battle',
    intro: 'Spin a random BUILD, RULE and STYLE, then race the clock. Ship before time runs out.',
    spinningUp: 'Spinning up…',
    spin: 'Spin',
    footer: 'No account needed. Your build is deleted when the battle ends; the results stay.',
    resumeTitle: 'You have a battle running',
    resumeText: 'Only one solo battle can run at a time. Jump back in before the clock runs out.',
    resume: 'Resume battle',
    back: 'Back',
  },

  spin: {
    heading: (name: string) => `${name}, your challenge is…`,
    title: 'SPIN',
    getReady: 'Get ready to build…',
  },

  build: {
    subtitle: 'Solo',
    lowTime: 'One minute left. Ship soon!',
    criticalTime: 'Ten seconds! Ship now or your last import ships for you.',
    autosave: {
      looking: 'Looking for your last import…',
      nothing: 'Nothing imported yet',
      saving: 'Saving…',
      saved: (time: string) => `Saved ${time}`.trim(),
      failed: 'Save failed, retrying',
      closed: 'Saving closed',
      notSaved: 'Not saved yet',
    },
    countdownBuild: 'Build',
    countdownGrace: 'Grace',
    countdownSpin: 'Spin',
    ship: 'Ship it 🚀',
    importFirst: 'Import your built site first',
    timesUp: "Time's up!",
    shippingForYou: 'Your last import is being shipped for you…',
    nothingToShip: 'Nothing was imported, so there is nothing to ship. Wrapping up the battle…',
    shipped: (name: string | null, at: string | null) =>
      `🚀 Shipped${name ? ` “${name}”` : ''}${at ? ` at ${at}` : ''}. Your build is locked.`,
    wrappingUp: 'Wrapping up the battle…',
  },

  ship: {
    title: 'Ship it?',
    text: "You can't import again after. The site you imported last is frozen, screenshotted and judged as it is now.",
    buildName: 'Build name',
    thumbnail: 'Taking a snapshot…',
    uploading: 'Uploading your site…',
    shipping: 'Shipping…',
    done: 'Shipped!',
    keepBuilding: 'Keep building',
    tryAgain: 'Try again',
    ship: 'Ship it 🚀',
  },

  results: {
    destroying: 'Destroying the build…',
    destroyed: 'Build destroyed',
    lastLookIn: (t: string) => `Last look · this build self-destructs in ${t}`,
    lastLookCapture: 'Last look · destroying it as soon as the screenshot is done…',
    lastLookDestroying: 'Last look · destroying…',
    eyebrowDestroy: 'Destroy build',
    eyebrowResults: 'Results',
    yourBuild: 'Your build',
    byStatus: 'by {name} · {status}',
    byStatusTime: 'by {name} · {status} in {time}',
    noShot: 'Nothing was shipped, so there is no screenshot.',
    sourceDeleted: '✓ The imported site was deleted from the server.',
    sourceDeleting: 'Deleting the imported site from the server…',
    permanent: 'View the permanent results',
    playAgain: 'Play again',
  },

  revealPane: {
    frameTitle: 'Your shipped build (last look)',
    loading: 'Loading your build…',
    unavailable: 'Nothing to show: no build was shipped.',
    noLoad: 'Your site couldn’t load in this browser. Its screenshot and results are safe.',
    noStart: 'Your build couldn’t start here: the preview sandbox never answered.',
    froze: 'Your build froze (it stopped responding), so it was stopped.',
    destroying: 'DESTROYING',
    destroyedStamp: 'BUILD DESTROYED',
    destroyedText:
      'The imported site is gone: from this browser now, and from the server in a moment. The results stay forever.',
  },

  status,
  capture,

  awards: {
    label: 'Awards',
    ...AUTO_AWARDS_EN,
    mostVotes: MOST_VOTES_EN,
    votes: (n: number) => plural(n, 'vote', 'votes'),
    perCategory: 'Votes per category',
  },

  voteCategories,

  stats: {
    files: (n: number) => plural(n, 'file', 'files'),
    imported: (n: number) => (n === 1 ? 'imported once' : `imported ${s(n)} times`),
    lines: (n: number) => plural(n, 'line', 'lines'),
    madeWith: (deps: string) => `made with ${deps}`,
  },

  battlePage: {
    shellTitle: 'Battle results',
    notFoundTitle: 'Battle not found',
    ...BATTLE_TITLE_EN,
    loading: 'Loading the results…',
    loadError: 'The results could not be loaded. Check your connection, then try again.',
    notFound: 'No battle has this link, or its results are not in yet.',
    soloEyebrow: 'Solo battle results',
    roomEyebrow: 'Battle results',
    timeLimit: (t: string) => `Time limit: ${t}`,
    rankedVotes:
      'ranked by the players’ votes (Best Build, then all votes, then the earlier ship); one winner per award category (a tie goes to more votes in all, then the earlier ship)',
    rankedTime: 'ranked by completion time',
    builds: 'Builds',
    nothingShipped: 'Nothing was shipped.',
    untitled: 'Untitled build',
    destroyedNote:
      'The builds were destroyed after the battle. Builds are temporary. Results are permanent.',
    tagline: 'Builds are temporary. Results are permanent.',
    playSolo: 'Play solo',
  },

  history: {
    shellTitle: 'Player history',
    notFoundTitle: 'Player not found',
    title: (name: string) => `${name}'s battles`,
    loading: 'Loading the battles…',
    loadError: 'The battles could not be loaded. Check your connection, then try again.',
    eyebrow: 'Player history',
    intro:
      'Finished battles, newest first. Builds are destroyed after each battle; their results and screenshots stay.',
    battles: 'Battles',
    pages: 'Pages',
    newest: '← Newest battles',
    older: 'Older battles →',
    footer:
      'This history belongs to an anonymous player on one browser. Clearing that browser’s data loses the way back here (bookmark this page to keep it).',
    play: 'Play a battle',
    notFoundHeading: 'No battles to show',
    notFoundText:
      'This player has no finished battle yet, or the link is wrong. Battles show up here once their results are in.',
    rank: (rank: number, of: number) => `#${s(rank)} of ${s(of)}`,
    unranked: 'Unranked',
    noScreenshot: 'No screenshot',
    nothingShipped: 'Nothing was shipped',
    solo: 'Solo',
    roomBattle: 'Room battle',
    autoShipped: 'auto-shipped',
  },

  loadStates: {
    title: 'Could not load this page',
  },

  notFound: {
    title: 'This page could not be found.',
  },

  globalError: {
    title: 'Something broke',
    text: 'The page hit an error. Your game state lives on the server, so reloading usually gets you back where you were.',
  },

  moderation: {
    removed: 'Removed by moderators',
    report: 'Report',
    reported: 'Reported',
    reportTitle: 'Report this build to the moderators',
    thanksTitle: 'Thanks for the report',
    alreadyTitle: 'Already reported',
    thanksText:
      'A moderator will look at it. If it breaks the rules it is removed from the results and its screenshot is deleted. Other players do not see who reported it.',
    alreadyText: 'You already reported this build. A moderator will look at it.',
    hideNow: 'Hide it for me now',
    dialogTitle: 'Report this build',
    question: 'What is wrong with it?',
    details: 'Details (optional)',
    placeholder: 'What did you see? (Links, what it asked for…)',
    buildGone: 'This build is no longer available (it may have been removed already).',
    justHide: 'Just hide it for me',
    sending: 'Sending…',
    send: 'Send report',
  },

  reportReasons,

  room: {
    loading: 'Loading the room…',
    title: 'Room',
    noCode: 'This link has no room code.',
    createOrJoin: 'Create or join a room',
    opening: (code: string) => `Opening room ${code}…`,
    joining: (code: string) => `Joining room ${code}…`,
    connecting: (code: string) => `Connecting to room ${code}…`,
    spinHeading: (code: string) => `Room ${code} · everyone's challenge is…`,
    waitingOthers: (shipped: number, total: number) =>
      `Waiting for the others (${s(shipped)}/${s(total)} shipped)…`,
    eyebrow: 'Room',
    reconnecting: 'Reconnecting…',
    copyPrompt: 'Copy the invite link:',
    copied: 'Copied!',
    copyInvite: 'Copy invite link',
    leave: 'Leave room',
    leaveTitle: 'Leave the room?',
    leaveAfterShipping:
      'The battle goes on without you: your build stays in the reveal and the results. You cannot vote unless you come back before the vote ends.',
    leaveDuring:
      'The battle goes on without you. If you do not come back, your last autosave ships for you at the deadline.',
    leaveConfirm: 'Leave',
    invited: 'You are invited to room',
    joiningButton: 'Joining…',
    join: 'Join the room',
    nameFooter: 'No account needed. Builds are deleted after each battle.',
    joinErrors: {
      room_not_found: {
        title: 'Room not found',
        text: (code: string) =>
          `No room has the code ${code}. Check the code, or create your own room.`,
      },
      room_closed: {
        title: 'This room is closed',
        text: () => 'Rooms close when everyone has left, or after two hours without a battle.',
      },
      kicked: {
        title: 'You cannot join this room',
        text: () => 'The host removed you from this room, so you cannot come back to it.',
      },
      rate_limited: {
        title: 'Too many wrong room codes',
        text: (why: string) => `${why} Ask your host for the invite link.`,
      },
      room_full: {
        title: 'This room is full',
        text: () =>
          `Every player and spectator slot is taken (${s(ROOM_LIMITS.max_players)} players and ${s(ROOM_LIMITS.max_spectators)} spectators).`,
      },
    },
    couldNotJoin: 'Could not join the room',
    another: 'Create or join another room',
    ended: {
      kicked: {
        title: (code: string) => `You were removed from room ${code}`,
        text: 'The host kicked you, so you cannot rejoin this room. You can always start your own.',
      },
      left: {
        title: (code: string) => `You left room ${code}`,
        text: 'Changed your mind? You can rejoin while the room is open.',
      },
      closed: {
        title: (code: string) => `Room ${code} is closed`,
        text: 'Everyone left, or nobody played for two hours.',
      },
      gone: {
        title: (code: string) => `Room ${code} is gone`,
        text: 'This room no longer exists.',
      },
    },
    rejoin: 'Rejoin the room',
  },

  toasts: {
    hostYou: '👑 You are the host now.',
    hostOther: (name: string | null) => `👑 ${name ?? 'Someone else'} is the host now.`,
    joined: (name: string, spectator: boolean) => `${name} joined${spectator ? ' to watch' : ''}.`,
    left: (name: string) => `${name} left.`,
    kicked: (name: string) => `${name} was removed by the host.`,
    /** `who` null: you. */
    shipped: (who: string | null, name: string | null, at: string | null) =>
      `🚀 ${who ?? 'You'} shipped “${name ?? 'Untitled'}”${at ? ` at ${at}` : ''}`,
  },

  desktop: {
    title: '💻 Building needs a computer',
    shipped:
      'You shipped **“{name}”**. It is locked in: watch the others build here, then the reveal and the vote.',
    yourBuild: 'your build',
    notShipped:
      'You are a **player** in this battle, but you build on a computer: with your own AI tool, then you import the built site. This phone does not import or autosave anything, so unless you import and ship here, your build ends as **DNF** (did not finish) at the deadline.',
    watchVote: 'You still **watch the reveal and vote** from this phone, like everyone else.',
    seat: 'Opening the room on a computer does not move your seat there: each browser is its own anonymous player, and a battle that already started only takes spectators.',
    buildAnyway: 'Import on this device anyway',
  },

  progress: {
    shipped: (name: string, at: string | null) => `🚀 Shipped “${name}”${at ? ` at ${at}` : ''}`,
    left: 'Left the room',
    removed: 'Removed by the host',
    imported: '📦 imported',
    imports: (n: number) => `(${s(n)}×)`,
    building: '🛠 building…',
    onPhone: 'On a phone',
    offline: 'Offline',
    players: 'Players',
    header: (shipped: number, total: number) => `Players · ${s(shipped)}/${s(total)} shipped`,
  },

  spectator: {
    playerWatching: '📱 Player · watching',
    spectating: '👀 Spectating',
    note: 'You are watching this battle (it started before you joined, or the player slots are taken). When it ends, you get a player slot for the rematch if one is free.',
  },

  lobby: {
    lastSeen: (ago: string) => `last seen ${ago}`,
    online: 'online',
    offline: 'offline',
    left: 'left',
    player: 'Player',
    spectator: 'Spectator',
    ready: '✓ Ready',
    notReady: 'Not ready',
    remove: (name: string) => `Remove ${name}`,
    kick: 'Kick',
    players: 'Players',
    playerCount: (n: number, max: number) => `${s(n)}/${s(max)} players`,
    spectators: (n: number, max: number) => `Spectators (${s(n)}/${s(max)})`,
    spectatorsLabel: 'Spectators',
    leftRoom: 'Left the room',
    readyDone: '✓ Ready!',
    readyUp: 'Ready up',
    spectatingNote: 'You are **spectating**. When a player slot frees up, you get it.',
    maxPlayers: 'Max players',
    spinningUp: 'Spinning up…',
    startRematch: 'Start the rematch',
    startBattle: 'Start battle',
    readySummary: (ready: number, enough: boolean, min: number) =>
      `${s(ready)} ready · ${
        enough
          ? 'everyone who is ready and online plays'
          : `at least ${s(min)} ready players are needed`
      }`,
    waitingBattle: 'Waiting for {host} to start the battle… ({ready} ready)',
    waitingRematch: 'Waiting for {host} to start the rematch… ({ready} ready)',
    theHost: 'the host',
    phoneNote:
      '📱 On a phone you watch the battle, then play the reveal and the vote. Building needs a computer (you build with your own AI tools and import the result): if you play from here, your build ends as DNF.',
    historyLink: 'Your battle history ↗',
    howTitle: 'How a battle works',
    how: (limits: string) => [
      `The reels pick a BUILD, a RULE, a STYLE and a time limit (${limits} min).`,
      'Everyone builds the same challenge on their own computer, with their own AI tools, and imports the built site.',
      'Ship before the clock runs out. Fast ships earn awards.',
      'The reveal: everyone watches every build, one at a time.',
      'Everyone votes in four categories (never for their own build).',
      'Results by votes, a last look, and then every build is destroyed.',
    ],
    kickTitle: (name: string) => `Kick ${name}?`,
    kickBody: 'They leave the room at once and cannot come back with this code.',
    lastBattle: 'Last battle',
    nobodyShipped: 'Nobody shipped.',
    abandoned: 'It was abandoned (nobody was left), so it has no results page.',
    settingsOff: 'Reveal and vote off: results by completion time.',
    slotFixed: (seconds: number) => `${s(seconds)} s per build`,
    slotAuto: (range: string) => `${range} per build (by the number of builds)`,
    settingsOn: (slot: string, voting: number) =>
      `Reveal and vote on · ${slot} · ${s(voting)} s to vote.`,
    afterBuild: 'After the build',
    revealVote: 'Reveal and vote',
    revealVoteOn: 'Everyone watches every build, then votes.',
    revealVoteOff: 'Results by completion time.',
    timePerBuild: 'Time per build',
    auto: (range: string) => `Auto (${range})`,
    votingTime: 'Voting time',
  },

  reveal: {
    badge: '🎬 Reveal',
    spectating: '👀 Spectating',
    thisBuild: 'This build',
    spotlight: 'Spotlight',
    position: (n: number, total: number) => `Build ${s(n)} of ${s(total)}`,
    byName: 'by {name}',
    thatsYou: '(that is you!)',
    autoShipped: 'Auto-shipped',
    autoShippedTitle: 'Not shipped by hand: the last autosave shipped at the deadline',
    userMade: '⚠ User-made build',
    sandboxNote: (name: string) =>
      `by ${name} · runs in a sandbox, cannot see your account. Nothing in it can act for Build Roulette.`,
    runAgain: '▶ Run it again',
    still: 'Screenshot · not running',
    skipTitle: 'Stop running this build on your screen (the room keeps going)',
    skip: '⏭ Skip this build',
    tapToRun: '▶ Tap to run live',
    frameTitle: (name: string, builder: string) => `${name} by ${builder} (user-made build)`,
    couldNotLoad: (why: string) => `This build could not be loaded. ${why}`,
    nothingToRun: 'This build has nothing to run.',
    loadingBuilds: (why: string) => `Loading the builds… (${why})`,
    loadingBuild: 'Loading the build…',
    theHost: 'The host',
    challenge: 'The challenge',
    watchNote:
      'Watch closely: when the reveal ends, every player votes for the best build in four categories (never their own).',
    stopped: {
      skipped: 'You skipped this build. It keeps going for everyone else.',
      frozen: 'This build froze, so it was stopped on your screen. Everyone else keeps watching.',
      no_start:
        'This build couldn’t start on your screen (its sandbox never answered). Everyone else keeps watching.',
      no_load:
        'This build couldn’t load on your screen, so here is its screenshot. Everyone else keeps watching.',
    },
    hostNote:
      '👑 {host} can move to the next build or skip to the vote. Otherwise each build gets its full slot.',
    hostTitle: '👑 You host the reveal',
    movingOn: 'Moving on…',
    nextVote: 'Next: start the vote ▶',
    next: 'Next build ▶',
    skipping: 'Skipping…',
    skipToVote: '⏭ Skip to the vote',
    strip: 'Every build of the reveal',
    thumbnailOf: (name: string) => `Thumbnail of ${name}`,
    comingUp: 'Coming up',
  },

  vote: {
    watching: 'You are watching: only the players of this battle vote. The results come next.',
    cannotVote: 'You cannot vote in this battle.',
    left: 'You left the room, so you cannot vote. Join it again to vote.',
    closed: 'Voting is closed.',
    badge: '🗳️ Vote',
    countdown: 'Voting',
    heading: 'Vote for the best builds',
    intro: (picked: number, total: number) =>
      `One pick per category, never your own build. You can change your picks until the timer ends (${s(picked)}/${s(total)} picked).`,
    unsent: (n: number) =>
      `⚠ Not saved yet: the server cannot be reached. Your ${
        n === 1 ? 'pick is' : `${s(n)} picks are`
      } sent again as soon as the connection is back. Keep this page open.`,
    complete: (voted: number | null, eligible: number | null) =>
      `✓ Ballot complete. Waiting for the others${
        voted !== null && eligible !== null ? ` (${s(voted)}/${s(eligible)} voted)` : ''
      }. You can still change a pick until the timer ends.`,
    progressLabel: (voted: number, eligible: number) =>
      `${s(voted)} of ${s(eligible)} players voted`,
    progress: (voted: number, eligible: number) => `${s(voted)}/${s(eligible)} voted`,
    saving: 'Saving…',
    unsentStatus: '⚠ Not saved yet · retrying',
    picked: '✓ Picked',
    pickOne: 'Pick one',
    yourPick: '✓ Your pick',
    notSaved: 'Not saved yet',
    yourBuild: 'Your build',
    imageAlt: (name: string, builder: string) => `${name} by ${builder}`,
    ownTitle: 'You cannot vote for your own build',
    optionLabel: (category: string, name: string, builder: string) =>
      `${category}: ${name} by ${builder}`,
  },

  roomResults: {
    destroying: 'Destroying every build…',
    destroyed: 'Builds destroyed',
    lastLookIn: (player: boolean, t: string) =>
      `Last look · ${player ? 'your build self-destructs' : 'the builds self-destruct'} in ${t}`,
    lastLookCaptures: 'Last look · destroying as soon as the screenshots are done…',
    lastLookDestroying: 'Last look · destroying…',
    rankedVotes:
      'Ranked by votes: Best Build first, then all votes, then the earlier ship. Each category award has one winner: a tie goes to more votes in all, then the earlier ship.',
    rankedTime: 'Ranked by completion time.',
    ranking: 'Ranking',
    removedMine: 'Your build was removed by the moderators.',
    disqualifiedMine: 'Your build was disqualified.',
    didNotShip: 'You did not ship this time. There is always the rematch.',
    lostPick: (category: string, name: string | null) =>
      name ? `${category} (“${name}”)` : category,
    lost: (count: number, list: string) =>
      `Not counted: your pick${count === 1 ? '' : 's'} for ${list} did not reach the server before voting closed (the connection was down).`,
    autoShipped: 'Auto-shipped',
    dnf: 'DNF',
    disqualified: 'Disqualified',
    nothingShipped: 'Nothing shipped',
    historyTitle: (name: string) => `${name}'s battles (opens a new tab)`,
  },

  errors,
  /** The server's "… Try again in 9 minutes." for `rate_limited`, in this language. */
  rateLimitedDetails: (details: string) => details,
  voteErrors,
};

export type Messages = typeof en;
