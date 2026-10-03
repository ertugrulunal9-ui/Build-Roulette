import type { Metadata } from 'next';

interface BattlePageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: BattlePageProps): Promise<Metadata> {
  const { id } = await params;
  return { title: `Battle ${id}` };
}

export default async function BattlePage({ params }: BattlePageProps) {
  const { id } = await params;

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-sm font-semibold tracking-wider text-zinc-500 uppercase">Battle results</p>
      <h1 className="font-mono text-2xl font-black break-all">{id}</h1>
      <p className="text-zinc-600 dark:text-zinc-400">Battle results are coming soon.</p>
    </main>
  );
}
