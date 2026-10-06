import type { Metadata } from 'next';
import { RoomLoader } from '../../../components/room/RoomLoader';

interface RoomPageProps {
  params: Promise<{ code: string }>;
}

export async function generateMetadata({ params }: RoomPageProps): Promise<Metadata> {
  const { code } = await params;
  const shown = decodeURIComponent(code).toUpperCase().slice(0, 12);
  return {
    title: `Room ${shown}`,
    description: 'You are invited to a Build Roulette battle. Open the link, pick a name, play.',
  };
}

/** A room: join, lobby, battle, rematch (all client-side; see components/room). */
export default async function RoomPage({ params }: RoomPageProps) {
  const { code } = await params;
  return <RoomLoader code={decodeURIComponent(code)} />;
}
