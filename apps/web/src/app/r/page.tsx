import type { Metadata } from 'next';
import { RoomLoader } from '../../components/room/RoomLoader';

export const metadata: Metadata = {
  title: 'Room',
  description: 'You are invited to a Build Roulette battle. Open the link, pick a name, play.',
};

/**
 * A room, `/r/{code}`: join, lobby, battle, rematch (all client-side; see components/room).
 *
 * Every room shares this one page: next.config.ts rewrites `/r/{code}` here, and the room
 * code comes from the browser's URL (RoomLoader). So the page is prerendered and answered
 * from the cache, never rendered per request: T-033, Workers Free allows 10 ms of CPU per
 * request and a server render of the old `/r/[code]` page took about as much warm, and
 * twenty times that in a fresh isolate (docs/08-free-tier.md §1). The tab title gets the
 * code once the page runs.
 */
export default function RoomPage() {
  return <RoomLoader />;
}
