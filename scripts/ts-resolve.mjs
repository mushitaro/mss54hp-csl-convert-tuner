/** Registers the extensionless-import resolve hook. Load with `--import ./scripts/ts-resolve.mjs`. */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-resolve-hooks.mjs', pathToFileURL(`${import.meta.dirname}/`));
