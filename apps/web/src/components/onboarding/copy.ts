/**
 * The words of the onboarding (T-049, docs/09 §9.6): the welcome screen, the home page, the
 * `/how-it-works` guide, the "How do I import?" help of the BUILD stage and `/try`, and the
 * lobby's hints. One module, plain English, so the English / Turkish switch (T-050) can take
 * it over. Backticks mark code (`CodeText` renders them as `<code>`).
 *
 * Numbers come from the game's own limits (`@br/game`, `@br/site`), never typed in twice.
 */
import { BUILD_TIME_LIMITS_MINUTES, ROOM_LIMITS } from '@br/game';
import { SITE_LIMITS } from '@br/site';

const MIN_MINUTES = Math.min(...BUILD_TIME_LIMITS_MINUTES);
const MAX_MINUTES = Math.max(...BUILD_TIME_LIMITS_MINUTES);
const MAX_MB = Math.round(SITE_LIMITS.maxPackBytes / (1024 * 1024));
const MAX_FILES = SITE_LIMITS.maxFiles;

/** Where the guide lives. */
export const GUIDE_PATH = '/how-it-works';
export const TRY_PATH = '/try';
export const NODE_URL = 'https://nodejs.org';

export type StepId = 'spin' | 'build' | 'drop' | 'ship';

export interface StepCopy {
  id: StepId;
  /** Big emoji of the step (decorative). */
  emoji: string;
  title: string;
  text: string;
}

/** The four steps of a battle: the welcome screen, the home page and the guide. */
export const STEPS: readonly [StepCopy, StepCopy, StepCopy, StepCopy] = [
  {
    id: 'spin',
    emoji: '🎰',
    title: 'Spin',
    text: `Everyone in the room gets the same random BUILD, RULE, STYLE and TIME LIMIT (${String(MIN_MINUTES)} to ${String(MAX_MINUTES)} minutes).`,
  },
  {
    id: 'build',
    emoji: '🤖',
    title: 'Build it your way',
    text: "Use your own AI tool on your own computer: Cursor, Claude Code, Windsurf, Copilot, Lovable, Bolt, v0… or plain HTML. Your prompts, your tricks. That's the game.",
  },
  {
    id: 'drop',
    emoji: '📦',
    title: 'Build & drop',
    text: "Run your project's build (`npm run build`), then drop the `dist` folder (or a .zip) into the game. Drop again as often as you like; the last drop before time runs out counts.",
  },
  {
    id: 'ship',
    emoji: '🚀',
    title: 'Ship, reveal, vote',
    text: "Ship it. Everyone's builds are revealed one by one, you vote, and the results stay forever. The builds themselves are deleted after the battle.",
  },
];

/** The pictures of the steps: example cards, tools, the build, the end of a battle. */
export const STEP_ART = {
  exampleCards: {
    build: 'A pomodoro timer',
    rule: 'Only one button',
    style: 'Retro arcade',
  },
  exampleTime: '15 min',
  timeLabel: 'TIME',
  tools: ['Cursor', 'Claude Code', 'Windsurf', 'Copilot', 'Lovable', 'Bolt', 'v0', 'HTML'],
  terminalCommand: 'npm run build',
  terminalResult: '✓ built in dist/',
  dropTarget: 'Drop `dist` here',
  endFlow: [
    { emoji: '🚀', label: 'Ship' },
    { emoji: '👀', label: 'Reveal' },
    { emoji: '🗳️', label: 'Vote' },
    { emoji: '🏆', label: 'Results' },
  ],
  endNote: 'Builds deleted · results stay',
} as const;

export const WELCOME_COPY = {
  /** The dialog's name for screen readers, and the eyebrow over each step. */
  title: 'Welcome to Build Roulette',
  stepOf: (n: number, total: number) => `Step ${String(n)} of ${String(total)}`,
  steps: 'Steps',
  goToStep: (n: number) => `Go to step ${String(n)}`,
  next: 'Next',
  back: 'Back',
  skip: 'Skip',
  practice: 'Practice first',
  play: "Let's play",
  guide: 'Read the full guide',
} as const;

/** "How it works" everywhere (home, `/play`, the lobby, `/try`, the BUILD header). */
export const HOW_IT_WORKS = 'How it works';
/** After a link that opens in a new tab (screen readers). */
export const NEW_TAB = '(opens in a new tab)';

export const HOME_COPY = {
  title: 'Build Roulette',
  pitch: 'A party game for vibe coders: same challenge, your own AI tools, different builds.',
  tryImport: 'Try an import',
  stepsTitle: 'How a battle works',
  phasesLabel: 'The phases of a battle',
  guide: 'Read the full guide',
  tagline: 'Builds are temporary. Results are permanent.',
  roomsAndSolo: `Create a room and send the link to up to ${String(ROOM_LIMITS.max_players - 1)} friends (and ${String(ROOM_LIMITS.max_spectators)} spectators), or race the clock on your own. No account needed.`,
} as const;

export const LOBBY_COPY = {
  newHereTitle: 'New here?',
  newHereText:
    'See how a battle works in four short steps, then practice an import before the host spins.',
  newHereShow: 'Show me',
  newHerePractice: 'Practice an import',
  reminder:
    "You'll build on your computer with your own AI tool. Have it open before the host spins.",
} as const;

export const PHONE_COPY = {
  /** DesktopNeeded, under the notice. */
  guideText: 'On this phone you watch and vote. Next time, join from a computer to build.',
  guideLink: 'How the game works',
} as const;

// ─── The "How do I import?" help (BUILD, /try) ─────────────────────────────────────────

export const IMPORT_HELP_COPY = {
  summary: 'How do I import?',
  steps: [
    'Ask your AI tool to "run the production build" (or run `npm run build` yourself).',
    'Drop the folder the build wrote here, or press Choose folder. A .zip works too.',
    'Changed something? Build again and drop again: the last drop counts.',
  ],
  whereTitle: 'Where is my build?',
  where: [
    'Vite (React, Vue, Svelte…) → `dist`',
    'Create React App → `build`',
    "Next.js → `out` (needs `output: 'export'`)",
    'Plain HTML → the folder itself',
  ],
  webBuildersTitle: 'Lovable, Bolt, v0?',
  webBuilders:
    'Download the project as a .zip, unzip it, run `npm install` and `npm run build` in that folder, then drop `dist`.',
  guide: 'Full guide',
  /** Next to an import error. */
  howToFix: 'How do I fix this?',
} as const;

// ─── The guide, /how-it-works ──────────────────────────────────────────────────────────

export interface Linked {
  text: string;
  link?: { label: string; href: string; external?: boolean };
}

export interface ToolGuide {
  id: 'editor' | 'terminal' | 'web' | 'plain';
  tab: string;
  tools: string;
  steps: readonly string[];
  note?: string;
}

export interface Trouble {
  problem: string;
  fix: string;
}

export const GUIDE_COPY = {
  metaTitle: 'How it works',
  metaDescription:
    'How to play Build Roulette: spin a challenge, build it with your own AI tools, run the build, drop the dist folder into the game, ship, reveal and vote. Tool guides, limits and troubleshooting.',
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
    `At most ${String(MAX_MB)} MB and ${String(MAX_FILES)} files.`,
    `The TIME LIMIT card gives you ${String(MIN_MINUTES)} to ${String(MAX_MINUTES)} minutes.`,
    "Drop as often as you want. The last import counts, and it is shipped for you at the deadline if you didn't ship.",
  ],

  checklistTitle: 'Before your first battle',
  checklist: [
    { text: 'Your AI tool is installed and signed in.' },
    { text: 'An empty folder for the new project.' },
    {
      text: 'Node.js installed, if your tool makes an npm project (most do):',
      link: { label: 'nodejs.org', href: NODE_URL, external: true },
    },
    {
      text: 'Practice one import:',
      link: { label: 'Try an import', href: TRY_PATH },
    },
  ] satisfies readonly Linked[],

  toolsTitle: 'Tool guides',
  toolsIntro: 'Pick the kind of tool you use.',
  toolsLabel: 'Kind of tool',
  tools: [
    {
      id: 'editor',
      tab: 'Editor agents',
      tools: 'Cursor, Windsurf, VS Code + Copilot, Zed',
      steps: [
        'Open an empty folder in your editor.',
        'Ask the agent for the app: paste the cards, plus the line below.',
        'When it works, ask the agent to "run the production build".',
        'Drop the `dist` folder into the game.',
      ],
    },
    {
      id: 'terminal',
      tab: 'Terminal agents',
      tools: 'Claude Code, Codex CLI, Gemini CLI, Aider',
      steps: [
        'Make an empty folder and start the agent in it.',
        'Ask for the app: paste the cards, plus the line below.',
        'End with "build it for production when you\'re done".',
        'Drop the `dist` folder into the game.',
      ],
    },
    {
      id: 'web',
      tab: 'Web builders',
      tools: 'Lovable, Bolt, v0, Replit',
      steps: [
        'Build the app in the browser as usual. These tools give you source code, not a built site.',
        'Use its download / export option to get the project as a .zip, and unzip it.',
        'Open a terminal in that folder and run `npm install`, then `npm run build`.',
        'Drop the `dist` folder into the game.',
      ],
      note: 'This needs Node.js on your computer. Importing straight from a link is planned for later.',
    },
    {
      id: 'plain',
      tab: 'No framework',
      tools: 'Plain HTML, CSS and JavaScript',
      steps: [
        'Write an `index.html`, with your CSS and JS files next to it.',
        'Drop the folder. No build needed.',
      ],
    },
  ] satisfies readonly ToolGuide[],

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
    { project: 'SvelteKit', how: 'use `adapter-static`, then `npm run build`', folder: '`build/`' },
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
      fix: `A site can be at most ${String(MAX_MB)} MB. Shrink big images and videos, then build again.`,
    },
    {
      problem: 'A feature needs a server (a database, a login, a secret API key)',
      fix: 'Fake it in the browser: keep data in `localStorage`, use mock data, or call a public API that needs no key.',
    },
    {
      problem: 'The preview never starts in a Firefox private window',
      fix: 'Private windows in Firefox turn off service workers, which the preview needs. Use a normal window.',
    },
  ] satisfies readonly Trouble[],

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
} as const;
