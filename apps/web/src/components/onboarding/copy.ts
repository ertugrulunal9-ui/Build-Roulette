/**
 * The onboarding's fixed parts (T-049, docs/09 §9.6): paths, the steps' order and emojis, and
 * the pictures' sample data. Its words are in the catalogs since T-050 (lib/i18n/messages:
 * `steps`, `stepArt`, `welcome`, `home`, `lobbyHints`, `phone`, `importHelp`, `guide`).
 */

/** Where the guide lives. */
export const GUIDE_PATH = '/how-it-works';
export const TRY_PATH = '/try';
export const NODE_URL = 'https://nodejs.org';

export const STEP_IDS = ['spin', 'build', 'drop', 'ship'] as const;
export type StepId = (typeof STEP_IDS)[number];

/** Big emoji of each step (decorative). */
export const STEP_EMOJI: Record<StepId, string> = {
  spin: '🎰',
  build: '🤖',
  drop: '📦',
  ship: '🚀',
};

/**
 * The pictures' sample data. The example cards stay English in every language: they show what
 * the deck looks like, and the deck (server content) is English.
 */
export const STEP_SAMPLES = {
  exampleCards: {
    build: 'A pomodoro timer',
    rule: 'Only one button',
    style: 'Retro arcade',
  },
  exampleMinutes: 15,
  tools: ['Cursor', 'Claude Code', 'Windsurf', 'Copilot', 'Lovable', 'Bolt', 'v0', 'HTML'],
  terminalCommand: 'npm run build',
  endFlow: [
    { emoji: '🚀', key: 'ship' },
    { emoji: '👀', key: 'reveal' },
    { emoji: '🗳️', key: 'vote' },
    { emoji: '🏆', key: 'results' },
  ],
} as const;

/** The guide's tool tabs, in order. */
export const TOOL_IDS = ['editor', 'terminal', 'web', 'plain'] as const;
export type ToolId = (typeof TOOL_IDS)[number];
