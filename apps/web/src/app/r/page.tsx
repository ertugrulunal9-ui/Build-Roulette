import type { Metadata } from 'next';
import { RoomLoader } from '../../components/room/RoomLoader';

export const metadata: Metadata = {
  title: 'Room',
  description: 'You are invited to a Build Roulette battle. Open the link, pick a name, play.',
};

/**
 * A room, `/r/{code}`: join, lobby, battle, rematch (all client-side; see components/room).
 *
 * Every room shares this one exported page: Cloudflare Pages rewrites `/r/{code}` here
 * (`out/_redirects`, src/lib/hosting/shells.ts; `next dev` does the same from next.config.ts)
 * and the room code comes from the browser's URL (RoomLoader), which also sets the tab title.
 * T-033 made it one page so a Worker could answer it from its cache; since T-037 it is a
 * plain static file.
 */
export default function RoomPage() {
  return <RoomLoader />;
}
