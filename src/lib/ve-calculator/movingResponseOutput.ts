import type { VEMap } from '@/lib/types';
import { BinaryParser } from '@/lib/binary-engine/parser';
import { BinaryPatcher } from '@/lib/binary-engine/patcher';
import { APP_CONFIG, EXPERIMENTAL_CONFIG, CSL_STOCK_WARMUP_MAP, WOT_FUEL_ROWS, COMMUNITY_WOT_FUEL_RAW } from '@/config/constants';
import { analyzeDataChecksum, DATA_PAIR_LENGTH, CHECKSUM_OFFSET_WITHIN_HALF, CHECKSUM_SLOT_LENGTH } from '@/lib/checksum/dmeDataChecksum';

/** Check the finished bytes, including raw edits and every patch toggle. A
 * decoded maximum gain is insufficient: a changed table shape can retain that
 * maximum. Only VE, warmup and the independent WOT tables may differ here. */
export function movingResponseOutputHold(map: VEMap | null, reference: ArrayBuffer | null | undefined,
    output: ArrayBuffer, lang: 'ja' | 'en' = 'ja'): string | null {
    const say = (ja: string, en: string) => lang === 'ja' ? ja : en;
    if (map?.calibrationStatus !== 'moving-validated') return null;
    if (!reference || reference.byteLength !== DATA_PAIR_LENGTH || output.byteLength !== DATA_PAIR_LENGTH)
        return say('走行履歴Tuneの記録時BINがありません。記録を開き直して再計算してください。',
            'The recording BIN is missing for this driving-history Tune. Reopen the recording and recalculate.');
    try {
        if ([reference, output].some(b => analyzeDataChecksum(new Uint8Array(b)).some(s => !s.isValid)))
            return say('走行履歴Tuneの参照BINまたは出力BINのチェックサムが不正です。',
                'The recording or output BIN has an invalid checksum.');
        const recorded = new BinaryParser(reference).getVETable();
        if (JSON.stringify(recorded.xAxis) !== JSON.stringify(map.xAxis)
            || JSON.stringify(recorded.yAxis) !== JSON.stringify(map.yAxis))
            return say('走行履歴TuneのVE軸が記録時BINと一致しません。', 'The VE axes differ from the recording BIN.');
        const expected = new BinaryPatcher(reference);
        expected.setVETableData(map.data);
        const expectedBytes = new Uint8Array(expected.getBuffer());
        const before = new Uint8Array(reference), after = new Uint8Array(output);
        const ve = APP_CONFIG.MSS54HP.VE_TABLE;
        const veEnd = ve.ADDRESS_DATA + ve.SIZE_X * ve.SIZE_Y * 2;
        for (let i = ve.ADDRESS_DATA; i < veEnd; i++) {
            if (after[i] !== expectedBytes[i])
                return say('走行履歴Tuneで検証したVEに、SHAPE・復元・手動編集を重ねて書き込めません。',
                    'SHAPE, restores and manual edits cannot overwrite the VE validated by this driving-history Tune.');
        }
        const allowed: [number, number][] = [
            [ve.ADDRESS_DATA, veEnd],
            [EXPERIMENTAL_CONFIG.ADDRESS_WARMUP_MAP, EXPERIMENTAL_CONFIG.ADDRESS_WARMUP_MAP
                + CSL_STOCK_WARMUP_MAP.length * CSL_STOCK_WARMUP_MAP[0].length * 2],
            [EXPERIMENTAL_CONFIG.ADDRESS_WOT_THRESHOLD_MAP, EXPERIMENTAL_CONFIG.ADDRESS_WOT_THRESHOLD_MAP + 32],
            [EXPERIMENTAL_CONFIG.ADDRESS_WOT_MAP, EXPERIMENTAL_CONFIG.ADDRESS_WOT_MAP + WOT_FUEL_ROWS * COMMUNITY_WOT_FUEL_RAW.length],
            [CHECKSUM_OFFSET_WITHIN_HALF, CHECKSUM_OFFSET_WITHIN_HALF + CHECKSUM_SLOT_LENGTH],
            [DATA_PAIR_LENGTH / 2 + CHECKSUM_OFFSET_WITHIN_HALF, DATA_PAIR_LENGTH / 2 + CHECKSUM_OFFSET_WITHIN_HALF + CHECKSUM_SLOT_LENGTH],
        ];
        for (let i = 0; i < after.length; i++) {
            if (after[i] !== before[i] && !allowed.some(([start, end]) => i >= start && i < end))
                return say(`走行履歴Tuneは記録時の補正設定を保持します。0x${i.toString(16).toUpperCase().padStart(4, '0')} の変更を外してください（PATCH・RF GATE・RF補正表・手動校正など）。`,
                    `Driving-history Tune retains the recorded correction calibration. Disarm the change at 0x${i.toString(16).toUpperCase().padStart(4, '0')} (PATCH, RF GATE, RF correction tables or manual calibration).`);
        }
        return null;
    } catch {
        return say('走行履歴Tuneの出力BINを検証できませんでした。記録時の設定で再計算してください。',
            'The driving-history output BIN could not be verified. Recalculate using the recorded calibration.');
    }
}
