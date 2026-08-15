/**
 * The tank-ventilation channels: are they read from the right bytes, and does absent stay
 * distinguishable from zero all the way through the filter?
 *
 * That distinction is the whole point. `tetv: 0` is "the valve was shut", which is the reading a
 * tuning run wants to be able to claim. `tetv: undefined` is "we never measured it" — and a log
 * recorded before this shipped must not acquire the first meaning by default.
 */
import { OPERATING_MEASUREMENTS_BLOCK, decodeOperatingMeasurementsBlock } from '../src/lib/dme-link/liveValueBlocks.ts';
import { processLogData } from '../src/lib/log-engine/filter.ts';

let fails = 0;
const check = (n, c, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : ' — ' + d)); if (!c) fails++; };

console.log('\n[offsets, against the reference catalog]');
const f = OPERATING_MEASUREMENTS_BLOCK.fields;
check('tetv @ 38, u16, x0.002 ms', f.tankVent.offset === 38 && f.tankVent.format === 'uint16' && f.tankVent.scale === 0.002);
check('tefc_ll_st @ 62, u8', f.tankVentCheckState.offset === 62 && f.tankVentCheckState.format === 'uint8');
check('tefc_ed @ 88, u8', f.tankVentDiag.offset === 88 && f.tankVentDiag.format === 'uint8');
check('block is still 90 bytes', OPERATING_MEASUREMENTS_BLOCK.expectedLength === 90);
check('tefc_ed at 88 fits a 90-byte block', f.tankVentDiag.offset < OPERATING_MEASUREMENTS_BLOCK.expectedLength);

console.log('\n[decode]');
const payload = new Uint8Array(90);
// 3700 raw x 0.002 = 7.4 ms, the mock's open value.
payload[38] = 0x0E; payload[39] = 0x74;
payload[40] = 0x80; payload[41] = 0x00;   // la_f_regler1 = 1.0
payload[62] = 0x12;                        // mid-way through the TEFC idle check
payload[88] = 0x00;
const d = decodeOperatingMeasurementsBlock(payload);
check('tetv decodes to 7.4 ms', Math.abs(d.tankVent - 7.4) < 1e-9, d.tankVent);
check('stft1 still 1.0 (offsets did not shift)', Math.abs(d.stft1 - 1.0) < 1e-6, d.stft1);
check('tefc_ll_st = 0x12', d.tankVentCheckState === 0x12, d.tankVentCheckState);
check('tefc_ed = 0', d.tankVentDiag === 0, d.tankVentDiag);

console.log('\n[short block: absent, not zero]');
const short = new Uint8Array(40);
short[38] = 0; short[39] = 0;
const s = decodeOperatingMeasurementsBlock(short);
check('tefc_ll_st is null past the end', s.tankVentCheckState === null, s.tankVentCheckState);
check('tefc_ed is null past the end', s.tankVentDiag === null, s.tankVentDiag);

console.log('\n[filter]');
// Six samples, alternating purge on/off, all otherwise identical and all passing every other test.
const rows = [];
for (let i = 0; i < 6; i++) {
    rows.push({ time: i, rpm: 3000, rawLoad: 40, stft1: 1.0, stft2: 1.0, coolantTemp: 85, rf: 60, tankVent: i % 2 ? 7.4 : 0 });
}
const off = processLogData(rows, 'test.csv', { enableCorrection: false, enableMinTemp: false, enableIdle: false, enableTransient: false });
check('off by default: nothing dropped for purge', off.data.length === 6, off.data.length);
const on = processLogData(rows, 'test.csv', { enableCorrection: false, enableMinTemp: false, enableIdle: false, enableTransient: false, enableTankVentExclusion: true });
check('on: the three purging samples go', on.data.length === 3, on.data.length);
check('and the three kept are the shut ones', on.data.every(p => p.tankVent === 0));

// The case that matters most: a log from before this existed.
const legacy = rows.map(({ tankVent, ...rest }) => rest);
const legacyOn = processLogData(legacy, 'test.csv', { enableCorrection: false, enableMinTemp: false, enableIdle: false, enableTransient: false, enableTankVentExclusion: true });
check('a log with no TETV channel is untouched even with the filter ON', legacyOn.data.length === 6, legacyOn.data.length);

// A car whose valve reads a small non-zero at rest.
const threshold = processLogData(rows, 'test.csv', { enableCorrection: false, enableMinTemp: false, enableIdle: false, enableTransient: false, enableTankVentExclusion: true, tankVentMaxMs: 10 });
check('threshold above the reading keeps everything', threshold.data.length === 6, threshold.data.length);

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
process.exit(fails ? 1 : 0);
