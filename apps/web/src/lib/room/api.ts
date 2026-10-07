/**
 * The room RPCs (supabase/README.md "Rooms and multiplayer") and Supabase Realtime, behind
 * interfaces so the sync engine and the room controller can be unit tested with fakes.
 * Every method throws a `GameError`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { EPHEMERAL_BUCKET } from '../supabase/config';
import { toGameError } from '../solo/errors';
import type {
  BattleSnapshot,
  CastVoteResult,
  HostRevealResult,
  MyVotes,
  RevealBuild,
} from '../solo/types';
import type { RevealVoteApi } from './reveal-vote';
import type { ChannelStatus, RealtimePort, RoomSyncApi, TopicSubscription } from './sync';
import type { HeartbeatResult, JoinResult, RoomSettings, RoomSnapshot } from './types';

export interface RoomApi extends RoomSyncApi, RevealVoteApi {
  /** Signs in anonymously if needed; returns the user id. */
  ensureSession(): Promise<string>;
  /** The profile's display name, or null when the user has none yet. */
  profileName(userId: string): Promise<string | null>;
  createRoom(displayName: string): Promise<JoinResult>;
  joinRoom(code: string, displayName: string): Promise<JoinResult>;
  leaveRoom(roomId: string): Promise<void>;
  setReady(roomId: string, ready: boolean): Promise<void>;
  updateSettings(roomId: string, settings: RoomSettings): Promise<RoomSettings>;
  kickMember(roomId: string, userId: string): Promise<void>;
  /** Returns the new battle's id. */
  startBattle(roomId: string): Promise<string>;
}

export class SupabaseRoomApi implements RoomApi {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly signIn: (s: SupabaseClient) => Promise<string>,
  ) {}

  ensureSession(): Promise<string> {
    return this.signIn(this.supabase).catch((e: unknown) => {
      throw toGameError(e);
    });
  }

  private async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    let res;
    try {
      res = await this.supabase.rpc(fn, args);
    } catch (e) {
      throw toGameError(e);
    }
    if (res.error) throw toGameError(res.error);
    return res.data as T;
  }

  async profileName(userId: string): Promise<string | null> {
    let res;
    try {
      res = await this.supabase
        .from('profiles')
        .select('display_name')
        .eq('id', userId)
        .maybeSingle<{ display_name: string }>();
    } catch (e) {
      throw toGameError(e);
    }
    if (res.error) throw toGameError(res.error);
    const name = res.data?.display_name.trim() ?? '';
    return name.length > 0 ? name : null;
  }

  async serverNow(): Promise<number> {
    const iso = await this.rpc<string>('server_now');
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) throw toGameError(new Error(`server_now returned ${iso}`));
    return t;
  }

  createRoom(displayName: string): Promise<JoinResult> {
    return this.rpc<JoinResult>('create_room', { p_display_name: displayName });
  }

  joinRoom(code: string, displayName: string): Promise<JoinResult> {
    return this.rpc<JoinResult>('join_room', { p_code: code, p_display_name: displayName });
  }

  async leaveRoom(roomId: string): Promise<void> {
    await this.rpc('leave_room', { p_room_id: roomId });
  }

  async setReady(roomId: string, ready: boolean): Promise<void> {
    await this.rpc('set_ready', { p_room_id: roomId, p_ready: ready });
  }

  updateSettings(roomId: string, settings: RoomSettings): Promise<RoomSettings> {
    return this.rpc<RoomSettings>('update_room_settings', {
      p_room_id: roomId,
      p_settings: settings,
    });
  }

  async kickMember(roomId: string, userId: string): Promise<void> {
    await this.rpc('kick_member', { p_room_id: roomId, p_user_id: userId });
  }

  startBattle(roomId: string): Promise<string> {
    return this.rpc<string>('start_battle', { p_room_id: roomId });
  }

  heartbeat(roomId: string): Promise<HeartbeatResult> {
    return this.rpc<HeartbeatResult>('heartbeat', { p_room_id: roomId });
  }

  getRoomSnapshot(roomId: string): Promise<RoomSnapshot> {
    return this.rpc<RoomSnapshot>('get_room_snapshot', { p_room_id: roomId });
  }

  getBattleSnapshot(battleId: string): Promise<BattleSnapshot> {
    return this.rpc<BattleSnapshot>('get_battle_snapshot', { p_battle_id: battleId });
  }

  // --- REVEAL and VOTING (supabase/README.md "Reveal and voting") ----------------------

  getRevealBuilds(battleId: string): Promise<RevealBuild[]> {
    return this.rpc<RevealBuild[]>('get_reveal_builds', { p_battle_id: battleId });
  }

  revealNext(battleId: string, expectedVersion: number): Promise<HostRevealResult> {
    return this.rpc<HostRevealResult>('reveal_next', {
      p_battle_id: battleId,
      p_expected_version: expectedVersion,
    });
  }

  skipToVote(battleId: string, expectedVersion: number): Promise<HostRevealResult> {
    return this.rpc<HostRevealResult>('skip_to_vote', {
      p_battle_id: battleId,
      p_expected_version: expectedVersion,
    });
  }

  castVote(battleId: string, category: string, buildId: string): Promise<CastVoteResult> {
    return this.rpc<CastVoteResult>('cast_vote', {
      p_battle_id: battleId,
      p_category: category,
      p_build_id: buildId,
    });
  }

  getMyVotes(battleId: string): Promise<MyVotes> {
    return this.rpc<MyVotes>('get_my_votes', { p_battle_id: battleId });
  }

  /**
   * A revealed object of another player (storage RLS: battle members, REVEAL to RESULTS).
   * Null when it does not exist; any other failure throws.
   */
  async downloadBlob(path: string): Promise<Blob | null> {
    let res;
    try {
      res = await this.supabase.storage.from(EPHEMERAL_BUCKET).download(path);
    } catch (e) {
      throw toGameError(e);
    }
    if (res.error) {
      // supabase-js reports a missing (or unreadable) object as a 400/404 StorageError.
      const err = res.error as { message: string; statusCode?: string; status?: number };
      const status = String(err.statusCode ?? err.status ?? '');
      if (status === '404' || status === '400' || /not found/i.test(err.message)) return null;
      throw toGameError(res.error);
    }
    return res.data;
  }

  async downloadText(path: string): Promise<string | null> {
    const blob = await this.downloadBlob(path);
    return blob === null ? null : blob.text();
  }
}

/**
 * Supabase Realtime as a RealtimePort: private channels (`config.private`), one presence key
 * per user, every broadcast event (`event: '*'`; the event name is the payload's `type`).
 */
export class SupabaseRealtime implements RealtimePort {
  /**
   * supabase-js keeps one channel object per topic name, so a topic that is being removed
   * (a rejoin right after leaving) must be gone before it is subscribed again.
   */
  private readonly removing = new Map<string, Promise<unknown>>();

  constructor(private readonly supabase: SupabaseClient) {}

  async setAuth(): Promise<void> {
    // No argument: Realtime asks supabase-js for the session's access token.
    await this.supabase.realtime.setAuth();
  }

  subscribe(
    topic: string,
    opts: { presenceKey: string | null },
    handlers: {
      broadcast(event: string, payload: unknown): void;
      presence(state: Record<string, unknown[]>): void;
      status(status: ChannelStatus, error?: string): void;
    },
  ): TopicSubscription {
    let closed = false;
    const key = opts.presenceKey;
    const ready = (this.removing.get(topic) ?? Promise.resolve()).then(() => {
      if (closed) return null;
      const channel = this.supabase.channel(topic, {
        config: key === null ? { private: true } : { private: true, presence: { key } },
      });
      channel.on('broadcast', { event: '*' }, (msg: { event: string; payload?: unknown }) => {
        if (!closed) handlers.broadcast(msg.event, msg.payload);
      });
      // Presence is joined only where it is used (the room topic).
      if (key !== null) {
        channel.on('presence', { event: 'sync' }, () => {
          if (!closed) handlers.presence(channel.presenceState());
        });
      }
      channel.subscribe((status, err) => {
        if (closed) return;
        handlers.status(status, err?.message);
      });
      return channel;
    });
    return {
      track: async (payload) => {
        const channel = await ready;
        if (!channel || closed) return false;
        try {
          return (await channel.track(payload)) === 'ok';
        } catch {
          return false;
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        const removal = ready
          .then((channel) => (channel ? this.supabase.removeChannel(channel) : null))
          .catch(() => null)
          .finally(() => {
            if (this.removing.get(topic) === removal) this.removing.delete(topic);
          });
        this.removing.set(topic, removal);
      },
    };
  }
}
