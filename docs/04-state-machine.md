# 4. Multiplayer state machine

## 4.1 Entities

- **Room**: a persistent lobby reached by a 5-character code (`K7QXM`). A room hosts many
  battles (rematches) one after another.
- **Battle**: one round, from SPIN to DESTROY. It has a frozen roster, one challenge and
  one build per player. Its results are permanent.
- **Room member**: a person in the room (online or not), who is either a player or a spectator.
- **Battle player**: a member on the battle's roster, frozen when the battle starts.
  Only roster players build and vote.
- **Build**: a player's entry in a battle.

Postgres decides every state. Clients only send intents through RPCs.

## 4.2 Room states

```mermaid
stateDiagram-v2
  [*] --> open: create_room
  open --> in_battle: start_battle (host, ≥2 ready players)
  in_battle --> open: battle reaches destroyed / abandoned
  open --> closed: idle > 2h or host closes
  in_battle --> closed: (never directly; battle must finish or be abandoned first)
  closed --> [*]
```

## 4.3 Battle phases

```mermaid
stateDiagram-v2
  [*] --> spinning: start_battle
  spinning --> building: deadline (spin animation ~6s)
  building --> shipping: deadline OR all roster players shipped
  shipping --> reveal: deadline (grace 15s) OR all builds finalized
  reveal --> voting: last build revealed + slot ends, OR host skips
  voting --> results: deadline (60s) OR all eligible voters done
  results --> destroyed: last-look window ends (60s) AND captures terminal (or capture deadline hit)
  destroyed --> [*]

  spinning --> abandoned: <1 roster player present
  building --> abandoned: no roster player present for 5 min
  reveal --> abandoned: no one present for 5 min
  voting --> abandoned: no one present for 5 min
  abandoned --> [*]
```

DESTROYED and ABANDONED are terminal. Both trigger the destroy job. An abandoned battle
keeps whatever results exist, marked incomplete.

### Transition table

`advance_battle` implements this table and nothing else implements it. "Deadline" means
`now() >= phase_ends_at`.

| From | To | Trigger | Guard | Side effects (same transaction) |
|---|---|---|---|---|
| — | `spinning` | `start_battle(room_id, opts)` by host | Room `open`. ≥2 roster players ready (≥1 in solo mode). Caller is host. | Pick cards (weighted random, avoiding the room's recent cards). Insert `challenges`. Freeze roster into `battle_players`. Create a `draft` build per roster player. `phase_ends_at = now()+6s`. Room → `in_battle`. |
| `spinning` | `building` | Deadline | — | `building_started_at = now()`, `building_ends_at = now() + time_limit`, `phase_ends_at = building_ends_at` |
| `building` | `shipping` | Deadline **or** every non-left roster player has a non-draft build | — | `phase_ends_at = now()+15s`. If entered early (everyone shipped), the grace is 0 s and the battle goes straight to `reveal`. |
| `shipping` | `reveal` | Deadline **or** every build is final | — | Remaining `draft` builds: if an autosaved bundle exists, mark `auto_shipped` with `shipped_at = building_ends_at`, otherwise `dnf`. Compute `reveal_order` (random shuffle of shipped builds). `reveal_index = 0`. `phase_ends_at = now() + reveal_slot`. Enqueue a capture job per shipped build. |
| `reveal` | `reveal` (next slot) | Slot deadline **or** host `reveal_next` | `reveal_index < len-1` | `reveal_index++`, new slot deadline |
| `reveal` | `voting` | Last slot deadline **or** host `skip_to_vote` | — | `phase_ends_at = now()+60s` (configurable) |
| `voting` | `results` | Deadline **or** every eligible voter has voted in every category | — | Tally votes, write `awards`, set `builds.final_rank` and `total_votes`, compute auto-awards (Fastest Ship, Clutch Ship = shipped in the last 10 s). `finished_at = now()`. `phase_ends_at = now()+60s` (last look). |
| `results` | `destroyed` | Deadline **and** (all captures terminal **or** `now() > shipping_ended_at + 10 min`) | — | Enqueue destroy job. `destroyed_at` is set later by the destroy-worker. Room → `open` (rematch possible immediately). |
| any non-terminal | `abandoned` | Sweeper presence check | See diagram | Same as destroyed. Results stay partial. |

**No backwards transitions, ever.** A rematch is a new battle row.

### Phase durations (defaults, configurable per room)

| Phase | Duration |
|---|---|
| spinning | 6 s |
| building | 3 / 5 / 10 / 15 / 20 / 30 min (comes from the TIME LIMIT card or a room setting) |
| shipping | 15 s grace |
| reveal | 30–60 s per build (scaled by player count: `clamp(300s / n, 30s, 60s)`) |
| voting | 60 s |
| results (last look) | 60 s, then DESTROY. The results page stays forever. |

## 4.4 Player and build states

### Room member (presence-derived plus persisted)
`joined → ready ⇄ not_ready`. Leaving doesn't remove the row: `left_at` is set and the
player can rejoin. A kicked member is blocked from rejoining the room.

### Battle player
```mermaid
stateDiagram-v2
  [*] --> building: battle enters building
  building --> shipped: ship_build
  building --> auto_shipped: deadline + autosave exists
  building --> dnf: deadline + nothing to ship
  shipped --> voted: cast all votes
  auto_shipped --> voted
  dnf --> voted: DNF players still vote
  voted --> [*]
```
Connectivity (`online`/`offline`) is a separate dimension that comes **only from
Presence** and never blocks the state machine, except for the abandonment check.

### Build
- `status`: `draft → shipped | auto_shipped | dnf`, plus `disqualified` (by host or
  moderation; hidden from reveal and results).
- `capture_status`: `pending → captured | fallback | failed`
- `source_status`: `live → destroyed`

**Ship is final.** There is no unship, which keeps completion time meaningful and adds
tension. The UI asks "Ship it? You can't edit after." with the build name input.

## 4.5 Time and deadlines

- The server stores absolute timestamps (`phase_started_at`, `phase_ends_at`). Clients
  never send durations or times that matter.
- **Clock offset:** on connect and every 60 s, the client calls `server_now()` three
  times and keeps the sample with the lowest RTT:
  `offset = server_time + rtt/2 - local_time`. The countdown is
  `phase_ends_at - (Date.now() + offset)`.
- **Who advances on a deadline?**
  1. **Client nudge:** when a client's countdown reaches 0, it calls
     `advance_battle(id, expected_version)` after a random 0–500 ms jitter. Every client
     can do this. The first one wins and the rest get `{changed: false}`.
  2. **pg_cron backstop:** `sweep_deadlines()` runs every few seconds and advances
     overdue battles. This covers the case where all clients are asleep or offline.
  3. **Event-driven early advance:** `ship_build` and `cast_vote` call the same internal
     `try_advance()` at the end of their transaction (for example when the last player
     ships).
- **Deadline enforcement:** RPC guards use `now()`. Storage upload policies use the same
  rule. `ship_build` is accepted while `now() <= building_ends_at + shipping_grace`.
  `completion_ms = least(shipped_at, building_ends_at) - building_started_at`.

## 4.6 Concurrency rules

- Every mutating RPC locks the battle row with `SELECT … FOR UPDATE`, checks guards,
  writes, bumps `battles.version`, appends to `battle_events`, and broadcasts. All in one
  transaction.
- `advance_battle(expected_version)` is compare-and-set. A stale version is a no-op, not
  an error.
- Votes use the primary key `(battle_id, voter_id, category)` with
  `ON CONFLICT DO UPDATE`, so a player can change their vote until VOTING ends.
- Ships use the unique `(battle_id, builder_id)` constraint and `status = 'draft'` as
  the guard, so a double-click is harmless.
- Clients ignore any broadcast whose `version` ≤ their current version. A gap (received
  `version > current + 1`) means refetch the snapshot.

## 4.7 Realtime protocol

**Channel:** `battle:{battle_id}` (private; Realtime authorization through RLS on
`realtime.messages` that checks battle membership). Lobby state uses `room:{room_id}`.

**Broadcast events** (sent from Postgres triggers and kept small):

| Event | Payload |
|---|---|
| `phase` | `{version, phase, phase_ends_at, reveal_index?}` |
| `player` | `{version, user_id, status}` |
| `build` | `{version, build_id, status, name?}` |
| `vote_progress` | `{version, voted_count, eligible_count}` (never who voted for what) |
| `capture` | `{build_id, capture_status}` |
| `destroyed` | `{version}`, which tells clients to wipe local copies |

**Presence state** per client: `{user_id, display_name, device: 'desktop'|'mobile', activity: {lines, last_build: 'ok'|'error', typing: bool}}`.
It is throttled to at most one update every 2 s. This powers the "everyone's
progress" sidebar during BUILDING without any database writes.

**Client sync loop**
```ts
async function sync() {
  const snap = await rpc('get_battle_snapshot', { battle_id }); // battle + players + builds (+ challenge)
  store.replace(snap);                       // version = snap.battle.version
}
channel
  .on('broadcast', { event: '*' }, ({ payload }) => {
    if (payload.version <= store.version) return;          // stale
    if (payload.version > store.version + 1) return sync(); // gap → refetch
    store.apply(payload);
  })
  .on('presence', { event: 'sync' }, () => store.setPresence(channel.presenceState()))
  .subscribe(status => { if (status === 'SUBSCRIBED') sync(); }); // (re)connect → refetch
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
```

## 4.8 Failure and reconnect scenarios

| Scenario | Behavior |
|---|---|
| Player refreshes during BUILDING | Workspace reloads from IndexedDB, snapshot refetched, countdown resumes. No loss. |
| Player's laptop dies during BUILDING | They can rejoin on another device. The workspace is restored from the remote autosave (≤30 s old). If they don't return, auto-ship uses the last autosaved bundle at the deadline. |
| Player offline at T-0 | The client can't auto-ship. At `shipping → reveal`, the server auto-ships the last autosaved bundle (`auto_shipped`), otherwise `dnf`. |
| Ship upload in flight at T-0 | The 15 s SHIPPING grace accepts it. `completion_ms` is capped at the time limit. |
| Host leaves mid-battle | Deadlines drive everything, so nothing blocks. Host powers (skip, kick, reveal_next) move to the longest-present roster player after 30 s of host absence. |
| Everyone leaves | The sweeper marks the battle `abandoned` after 5 min with no presence. Destroy still runs. |
| Two clients nudge at once | Compare-and-set: one advances, the other gets a no-op |
| Realtime disconnect | supabase-js reconnects. On `SUBSCRIBED` the client resyncs from the snapshot. |
| Late joiner during battle | Becomes a spectator. Watches presence and reveal. Not on the roster, so can't build or vote. |
| Clock skew of minutes | Irrelevant to correctness: the server decides. The UI is accurate after offset correction. |
| Malicious client calls RPCs out of order | Guards reject it. Clients can't write any table directly. |

## 4.9 Voting rules

- Default categories: **Best Build** (overall), **Best Use of the Rule**, **Best Style**,
  **Most Chaotic**. Each eligible voter gets one vote per category.
- Eligible voters are roster players (including DNF). No self-votes. Votes for DNF or
  disqualified builds are not possible.
- Ranking order: votes in Best Build, then total votes across categories, then earlier
  `shipped_at`.
- Award ties are shared (several `awards` rows).
- Individual ballots are never exposed to clients, only tallies after RESULTS.
- Solo or 1-player battles skip VOTING and get auto-awards only.

## 4.10 Implementation notes (T-016, M3)

The migrations are the source of truth; the event table in §4.7 is superseded by this
section.

- **M3 flow:** multiplayer battles run SPINNING → BUILDING → SHIPPING → RESULTS →
  DESTROYED. `settings.reveal_vote = false` is the seam for M4, which inserts REVEAL and
  VOTING after SHIPPING.
- **Heartbeat:**
  - per room, sent by clients about every **10 s** (60 s can't work with the 30 s host
    threshold);
  - the server writes at most one per 5 s per member;
  - any member RPC also counts as presence.
- **Host migration:** goes to the earliest-joined *present* member, players before
  spectators. It happens lazily in RPCs and in `sweep_deadlines`.
- **Abandonment:** a running battle is abandoned when no roster player has been seen for
  5 min, in any running phase except RESULTS. Abandoned battles keep partial data and
  have no ranks.
- **Ranking until votes exist (M3):**
  1. lower `completion_ms`;
  2. at equal time, hand-shipped before auto-shipped;
  3. then earlier `shipped_at`.

  Builds equal on all three share a rank. DNF and disqualified builds are unranked.
  Awards are `clutch_ship`, `speedrun`, and `fastest_ship` (only when ≥2 builds were
  shipped by hand; ties share it).
- **Realtime:**
  - private topics `room:{id}` and `battle:{id}`, sent by an AFTER INSERT trigger on
    `room_events` / `battle_events` with `realtime.send`. That gives exactly one message
    per version, with allow-listed fields only;
  - battle events: `phase`, `build`, `player`, `host`, `capture`, `destroyed`, `sync`;
  - room events: `room`, `member`, `sync`;
  - every payload carries `version`, and room and battle versions are independent;
  - clients refetch the battle snapshot after each `phase` event and on any version gap.
- **Realtime authorization (RLS on `realtime.messages`):**
  - only members receive;
  - clients may send **Presence only**, and only as active members;
  - client Broadcast is refused, so members can't forge phase events.
  - Policies are checked at join time, so a kicked user's already-open subscription keeps
    receiving until it rejoins. Every RPC re-checks, and the payloads aren't secret.
- **Kick:** the kicked user loses the room, its topics and the running battle; the battle
  is public again from RESULTS. Only a *draft* build is disqualified.
- **Rooms:**
  - 2–8 players and up to 20 spectators;
  - late joiners and overflow become spectators, and are promoted in join order when a
    player slot frees up or the room reopens;
  - a user can host at most 3 open rooms;
  - an idle room (no event and no heartbeat for 2 h) is closed, and closed rooms are
    purged after 7 days.
- **Client (T-017):**
  - Presence is tracked on the **room** topic only, and powers both the lobby and the
    BUILD sidebar; the battle topic is subscribed without Presence;
  - the sync engine (`apps/web/src/lib/room/sync.ts`) applies the version rules, buffers
    events during a refetch, polls every 5 s while the room channel is down, and resyncs
    on visible/online;
  - after DESTROY everyone returns to the lobby, which shows a "Last battle" podium and a
    rematch button for the host.
- **Resilience (T-018):**
  - **Presence rate limit:** Supabase Realtime closes a channel after more than 5
    Presence messages per 30 s per client, so activity updates are capped at **4 per
    30 s**, none are sent while offline, and channels the server closes are re-subscribed
    with backoff.
  - **Going offline:** an offline browser keeps the WebSocket "open", so the engine also
    listens to the window's `offline`/`online` events.
  - **Version gaps:** each new gap refetches immediately; a gap that stays open retries
    with backoff (1 → 30 s), keeping the newest 200 events.
  - **Local workspaces:** only battles the server reports as over, or untouched for 24 h,
    have their IndexedDB workspace deleted.
  - Verified by `e2e/chaos.spec.ts`: 6 players, ±5 min clock skew, a 15 s network drop,
    refreshes, the host vanishing, all clients closed at T-0, abandonment, a full room,
    and a minute of steady typing. Every run ends with a DB terminal-state check. It runs
    nightly in CI.

## 4.11 Reveal and voting as implemented (T-019, M4)

- **Flow:** SHIPPING → REVEAL → VOTING → RESULTS for multiplayer rooms with
  `reveal_vote = true` (the default; a room setting can turn it off). If fewer than 2
  builds are final (shipped or auto-shipped), the battle goes straight to RESULTS with
  `reason: too_few_builds`.
- **REVEAL:**
  - `reveal_order` is a random shuffle of the final builds;
  - the slot is the room's `reveal_slot_s`, otherwise `round(clamp(300/n, 30, 60))` with
    n = the number of final builds (the TS helper rounds the same way);
  - each slot runs its full length;
  - the host can `reveal_next` (on the last slot it starts VOTING) or `skip_to_vote`.
    Both use a version CAS, so a stale call is a no-op;
  - `phase` events carry `reveal_index`.
- **VOTING:**
  - eligible voters are roster players who aren't kicked (DNF included); spectators
    can't vote;
  - one vote per category, revotes allowed, no self-votes, no votes for DNF or
    disqualified builds;
  - voting ends early when at least one eligible voter is present and every present
    eligible voter has completed their ballot ("present" = seen within 30 s);
  - `vote_progress {voted_count, eligible_count}` is sent only when a ballot is completed.
- **Secrecy:** who voted for what is never exposed; `voted_at` isn't set. Tallies are
  frozen at RESULTS into `builds.vote_counts`.
- **Ranking:** overall votes → total votes → earlier `shipped_at`. Each category's top
  build gets an award (ties share; no award with zero votes), and the auto-awards stay.
- **Reveal storage:** from REVEAL to RESULTS, members and spectators can read the final
  builds' `bundle.js`, `bundle.css` and `manifest.json` (not `source.json`). The new
  `manifest.json` holds only the pinned deps. `get_reveal_builds` returns the paths per
  build.
- **Test-only switch:** `private.app_settings('reveal_vote_default', false)` can turn the
  phases off for a whole stack. It was used in CI only until T-020; it is now unused, and
  production has no such row.
- **Client (T-020):**
  - the REVEAL spotlight is synchronized from `reveal_index`, with one live build in
    reveal mode in a fresh iframe with storage wiped first, and the next build prefetched;
  - upcoming builds stay hidden as "? Coming up";
  - "Skip this build" and the frozen state only affect the viewer's tab;
  - the vote grid can't offer the player's own build, and `get_my_votes` restores the
    ballot after a refresh;
  - results are ranked by votes, with category award badges and a winner banner.
- **M4 completion (T-021):**
  - **Phones** (`hover: none` and `pointer: coarse`): REVEAL shows the screenshot first with
    "Tap to run live" (the R2 mitigation), and the host controls sit in a bar fixed to the
    bottom. VOTE uses a single column.
  - **A phone player** can watch and vote but doesn't build: the editor never mounts, so
    their build ends DNF, unless they choose "Build on this device anyway".
  - **Unsent votes:** picks that fail on the network are retried every 2 s and with every
    fresh snapshot. Picks that never land are shown as "Not counted" in RESULTS, so a vote
    is never lost silently.
  - **History:** `/u/[id]` is backed by `get_player_history`, which `anon` can call and
    which returns only permanent data. History belongs to the anonymous auth user until
    account linking exists.
  - **Lobby settings (host only):** `reveal_vote`, the time per build (Auto or
    30–60 s) and the voting time (30 s–3 min).
  - ~~Known server gap~~ **fixed in T-022:** `sweep_deadlines` also re-checks the early end
    of VOTING, so a battle ends about 30–35 s after the last unfinished voter goes silent
    (`reason: all_voted`, no actor).
- **One winner per category (T-022, user decision 2026-10-07):**
  - **Awards:** among the builds with the top count in a category (count > 0), the winner
    has the most **total votes**, then the earlier **`shipped_at`**, then the lower build
    id (deterministic). Zero votes in a category means no award.
  - **Ranks:** vote ranks use the same order through `row_number()`, so there is exactly
    one rank-1 build, and the Best Build award is on it whenever anyone voted for Best
    Build. Ranks without votes (M3 path) still share on full ties.
  - Battles that finished before the change keep their stored (shared) awards; results
    are never recomputed. This supersedes "award ties are shared" in §4.9.
- **Reliability (T-023):**
  - **Lost broadcasts:** `realtime.send` broadcasts can be lost while Realtime reconnects
    its database feed. The local stack does this every 10 min ("rebalancing"), and
    production may do it too. The client therefore reads `battles.version` with every
    10 s heartbeat and refetches if the server is ahead, so a lost event costs at most one
    beat. Ship toasts come from snapshot diffs.
  - **Host REVEAL actions** (`reveal_next`/`skip_to_vote`) use a version CAS that a burst
    of capture events can make stale. When the stale answer shows the same spotlight, the
    client resends with the returned version (at most 3 times).
  - Server alternatives for later: return the battle version from `heartbeat`, and compare
    on `reveal_index` instead of `version` for host actions.

