import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @br/game ships TypeScript source (no build step), so Next compiles it.
  transpilePackages: ['@br/game'],
  poweredByHeader: false,
};

export default nextConfig;
