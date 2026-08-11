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
    // Wrangler's build scratch. It writes bundled middleware facades under here on every
    // `pages dev`, and linting generated code that nobody can fix only makes the real count
    // harder to read — which is the number this project actually watches.
    ".wrangler/**",
  ]),
]);

export default eslintConfig;
