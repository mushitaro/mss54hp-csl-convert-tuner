/**
 * Lets `node --experimental-strip-types` import this project's source directly.
 *
 * The app's imports are extensionless (`from './gradient'`) because a bundler resolves them; Node's
 * ESM resolver requires the extension. Rather than change ~everything under src/ to suit a
 * verification script, this hook tries `<specifier>.ts` for relative specifiers that have no
 * extension, and falls through to normal resolution otherwise.
 *
 * Registered by `ts-resolve.mjs`, which must be loaded with `--import` — static imports hoist, so a
 * hook registered inside the script under test would arrive too late to resolve its own imports.
 */
export async function resolve(specifier, context, nextResolve) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    const isAlias = specifier.startsWith('@/');
    const hasExtension = /\.[cm]?[jt]sx?$/.test(specifier);

    // `@/` is the tsconfig path alias for `src/`. Rewritten here rather than taught to Node,
    // because the mapping belongs to the build and this is only borrowing it.
    const base = isAlias
        ? new URL(`../src/${specifier.slice(2)}`, import.meta.url).href
        : specifier;

    if ((isRelative || isAlias) && !hasExtension) {
        // Both shapes a bundler resolves and Node does not: `./foo` -> `./foo.ts`, and a directory
        // import `./bar` -> `./bar/index.ts`.
        for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
            try {
                return await nextResolve(candidate, context);
            } catch {
                // Try the next shape; fall through to the default resolver for the real error.
            }
        }
    }
    return nextResolve(base, context);
}
