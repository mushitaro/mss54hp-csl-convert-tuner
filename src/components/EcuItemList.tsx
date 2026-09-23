'use client';

import React, { useMemo } from 'react';
import { BinaryParser } from '@/lib/binary-engine/parser';
import { ECU_ITEMS } from '@/lib/ecu-items/catalog';
import { EcuCategory, EcuItemDef, EcuItemValue } from '@/lib/ecu-items/types';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * Read-only view of the calibration items this app can decode out of a partial BIN.
 *
 * Its job is verification, not editing. `src/config/constants.ts` warns that the addresses in this
 * app need checking against the user's own BIN version; this is how that check gets made without
 * writing a byte. It is also the fastest way to see that a tune has, say, flattened the EGT
 * correction table — which a map view of the VE table alone would never show.
 *
 * ## Why this is a list and not a panel any more
 *
 * It used to be a popover behind an unlabelled icon in the footer's row of chart controls, which
 * put the KORR calibration — the numbers the RF KORR tab's whole derivation rests on — two taps and
 * one guess away from the table derived FROM them. They belong on the same screen: reading
 * `KF_RF_KORR_DRREL` out of the binary is how you check that the tuned table beside it is a change
 * to the right numbers.
 *
 * Losing the popover also gives the phone footer its third slot back, which is what it was sized
 * for before this branch added two.
 */

const TEXT = {
    ja: {
        title: 'ECU パラメータ (読み取り専用)',
        none: 'BIN を読み込むと表示されます。',
        note: 'このパネルは書き込みを行いません。アドレスとスケールを実機の BIN に対して確認するためのものです。',
    },
    en: {
        title: 'ECU parameters (read-only)',
        none: 'Load a BIN to see decoded values.',
        note: 'This panel never writes. It exists so an address and its scaling can be checked against a real binary.',
    },
};

/** Group headings, in display order. EGT first: on the RF KORR tab those are the subject, and the
 *  rest are context that happens to share this decoder. */
const GROUPS: Array<{ category: EcuCategory; en: string; ja: string }> = [
    { category: 'egt', en: 'EGT / RF KORR', ja: 'EGT / RF KORR' },
    { category: 'load', en: 'LOAD PATH', ja: '負荷経路' },
    { category: 'fuel', en: 'FUEL', ja: '燃料' },
    { category: 'idle', en: 'IDLE', ja: 'アイドル' },
];

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;

/** Enough decimals to tell 1.0186 from 1.0195 without turning rpm into 1050.000. */
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, ''));

const Grid: React.FC<{ value: Extract<EcuItemValue, { kind: 'map' }>; def: EcuItemDef & { kind: 'map' } }> =
    ({ value, def }) => (
        // Wide maps (6x12) must scroll inside their own box; the container itself must not grow.
        <div className="overflow-x-auto">
            <table className="text-[9px] font-mono border-collapse">
                <thead>
                    <tr>
                        <th className="px-1 py-0.5 text-slate-600 text-left sticky left-0 bg-slate-950">
                            {def.y.label}\{def.x.label}
                        </th>
                        {value.x.map((x, i) => (
                            <th key={i} className="px-1 py-0.5 text-slate-500 font-normal text-right">{fmt(x)}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {value.values.map((row, r) => (
                        <tr key={r}>
                            <th className="px-1 py-0.5 text-slate-500 font-normal text-right sticky left-0 bg-slate-950">
                                {fmt(value.y[r])}
                            </th>
                            {row.map((v, cIdx) => (
                                <td key={cIdx} className="px-1 py-0.5 text-slate-300 text-right">{fmt(v)}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );

const Curve: React.FC<{ value: Extract<EcuItemValue, { kind: 'curve' }>; def: EcuItemDef & { kind: 'curve' } }> =
    ({ value, def }) => (
        <div className="overflow-x-auto">
            <table className="text-[9px] font-mono border-collapse">
                <tbody>
                    <tr>
                        <th className="px-1 py-0.5 text-slate-600 font-normal text-left sticky left-0 bg-slate-950">{def.x.label}</th>
                        {value.x.map((x, i) => <td key={i} className="px-1 py-0.5 text-slate-500 text-right">{fmt(x)}</td>)}
                    </tr>
                    <tr>
                        <th className="px-1 py-0.5 text-slate-600 font-normal text-left sticky left-0 bg-slate-950">
                            {def.values.units || 'VAL'}
                        </th>
                        {value.values.map((v, i) => <td key={i} className="px-1 py-0.5 text-slate-300 text-right">{fmt(v)}</td>)}
                    </tr>
                </tbody>
            </table>
        </div>
    );

export const EcuItemList: React.FC<{
    /** The partial BIN currently loaded. Null until a BIN is read. */
    buffer: ArrayBuffer | null;
    /** Restrict to these categories. Omitted shows everything, grouped. */
    categories?: EcuCategory[];
}> = ({ buffer, categories }) => {
    const lang = useDialogLang();
    const t = TEXT[lang];

    /** Decoded once per buffer rather than per render: readItem walks the DataView, and a 6x12 map
     *  plus its axes is 90 reads. */
    const decoded = useMemo(() => {
        if (!buffer || buffer.byteLength !== 0x10000) return null;
        const parser = new BinaryParser(buffer);
        const out = new Map<string, EcuItemValue>();
        for (const def of ECU_ITEMS) {
            try {
                out.set(def.symbol, parser.readItem(def));
            } catch {
                // A bad address must not blank the whole list — skip the item and keep the rest.
                // Its absence is itself the signal.
            }
        }
        return out;
    }, [buffer]);

    if (!decoded) return <p className="text-[10px] text-slate-500">{t.none}</p>;

    const groups = GROUPS
        .filter(g => !categories || categories.includes(g.category))
        .map(g => ({ ...g, items: ECU_ITEMS.filter(i => i.category === g.category) }))
        .filter(g => g.items.length > 0);

    return (
        <div className="space-y-3">
            <p className="text-[9px] text-slate-600">{t.note}</p>
            {groups.map(group => (
                <section key={group.category} className="space-y-2">
                    {/* Headings only once there is more than one group — with a single category the
                        heading would just repeat the section title above it. */}
                    {groups.length > 1 && (
                        <h4 className="text-[9px] font-bold uppercase tracking-widest text-slate-600 pt-1">
                            {group[lang]}
                        </h4>
                    )}
                    {group.items.map(def => {
                        const v = decoded.get(def.symbol);
                        if (!v) return null;
                        return (
                            <div key={def.symbol} className="border-t border-slate-800 pt-2 space-y-1">
                                <div className="flex justify-between items-baseline gap-3">
                                    <span className="text-[10px] text-slate-300 font-mono">{def.symbol}</span>
                                    <span className="text-[9px] text-slate-600 font-mono shrink-0">
                                        {hex(def.address)} · {def.bank}
                                    </span>
                                </div>
                                {/* Narrow on `def`, not on `v`: TypeScript cannot infer that the two
                                    discriminants agree just because they were built together. */}
                                {def.kind === 'constant' && v.kind === 'constant' && (
                                    <div className="text-[11px] font-mono text-blue-400">
                                        {fmt(v.value)} <span className="text-slate-600">{def.units}</span>
                                        <span className="text-slate-700 ml-2">raw {v.raw}</span>
                                    </div>
                                )}
                                {v.kind === 'curve' && def.kind === 'curve' && <Curve value={v} def={def} />}
                                {v.kind === 'map' && def.kind === 'map' && <Grid value={v} def={def} />}
                                <p className="text-[9px] text-slate-600 leading-snug">{def.description[lang]}</p>
                            </div>
                        );
                    })}
                </section>
            ))}
        </div>
    );
};
