import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The dev server's build output. `dev.cmd` runs Next on an explicit port and Next names the
    // directory after it (.next-dev-5055), so the default ".next/**" does not cover it — and
    // eslint then walks megabytes of generated chunks and dies on an out-of-memory before it
    // reports a single real finding. Already gitignored as /.next-dev-*/; this is the same rule
    // stated where eslint reads it.
    ".next-dev-*/**",
    // Wrangler's build scratch. It writes bundled middleware facades under here on every
    // `pages dev`, and linting generated code that nobody can fix only makes the real count
    // harder to read — which is the number this project actually watches.
    ".wrangler/**",
  ]),
]);

export default eslintConfig;
