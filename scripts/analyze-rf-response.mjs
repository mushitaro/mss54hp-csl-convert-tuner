/** Read-only response report from fetch-d1-sessions.mjs output.
 * Usage: node scripts/analyze-rf-response.mjs <session-directory>
 * Writes private JSON only under ignored archive/rf-response; never a BIN. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
if (process.argv.length !== 3 || process.argv.includes('--help')) {
    console.log('Usage: node scripts/analyze-rf-response.mjs <session-directory>');
    process.exit(process.argv.includes('--help') ? 0 : 2);
}
const input = path.resolve(process.argv[2]);
const read = name => JSON.parse(fs.readFileSync(path.join(input, name), 'utf8'));
const session = read('session.json');
const log = read('log.json');
const raw = Array.isArray(log) ? log : log.data;
if (!Array.isArray(raw)) throw new Error('Expected raw log array or SessionLogRecord.data.');
if (Number.isFinite(session.logPointCount) && session.logPointCount !== raw.length) throw new Error('Log count differs from session metadata.');
const binaries = fs.existsSync(path.join(input, 'binaries.json')) ? read('binaries.json') : {};
const base = binaries.base ? Buffer.from(binaries.base, 'base64') : fs.readFileSync(path.join(input, 'base.bin'));
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const baseSha256 = hash(base);
if (!session.baseSha256 || session.baseSha256 !== baseSha256) throw new Error('BASE identity does not match session metadata.');
if (fs.existsSync(path.join(input, 'base.bin')) && hash(fs.readFileSync(path.join(input, 'base.bin'))) !== baseSha256) {
    throw new Error('base.bin and binaries.json disagree.');
}
const bundle = await build({ stdin: { contents: `
export * from './src/lib/ve-calculator/rfResponseEvidence';
export { timeScaleSeconds } from './src/lib/log-engine/filter';
export { APP_CONFIG } from './src/config/constants';`, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, alias: { '@': path.join(root, 'src') } });
const m = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const settings = session.tuneSettings ?? {};
const report = m.summarizeRfResponse(raw, {
    calibration: m.readResponseCalibration(base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength)),
    secondsPerTimeUnit: m.timeScaleSeconds(raw), correctLoad: !!settings.filterConfig?.enableCorrection,
    loadTable: settings.interpolationTable ?? m.APP_CONFIG.MSS54HP.INTERPOLATION_TABLE,
});
const output = path.join(root, 'archive', 'rf-response', path.basename(input));
fs.mkdirSync(output, { recursive: true });
const file = path.join(output, 'analysis.json');
fs.writeFileSync(file, JSON.stringify({ sessionId: session.id, sequence: session.seq,
    baseSha256, logSha256: hash(JSON.stringify(raw)), ...report }, null, 2));
console.log(JSON.stringify({ file, coverage: report.coverage, passes: report.passes.length,
    observedReversals: report.banks.map(b => b.reversals), calibration: report.settings.calibration }, null, 2));
