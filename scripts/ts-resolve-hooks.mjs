import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
        // The shapes a bundler resolves and Node does not: `./foo` -> `./foo.ts`, a directory
        // import `./bar` -> `./bar/index.ts`, and a component `./Baz` -> `./Baz.tsx` (see `load`).
        for (const candidate of [`${base}.ts`, `${base}/index.ts`, `${base}.tsx`]) {
            try {
                return await nextResolve(candidate, context);
            } catch {
                // Try the next shape; fall through to the default resolver for the real error.
            }
        }
    }
    return nextResolve(base, context);
}

/**
 * `.tsx`: a component, so that a verify script can render one (verify:preview-notice pins what the
 * first-run dialog says in each build).
 *
 * Node strips types but will not transform JSX, so a `.tsx` file is compiled here by the TypeScript
 * compiler the project already depends on — one file at a time (`transpileModule`: no type check, no
 * bundling; its imports stay imports and come back through `resolve` above). Imported lazily, so the
 * scripts that never touch a component do not pay for loading the compiler.
 */
let ts;
export async function load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !new URL(url).pathname.endsWith('.tsx')) return nextLoad(url, context);
    ts ??= (await import('typescript')).default;
    const path = fileURLToPath(url);
    const { outputText } = ts.transpileModule(await readFile(path, 'utf8'), {
        fileName: path,
        compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
        },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
}
