import { ImageResponse } from 'next/og';
import { formatTimeLimit } from '../../../lib/solo/format';
import { ogTopBuild } from '../../../lib/solo/og-card';
import { loadPublicBattle } from '../../../lib/solo/public-battle';
import { screenshotUrl } from '../../../lib/supabase/config';

/**
 * The social card of a battle (docs/01 §1.3): the challenge, the top build, and its
 * screenshot. With voting (M4): the winner's votes and its category awards (text only:
 * satori would fetch emoji images from a CDN). A top build a moderator removed after
 * RESULTS (T-028) has no WINNER chip and no awards, only its rank and votes; the next
 * build is not promoted (lib/solo/og-card.ts).
 *
 * `next/og` (satori + resvg) decodes only PNG, JPEG and GIF. The capture worker stores
 * WebP locally (sharp), and the planned Browser Rendering path may store PNG
 * (apps/capture-worker README). So a PNG/JPEG screenshot is embedded, and a WebP one is
 * replaced by a framed card with the build's name: decoding WebP here would need a wasm
 * codec in the Worker bundle. Follow-up: a PNG card image from the capture worker, or
 * Cloudflare image transformations in production.
 *
 * Cached like the page (T-026): ISR with the lifetime and the `battle:{id}` tag of
 * `loadPublicBattle`, so a takedown re-renders it at once. The screenshot is fetched
 * `no-store` (`force-static` keeps that from turning the route dynamic): only the finished
 * PNG is cached, never a copy of the screenshot, which a takedown deletes from Storage.
 */

export const dynamic = 'force-static';
/** The longest a card is cached (SETTLED_BATTLE.revalidate, as a literal for Next). */
export const revalidate = 3600;
export const alt = 'Build Roulette battle results';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** The screenshot as a data URL satori can draw, or null (missing, WebP, too large). */
async function embeddableScreenshot(path: string): Promise<string | null> {
  try {
    const res = await fetch(screenshotUrl(path), { cache: 'no-store' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > 2 * 1024 * 1024) return null;
    if (startsWith(bytes, PNG)) return `data:image/png;base64,${toBase64(bytes)}`;
    if (startsWith(bytes, JPEG)) return `data:image/jpeg;base64,${toBase64(bytes)}`;
    return null;
  } catch {
    return null;
  }
}

const CHIP: Record<'build' | 'rule' | 'style', { bg: string; fg: string }> = {
  build: { bg: '#0ea5e9', fg: '#ffffff' },
  rule: { bg: '#f59e0b', fg: '#1c1917' },
  style: { bg: '#d946ef', fg: '#ffffff' },
};

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A failed read throws (a 500, not cached; ISR keeps serving the last good card).
  const data = await loadPublicBattle(id.toLowerCase());

  if (!data) {
    return new ImageResponse(
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#09090b',
          color: '#fafafa',
          fontSize: 72,
          fontWeight: 900,
        }}
      >
        Build Roulette
      </div>,
      size,
    );
  }

  const card = ogTopBuild(data);
  const top = card?.build ?? null;
  const shot =
    top?.screenshot_path && top.taken_down !== true
      ? await embeddableScreenshot(top.screenshot_path)
      : null;
  const { challenge } = data;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: '#09090b',
        color: '#fafafa',
        padding: 48,
        gap: 40,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 18 }}>
        <div style={{ display: 'flex', fontSize: 26, fontWeight: 800, color: '#a1a1aa' }}>
          BUILD ROULETTE · {formatTimeLimit(challenge.time_limit_seconds)}
        </div>
        {(['build', 'rule', 'style'] as const).map((k) => (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div
              style={{
                display: 'flex',
                alignSelf: 'flex-start',
                background: CHIP[k].bg,
                color: CHIP[k].fg,
                fontSize: 18,
                fontWeight: 900,
                letterSpacing: 4,
                padding: '2px 10px',
                borderRadius: 6,
              }}
            >
              {k.toUpperCase()}
            </div>
            <div style={{ display: 'flex', fontSize: k === 'build' ? 46 : 32, fontWeight: 800 }}>
              {challenge[k].text}
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', flex: 1 }} />
        {card && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {card.chip && (
              <div
                style={{
                  display: 'flex',
                  alignSelf: 'flex-start',
                  background: card.chip.tone === 'winner' ? '#fbbf24' : '#3f3f46',
                  color: card.chip.tone === 'winner' ? '#1c1917' : '#e4e4e7',
                  fontSize: 18,
                  fontWeight: 900,
                  letterSpacing: 4,
                  padding: '2px 10px',
                  borderRadius: 6,
                }}
              >
                {card.chip.text}
              </div>
            )}
            <div style={{ display: 'flex', fontSize: 34, fontWeight: 900 }}>{card.title}</div>
            <div style={{ display: 'flex', fontSize: 24, color: '#d4d4d8' }}>{card.byline}</div>
            {card.awards.length > 0 && (
              <div style={{ display: 'flex', fontSize: 22, color: '#fcd34d' }}>
                {card.awards.join(' · ')}
              </div>
            )}
          </div>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          width: 520,
          alignSelf: 'center',
          height: 325,
          borderRadius: 18,
          overflow: 'hidden',
          border: '4px solid #3f3f46',
          background: '#18181b',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {shot ? (
          <img src={shot} width={520} height={325} alt="" style={{ objectFit: 'cover' }} />
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              padding: 24,
              color: '#a1a1aa',
              fontSize: 26,
              textAlign: 'center',
            }}
          >
            <div style={{ display: 'flex', fontSize: 40, fontWeight: 900, color: '#fafafa' }}>
              {top?.name ?? challenge.build.text}
            </div>
            <div style={{ display: 'flex' }}>Builds are temporary.</div>
            <div style={{ display: 'flex' }}>Results are permanent.</div>
          </div>
        )}
      </div>
    </div>,
    size,
  );
}
