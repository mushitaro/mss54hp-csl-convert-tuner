/**
 * Writes scripts/fixtures/practice-drive.testo.csv — the TESTO CSV that verify-file-workflow feeds
 * the file workflow.
 *
 * The file workflow needs a drive log, and the repository has no TESTO CSV to give it: the real
 * sessions' logs belong to the developer's car. PRACTICE already drives a car that belongs to
 * nobody — MockDrive computes its telemetry from the loaded BIN's own tables — so the fixture is a
 * PRACTICE drive over the community partial PRACTICE ships with, sampled at a fixed 10 Hz (the
 * app samples on performance.now(), which never repeats) and written by the app's own exporter,
 * serializeLogFile. Uploaded, it goes through the same parseLogFile as anybody's log.
 *
 * Committed rather than regenerated on every check, so that verify-file-workflow pins the file
 * workflow and not MockDrive too. Run this only to replace the fixture on purpose; the golden hash
 * in verify-file-workflow.mjs changes with it, and has to be re-measured from the app (see there).
 *
 *     node scripts/make-practice-log.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const BIN = path.join(root, 'public', 'mock', 'csl-0401-community-patch-v1.partial.bin');
const OUT = path.join(root, 'scripts', 'fixtures', 'practice-drive.testo.csv');

const entry = path.join(root, 'scripts', '.practice-log-entry.ts');
const outfile = path.join(root, 'scripts', '.practice-log-bundle.mjs');
fs.writeFileSync(entry, `
export { MockDrive, MOCK_DRIVE_CYCLE_SECONDS } from '@/lib/dme-link/mockDrive';
export { serializeLogFile } from '@/lib/log-engine/serializer';
`);
try {
    await build({
        entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
        logLevel: 'warning', alias: { '@': path.join(root, 'src') },
    });
} finally {
    fs.rmSync(entry, { force: true });
}
const { MockDrive, MOCK_DRIVE_CYCLE_SECONDS, serializeLogFile } = await import(pathToFileURL(outfile).href);
fs.rmSync(outfile, { force: true });

const bytes = fs.readFileSync(BIN);
const drive = new MockDrive();
if (!drive.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))) {
    throw new Error(`MockDrive could not load ${BIN}`);
}

// One cycle at 10 Hz: 2,230 samples, ~370 KB. Enough closed-loop time in enough cells that the
// evidence gate accepts some of them (19 of 480 on 2026-09-30), which is what makes the tuned BIN
// differ from the BASE at all; three cycles moved 41 cells for three times the file.
const HZ = 10;
const CYCLES = 1;
const seconds = MOCK_DRIVE_CYCLE_SECONDS * CYCLES;
const points = [];
for (let i = 0; i < seconds * HZ; i++) points.push({ ...drive.sample(i / HZ) });

const csv = serializeLogFile(points);
fs.writeFileSync(OUT, csv);
console.log(`${path.relative(root, OUT)}: ${points.length} samples over ${seconds} s at ${HZ} Hz, `
    + `${csv.length} bytes, ${csv.split('\n')[0].split(/[;,]/).length} columns`);
