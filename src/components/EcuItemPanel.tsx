import React, { useMemo, useState } from 'react';
import { X, ListTree } from 'lucide-react';
import { BinaryParser } from '@/lib/binary-engine/parser';
import { ECU_ITEMS } from '@/lib/ecu-items/catalog';
import { EcuItemDef, EcuItemValue } from '@/lib/ecu-items/types';
import { useDialogLang } from '@/hooks/useDialogLang';

/**
 * Read-only view of the calibration items this app can decode out of a partial BIN.
 *
 * Its job is verification, not editing. `src/config/constants.ts` warns that the addresses in this
 * app need checking against the user's own BIN version; this is how that check gets made without
 * writing a byte. It is also the fastest way to see that a tune has, say, flattened the EGT
 * correction table — which a map view of the VE table alone would never show.
 */

const TEXT = {
    ja: {
        title: 'ECU パラメータ (読み取り専用)',
        none: 'BIN を読み込むと表示されます。',
        note: 'このパネルは書き込みを行いません。アドレスとスケールを実機の BIN に対して確認するためのものです。',
        addr: 'アドレス',
    },
    en: {
        title: 'ECU Items (read-only)',
        none: 'Load a BIN to see decoded values.',
        note: 'This panel never writes. It exists so an address and its scaling can be checked against a real binary.',
        addr: 'Address',
    },
};

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;

/** Enough decimals to tell 1.0186 from 1.0195 without turning rpm into 1050.000. */
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, ''));

const Grid: React.FC<{ value: Extract<EcuItemValue, { kind: 'map' }>; def: EcuItemDef & { kind: 'map' } }> =
    ({ value, def }) => (
        // Wide maps (6x12) must scroll inside their own box; the popover itself must not grow.
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

interface Props {
    /** The partial BIN currently loaded. Null until a BIN is read. */
    buffer: ArrayBuffer | null;
    openUp?: boolean;
}

export const EcuItemPanel: React.FC<Props> = ({ buffer, openUp }) => {
    const [isOpen, setIsOpen] = useState(false);
    const lang = useDialogLang();
    const t = TEXT[lang];

    /** Decoded once per (buffer, open) rather than per render: readItem walks the DataView, and a
     *  6x12 map plus its axes is 90 reads. */
    const decoded = useMemo(() => {
        if (!buffer || buffer.byteLength !== 0x10000) return null;
        const parser = new BinaryParser(buffer);
        const out = new Map<string, EcuItemValue>();
        for (const def of ECU_ITEMS) {
            try {
                out.set(def.symbol, parser.readItem(def));
            } catch {
                // A bad address must not blank the whole panel — skip the item and keep the rest,
                // its absence from the list is itself the signal.
            }
        }
        return out;
    }, [buffer]);

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(o => !o)}
                title={t.title}
                className="p-2 text-slate-500 hover:text-slate-300 transition-colors"
            >
                <ListTree size={14} />
            </button>

            {isOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
                    {/* A fixed bottom sheet on a phone, an anchored popover on a desk — the shape
                        FilterConfigPanel and FieldVisibilityPanel already use.

                        This was the odd one out, and it showed: anchored `bottom-10` at 70vh, it
                        hung off the bottom of a 393px landscape screen and the list was cut in
                        half with no way to reach the rest. An anchored panel cannot be rescued by
                        capping its height — its overflow depends on where the anchor sits, not on
                        how tall it is — so it has to stop being anchored.
                        svh, never vh: vh grows when the address bar retracts, and a panel sized to
                        that loses its own bottom the moment the bar comes back. */}
                    <div className={`${openUp
                        ? 'fixed inset-x-3 bottom-[60px] max-h-[min(calc(100svh-72px),560px)]'
                        : 'absolute right-0 top-10 w-[min(92vw,720px)] max-h-[min(70dvh,560px)]'
                        } z-50 overflow-y-auto overscroll-contain bg-slate-950 border border-slate-800 rounded-lg shadow-xl p-4 space-y-3`}>
                        <div className="flex justify-between items-center">
                            <span className="text-[10px] text-slate-400 uppercase tracking-wider font-bold">{t.title}</span>
                            <button onClick={() => setIsOpen(false)} className="text-slate-600 hover:text-slate-300">
                                <X size={12} />
                            </button>
                        </div>
                        <p className="text-[9px] text-slate-600">{t.note}</p>

                        {!decoded && <p className="text-[10px] text-slate-500">{t.none}</p>}

                        {decoded && ECU_ITEMS.map(def => {
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
                                    {/* Narrow on `def`, not on `v`: TypeScript cannot infer that the
                                        two discriminants agree just because they were built together. */}
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
                    </div>
                </>
            )}
        </div>
    );
};
