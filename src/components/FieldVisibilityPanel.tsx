import React, { useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { FieldKey, LOG_FIELD_REGISTRY, TOGGLEABLE_FIELDS, describeField } from '@/lib/field-registry/registry';
import { useDialogLang } from '@/hooks/useDialogLang';

interface Props {
    visibleFields: Record<FieldKey, boolean>;
    onToggle: (key: FieldKey) => void;
    onShowCoreOnly: () => void;
    onShowAll: () => void;
    /** Open above the trigger instead of below it. The mobile footer sits at the bottom edge, so a
     *  popover hanging `top-10` off a control down there opens off-screen. */
    openUp?: boolean;

}

const TEXT = {
    ja: { title: 'ログ項目', coreOnly: 'コアのみ', showAll: 'すべて表示', calc: '算出' },
    en: { title: 'Log Fields', coreOnly: 'Core Only', showAll: 'Show All', calc: 'calc' },
};

/**
 * What each channel IS, in Japanese.
 *
 * The registry holds the DME's own symbol and an English name, and that pairing is deliberate — it
 * is karter16's `LiveValueRow` convention, so a column here, a row in his tool and a line in the
 * Funktionsrahmen are visibly the same quantity. What it does not do is tell a Japanese reader what
 * `tefc_ll_st` measures, and this list is exactly where that question gets asked: it is chosen
 * before a drive, from a phone, by someone deciding what is worth the round trip.
 *
 * So the name leads and the symbol follows. The symbol does not go away — it is what the tooltip,
 * the docs and the disassembly all use, and losing it would cost the traceability the registry
 * exists for.
 *
 * `Record<FieldKey, string>` rather than a partial with a fallback: a field added to the registry
 * and forgotten here should fail the build, not appear in the list under its raw symbol.
 */
const NAME_JA: Record<FieldKey, string> = {
    rpm: '機関回転数',
    rawLoad: '相対開口断面積',
    correctedLoad: '補正後の相対開口（Alpha-N）',
    stft1: 'λ 制御係数 バンク1',
    stft2: 'λ 制御係数 バンク2',
    coolantTemp: '冷却水温',
    exhaustTemp: '排気温度',
    rf: '相対充填量（rf_korr 適用後）',
    wdk1: 'スロットル開度センサ1 実測値',
    rfKorr: 'EGT 補正（rf / rf_soll から実測）',
    egtFromRfKorr: '排気温度（DME テーブルから逆算）',
    rfKorrFromEgt: 'rf_korr（DME テーブルから逆算）',
    tankVent: 'タンク換気バルブ 通電時間',
    tankVentCheckState: 'タンク換気 機能検査の状態',
    tankVentDiag: 'TEV 検査 診断ステータス',
    lambdaFreeze: 'λ フリーズフレーム状態（意味は未検証）',
};

export const FieldVisibilityPanel: React.FC<Props> = ({ visibleFields, onToggle, onShowCoreOnly, onShowAll, openUp }) => {
    const [isOpen, setIsOpen] = useState(false);
    const lang = useDialogLang();
    const t = TEXT[lang];

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`p-2 rounded text-slate-400 hover:text-blue-400 transition-colors ${isOpen ? 'text-blue-400 bg-slate-800' : 'hover:bg-slate-800'}`}
                title={t.title}
            >
                <SlidersHorizontal className="w-4 h-4" />
            </button>

            {isOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />

                    {/* Sized like ROW FILTER, which is the panel beside it in the same cluster and the
                        one this is read against. It used to cap at 172px — three and a bit rows of a
                        sixteen-row list, on a control whose entire job is choosing among sixteen
                        things. 494px is FilterConfigPanel's cap, and 280px its width; matching both
                        makes the two popovers one control repeated rather than two sizes. */}
                    <div className={`${openUp ? 'fixed inset-x-3 bottom-[60px] max-h-[min(calc(100svh-72px),494px)] overflow-y-auto overscroll-contain' : 'absolute right-0 top-10 w-[280px] max-h-[min(70dvh,494px)] overflow-y-auto overscroll-contain'} bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 p-4 animate-in fade-in zoom-in-95 duration-200`}>
                        <div className="flex justify-between items-center mb-3 border-b border-slate-800 pb-2">
                            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                                <SlidersHorizontal className="w-3 h-3" />
                                {t.title}
                            </h3>
                            <button onClick={() => setIsOpen(false)} className="text-slate-500 hover:text-slate-300">
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="space-y-1">
                            {TOGGLEABLE_FIELDS.map(key => {
                                const meta = LOG_FIELD_REGISTRY[key];
                                const on = visibleFields[key];
                                return (
                                    <label
                                        key={key}
                                        title={describeField(meta)}
                                        className="flex items-start gap-2 py-1.5 px-1 -mx-1 rounded cursor-pointer hover:bg-slate-800/60"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={on}
                                            onChange={() => onToggle(key)}
                                            className="mt-0.5 w-3.5 h-3.5 shrink-0 accent-blue-500 rounded bg-slate-700 border-none"
                                        />
                                        <span className="min-w-0 flex flex-col gap-0.5">
                                            {/* What it is, first. The colour is the one this channel
                                                is drawn in on the chart, so the list and the trace
                                                agree without a legend. */}
                                            <span
                                                className="text-[11px] leading-tight text-slate-300"
                                                style={{ color: on ? meta.color : undefined }}
                                            >
                                                {lang === 'ja' ? NAME_JA[key] : meta.name}
                                            </span>
                                            <span className="flex items-baseline gap-1.5">
                                                {/* Symbols are lowercase DME identifiers, so this list must NOT
                                                    uppercase them the way the rest of the app's labels are
                                                    uppercased — `la_f_regler1` shouted as `LA_F_REGLER1` stops
                                                    matching the reference tool, the Funktionsrahmen and the
                                                    disassembly, which is the whole point of using the symbol.
                                                    Computed fields carry a `calc` tag instead, so a name that
                                                    looks like a symbol but is not one cannot be mistaken for
                                                    one. */}
                                                <span className="font-mono text-[10px] leading-tight text-slate-500">
                                                    {meta.symbol}
                                                </span>
                                                {meta.source === 'derived' && (
                                                    <span className="text-slate-600 text-[9px]" title="Computed by this app">{t.calc}</span>
                                                )}
                                            </span>
                                        </span>
                                    </label>
                                );
                            })}
                        </div>

                        <div className="mt-3 pt-3 border-t border-slate-800 flex justify-between text-[10px]">
                            <button onClick={onShowCoreOnly} className="text-slate-500 hover:text-blue-400 uppercase tracking-wider">{t.coreOnly}</button>
                            <button onClick={onShowAll} className="text-slate-500 hover:text-blue-400 uppercase tracking-wider">{t.showAll}</button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};
