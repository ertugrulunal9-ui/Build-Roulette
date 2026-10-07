/**
 * One player's view of a room, modelled on the web client (apps/web/src/lib/room/sync.ts,
 * reveal-vote.ts and the solo controller in external mode):
 *
 * - **Room:** `room:{id}` with Presence (`{user_id, display_name, device, activity}`,
 *   ≤ 1 per 2 s and ≤ 4 per 30 s), `get_room_snapshot` on subscribe and on a version gap or
 *   a newer `room_version` in the heartbeat answer.
 * - **Heartbeat** every 10 s, plus the T-023 version check (`battles.version` via
 *   PostgREST) while a battle runs. **Clock:** 3 × `server_now` at start and every 60 s.
 * - **Battle:** `battle:{id}` without Presence; version rules (ignore stale, refetch on a
 *   gap); `get_battle_snapshot` after every `phase` event except a REVEAL slot step, after
 *   `capture` and `sync` events, after each deadline nudge. **Nudges:** at each deadline
 *   (+0–500 ms jitter) `advance_battle` with the snapshot's version, then a refetch; again
 *   every 5 s while the version does not move (e.g. RESULTS waiting for screenshots).
 * - **BUILDING:** autosave every 30 s (`autosave/{bundle.js,bundle.css,source.json}`, plus
 *   `manifest.json` once), a final autosave 3 s before the deadline, one more in the SHIPPING
 *   grace; a ship (`source.json, bundle.js, bundle.css, manifest.json, thumb.webp` then
 *   `ship_build`) at a random time for players who ship; presence activity changes every
 *   4–8 s (the throttle keeps it at ≤ 4 per 30 s).
 * - **REVEAL:** `get_reveal_builds` once, every build's `thumb.webp`, and the spotlighted
 *   and the next build's `bundle.js`, `bundle.css`, `manifest.json` (prefetch). The host
 *   clicks `reveal_next` in some slots (CAS, resent up to 3 times on a stale version with
 *   the same spotlight), the others time out.
 * - **VOTING:** `get_my_votes`, then one `cast_vote` per category (overall, rule, style,
 *   chaos) for a random other final build, sometimes a revote; a few voters stay silent.
 * - **RESULTS:** every screenshot through its public URL, as the results page's <img>s.
 *
 * Not simulated: the sandbox preview itself (bundling, iframes, the package CDN), spectators,
 * kicks, leaves and refreshes mid-battle (the chaos e2e covers those), host migration
 * (handled if it happens), solo battles, reports and the admin page.
 */
import type { LoadConfig } from './config';
import {
  MANIFEST_JSON,
  bundleCss,
  bundleJs,
  drawBuildSizes,
  sourceJson,
  thumbWebp,
  type BuildSizes,
} from './payloads';
import { now, sleep, type SimPlayer, type Topic } from './player';
import type { Rng } from './rng';

export type Plan = 'ship' | 'auto' | 'dnf';
export type Outcome = 'destroyed' | 'abandoned' | 'timeout' | 'error';

const CATEGORIES = ['overall', 'rule', 'style', 'chaos'] as const;
const TERMINAL = new Set(['destroyed', 'abandoned']);
const BUILD_NAMES = [
  'Pomodoro Pro',
  'Cat Clicker',
  'Weather Dial',
  'Pixel Garden',
  'Snake Again',
  'Mood Board',
  'Tiny Synth',
  'Quiz Blitz',
];

interface SnapBuild {
  id: string;
  builder_id: string;
  status: string;
  capture_status: string | null;
  screenshot_path: string | null;
}

interface BattleSnap {
  me: { user_id: string; is_host?: boolean; can_vote?: boolean };
  battle: {
    id: string;
    phase: string;
    version: number;
    phase_started_at: string | null;
    phase_ends_at: string | null;
    building_started_at: string | null;
    building_ends_at: string | null;
    reveal_order: string[] | null;
    reveal_index: number | null;
  };
  builds: SnapBuild[];
}

interface RevealBuild {
  build_id: string;
  position: number;
  files: { js: string | null; css: string | null; manifest: string | null; thumb: string | null };
}

interface BattleState {
  id: string;
  plan: Plan;
  silentVoter: boolean;
  sizes: BuildSizes;
  buildName: string;
  version: number;
  phase: string;
  phaseEndsAt: number | null;
  revealIndex: number;
  snap: BattleSnap | null;
  topic: Topic;
  entered: Set<string>;
  shipped: boolean;
  shipping: boolean;
  manifestUploaded: boolean;
  revealBuilds: RevealBuild[] | null;
  downloaded: Set<string>;
  hostActed: Set<number>;
  isHost: boolean;
  refetching: boolean;
  refetchAgain: boolean;
  nudgeTimer: NodeJS.Timeout | null;
  nudgeFor: number | null;
  lastNudge: { version: number; at: number } | null;
  timers: Set<NodeJS.Timeout>;
  finished: boolean;
  finish: (o: Outcome) => void;
  lines: number;
  typing: boolean;
}

export interface SessionDeps {
  cfg: LoadConfig;
  roomId: string;
  rng: Rng;
  log: (msg: string) => void;
}

/** A call, so TypeScript does not narrow the flag across awaits. */
const isOver = (b: { finished: boolean }): boolean => b.finished;
const wantsAgain = (b: { refetchAgain: boolean }): boolean => b.refetchAgain;

const ms = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);

export class PlayerSession {
  roomTopic: Topic | null = null;
  roomVersion = 0;
  battle: BattleState | null = null;
  /** Final builds of the last battle (REVEAL's reveal_order length). */
  lastFinalBuilds = 0;
  private stopped = false;
  private timers = new Set<NodeJS.Timeout>();
  private announced = new Set<string>();
  private waiters = new Map<string, () => void>();
  private presenceState = { lines: 0, last_build: 'ok' as const, typing: false };

  constructor(
    readonly player: SimPlayer,
    private readonly deps: SessionDeps,
  ) {}

  private get m() {
    return this.player.metrics;
  }

  private after(ms: number, fn: () => void, set: Set<NodeJS.Timeout> = this.timers): void {
    const t = setTimeout(
      () => {
        set.delete(t);
        fn();
      },
      Math.max(0, ms),
    );
    set.add(t);
  }

  // ─── Room ─────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const { roomId, cfg, rng } = this.deps;
    const topic = this.player.subscribe(`room:${roomId}`, { presence: true }, (p, at) => {
      this.onRoomEvent(p, at);
    });
    this.roomTopic = topic;
    const status = await topic.subscribe();
    if (status !== 'SUBSCRIBED') this.m.count(`room_subscribe_${status}`);
    this.trackPresence();
    await this.refetchRoom();
    await this.syncClock();
    this.after(rng.between(0, cfg.heartbeatMs), () => {
      this.heartbeatLoop();
    });
    this.after(cfg.clockResyncMs, () => {
      this.clockLoop();
    });
  }

  private trackPresence(): void {
    this.roomTopic?.track({
      user_id: this.player.id,
      display_name: this.player.name,
      device: 'desktop',
      activity: { ...this.presenceState },
    });
  }

  private onRoomEvent(p: Record<string, unknown>, at: number): void {
    const v = Number(p['version']);
    this.m.receipt(`r:${this.deps.roomId}`, v, at);
    if (v <= this.roomVersion) {
      this.m.count('room_event_stale');
    } else if (v > this.roomVersion + 1 && this.roomVersion > 0) {
      this.m.count('room_event_gap');
      void this.refetchRoom();
    } else {
      this.roomVersion = v;
    }
    const battleId = p['current_battle_id'];
    if (p['type'] === 'room' && typeof battleId === 'string') this.announce(battleId);
  }

  private announce(battleId: string): void {
    this.announced.add(battleId);
    this.waiters.get(battleId)?.();
    this.waiters.delete(battleId);
  }

  private async refetchRoom(): Promise<void> {
    this.m.count('room_snapshot_fetch');
    const r = await this.player.rpc<{
      room: { version: number; current_battle_id: string | null };
    }>('get_room_snapshot', { p_room_id: this.deps.roomId });
    if (r.data) {
      this.roomVersion = Math.max(this.roomVersion, r.data.room.version);
      if (r.data.room.current_battle_id) this.announced.add(r.data.room.current_battle_id);
    }
  }

  private heartbeatLoop(): void {
    if (this.stopped) return;
    void this.beat().finally(() => {
      this.after(this.deps.cfg.heartbeatMs, () => {
        this.heartbeatLoop();
      });
    });
  }

  private async beat(): Promise<void> {
    const b = this.battle;
    const check =
      b && !b.finished && !TERMINAL.has(b.phase)
        ? this.player.battleVersion(b.id).then((v) => {
            if (v !== null && v > b.version && !b.finished) {
              this.m.count('version_check_miss');
              void this.refetch(b);
            }
          })
        : Promise.resolve();
    const hb = await this.player.rpc<{ room_version: number }>('heartbeat', {
      p_room_id: this.deps.roomId,
    });
    if (hb.data && hb.data.room_version > this.roomVersion) {
      this.m.count('heartbeat_room_ahead');
      void this.refetchRoom();
    }
    await check;
  }

  private clockLoop(): void {
    if (this.stopped) return;
    void this.syncClock().finally(() => {
      this.after(this.deps.cfg.clockResyncMs, () => {
        this.clockLoop();
      });
    });
  }

  /** 3 samples of server_now, keep the one with the lowest round trip (the client's rule). */
  private async syncClock(): Promise<void> {
    let best: { rtt: number; offset: number } | null = null;
    for (let i = 0; i < 3; i++) {
      const t0 = now();
      const r = await this.player.rpc<string>('server_now');
      const t1 = now();
      if (!r.data) continue;
      const server = Date.parse(r.data);
      const sample = { rtt: t1 - t0, offset: (t0 + t1) / 2 - server };
      if (!best || sample.rtt < best.rtt) best = sample;
    }
    if (best) this.m.raw.clockOffsetMs.push(Math.round(best.offset * 100) / 100);
  }

  /** Waits for the room event that names the battle (the realistic path), else asks. */
  async waitForBattle(battleId: string, timeoutMs = 3000): Promise<void> {
    if (this.announced.has(battleId)) return;
    const seen = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(battleId);
        resolve(false);
      }, timeoutMs);
      this.waiters.set(battleId, () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    if (!seen) {
      this.m.count('battle_announce_fallback');
      await this.refetchRoom();
    }
  }

  // ─── Battle ───────────────────────────────────────────────────────────────────────

  async runBattle(battleId: string, plan: Plan, timeoutMs: number): Promise<Outcome> {
    const { rng } = this.deps;
    await this.waitForBattle(battleId);
    if (this.battle) await this.battle.topic.close();
    let finish: (o: Outcome) => void = () => undefined;
    const done = new Promise<Outcome>((resolve) => {
      finish = resolve;
    });
    const b: BattleState = {
      id: battleId,
      plan,
      silentVoter: rng.chance(this.deps.cfg.silentVoterShare),
      sizes: drawBuildSizes(rng),
      buildName: `${rng.pick(BUILD_NAMES)} ${String(rng.int(1, 99))}`,
      version: 0,
      phase: '',
      phaseEndsAt: null,
      revealIndex: -1,
      snap: null,
      topic: this.player.subscribe(`battle:${battleId}`, { presence: false }, (p, at) => {
        this.onBattleEvent(b, p, at);
      }),
      entered: new Set(),
      shipped: false,
      shipping: false,
      manifestUploaded: false,
      revealBuilds: null,
      downloaded: new Set(),
      hostActed: new Set(),
      isHost: false,
      refetching: false,
      refetchAgain: false,
      nudgeTimer: null,
      nudgeFor: null,
      lastNudge: null,
      timers: new Set(),
      finished: false,
      finish: (o) => {
        if (b.finished) return;
        b.finished = true;
        for (const t of b.timers) clearTimeout(t);
        b.timers.clear();
        if (b.nudgeTimer) clearTimeout(b.nudgeTimer);
        finish(o);
      },
      lines: 0,
      typing: false,
    };
    this.battle = b;
    this.after(
      timeoutMs,
      () => {
        b.finish('timeout');
      },
      b.timers,
    );
    const status = await b.topic.subscribe();
    if (status !== 'SUBSCRIBED') this.m.count(`battle_subscribe_${status}`);
    await this.refetch(b);
    return done;
  }

  private onBattleEvent(b: BattleState, p: Record<string, unknown>, at: number): void {
    const v = Number(p['version']);
    this.m.receipt(`b:${b.id}`, v, at);
    if (b.finished) return;
    if (v <= b.version) {
      this.m.count('battle_event_stale');
      return;
    }
    if (v > b.version + 1) {
      // Includes events that arrive before the first snapshot (version 0).
      this.m.count(b.version === 0 ? 'battle_event_before_snapshot' : 'battle_event_gap');
      void this.refetch(b);
      return;
    }
    b.version = v;
    switch (p['type']) {
      case 'phase': {
        const to = String(p['phase']);
        b.phaseEndsAt = ms(p['phase_ends_at'] as string | null);
        if (to === 'reveal' && b.phase === 'reveal') {
          b.revealIndex = Number(p['reveal_index']);
          this.onState(b);
        } else {
          b.phase = to;
          if (to === 'reveal') b.revealIndex = Number(p['reveal_index']);
          this.scheduleNudge(b);
          void this.refetch(b);
        }
        break;
      }
      case 'capture':
      case 'sync':
        void this.refetch(b);
        break;
      case 'host':
        b.isHost = p['host_id'] === this.player.id;
        break;
      default:
        break;
    }
  }

  private async refetch(b: BattleState): Promise<void> {
    if (b.refetching) {
      b.refetchAgain = true;
      return;
    }
    b.refetching = true;
    try {
      do {
        b.refetchAgain = false;
        this.m.count('battle_snapshot_fetch');
        const r = await this.player.rpc<BattleSnap>('get_battle_snapshot', { p_battle_id: b.id });
        if (r.data && !b.finished) this.applySnapshot(b, r.data);
      } while (wantsAgain(b) && !isOver(b));
    } finally {
      b.refetching = false;
    }
  }

  private applySnapshot(b: BattleState, s: BattleSnap): void {
    b.snap = s;
    if (s.battle.version >= b.version) {
      b.version = s.battle.version;
      b.phase = s.battle.phase;
      b.phaseEndsAt = ms(s.battle.phase_ends_at);
      b.revealIndex = s.battle.reveal_index ?? -1;
    } else {
      this.m.count('snapshot_older_than_events');
    }
    b.isHost = s.me.is_host === true;
    this.onState(b);
  }

  private onState(b: BattleState): void {
    if (b.finished) return;
    this.scheduleNudge(b);
    const phase = b.phase;
    if (!b.entered.has(phase)) {
      b.entered.add(phase);
      this.enter(b, phase);
    }
    if (phase === 'reveal') this.onRevealSlot(b);
    if (phase === 'results' || phase === 'destroyed') this.downloadScreenshots(b);
    if (TERMINAL.has(phase)) b.finish(phase === 'destroyed' ? 'destroyed' : 'abandoned');
  }

  /** The deadline nudge of the solo controller (also used by room battles). */
  private scheduleNudge(b: BattleState): void {
    if (b.finished || TERMINAL.has(b.phase) || b.phaseEndsAt === null) return;
    if (b.nudgeFor === b.version && b.nudgeTimer) return;
    if (b.nudgeTimer) clearTimeout(b.nudgeTimer);
    const t = now();
    let delay = b.phaseEndsAt - t + this.deps.rng.between(0, 500);
    if (b.lastNudge?.version === b.version) delay = Math.max(delay, b.lastNudge.at + 5000 - t);
    b.nudgeFor = b.version;
    b.nudgeTimer = setTimeout(
      () => {
        b.nudgeTimer = null;
        void this.nudge(b);
      },
      Math.max(0, delay),
    );
  }

  private async nudge(b: BattleState): Promise<void> {
    if (b.finished) return;
    const version = b.version;
    b.lastNudge = { version, at: now() };
    this.m.count('nudge');
    await this.player.rpc('advance_battle', { p_battle_id: b.id, p_expected_version: version });
    await this.refetch(b);
    if (isOver(b)) return;
    b.nudgeFor = null;
    this.scheduleNudge(b);
  }

  private enter(b: BattleState, phase: string): void {
    switch (phase) {
      case 'building':
        this.enterBuilding(b);
        break;
      case 'shipping':
        if (b.plan === 'auto' && !b.shipped) void this.autosave(b);
        break;
      case 'reveal':
        void this.enterReveal(b);
        break;
      case 'voting':
        this.enterVoting(b);
        break;
      default:
        break;
    }
  }

  private enterBuilding(b: BattleState): void {
    const { cfg, rng } = this.deps;
    const s = b.snap?.battle;
    const start = ms(s?.building_started_at) ?? now();
    const end = ms(s?.building_ends_at) ?? b.phaseEndsAt ?? start + cfg.buildS * 1000;
    const dur = Math.max(1000, end - start);
    const progress = () => Math.min(1, Math.max(0, (now() - start) / dur));
    // Presence: activity changes while typing; the throttle keeps it within budget.
    const activity = () => {
      if (b.finished || b.phase !== 'building' || this.stopped) return;
      b.typing = !b.typing;
      b.lines += rng.int(0, 12);
      this.presenceState = { lines: b.lines, last_build: 'ok', typing: b.typing };
      this.trackPresence();
      this.after(rng.between(4000, 8000), activity, b.timers);
    };
    this.after(rng.between(500, 3000), activity, b.timers);
    if (b.plan === 'dnf') return;
    const autosaveLoop = () => {
      if (b.finished || b.phase !== 'building' || b.shipped) return;
      void this.autosave(b, progress()).finally(() => {
        this.after(cfg.autosaveMs, autosaveLoop, b.timers);
      });
    };
    this.after(cfg.autosaveMs, autosaveLoop, b.timers);
    this.after(
      end - now() - 3000,
      () => {
        if (!b.shipped && b.phase === 'building') void this.autosave(b, 1);
      },
      b.timers,
    );
    if (b.plan === 'ship') {
      const at = start + dur * rng.between(0.35, 0.95);
      this.after(at - now(), () => void this.ship(b), b.timers);
    }
  }

  private path(b: BattleState, file: string): string {
    return `${b.id}/${this.player.id}/${file}`;
  }

  private async autosave(b: BattleState, progress = 1): Promise<void> {
    const rng = this.deps.rng;
    this.m.count('autosave');
    const files: [string, string, string][] = [
      ['autosave/bundle.js', bundleJs(rng, b.sizes, b.buildName, progress), 'text/javascript'],
      ['autosave/bundle.css', bundleCss(rng, b.sizes, progress), 'text/css'],
      ['autosave/source.json', sourceJson(rng, b.sizes, progress), 'application/json'],
    ];
    if (!b.manifestUploaded)
      files.push(['autosave/manifest.json', MANIFEST_JSON, 'application/json']);
    const ok = await Promise.all(
      files.map(([f, body, type]) => this.player.upload(this.path(b, f), body, type)),
    );
    if (ok.every(Boolean)) b.manifestUploaded = true;
    else this.m.count('autosave_failed');
  }

  private async ship(b: BattleState): Promise<void> {
    if (b.finished || b.phase !== 'building' || b.shipped || b.shipping) {
      this.m.count('ship_skipped');
      return;
    }
    b.shipping = true;
    const rng = this.deps.rng;
    const uploads: [string, string | Uint8Array<ArrayBuffer>, string][] = [
      ['source.json', sourceJson(rng, b.sizes, 1), 'application/json'],
      ['bundle.js', bundleJs(rng, b.sizes, b.buildName, 1), 'text/javascript'],
      ['bundle.css', bundleCss(rng, b.sizes, 1), 'text/css'],
      ['manifest.json', MANIFEST_JSON, 'application/json'],
      ['thumb.webp', thumbWebp(rng, b.sizes), 'image/webp'],
    ];
    const ok = await Promise.all(
      uploads.map(([f, body, type]) => this.player.upload(this.path(b, f), body, type)),
    );
    if (!ok[0] || !ok[1]) {
      this.m.count('ship_upload_failed');
      b.shipping = false;
      return;
    }
    const r = await this.player.rpc('ship_build', {
      p_battle_id: b.id,
      p_name: b.buildName,
      p_stats: {
        files: 4,
        lines: b.lines + 40,
        bundle_bytes: b.sizes.bundle,
        rebuilds: rng.int(5, 80),
        pastes: rng.int(0, 5),
      },
    });
    b.shipping = false;
    if (r.error) {
      this.m.count(`ship_failed`);
      return;
    }
    b.shipped = true;
    this.m.count('shipped');
  }

  private async enterReveal(b: BattleState): Promise<void> {
    for (let attempt = 0; attempt < 4 && !b.finished; attempt++) {
      const r = await this.player.rpc<RevealBuild[]>('get_reveal_builds', { p_battle_id: b.id });
      if (r.data) {
        b.revealBuilds = r.data;
        break;
      }
      await sleep(1000);
    }
    const list = b.revealBuilds;
    if (!list) return;
    this.lastFinalBuilds = list.length;
    await Promise.all(
      list.map((rb) => (rb.files.thumb ? this.fetchOnce(b, rb.files.thumb) : Promise.resolve())),
    );
    this.onRevealSlot(b);
  }

  private fetchOnce(b: BattleState, path: string): Promise<void> {
    if (b.downloaded.has(path)) return Promise.resolve();
    b.downloaded.add(path);
    return this.player.download(path).then(() => undefined);
  }

  private onRevealSlot(b: BattleState): void {
    const list = b.revealBuilds;
    const i = b.revealIndex;
    if (!list || i < 0 || b.phase !== 'reveal') return;
    for (const rb of [list[i], list[i + 1]]) {
      if (!rb) continue;
      for (const p of [rb.files.js, rb.files.css, rb.files.manifest])
        if (p) void this.fetchOnce(b, p);
    }
    if (b.isHost && !b.hostActed.has(i)) {
      b.hostActed.add(i);
      const { cfg, rng } = this.deps;
      if (rng.chance(cfg.hostNextShare)) {
        this.after(
          cfg.revealSlotS * 1000 * rng.between(0.5, 0.9),
          () => void this.hostNext(b, i),
          b.timers,
        );
      }
    }
  }

  private async hostNext(b: BattleState, index: number): Promise<void> {
    let version = b.version;
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (b.finished || b.phase !== 'reveal' || b.revealIndex !== index) return;
      const r = await this.player.rpc<{
        changed: boolean;
        version: number;
        phase: string;
        reveal_index: number | null;
      }>('reveal_next', { p_battle_id: b.id, p_expected_version: version });
      if (!r.data || r.data.changed) return;
      if (r.data.phase !== 'reveal' || r.data.reveal_index !== index) return;
      this.m.count('host_reveal_resend');
      version = r.data.version;
    }
  }

  private enterVoting(b: BattleState): void {
    const { cfg, rng } = this.deps;
    void this.player.rpc('get_my_votes', { p_battle_id: b.id });
    const snap = b.snap;
    if (!snap || b.silentVoter || snap.me.can_vote === false) {
      if (b.silentVoter) this.m.count('silent_voter');
      return;
    }
    const mine = snap.builds.find((x) => x.builder_id === this.player.id)?.id;
    const candidates = (snap.battle.reveal_order ?? []).filter((id) => id !== mine);
    if (candidates.length === 0) return;
    let t = rng.between(1000, Math.max(1500, cfg.votingS * 1000 * 0.35));
    const vote = (category: string, buildId: string) => () => {
      if (b.finished || b.phase !== 'voting') return;
      this.m.count('vote');
      void this.player.rpc('cast_vote', {
        p_battle_id: b.id,
        p_category: category,
        p_build_id: buildId,
      });
    };
    for (const c of CATEGORIES) {
      this.after(t, vote(c, rng.pick(candidates)), b.timers);
      t += rng.between(300, 1500);
    }
    if (rng.chance(0.1)) this.after(t + 500, vote('overall', rng.pick(candidates)), b.timers);
  }

  private downloadScreenshots(b: BattleState): void {
    for (const build of b.snap?.builds ?? []) {
      const p = build.screenshot_path;
      if (!p || b.downloaded.has(`shot:${p}`)) continue;
      b.downloaded.add(`shot:${p}`);
      void this.player.downloadPublic(p);
    }
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────────────

  async stop(leave: boolean): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.battle?.finish('timeout');
    if (leave) await this.player.rpc('leave_room', { p_room_id: this.deps.roomId });
    await this.battle?.topic.close();
    await this.roomTopic?.close();
    await this.player.stop();
  }
}
