import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production';
const repoName = 'mss54hp-csl-convert-tuner';

const nextConfig: NextConfig = {
  output: 'export',
  // Where the build goes. `.next` unless something asks otherwise, so every existing command —
  // `npm run build`, `npm run dev`, dev.cmd — is unchanged.
  //
  // It is overridable because `next dev` locks `<distDir>/dev/lock`: a second dev server on this one
  // checkout is refused by that lock no matter which port it was given, and there is no `--dist-dir`
  // flag to move it with. `scripts/dev-alt.mjs` sets this so two sessions can each have one.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // basePath: isProd ? `/${repoName}` : '', // Custom Domain uses root path
  // assetPrefix: isProd ? `/${repoName}/` : '', // Custom Domain uses root path
  // Optional: Disable image optimization since it requires server
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
