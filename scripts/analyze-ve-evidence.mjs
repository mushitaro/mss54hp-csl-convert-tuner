/**
 * Read-only replay of a D1 session against its BASE calibration.
 *
 * node scripts/analyze-ve-evidence.mjs <session-directory> [--out <archive-directory>]
 *
 * Input: session.json, log.json and binaries.json (or base.bin). Output is private local
 * analysis.json, points.csv and report.html, never a BIN or an ECU write. The old single-point
 * correction is shown before charge-temperature normalization and cell aggregation; it is not
 * a reproduction of the saved TUNED map. T alone is a conditional comparison at unchanged
 * operating conditions, not an identified VE update or an estimate of a best alpha.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
    console.log('Usage: node scripts/analyze-ve-evidence.mjs <session-directory> [--out <archive-directory>]');
    process.exit(args.includes('--help') ? 0 : 2);
}
const input = path.resolve(args.shift());
let output = path.join(root, 'archive', 've-evidence', path.basename(input));
while (args.length) {
    const arg = args.shift();
    if (arg === '--out' && args.length) output = path.resolve(args.shift());
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
// This repository is public. Restrict all reports (which contain private driving data) to its
// ignored archive tree, even if the caller accidentally points --out at public/ or docs/.
const archive = path.join(root, 'archive');
const relative = path.relative(archive, output);
if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Output must be inside this repository\'s gitignored archive directory.');
}
fs.mkdirSync(output, { recursive: true });
const read = name => JSON.parse(fs.readFileSync(path.join(input, name), 'utf8'));
const session = read('session.json');
const raw = read('log.json');
if (!Array.isArray(raw) || raw.length < 2) throw new Error('log.json must contain at least two samples.');
if (raw.some((p, i) => !Number.isFinite(p.time) || (i > 0 && p.time <= raw[i - 1].time))) {
    throw new Error('A strictly increasing, finite time column is required; do not reorder the driving history.');
}
const binariesPath = path.join(input, 'binaries.json');
const binaries = fs.existsSync(binariesPath) ? read('binaries.json') : {};
const base = binaries.base ? Buffer.from(binaries.base, 'base64') : fs.readFileSync(path.join(input, 'base.bin'));
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const baseSha256 = sha(base);
if (!session.baseSha256 || baseSha256 !== session.baseSha256) {
    throw new Error('BASE SHA-256 is absent or does not match session metadata. Analysis stopped.');
}
if (fs.existsSync(path.join(input, 'base.bin')) && sha(fs.readFileSync(path.join(input, 'base.bin'))) !== baseSha256) {
    throw new Error('base.bin and binaries.json disagree. Analysis stopped.');
}
if (Number.isFinite(session.logPointCount) && session.logPointCount !== raw.length) {
    throw new Error('Log point count does not match session metadata. Re-export a consistent D1 snapshot.');
}
const tunedSha256 = binaries.tuned ? sha(Buffer.from(binaries.tuned, 'base64')) : null;
if (tunedSha256 && session.sha256 && tunedSha256 !== session.sha256) {
    throw new Error('TUNED SHA-256 does not match metadata. Analysis stopped.');
}

// Bundle the actual application modules. No network, browser, production API or serial code is
// invoked. Temporary code contains no log or BIN data and is removed after loading.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 've-evidence-'));
let M;
try {
    const bundle = path.join(scratch, 'bundle.mjs');
    await build({
        stdin: {
            contents: [
                "export { processLogData, interpolateFactor, timeScaleSeconds } from '@/lib/log-engine/filter';",
                "export { VECalculator, RF_KORR_SETTLE_SEC_DEFAULT } from '@/lib/ve-calculator/calculator';",
                "export { readEgtTables } from '@/lib/ve-calculator/egtTables';",
                "export { readRfPtKorrCurves } from '@/lib/ve-calculator/chargeTemp';",
                "export { BinaryParser } from '@/lib/binary-engine/parser';",
                "export { readLogicPatches } from '@/lib/binary-engine/patcher';",
                "export { learnersFrozen } from '@/lib/log-engine/trimNeutrality';",
                "export { annotateSteadyEvidence, STEADY_EVIDENCE_DEFAULTS } from '@/lib/ve-calculator/steadyEvidence';",
                "export { APP_CONFIG } from '@/config/constants';",
            ].join('\n'),
            resolveDir: root, loader: 'ts',
        },
        outfile: bundle, bundle: true, format: 'esm', platform: 'node',
        logLevel: 'warning', alias: { '@': path.join(root, 'src') },
    });
    M = await import(pathToFileURL(bundle).href);
} finally {
    // Known scratch files only: no recursive directory removal or computed-tree deletion.
    const bundle = path.join(scratch, 'bundle.mjs');
    if (fs.existsSync(bundle)) fs.unlinkSync(bundle);
    fs.rmdirSync(scratch);
}
const ab = base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength);
const parser = new M.BinaryParser(ab);
const map = parser.getVETable(); // veMapSnapshot is the TUNED output and must never be the input.
const egt = M.readEgtTables(ab);
const curves = M.readRfPtKorrCurves(ab);
const limits = parser.readLambdaLimits();
const learnWindow = parser.readLtftLearnWindow();
const kRfCfg = parser.getUint8(M.APP_CONFIG.MSS54HP.ADDRESS_MAP_CONFIG);
const settings = session.tuneSettings ?? {};
const cfg = settings.filterConfig;
const table = settings.interpolationTable;
if (!cfg || (cfg.enableCorrection && !Array.isArray(table))) {
    throw new Error('Saved filter configuration / load interpolation table is required.');
}
const timeScale = M.timeScaleSeconds(raw);
// processLogData.rawData is the ORIGINAL input, not the corrected rows it places in data.
// Correct the entire timeline before the latch walk, including cold/transient/fuel-cut rows.
const corrected = raw.map(p => {
    const factor = cfg.enableCorrection ? (M.interpolateFactor(p.rpm, table) || 1) : 1;
    return { ...p, correctedLoad: p.rawLoad / factor, correctionFactor: factor };
});
const calculator = new M.VECalculator();
const annotated = calculator.annotateRfKorr(map, corrected, egt,
    { curves, assumedPressureMbar: cfg.assumedAmbientPressure }, corrected);
const evidenceOptions = {
    ...M.STEADY_EVIDENCE_DEFAULTS,
    lambdaLimits: limits,
    secondsPerTimeUnit: timeScale,
    excludeTimeRanges: cfg.excludeTimeRanges ?? [],
    minCoolantTemp: Math.max(65, cfg.enableMinTemp ? cfg.minTemp : 65),
    katsTabgOn: cfg.katsTabgOn ?? 850,
    katsTabgOff: Math.min(cfg.katsTabgOff ?? ((cfg.katsTabgOn ?? 850) - 10), cfg.katsTabgOn ?? 850),
    katsTailSec: cfg.katsTailSec ?? 20,
};
const evidence = M.annotateSteadyEvidence(annotated, evidenceOptions);
const legacy = M.processLogData(raw, session.baseFileName ?? 'BASE', cfg, table, limits);
const legacyTimes = new Set(legacy.data.map(p => p.time));
const wait = cfg.rfKorrSettleSec ?? M.RF_KORR_SETTLE_SEC_DEFAULT;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const mean = values => values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
const values = (rows, key) => rows.map(p => p[key]).filter(finite);
const stats = numbers => {
    const a = numbers.filter(finite).sort((x, y) => x - y);
    if (!a.length) return { n: 0, min: null, median: null, max: null, mean: null };
    const middle = Math.floor(a.length / 2);
    return { n: a.length, min: a[0], median: a.length % 2 ? a[middle] : (a[middle - 1] + a[middle]) / 2,
        max: a[a.length - 1], mean: mean(a) };
};
const rows = evidence.map((p, index) => {
    const stft = [p.stft1, p.stft2].filter(finite);
    const ltft = [p.ltft1, p.ltft2].filter(finite);
    // The old code averages the banks separately, then multiplies. Require BOTH bank pairs for
    // the conditional new comparison; a missing LTFT is not a measured value of 1.
    const legacyTrim = stft.length ? mean(stft) * (ltft.length ? mean(ltft) : 1) : null;
    const trim = stft.length === 2 && ltft.length === 2 ? mean(stft) * mean(ltft) : null;
    const settled = !p.rfKorrGateOpen || (finite(p.rfKorrDwellSec) && p.rfKorrDwellSec >= wait);
    const oldPointCorrection = legacyTrim === null ? null : legacyTrim *
        (settled && finite(p.rfKorr) ? p.rfKorr : 1);
    return { ...p, index, seconds: p.time * timeScale, trim, oldPointCorrection,
        legacyAccepted: legacyTimes.has(p.time),
        reduction: (finite(p.stft1) && p.stft1 < 0.8) || (finite(p.stft2) && p.stft2 < 0.8),
        atClamp: !!limits && [p.stft1, p.stft2].some(v => finite(v) &&
            (v <= limits.fMin + 1 / 32768 || v >= limits.fMax - 1 / 32768)),
    };
});
const inRpm = p => p.rpm >= 2200 && p.rpm <= 2700;
const focus = p => inRpm(p) && p.correctedLoad >= 7.5 && p.correctedLoad <= 10;
const lower = p => inRpm(p) && p.correctedLoad >= 5 && p.correctedLoad < 7.5;
const byReason = points => {
    const result = {};
    for (const p of points) {
        const reason = p.veEvidenceEligible ? 'eligible' : (p.veEvidenceReason ?? 'unclassified');
        result[reason] = (result[reason] ?? 0) + 1;
    }
    return result;
};
const describe = points => ({
    n: points.length,
    legacyAccepted: points.filter(p => p.legacyAccepted).length,
    steadyEligible: points.filter(p => p.veEvidenceEligible).length,
    reduction: points.filter(p => p.reduction).length,
    atClamp: points.filter(p => p.atClamp).length,
    purgeActive: points.filter(p => finite(p.tankVent) && p.tankVent > 0).length,
    purgeUnknown: points.filter(p => !finite(p.tankVent)).length,
    gateOpen: points.filter(p => p.rfKorrGateOpen).length,
    reasons: byReason(points),
    ...Object.fromEntries(['seconds', 'rpm', 'correctedLoad', 'rf', 'rfKorr', 'rfKorrDwellSec',
        'tabgDelta', 'trim', 'oldPointCorrection', 'stft1', 'stft2', 'ltft1', 'ltft2',
        'tankVent', 'intakeTemp', 'ambientPressure', 'chargeTemp'].map(k => [k, stats(values(points, k))])),
});
const contiguous = predicate => {
    const groups = [];
    let group = [];
    for (const p of rows) {
        if (group.length && (p.seconds - group.at(-1).seconds > 1 || !predicate(p))) {
            groups.push(group); group = [];
        }
        if (predicate(p)) group.push(p);
    }
    if (group.length) groups.push(group);
    return groups;
};
const summarizeGroup = points => ({
    start: points[0].seconds, end: points.at(-1).seconds,
    duration: points.at(-1).seconds - points[0].seconds,
    ...describe(points),
});
const strongReduction = contiguous(p => p.reduction && p.rpm >= 2000 && p.rpm <= 2800
    && p.correctedLoad >= 4.5 && p.correctedLoad <= 7.5)
    .filter(group => group.at(-1).seconds - group[0].seconds >= 2)
    .map(summarizeGroup);
const steadySegments = contiguous(p => p.veEvidenceEligible && inRpm(p)
    && p.correctedLoad >= 5 && p.correctedLoad <= 10)
    .filter(group => group.at(-1).seconds - group[0].seconds >= 2)
    .map(summarizeGroup);
// Independent holds, not individual correlated rows. These are candidate pairs only: direct
// rf_korr/filter-state observability and MAP/additive learning are separate requirements.
const thermalCandidates = [];
for (let i = 0; i < steadySegments.length; i++) {
    for (let j = i + 1; j < steadySegments.length; j++) {
        const a = steadySegments[i], b = steadySegments[j];
        if (b.start - a.end < 5) continue;
        const near = (key, tolerance) => finite(a[key].median) && finite(b[key].median)
            && Math.abs(a[key].median - b[key].median) <= tolerance;
        if (!near('rpm', 100) || !near('correctedLoad', 0.5)
            || !near('intakeTemp', 2) || !near('ambientPressure', 5)
            || !near('ltft1', 0.005) || !near('ltft2', 0.005)) continue;
        if (!finite(a.tabgDelta.median) || !finite(b.tabgDelta.median)
            || Math.abs(a.tabgDelta.median - b.tabgDelta.median) < 50) continue;
        thermalCandidates.push({ segmentA: i, segmentB: j,
            deltaDifferenceC: b.tabgDelta.median - a.tabgDelta.median });
    }
}
const mapCompensationActive = (kRfCfg & 0x10) !== 0;
const learnerWindowOpen = !M.learnersFrozen(learnWindow);
const binaryConfounds = [
    ...(mapCompensationActive ? ['MAP補正が有効で、RF比は実rf_korrを分離していない。'] : []),
    ...(learnerWindowOpen ? ['学習の温度窓が開いている。乗算LTFTを記録しても加算学習の寄与は未分離。'] : []),
    ...((session.flashHistory ?? []).length ? ['フラッシュ履歴あり。このBASE固定解析では走行中の全校正状態を確定していない。'] : []),
];
const channelCounts = Object.fromEntries(['rf', 'exhaustTemp', 'vehicleSpeed', 'stft1', 'stft2',
    'ltft1', 'ltft2', 'tankVent', 'lambdaFreeze', 'intakeTemp', 'ambientPressure', 'chargeTemp']
    .map(key => [key, raw.filter(p => finite(p[key])).length]));
const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    session: { label: session.label, seq: session.seq, createdAt: session.createdAt,
        note: 'セッション作成時刻は走行開始時刻ではありません。表とグラフはログ相対時刻。',
        pointCount: rows.length, durationSeconds: rows.at(-1).seconds - rows[0].seconds,
        baseSha256, baseHashVerified: true, tunedSha256,
        tunedHashVerified: !!(tunedSha256 && session.sha256 && tunedSha256 === session.sha256),
        flashHistoryCount: (session.flashHistory ?? []).length },
    calibration: { kRfCfg, patches: M.readLogicPatches(ab), learnWindow, lambdaClamps: limits
        ? { fMin: limits.fMin, fMax: limits.fMax } : null, mapCompensationActive, learnerWindowOpen },
    diagnosticsOnly: true,
    binaryConfounds,
    inputAssumptions: [
        'BASE BINがログ取得時のVEと補正テーブルを表すというセッション対応を使用。BINのハッシュを照合。',
        '全生履歴にRO補正を付与してからrf_korrラッチを再構成。実RAM値ではなく推定。',
        '車速・パージ等の保存値は低速取得値を保持している可能性があり、行数は独立した観測数ではない。',
        'lambdaFreezeは意味が確定していないため閉ループの証明にも除外理由にも使用しない。',
    ],
    formulas: {
        trim: 'T = mean(STFT1, STFT2) × mean(LTFT1, LTFT2), both banks required',
        oldPointCorrection: 'T_legacy × RF比 (推定gateが開き旧settle時間経過時); それ以外T_legacy。温度正規化・セル集約前。',
        unchangedConditions: '他の燃料寄与とk_new=k_oldが成立する同じ運転条件だけではC≈T。将来のBIN燃料量を予測した値ではない。',
        noAlphaEstimate: true,
    },
    steadyEvidenceOptions: { ...evidenceOptions, lambdaLimits: undefined },
    channelCounts,
    legacyDropCensus: legacy.dropCensus,
    all: describe(rows),
    regions: [
        { name: '2200–2700 rpm / RO 7.5–10%', ...describe(rows.filter(focus)) },
        { name: '2200–2700 rpm / RO 5–7.5%未満', ...describe(rows.filter(lower)) },
    ],
    focusPoints: rows.filter(focus).map(p => ({ seconds: p.seconds, rpm: p.rpm, ro: p.correctedLoad,
        trim: p.trim, oldPointCorrection: p.oldPointCorrection, rfRatio: p.rfKorr,
        rfTable: p.rfKorrFromEgt, gateOpen: p.rfKorrGateOpen, gateAgeSeconds: p.rfKorrDwellSec ?? null,
        deltaC: p.tabgDelta, purgeMs: p.tankVent, legacyAccepted: p.legacyAccepted,
        steadyEligible: p.veEvidenceEligible, reason: p.veEvidenceReason })),
    strongReduction,
    steadySegments,
    thermalComparison: {
        status: thermalCandidates.length ? 'candidate-pairs-only' : 'insufficient-matched-steady-segments',
        independentSegmentCount: steadySegments.length,
        candidates: thermalCandidates,
        anchorDelta30Points: rows.filter(p => inRpm(p) && p.correctedLoad >= 5 && p.correctedLoad <= 10
            && p.veEvidenceEligible && finite(p.tabgDelta) && p.tabgDelta <= 30).length,
        matchingRules: { rpmDifferenceMax: 100, roDifferenceMax: 0.5, intakeTempDifferenceMaxC: 2,
            pressureDifferenceMaxMbar: 5, ltftDifferenceMax: 0.005, deltaDifferenceMinC: 50,
            eligibleTailMinSeconds: 2, separationMinSeconds: 5 },
        conclusion: 'Δ30がなくても相対形状は条件を揃えた複数の定常保持で比較できる。今回の結果は候補の有無までで、α・真のVE・rf_korr絶対値は推定しない。',
    },
};
fs.writeFileSync(path.join(output, 'analysis.json'), JSON.stringify(report, null, 2) + '\n');
const columns = ['seconds', 'rpm', 'rawLoad', 'correctedLoad', 'rf', 'exhaustTemp', 'tabgDelta',
    'stft1', 'stft2', 'ltft1', 'ltft2', 'trim', 'rfSoll', 'rfKorr', 'rfKorrFromEgt',
    'rfKorrGateOpen', 'rfKorrDwellSec', 'oldPointCorrection', 'tankVent', 'lambdaFreeze',
    'vehicleSpeed', 'legacyAccepted', 'veEvidenceEligible', 'veEvidenceReason', 'veSteadySeconds', 'atClamp'];
const csvValue = value => value === undefined || value === null ? '' : typeof value === 'string'
    ? '"' + value.replaceAll('"', '""') + '"' : String(value);
fs.writeFileSync(path.join(output, 'points.csv'), '\uFEFF' + columns.join(',') + '\n'
    + rows.map(p => columns.map(key => csvValue(p[key])).join(',')).join('\n') + '\n');

const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const fmt = (v, digits = 2) => finite(v) ? v.toFixed(digits) : '—';
const percent = value => finite(value) ? `${value >= 1 ? '+' : ''}${((value - 1) * 100).toFixed(1)}%` : '—';
const clock = seconds => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
const range = (s, digits = 1) => s.n ? `${fmt(s.min, digits)}–${fmt(s.max, digits)}` : '—';
const reasonLabels = {
    eligible: '定常条件を通過', 'purge-active': 'パージ作動', 'purge-unknown': 'パージ不明',
    'invalid-config': '判定設定不正', 'invalid-time': '時刻不正', 'non-monotonic-time': '時刻逆転',
    'sample-gap': '取得間隔が長い', excluded: '指定除外区間',
    'controller-limits-unknown': '制御閾値不明', 'operating-point-unknown': '運転点不明',
    'trim-unknown': 'STFT不足', 'ltft-unknown': 'LTFT不足', 'lambda-state-unknown': '制御判定信号不足',
    'cold-engine': '水温不足', 'full-load': '閉ループ負荷閾値超過', 'fuel-cut': '燃料カット',
    'controller-clamp': 'トリム上下限付近', 'cat-protect': '触媒保護',
    'correction-state-unknown': 'rf_korr作動状態不明', 'correction-transition': 'rf_korr切替直後',
    'correction-settling': 'rf_korr作動後の保持不足', 'rpm-moving': '回転数変化',
    'load-moving': 'RO変化', 'rf-moving': 'RF変化', 'trim-moving': 'トリム変化',
    'ltft-moving': 'LTFT変化', 'short-window': '保持時間不足', 'thin-window': '点数不足',
};
const reasonsHtml = reasonCounts => Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${escape(reasonLabels[key] ?? key)} ${count}点`).join(' / ');
const regionTable = report.regions.map(r => `<tr><th>${escape(r.name)}</th><td>${r.n}</td><td>${r.legacyAccepted}</td><td>${r.steadyEligible}</td><td>${r.purgeActive}</td><td>${r.atClamp}</td></tr>`).join('');
const focusTable = report.focusPoints.map(p => `<tr><td>${clock(p.seconds)}</td><td>${fmt(p.rpm, 0)}</td><td>${fmt(p.ro)}</td><td>${fmt(p.trim, 3)}<small>${percent(p.trim)}</small></td><td>${fmt(p.rfRatio, 3)}</td><td>${fmt(p.oldPointCorrection, 3)}<small>${percent(p.oldPointCorrection)}</small></td><td>${fmt(p.gateAgeSeconds, 1)}</td><td>${fmt(p.deltaC, 0)}</td><td>${fmt(p.purgeMs, 1)}</td><td>${escape(reasonLabels[p.reason] ?? p.reason)}</td></tr>`).join('');
const reductionTable = strongReduction.map(s => `<tr><td>${clock(s.start)}–${clock(s.end)}</td><td>${fmt(s.duration, 1)}秒 / ${s.n}点</td><td>${range(s.rpm, 0)}</td><td>${range(s.correctedLoad)}</td><td>${range(s.stft1, 3)}<br>${range(s.stft2, 3)}</td><td>${s.atClamp}</td><td>${s.steadyEligible}</td></tr>`).join('');
const plotWindows = strongReduction.length ? strongReduction.map(s => ({ start: Math.max(0, s.start - 8), end: s.end + 8,
    label: `${clock(s.start)}–${clock(s.end)} 強い減量` })) : [{ start: rows[0].seconds, end: Math.min(rows[0].seconds + 60, rows.at(-1).seconds), label: 'ログ先頭60秒' }];
const plotRows = rows.filter(p => plotWindows.some(w => p.seconds >= w.start && p.seconds <= w.end))
    .map(p => ({ t: p.seconds, stft1: p.stft1, stft2: p.stft2, trim: p.trim,
        old: p.oldPointCorrection, rpm: p.rpm, ro: p.correctedLoad, purge: p.tankVent,
        eligible: p.veEvidenceEligible }));
const jsonSafe = obj => JSON.stringify(obj).replaceAll('<', '\\u003c');
const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VE定常証拠の再解析</title>
<style>
:root{color-scheme:light;--ink:#17304c;--muted:#587086;--line:#d9e3e8;--blue:#176b98;--orange:#b56616}*{box-sizing:border-box}body{margin:0;background:#f3f6f7;color:var(--ink);font:15px/1.75 system-ui,-apple-system,"Yu Gothic",sans-serif}main{max-width:1160px;margin:0 auto;padding:36px 24px 60px}header{border-bottom:3px solid var(--ink);padding-bottom:24px}.eyebrow{letter-spacing:.12em;font-size:12px;color:var(--muted)}h1{font-size:30px;line-height:1.4;margin:8px 0 14px}h2{font-size:20px;margin:0 0 14px}p{margin:10px 0}.lead{font-size:17px;max-width:970px}.tag{display:inline-block;background:#fff0d8;color:#734100;font-weight:700;font-size:13px;padding:3px 12px;border-radius:20px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}.card,section{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px}.card strong{display:block;font-size:28px}.card span{color:var(--muted);font-size:13px}section{margin-top:18px}.note{background:#f5f8fa;border-left:3px solid var(--blue);padding:13px 16px}.warning{background:#fff7e9;border-left-color:var(--orange)}.muted,small{color:var(--muted)}small{display:block}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:right;padding:11px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th:first-child,td:first-child{text-align:left}thead{background:#edf3f6}th{font-weight:600}.chart{width:100%;height:auto;display:block}.legend{display:flex;flex-wrap:wrap;gap:18px;font-size:13px}.legend b{display:inline-block;width:18px;height:3px;vertical-align:middle;margin-right:5px}select{font:inherit;padding:5px 10px;border:1px solid var(--line);border-radius:6px;margin:10px 0}code{overflow-wrap:anywhere;font-size:12px}.footer{font-size:12px;color:var(--muted);margin-top:24px}li{margin:6px 0}@media(max-width:700px){main{padding:20px 12px}.cards{grid-template-columns:repeat(2,1fr)}h1{font-size:24px}section{padding:16px}}
</style><main>
<header><div class="eyebrow">E46 M3 CSL · VE EVIDENCE REPLAY</div><h1>VEを変える根拠と、まだ分離できない補正</h1><span class="tag">診断のみ · BIN作成／書き込みなし</span><p class="lead">${escape(session.label ?? 'Recorded session')}をBASE BINから再解析しました。固定αは推定せず、旧方式の単点補正と同じ運転条件を仮定したトリムTを並べ、定常データとして使えるかを判定します。</p><p class="muted">時刻はログ開始からの相対時刻です。ファイル名やセッション作成日から走行日時を推定していません。</p></header>
<div class="cards"><div class="card"><strong>${rows.length.toLocaleString('ja-JP')}</strong><span>生ログの点数</span></div><div class="card"><strong>${fmt(report.session.durationSeconds / 60, 1)}分</strong><span>記録範囲</span></div><div class="card"><strong>${report.regions[0].steadyEligible} / ${report.regions[0].n}</strong><span>対象領域で定常条件を通過</span></div><div class="card"><strong>${thermalCandidates.length}組</strong><span>条件の揃う異なる熱状態の候補</span></div></div>
<section><h2>このログから使える結論</h2><p>2200–2700 rpm・RO 7.5–10%は${report.regions[0].n}点あり、定常条件の通過は${report.regions[0].steadyEligible}点です。RO 5–7.5%未満も含めて評価し、強い減量が続く${strongReduction.length}区間を診断用に残しました。除外は「現象がない」という意味ではありません。</p><div class="note warning">${binaryConfounds.map(escape).join('<br>') || '時間的に定常でも、他の燃料寄与が分離されたことを保証する判定ではありません。'}<br>RF比を実rf_korrとして固定αへ当てはめず、Tをそのまま新VEへ適用していません。</div></section>
<section><h2>対象領域のデータ量</h2><div class="scroll"><table><thead><tr><th>領域（補正後RO）</th><th>生ログ</th><th>旧フィルタ通過</th><th>新定常条件通過</th><th>パージ作動</th><th>上下限到達</th></tr></thead><tbody>${regionTable}</tbody></table></div>${report.regions.map(r => `<p><strong>${escape(r.name)}</strong><br><small>${reasonsHtml(r.reasons)}</small></p>`).join('')}<p class="muted">理由は1点につき主な1つを表示します。旧フィルタ通過は旧パイプラインの入口判定で、最終セルの採用件数とは異なります。</p></section>
<section><h2>掛け戻しが単点補正をどう変えるか</h2><p><strong>T = STFT平均 × LTFT平均</strong>。旧単点式は推定ゲートが開いて旧settle時間（${fmt(wait, 1)}秒）を超えるとT×RF比、切替直後はTです。以下は温度正規化・セル集約の前段だけを比較しています。</p><div class="scroll"><table><thead><tr><th>経過時刻</th><th>rpm</th><th>RO %</th><th>T</th><th>推定RF比</th><th>旧単点式</th><th>gate経過秒</th><th>Δ °C</th><th>パージms</th><th>定常判定</th></tr></thead><tbody>${focusTable || '<tr><td colspan="10">対象範囲の記録なし</td></tr>'}</tbody></table></div><p class="note">k_new=k_oldで他の燃料寄与も変わらない条件に限り、必要な倍率の第一近似はTです。VE変更でRF・Δ・ゲート・MAP補正などが変わるため、この表は変更後BINの予測でも更新推奨値でもありません。</p></section>
<section><h2>RO約5–7%で続いた強い減量</h2><p>少なくとも片側STFTが0.80未満で2秒以上連続した区間を表示します（探索範囲2000–2800 rpm、RO 4.5–7.5%）。制御下限に到達した値は誤差の正確な大きさを示しません。</p><div class="scroll"><table><thead><tr><th>経過時刻</th><th>継続・点数</th><th>rpm</th><th>RO %</th><th>STFT 1 / 2</th><th>上下限点数</th><th>定常通過</th></tr></thead><tbody>${reductionTable || '<tr><td colspan="7">該当する連続区間なし</td></tr>'}</tbody></table></div><label for="window">表示区間 </label><select id="window">${plotWindows.map((w, i) => `<option value="${i}">${escape(w.label)}</option>`).join('')}</select><div class="legend"><span><b style="background:#176b98"></b>STFT 1</span><span><b style="background:#6b55b0"></b>STFT 2</span><span><b style="background:#328457"></b>T</span><span><b style="background:#c07b24"></b>旧単点式</span></div><svg id="plot" class="chart" viewBox="0 0 1000 300" role="img" aria-label="選択区間のトリムと旧補正式"></svg><p class="muted">線の変化を時間順で表示しています。パージ作動・MAP補正・学習の影響を除いた混合気測定ではなく、STFTはラムダセンサーの実測空燃比ではありません。</p></section>
<section><h2>Δ30を待たずに比較できる条件</h2><p>同一BINで運転点・吸気温・気圧・学習値を揃えた独立した定常保持を比較し、Δの差が50°C以上ある候補を探しました。対象RO 5–10%で2秒以上続く定常通過区間は${steadySegments.length}区間、条件が合う熱状態の組は${thermalCandidates.length}組です。</p><p class="note">${thermalCandidates.length ? '候補の対応関係はanalysis.jsonに保存しました。MAP寄与・実rf_korr・加算学習の識別が残るため、補正比の決定は保留です。' : '今回のログだけでは、VEの誤差と温度補正の相対形状を切り分ける比較が成立しません。Δ30不足だけでなく、同条件の定常保持が不足しています。'}</p><p>次は実rf_korrとフィルタ後rf_sollの取得可否を確認し、MAP寄与を分離します。そのうえで同じBIN・同じ運転点を異なる熱状態で比較します。Δ30を得ることは最初の必須条件にしません。</p></section>
<section><h2>解析条件と照合</h2><ul><li>BASE SHA-256をセッションと照合済み。TUNEDのveMapSnapshotは入力に使いません。</li><li>保存RO補正を全生履歴へ適用し、除外点も含めて推定rf_korrラッチを進めています。</li><li>定常の初期基準は5秒・10点以上、最大間隔1秒、窓内rpm範囲200・RO範囲1・RF範囲5。トリム変動・学習変動・上下限・パージも判定します。これらは検証用の基準で、実車の応答時間を同定した値ではありません。</li><li>lambdaFreezeは意味未確定のため判定に使用しません。各信号の取得間隔・同期誤差は保存ログだけでは完全に検証できません。</li><li>WOT TH ${report.calibration.patches.applyWotDisable ? 'ON' : 'OFF'} / k_rf_cfg 0x${kRfCfg.toString(16).padStart(2, '0')} / 学習温度窓 ${learnWindow.tmotMin}–${learnWindow.tmotMax}°C。</li></ul><p>BASE <code>${baseSha256}</code></p><p class="muted">数値データ: <a href="analysis.json">analysis.json</a> · 全点判定: <a href="points.csv">points.csv</a></p></section>
<p class="footer">このレポートはローカルのgitignored archiveに保存されています。VINやBIN本体はHTMLに含めません。保存済みBIN、ECU、D1を変更していません。</p>
</main><script>
const data=${jsonSafe(plotRows)}, windows=${jsonSafe(plotWindows)};
function draw(){const w=windows[Number(document.getElementById('window').value)], rows=data.filter(p=>p.t>=w.start&&p.t<=w.end);const W=1000,H=300,L=60,R=20,T=20,B=42;const ymin=.6,ymax=1.35;const x=t=>L+(t-w.start)/(w.end-w.start)*(W-L-R);const y=v=>T+(ymax-v)/(ymax-ymin)*(H-T-B);let s='';for(let v=.6;v<=1.301;v+=.1){s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="'+(Math.abs(v-1)<.001?'#8194a4':'#e5ebef')+'"/><text x="'+(L-10)+'" y="'+(y(v)+4)+'" text-anchor="end" fill="#587086" font-size="12">'+v.toFixed(2)+'</text>';}for(let i=0;i<=6;i++){const t=w.start+(w.end-w.start)*i/6;s+='<text x="'+x(t)+'" y="'+(H-14)+'" text-anchor="middle" fill="#587086" font-size="12">'+Math.floor(t/60)+':'+String(Math.floor(t%60)).padStart(2,'0')+'</text>';}for(const [key,c] of [['stft1','#176b98'],['stft2','#6b55b0'],['trim','#328457'],['old','#c07b24']]){let d='',last=null;for(const p of rows){if(typeof p[key]!=='number'){last=null;continue;}d+=(last!==null&&p.t-last<=1?'L':'M')+x(p.t).toFixed(1)+','+y(p[key]).toFixed(1);last=p.t;}s+='<path d="'+d+'" fill="none" stroke="'+c+'" stroke-width="2"/>';}document.getElementById('plot').innerHTML=s;}
document.getElementById('window').addEventListener('change',draw);draw();
</script></html>`;
fs.writeFileSync(path.join(output, 'report.html'), html);
console.log(JSON.stringify({ output, session: report.session.label, pointCount: rows.length,
    baseHashVerified: true, regions: report.regions.map(r => ({ name: r.name, n: r.n,
        legacyAccepted: r.legacyAccepted, steadyEligible: r.steadyEligible, reasons: r.reasons })),
    strongReduction: strongReduction.map(s => ({ start: clock(s.start), end: clock(s.end),
        duration: s.duration, n: s.n, atClamp: s.atClamp, steadyEligible: s.steadyEligible })),
    thermalComparison: report.thermalComparison.status, binaryConfounds }, null, 2));
