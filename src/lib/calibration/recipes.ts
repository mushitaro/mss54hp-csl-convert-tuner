/**
 * Known calibration recipes: changes owners ask for by what they want ("make the DME manual"),
 * spelled as the catalog parameters and values that do it, with where each step's value comes
 * from and how sure it is.
 *
 * A recipe is evidence, not an action. Nothing here writes: the assistant reads a recipe, compares
 * it with the open BIN (tuner_recipes), and stages each step only after the owner hears it and
 * says yes (tuner_calibration_edit). SAVE and WRITE stay on the screen.
 *
 * ## The rule for adding one
 *
 * Every step names its source, and the recipe says how sure it is: `grade: 'confirmed'` only when
 * two independent sources give the same new values, `'single'` otherwise, with `gradeWhy` saying so. The sources used so far, in the order they are tried:
 *   1. The DME code (evidence.ts codeUses): which values it tells apart. It rarely names the
 *      value to choose, but it rules values out and says what a value switches.
 *   2. The XDF's own enumeration (paramChoices), when it has one.
 *   3. A known image: the shipped CSL 0401 (SMG) image holds the "before" of an SMG recipe.
 *   4. A tool that already makes the change, read as an answer key. Its code is read, never run,
 *      never copied — only the addresses and values it writes are taken, mapped onto this catalog
 *      through its own file layout, and checked against (3).
 * scripts/verify-calibration-recipes.mjs pins the names, the kinds, and the "before" bytes.
 */

export interface Words { ja: string; en: string }

export interface RecipeStep {
    /** The catalog name, exactly. */
    param: string;
    /** A constant's new value, in its units. */
    set?: number;
    /** A run's every cell set to this value (a row switched off whole). */
    fill?: number;
    /** What the image holds before the change, as the recipe's sources saw it: the raw integer of
     *  each cell (one for a constant, 16-bit ones included). */
    from: readonly number[];
    why: Words;
}

export interface RecipeOption {
    /** When this option applies — the owner's wiring or hardware, never guessed. */
    when: Words;
    steps: readonly RecipeStep[];
}

export interface Recipe {
    id: string;
    title: Words;
    /** Words an owner might use for it. */
    keywords: readonly string[];
    /** Which DME software it was checked on. */
    software: string;
    summary: Words;
    steps: readonly RecipeStep[];
    /** Choices the owner makes from the car, not from the BIN: one option of the group applies. */
    choose?: { question: Words; options: readonly RecipeOption[] };
    sources: readonly Words[];
    /**
     * 'confirmed': two independent sources give the same new value for every required step.
     * 'single': one source gives the new values (the others may agree with it, or only rule
     * things out) — said with the recipe.
     */
    grade: 'confirmed' | 'single';
    /** Why the grade is what it is, in a sentence. */
    gradeWhy: Words;
    /** What nobody here has checked. Said with the recipe, every time. */
    unverified: Words;
}

const DTC_OFF_WHY: Words = {
    ja: 'SMG の CAN が無くなるので、この故障コードの行を 0 にして使わない（行の DTC 欄が 0 で、コードが立たない）。',
    en: 'With no SMG on the CAN this fault would set; the row is zeroed so it is not used (its DTC column 0 raises no code).',
};

export const RECIPES: readonly Recipe[] = [
    {
        id: 'smg-to-manual',
        title: { ja: 'SMG から 6 速マニュアルへ', en: 'SMG to 6-speed manual' },
        keywords: ['smg', 'manual', 'mt', '6mt', 'マニュアル', 'ミッション', 'getriebetyp', 'gearbox', 'transmission', '変速機', 'スワップ', 'swap'],
        software: '211325000401 (CSL 0401, MSS54HP)',
        summary: {
            ja: '変速機の種類のバイトを master と slave の両方で 0x40（SMG）から 0x03（マニュアル）にし、SMG の CAN に関わる故障コード三つを止める。クラッチスイッチの配線しだいで、さらに二つ。',
            en: 'Set the gearbox-type byte from 0x40 (SMG) to 0x03 (manual) in both master and slave, and switch off the three SMG CAN fault codes. Two more depend on how the clutch switch is wired.',
        },
        steps: [
            {
                param: 'cfg_m.getriebetyp', set: 0x03, from: [0x40],
                why: {
                    ja: 'master の変速機の種類。DME のコードは == 0x40（SMG）、== 0x70、(x & 0x30) == 0x30 でしか分けず、0x03 はどれにも当たらないのでマニュアルの経路になる。',
                    en: 'Master gearbox type. The DME code tells apart only == 0x40 (SMG), == 0x70 and (x & 0x30) == 0x30; 0x03 is none of them, so the manual path runs.',
                },
            },
            {
                param: 'cfg_s.getriebetyp', set: 0x03, from: [0x40],
                why: {
                    ja: 'slave の変速機の種類。master と同じ値にする（slave の SMG の処理は == 0x40 で動く）。',
                    en: 'Slave gearbox type, set the same as the master (the slave\'s SMG tasks run on == 0x40).',
                },
            },
            {
                param: 'DTC_06_SMG_CAN_TIMEOUT', fill: 0,
                from: [0x06, 0x01, 0x0A, 0x01, 0x01, 0x01, 0x0A, 0x00, 0x01, 0x02, 0x03, 0x28, 0x23, 0xFF],
                why: DTC_OFF_WHY,
            },
            {
                param: 'DTC_7B_SMG_CAN_FAIL', fill: 0,
                from: [0x7B, 0x01, 0x0A, 0x01, 0x01, 0x01, 0x0A, 0x00, 0x01, 0x02, 0x03, 0x28, 0x23, 0xFF],
                why: DTC_OFF_WHY,
            },
            {
                param: 'DTC_B1_SMG_MIL', fill: 0,
                from: [0xB1, 0x0A, 0x0A, 0x03, 0x02, 0x03, 0x02, 0x00, 0x01, 0x02, 0x03, 0x28, 0x01, 0xFF],
                why: DTC_OFF_WHY,
            },
        ],
        choose: {
            question: {
                ja: 'クラッチスイッチはどう配線しますか？（純正の 6 速マニュアルと同じく GPS と直列か、クラッチスイッチを直接か）',
                en: 'How is the clutch switch wired — in series with the GPS as on a stock 6-speed manual, or the clutch switch directly?',
            },
            options: [
                {
                    when: { ja: '純正の 6 速マニュアルと同じ（クラッチスイッチと GPS を直列）', en: 'As a stock 6-speed manual (clutch switch and GPS in series)' },
                    steps: [{
                        param: 'K_SKRAFTS_CONTROL', set: 1, from: [0x01],
                        why: { ja: 'XDF の選択肢で 1 は「aus S_Gang」。SMG の BIN も 1 なので、変えるものはない。', en: 'In the XDF\'s choices 1 is "aus S_Gang". The SMG BIN already holds 1, so nothing changes.' },
                    }],
                },
                {
                    when: { ja: 'GPS なし、クラッチスイッチを直接', en: 'No GPS, the clutch switch wired directly' },
                    steps: [
                        {
                            param: 'K_SKRAFTS_CONTROL', set: 2, from: [0x01],
                            why: { ja: 'XDF の選択肢で 2 は「aus S_Kuppl」（クラッチスイッチから）。', en: 'In the XDF\'s choices 2 is "aus S_Kuppl" (from the clutch switch).' },
                        },
                        {
                            param: 'K_S_GANG_LL_ED', set: 6553.5, from: [0x0032],
                            why: {
                                ja: '0x0032（5.0 秒）を 0xFFFF にすると、GPS の判定が止まる（参考にしたツールの「GPS 無効」と同じ値）。名前の S_GANG（ギア信号）と LL（ニュートラル）以外の意味は確かめていない。',
                                en: '0x0032 (5.0 s) to 0xFFFF turns the GPS check off (the value the reference tool writes for "GPS disable"). Beyond S_GANG (gear signal) and LL (neutral) in its name, its meaning is unchecked.',
                            },
                        },
                    ],
                },
            ],
        },
        sources: [
            {
                ja: 'DME のコード（解析ノートのグラフ）：変速機の種類は == 0x40、== 0x70、(x & 0x30) == 0x30 でだけ分かれる。0x03 と比べる箇所は無い。',
                en: 'The DME code (the notes\' graph): the gearbox type is told apart only by == 0x40, == 0x70 and (x & 0x30) == 0x30. Nothing compares it with 0x03.',
            },
            {
                ja: '既存の第三者の調整ツール（答え合わせに使った。2026-10-21）：その変速機の切り替えは、二か所の変速機の種類に 0x03（Manual）／0x40（SMG）を書き、SMG の故障コード三行を 0 にする（SMG に戻すときは元の値を書く）。クラッチスイッチと GPS は別の選択肢。',
                en: 'An existing third-party tuning tool, used as an answer key (2026-10-21): its transmission swap writes 0x03 (Manual) / 0x40 (SMG) to both gearbox-type bytes and zeroes the three SMG fault-code rows (restoring their values for SMG). Clutch switch and GPS are separate options.',
            },
            {
                ja: 'TUNER が持つ CSL 0401（SMG）のイメージは、五か所すべてで、そのツールが SMG に戻すときの値とバイト単位で一致する（アドレスの対応が正しいことの確かめ）。',
                en: 'The CSL 0401 (SMG) image TUNER ships holds, at all five places, exactly the bytes that tool writes for SMG — which checks the address mapping.',
            },
            {
                ja: 'K_SKRAFTS_CONTROL の XDF の選択肢：0 aus V-Fz、1 aus S_Gang、2 aus S_Kuppl。',
                en: 'K_SKRAFTS_CONTROL\'s XDF choices: 0 aus V-Fz, 1 aus S_Gang, 2 aus S_Kuppl.',
            },
        ],
        grade: 'single',
        gradeWhy: {
            ja: '新しい値（0x03 と、故障コードの行を 0）は参考ツール一つから。DME のコードはそれと矛盾しない（0x03 はどの分岐にも当たらない）が、0x03 を名指しはしない。アドレスと元の値は、TUNER の SMG のイメージとツールの両方で確かめた。',
            en: 'The new values (0x03, and the fault-code rows zeroed) come from one reference tool. The DME code agrees with them (0x03 meets none of its branches) but does not name 0x03. The addresses and the values before were checked against both the SMG image TUNER ships and the tool.',
        },
        unverified: {
            ja: 'TSUNAGI はこの変更を車で試していない。BMW の 6 速マニュアル用のソフトウェアの BIN とは比べていない。変速機の配線、クラッチスイッチ、CAN の相手など、BIN の外の変更は含まない。',
            en: 'TSUNAGI has not tried this on a car, nor compared it with a BIN of BMW\'s own 6-speed manual software. Changes outside the BIN — gearbox wiring, the clutch switch, what else is on the CAN — are not part of it.',
        },
    },
];

/** Recipes by words in their title, keywords or parameter names; all of them for an empty query. */
export function findRecipes(query: string): Recipe[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...RECIPES];
    const words = q.split(/\s+/);
    return RECIPES.filter(r => {
        const hay = [r.id, r.title.ja, r.title.en, ...r.keywords,
            ...r.steps.map(s => s.param), ...(r.choose?.options.flatMap(o => o.steps.map(s => s.param)) ?? [])]
            .join(' ').toLowerCase();
        return words.some(w => hay.includes(w));
    });
}

/** Every parameter a recipe touches, its options included. */
export function recipeParams(r: Recipe): string[] {
    return [...r.steps, ...(r.choose?.options.flatMap(o => o.steps) ?? [])].map(s => s.param);
}
