import type { Metadata } from 'next';

interface RoomPageProps {
  params: Promise<{ code: string }>;
}

export async function generateMetadata({ params }: RoomPageProps): Promise<Metadata> {
  const { code } = await params;
  return { title: `Room ${code}` };
}

export default async function RoomPage({ params }: RoomPageProps) {
  const { code } = await params;

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-sm font-semibold tracking-wider text-zinc-500 uppercase">Room</p>
      <h1 className="font-mono text-4xl font-black break-all">{code}</h1>
      <p className="text-zinc-600 dark:text-zinc-400">Rooms are coming soon.</p>
    </main>
  );
}
