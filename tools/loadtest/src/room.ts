/**
 * One room from creation to its last battle: sign-ins, create/join, ready, start (host),
 * the per-battle time compression, every player's session, and the room's battle records.
 */
import type { LoadConfig } from './config';
import { compressedSettings } from './config';
import { compressBattle, type Db } from './db';
import type { BattleRecord, Metrics } from './metrics';
import { sleep, type ClientDeps, SimPlayer } from './player';
import type { Rng } from './rng';
import { PlayerSession, type Outcome, type Plan } from './session';
import { bump } from './stats';

export interface RoomDeps {
  cfg: LoadConfig;
  client: ClientDeps;
  metrics: Metrics;
  db: Db;
  rng: Rng;
  log: (msg: string) => void;
}

/** Upper bound for one compressed battle, plus margin for a capture backlog. */
export function battleTimeoutMs(cfg: LoadConfig): number {
  const s =
    cfg.spinningS +
    cfg.buildS +
    cfg.shippingS +
    cfg.players * cfg.revealSlotS +
    cfg.votingS +
    cfg.resultsS +
    cfg.captureDeadlineS +
    180;
  return s * 1000;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(500 * 2 ** i);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function runRoom(deps: RoomDeps, roomIndex: number): Promise<void> {
  const { cfg, metrics, log } = deps;
  const rng = deps.rng.fork(roomIndex + 1);
  const players = Array.from(
    { length: cfg.players },
    (_, i) =>
      new SimPlayer(
        deps.client,
        `r${String(roomIndex)}p${String(i)}`,
        `P${String(i + 1)} R${String(roomIndex + 1)}`,
        rng.fork(100 + i),
      ),
  );
  try {
    await Promise.all(players.map((p) => withRetry(() => p.signIn())));
  } catch (e) {
    metrics.count('room_signin_failed');
    log(`room ${String(roomIndex)}: sign-in failed: ${(e as Error).message}`);
    await Promise.all(players.map((p) => p.stop()));
    return;
  }
  const host = players[0];
  if (!host) return;
  const created = await host.rpc<{ room_id: string; code: string }>('create_room', {
    p_display_name: host.name,
  });
  if (!created.data) {
    metrics.count('room_create_failed');
    log(`room ${String(roomIndex)}: create_room failed: ${created.error}`);
    await Promise.all(players.map((p) => p.stop()));
    return;
  }
  const { room_id: roomId, code } = created.data;
  const sessions = players.map(
    (p, i) => new PlayerSession(p, { cfg, roomId, rng: rng.fork(200 + i), log }),
  );
  const hostSession = sessions[0];
  if (!hostSession) return;
  await hostSession.start();
  await Promise.all(
    sessions.slice(1).map(async (s) => {
      await sleep(rng.between(200, 2500));
      const j = await s.player.rpc('join_room', { p_code: code, p_display_name: s.player.name });
      if (j.error) metrics.count(`join_failed:${j.error}`);
      await s.start();
    }),
  );

  let starter: SimPlayer = host;
  for (let n = 0; n < cfg.battlesPerRoom; n++) {
    await Promise.all(
      sessions.map(async (s) => {
        await sleep(rng.between(300, 3000));
        await s.player.rpc('set_ready', { p_room_id: roomId, p_ready: true });
      }),
    );
    let battleId: string | null = null;
    for (let attempt = 0; attempt < 15 && !battleId; attempt++) {
      const r = await starter.rpc<string>('start_battle', { p_room_id: roomId });
      if (r.data) battleId = r.data;
      else if (r.error === 'not_host') {
        // The host role moved (a silent host for 30 s): the new host starts, as in the app.
        const snap = await starter.rpc<{ room: { host_id: string } }>('get_room_snapshot', {
          p_room_id: roomId,
        });
        const next = players.find((p) => p.id === snap.data?.room.host_id);
        if (next) starter = next;
        metrics.count('host_moved_before_start');
      } else if (
        r.error === 'not_enough_players' ||
        r.error === 'room_busy' ||
        r.error === 'wrong_room_state'
      ) {
        await sleep(1000);
      } else break;
    }
    if (!battleId) {
      metrics.count('battle_start_failed');
      log(`room ${String(roomIndex)}: start_battle failed`);
      break;
    }
    let drawnBuildS: number | null = null;
    try {
      const c = await compressBattle(deps.db, battleId, compressedSettings(cfg), cfg.buildS);
      drawnBuildS = c.drawnBuildS;
      if (!c.ok) metrics.count('compress_missed');
    } catch (e) {
      metrics.count('compress_failed');
      log(`compress ${battleId}: ${(e as Error).message}`);
    }
    const plans: Plan[] = sessions.map(() => {
      const x = rng.next();
      return x < cfg.dnfShare ? 'dnf' : x < cfg.dnfShare + cfg.shipShare ? 'ship' : 'auto';
    });
    const record: BattleRecord = {
      battleId,
      roomId,
      players: cfg.players,
      plans: {},
      drawnBuildS,
      startedAt: Date.now(),
      endedAt: null,
      outcome: 'error',
      finalBuilds: 0,
    };
    for (const p of plans) bump(record.plans, p);
    metrics.raw.battles.push(record);
    const outcomes: Outcome[] = await Promise.all(
      sessions.map((s, i) => s.runBattle(battleId, plans[i] ?? 'auto', battleTimeoutMs(cfg))),
    );
    record.endedAt = Date.now();
    record.outcome = outcomes[0] ?? 'error';
    record.finalBuilds = hostSession.lastFinalBuilds;
    for (const o of outcomes) metrics.count(`battle_outcome_client:${o}`);
    log(
      `room ${String(roomIndex)} battle ${String(n + 1)}/${String(cfg.battlesPerRoom)}: ${record.outcome} in ${String(
        Math.round((record.endedAt - record.startedAt) / 1000),
      )} s`,
    );
    if (record.outcome !== 'destroyed') break;
    await sleep(rng.between(2000, 5000));
  }
  await Promise.all(sessions.map((s) => s.stop(true)));
}
