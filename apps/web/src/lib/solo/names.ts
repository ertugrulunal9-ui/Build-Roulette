/** Random fun default names (display names are 1–24 characters, build names 1–48). */

const ADJECTIVES = [
  'Turbo',
  'Sleepy',
  'Cosmic',
  'Feral',
  'Pixel',
  'Spicy',
  'Quantum',
  'Rogue',
  'Glitchy',
  'Neon',
  'Caffeinated',
  'Sneaky',
  'Chaotic',
  'Lucky',
  'Mighty',
  'Wobbly',
] as const;

const NOUNS = [
  'Otter',
  'Wizard',
  'Goblin',
  'Raccoon',
  'Penguin',
  'Llama',
  'Gremlin',
  'Hamster',
  'Yeti',
  'Kraken',
  'Possum',
  'Narwhal',
  'Badger',
  'Ferret',
  'Toaster',
  'Moth',
] as const;

const BUILD_SUFFIXES = ['3000', 'Deluxe', 'Pro Max', 'Lite', 'XL', 'Reloaded', 'Turbo'] as const;

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('empty list');
  return item;
}

/** e.g. "Caffeinated Narwhal" (always within 24 characters). */
export function randomDisplayName(random: () => number = Math.random): string {
  return `${pick(ADJECTIVES, random)} ${pick(NOUNS, random)}`;
}

/** A suggested build name from the BUILD card, e.g. "Pomodoro Timer 3000". */
export function suggestBuildName(buildCard: string, random: () => number = Math.random): string {
  const base = buildCard
    .replace(/^(an?|the)\s+/i, '')
    .split(/\s+/)
    .slice(0, 3)
    .join(' ')
    .replace(/[^\p{L}\p{N} '-]/gu, '')
    .trim();
  const title = base.length > 0 ? base.charAt(0).toUpperCase() + base.slice(1) : 'My Build';
  return `${title} ${pick(BUILD_SUFFIXES, random)}`.slice(0, 48);
}
