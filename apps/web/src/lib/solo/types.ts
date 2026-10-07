/**
 * Shapes returned by the solo RPCs (supabase/migrations/20261004120300_solo_battle.sql and
 * 20261006120000_autosave_css_and_public_battle.sql). Timestamps are ISO strings.
 */
import type { BattlePhase, BattleRole, BuildStatus, CaptureStatus, MemberState } from '@br/game';

export type { BuildStatus, CaptureStatus };
/** Auto-awards, and one award per vote category (`award` = the category slug, M4). */
export type AwardKind =
  | 'clutch_ship'
  | 'speedrun'
  | 'fastest_ship'
  | 'overall'
  | 'rule'
  | 'style'
  | 'chaos'
  | (string & {});

/** Per-category vote counts of a final build, frozen at RESULTS (`{overall: 2, …}`). */
export type VoteCounts = Record<string, number>;

/** A vote category of the battle (`vote_categories` in the multiplayer snapshot). */
export interface VoteCategoryInfo {
  slug: string;
  label: string;
  description: string;
}

/** `vote_progress`: eligible voters, and how many completed their ballot. Counts only. */
export interface VoteProgress {
  voted_count: number;
  eligible_count: number;
}

export interface ChallengeCard {
  text: string;
  hint: string | null;
}

export interface Challenge {
  build: ChallengeCard;
  rule: ChallengeCard;
  style: ChallengeCard;
  time_limit_seconds: number;
}

export interface BuildStats {
  files?: number;
  lines?: number;
  deps?: string[];
  bundle_bytes?: number;
  rebuilds?: number;
  pastes?: number;
}

export interface Award {
  build_id: string;
  award: AwardKind;
  source: string;
  votes: number | null;
}

/**
 * `get_battle_snapshot` (members, or anyone signed in once RESULTS/DESTROYED). Multiplayer
 * battles add `me.role`, `me.is_host` and `players[].state` (T-016), and the REVEAL / VOTING
 * fields (T-019): `battle.reveal_*`, `me.is_voter`, `me.can_vote`, `vote_categories`,
 * `vote_progress` and `builds[].votes`.
 */
export interface BattleSnapshot {
  server_now: string;
  me: {
    user_id: string;
    is_player: boolean;
    role?: BattleRole;
    is_host?: boolean;
    /** On the roster, a voter, not kicked. */
    is_voter?: boolean;
    /** is_voter, still in the room, VOTING before its deadline. */
    can_vote?: boolean;
  };
  battle: {
    id: string;
    room_id: string | null;
    host_id: string;
    mode: string;
    phase: BattlePhase;
    version: number;
    phase_started_at: string | null;
    phase_ends_at: string | null;
    building_started_at: string | null;
    building_ends_at: string | null;
    shipping_ended_at: string | null;
    finished_at: string | null;
    destroyed_at: string | null;
    is_complete: boolean;
    created_at: string;
    /** Multiplayer: this battle has REVEAL and VOTING. */
    reveal_vote?: boolean;
    /** Multiplayer: the final builds' ids in reveal order (null without a reveal). */
    reveal_order?: string[] | null;
    /** Multiplayer: the spotlighted position in `reveal_order` (0-based). */
    reveal_index?: number | null;
    /** Multiplayer: the slot length in seconds (null without a reveal). */
    reveal_slot_s?: number | null;
  };
  challenge: Challenge & { id: string };
  players: SnapshotPlayer[];
  builds: SnapshotBuild[];
  awards: Award[];
  /** Multiplayer: the active categories in display order. */
  vote_categories?: VoteCategoryInfo[];
  /** Multiplayer, VOTING only (null otherwise). */
  vote_progress?: VoteProgress | null;
}

export interface SnapshotPlayer {
  user_id: string;
  display_name: string;
  /** Multiplayer only: the roster player's room membership. */
  state?: MemberState;
}

export interface SnapshotBuild {
  id: string;
  builder_id: string;
  name: string | null;
  status: BuildStatus;
  shipped_at: string | null;
  completion_ms: number | null;
  stats: BuildStats;
  capture_status: CaptureStatus;
  screenshot_path: string | null;
  captured_at: string | null;
  source_destroyed_at: string | null;
  final_rank: number | null;
  total_votes: number;
  /** Multiplayer: per-category votes, null until RESULTS (and for builds that were not final). */
  votes?: VoteCounts | null;
}

/** `advance_battle` */
export interface AdvanceResult {
  changed: boolean;
  version: number;
  phase: BattlePhase;
  phase_ends_at: string | null;
}

/** `ship_build` */
export interface ShipResult {
  build: {
    id: string;
    status: BuildStatus;
    name: string;
    shipped_at: string;
    completion_ms: number;
    stats: BuildStats;
  };
  battle: { version: number; phase: BattlePhase; phase_ends_at: string | null };
}

/** `get_public_battle` (anyone, RESULTS/DESTROYED only): permanent data, no user ids. */
export interface PublicBattle {
  battle: {
    id: string;
    mode: string;
    phase: 'results' | 'destroyed';
    is_complete: boolean;
    building_started_at: string | null;
    building_ends_at: string | null;
    finished_at: string | null;
    destroyed_at: string | null;
    created_at: string;
  };
  challenge: Challenge;
  players: string[];
  builds: PublicBuild[];
  awards: Award[];
}

export interface PublicBuild {
  id: string;
  builder_name: string;
  name: string | null;
  status: BuildStatus;
  shipped_at: string | null;
  completion_ms: number | null;
  final_rank: number | null;
  total_votes: number;
  /** Per-category votes (null for battles without voting and builds that were not final). */
  votes?: VoteCounts | null;
  stats: BuildStats;
  capture_status: CaptureStatus;
  screenshot_path: string | null;
}

// ─── REVEAL and VOTING (M4) ───────────────────────────────────────────────────────────

/** One entry of `get_reveal_builds`: object names in `ephemeral-builds` (null = never uploaded). */
export interface RevealBuild {
  build_id: string;
  /** 0-based, like `reveal_index`. */
  position: number;
  name: string | null;
  builder_id: string;
  builder_name: string;
  status: BuildStatus;
  files: {
    js: string | null;
    css: string | null;
    manifest: string | null;
    thumb: string | null;
  };
}

/** `reveal_next` / `skip_to_vote`: `changed: false` when the expected version was stale. */
export interface HostRevealResult {
  changed: boolean;
  version: number;
  phase: BattlePhase;
  phase_ends_at: string | null;
  reveal_index: number | null;
}

/** `cast_vote`. */
export interface CastVoteResult {
  category: string;
  build_id: string;
  ballot_complete: boolean;
  battle: { version: number; phase: BattlePhase; phase_ends_at: string | null };
}

/** `get_my_votes`: the caller's own ballot only. */
export interface MyVotes {
  votes: Record<string, string>;
  complete: boolean;
}
