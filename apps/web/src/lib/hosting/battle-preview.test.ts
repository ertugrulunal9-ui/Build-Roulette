// @vitest-environment happy-dom
/**
 * The head that T-038's link-preview Function writes into `/battles/{id}` (battle-preview.ts):
 * which paths it answers, the battle's title, description and image (T-033's image rule and
 * T-028's: a removed rank-1 build is never named, its screenshot never shown, and nobody is
 * promoted in its place), the 404 head, and the escaping of user and deck data.
 *
 * The escaping tests parse the HTML back with a real HTML parser (happy-dom): every value must
 * come back exactly as it went in, inside its own attribute, with no element added.
 */
import { describe, expect, it } from 'vitest';
import { STATIC_OG_CARD } from '../solo/og-image';
import type { PublicBattle, PublicBuild } from '../solo/types';
import {
  NOT_FOUND_DESCRIPTION,
  REPLACED_HEAD_ELEMENTS,
  battlePreview,
  escapeHtml,
  previewHeadHtml,
  previewTarget,
} from './battle-preview';

const ID = 'b0380000-0000-4000-8000-000000000001';
const ORIGIN = 'https://br.example';
const STORAGE = 'http://127.0.0.1:54321/storage/v1/object/public/screenshots';

function build(id: string, patch: Partial<PublicBuild>): PublicBuild {
  return {
    id,
    builder_name: 'Someone',
    name: 'A build',
    status: 'shipped',
    shipped_at: '2026-10-09T11:58:00Z',
    completion_ms: 150_000,
    final_rank: null,
    total_votes: 0,
    votes: null,
    stats: {},
    capture_status: 'captured',
    screenshot_path: null,
    taken_down: false,
    ...patch,
  };
}

/** Mallory's "Free Gift Card" won with a screenshot; Ana's "Pomodoro Pal" (rank 2) has one too. */
function battle(top: Partial<PublicBuild> = {}): PublicBattle {
  return {
    battle: {
      id: ID,
      mode: 'multiplayer',
      phase: 'destroyed',
      is_complete: true,
      building_started_at: '2026-10-09T11:55:00Z',
      building_ends_at: '2026-10-09T12:00:00Z',
      finished_at: '2026-10-09T12:03:00Z',
      destroyed_at: '2026-10-09T12:04:00Z',
      created_at: '2026-10-09T11:54:00Z',
    },
    challenge: {
      build: { text: 'A pomodoro timer', hint: null },
      rule: { text: 'Only one button', hint: null },
      style: { text: 'Brutalist', hint: null },
      time_limit_seconds: 300,
    },
    players: ['Ana', 'Mallory'],
    builds: [
      build('mallory', {
        builder_name: 'Mallory',
        name: 'Free Gift Card',
        final_rank: 1,
        total_votes: 3,
        screenshot_path: `${ID}/mallory.png`,
        ...top,
      }),
      build('ana', {
        builder_name: 'Ana',
        name: 'Pomodoro Pal',
        final_rank: 2,
        total_votes: 2,
        screenshot_path: `${ID}/ana.webp`,
      }),
    ],
    awards: [],
  };
}

/** The head's HTML parsed by a real HTML parser. */
function parse(html: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.head.innerHTML = html;
  return doc;
}

const content = (doc: Document, selector: string) =>
  doc.head.querySelector(selector)?.getAttribute('content') ?? null;

describe('previewTarget: which requests the Function answers', () => {
  it('a battle id (any case; a trailing slash allowed)', () => {
    expect(previewTarget(`/battles/${ID}`)).toEqual({ kind: 'battle', id: ID });
    expect(previewTarget(`/battles/${ID.toUpperCase()}`)).toEqual({ kind: 'battle', id: ID });
    expect(previewTarget(`/battles/${ID}/`)).toEqual({ kind: 'battle', id: ID });
  });

  it('a malformed id: 404 without asking Supabase', () => {
    for (const path of [
      '/battles/not-a-uuid',
      '/battles/x',
      `/battles/${ID}x`,
      `/battles/${ID}.txt`,
      '/battles/%E0%A4%A',
      `/battles/%22%3E%3Cscript%3E`,
    ]) {
      expect(previewTarget(path), path).toEqual({ kind: 'malformed' });
    }
  });

  it('anything else is not a battle page (Pages serves it as without the Function)', () => {
    for (const path of ['/battles', '/battles/', `/battles/${ID}/extra`, '/u/x', '/']) {
      expect(previewTarget(path), path).toEqual({ kind: 'other' });
    }
  });
});

describe('battlePreview: a public battle', () => {
  it('the winner with its screenshot: title, description, image, canonical URL', () => {
    const head = battlePreview(battle(), { id: ID, origin: ORIGIN });
    expect(head).toEqual({
      status: 200,
      documentTitle: 'Free Gift Card by Mallory · Build Roulette',
      title: 'Free Gift Card by Mallory',
      description:
        'Winner: Free Gift Card by Mallory. BUILD: A pomodoro timer · RULE: Only one button · STYLE: Brutalist · 5 min',
      image: {
        url: `${STORAGE}/${ID}/mallory.png`,
        width: 1280,
        height: 800,
        type: 'image/png',
        alt: 'Screenshot of Free Gift Card by Mallory',
      },
      url: `${ORIGIN}/battles/${ID}`,
      noindex: false,
    });
  });

  it('rank 1 without a screenshot: the static card, absolute on the site origin', () => {
    const head = battlePreview(battle({ screenshot_path: null }), { id: ID, origin: ORIGIN });
    expect(head.image).toEqual({ ...STATIC_OG_CARD, url: `${ORIGIN}/og-card.png` });
    expect(head.title).toBe('Free Gift Card by Mallory');
  });

  it('T-028: rank 1 taken down: the static card, no winner named, nobody promoted', () => {
    // get_public_battle drops a removed build's name and screenshot; an older server's
    // answer may still carry the screenshot path: it is not used either.
    const head = battlePreview(
      battle({ name: null, taken_down: true, screenshot_path: `${ID}/mallory.png` }),
      { id: ID, origin: ORIGIN },
    );
    expect(head.status).toBe(200);
    expect(head.title).toBe('A pomodoro timer · Battle results');
    expect(head.documentTitle).toBe('A pomodoro timer · Battle results · Build Roulette');
    expect(head.description).toBe(
      'BUILD: A pomodoro timer · RULE: Only one button · STYLE: Brutalist · 5 min',
    );
    expect(head.image).toEqual({ ...STATIC_OG_CARD, url: `${ORIGIN}/og-card.png` });
    const html = previewHeadHtml(head);
    for (const absent of ['Winner', 'Free Gift Card', 'mallory.png', 'Pomodoro Pal', 'ana.webp']) {
      expect(html, absent).not.toContain(absent);
    }
  });

  it('no winner when rank 1 is not ranked first (e.g. nothing was ranked)', () => {
    const head = battlePreview(battle({ final_rank: null }), { id: ID, origin: ORIGIN });
    expect(head.description).not.toContain('Winner');
  });
});

describe('battlePreview: not found', () => {
  it('unknown, not public yet, or malformed: 404, "Battle not found", noindex, the card', () => {
    for (const [data, id] of [
      [null, ID],
      [null, null],
    ] as const) {
      const head = battlePreview(data, { id, origin: ORIGIN });
      expect(head).toEqual({
        status: 404,
        documentTitle: 'Battle not found · Build Roulette',
        title: 'Battle not found',
        description: NOT_FOUND_DESCRIPTION,
        image: { ...STATIC_OG_CARD, url: `${ORIGIN}/og-card.png` },
        url: null,
        noindex: true,
      });
    }
  });
});

describe('previewHeadHtml', () => {
  it('writes the title, description, canonical, og:* and twitter:* tags', () => {
    const doc = parse(previewHeadHtml(battlePreview(battle(), { id: ID, origin: ORIGIN })));
    expect(doc.head.querySelectorAll('title')).toHaveLength(1);
    expect(doc.head.querySelector('title')?.textContent).toBe(
      'Free Gift Card by Mallory · Build Roulette',
    );
    expect(doc.head.querySelector('link[rel=canonical]')?.getAttribute('href')).toBe(
      `${ORIGIN}/battles/${ID}`,
    );
    expect(content(doc, 'meta[property="og:url"]')).toBe(`${ORIGIN}/battles/${ID}`);
    expect(content(doc, 'meta[property="og:type"]')).toBe('article');
    expect(content(doc, 'meta[property="og:title"]')).toBe('Free Gift Card by Mallory');
    expect(content(doc, 'meta[property="og:description"]')).toMatch(/^Winner: Free Gift Card/);
    expect(content(doc, 'meta[property="og:image"]')).toBe(`${STORAGE}/${ID}/mallory.png`);
    expect(content(doc, 'meta[property="og:image:width"]')).toBe('1280');
    expect(content(doc, 'meta[property="og:image:height"]')).toBe('800');
    expect(content(doc, 'meta[property="og:image:type"]')).toBe('image/png');
    expect(content(doc, 'meta[name="twitter:card"]')).toBe('summary_large_image');
    expect(content(doc, 'meta[name="twitter:image"]')).toBe(`${STORAGE}/${ID}/mallory.png`);
    expect(content(doc, 'meta[name="robots"]')).toBeNull();
  });

  it('an image of unknown size and type: no width, height or type tags', () => {
    const head = battlePreview(battle({ screenshot_path: `${ID}/m`, capture_status: 'pending' }), {
      id: ID,
      origin: ORIGIN,
    });
    const doc = parse(previewHeadHtml(head));
    expect(content(doc, 'meta[property="og:image"]')).toBe(`${STORAGE}/${ID}/m`);
    for (const tag of ['og:image:width', 'og:image:height', 'og:image:type']) {
      expect(doc.head.querySelector(`meta[property="${tag}"]`), tag).toBeNull();
    }
  });

  it('the 404 head: noindex, no canonical URL', () => {
    const doc = parse(previewHeadHtml(battlePreview(null, { id: null, origin: ORIGIN })));
    expect(content(doc, 'meta[name="robots"]')).toBe('noindex');
    expect(doc.head.querySelector('link[rel=canonical]')).toBeNull();
    expect(doc.head.querySelector('meta[property="og:url"]')).toBeNull();
    expect(content(doc, 'meta[property="og:title"]')).toBe('Battle not found');
  });

  it('replaces every tag of the kinds it writes (the selectors cover its own output)', () => {
    const doc = parse(previewHeadHtml(battlePreview(battle(), { id: ID, origin: ORIGIN })));
    const covered = doc.head.querySelectorAll(REPLACED_HEAD_ELEMENTS.join(', ')).length;
    expect(covered).toBe(doc.head.children.length);
  });
});

describe('escaping: names and challenge texts are user and deck data', () => {
  const ATTACKS = [
    '"><script>alert(1)</script>',
    "'><img src=x onerror=alert(1)>",
    '</title><script>alert(2)</script>',
    'Tom & Jerry <3 "quotes" \'single\'',
    '&lt;already escaped&gt; &amp;',
    '"/><meta property="og:image" content="https://evil.example/x.png',
  ];

  it('escapeHtml encodes & < > " \'', () => {
    expect(escapeHtml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
    expect(escapeHtml('plain · text')).toBe('plain · text');
  });

  for (const attack of ATTACKS) {
    it(`round-trips ${JSON.stringify(attack)} as text, adding no element`, () => {
      const data = battle({ name: attack, builder_name: attack });
      data.challenge.build.text = attack;
      data.challenge.rule.text = attack;
      data.challenge.style.text = attack;
      const head = battlePreview(data, { id: ID, origin: ORIGIN });
      const html = previewHeadHtml(head);
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      const doc = parse(html);
      // Exactly the tags it writes: nothing opened by the data.
      expect(doc.querySelectorAll('script, img')).toHaveLength(0);
      expect(doc.head.querySelectorAll('title')).toHaveLength(1);
      expect(doc.head.querySelectorAll('meta[property="og:image"]')).toHaveLength(1);
      expect(content(doc, 'meta[property="og:image"]')).toBe(`${STORAGE}/${ID}/mallory.png`);
      // Every value comes back exactly as the data had it.
      expect(doc.head.querySelector('title')?.textContent).toBe(head.documentTitle);
      expect(content(doc, 'meta[property="og:title"]')).toBe(`${attack} by ${attack}`);
      expect(content(doc, 'meta[name="twitter:title"]')).toBe(`${attack} by ${attack}`);
      expect(content(doc, 'meta[property="og:description"]')).toBe(head.description);
      expect(head.description).toContain(`RULE: ${attack}`);
      expect(content(doc, 'meta[property="og:image:alt"]')).toBe(
        `Screenshot of ${attack} by ${attack}`,
      );
    });
  }

  it('a screenshot path with odd characters stays one URL (percent-encoded, then escaped)', () => {
    const head = battlePreview(battle({ screenshot_path: `${ID}/a"b<c>&d.png` }), {
      id: ID,
      origin: ORIGIN,
    });
    const doc = parse(previewHeadHtml(head));
    expect(content(doc, 'meta[property="og:image"]')).toBe(`${STORAGE}/${ID}/a%22b%3Cc%3E%26d.png`);
  });
});
