import React from 'react';
import { Fingerprint } from 'lucide-react';
import { DmeIdentity } from '@/lib/dme-link/types';
import { ServiceBlockLayout, LOW_SLOT_WARNING_THRESHOLD } from '@/lib/dme-link/flashCounter';
import { useDialogLang } from '@/hooks/useDialogLang';
import { DialogFrame } from './DialogFrame';

/**
 * What car this is, on demand.
 *
 * The header carries VIN/AIF/SW inline, but only above 900px — below that the three spans are
 * `hidden` and there was no other way to reach them. A comment in the header claimed the identity
 * was still on the status dot's tooltip; it was not (that title carries link state and error only),
 * so on a phone the identity was simply gone. This is the dot's actual destination.
 *
 * Read-only on purpose. The one control that lives on this data — the flash-counter reset — stays
 * on the FLASH button in the header, one step deeper than a readout, and is not duplicated here.
 */
interface Props {
    identity: DmeIdentity | null;
    /** dmeLink.state, so the dialog can say why the fields are empty rather than just showing dashes. */
    state: string;
    onClose: () => void;
}

const TEXT = {
    ja: {
        title: 'DME IDENTITY — 車両識別',
        close: '閉じる',
        vin: '車台番号',
        aif: '識別情報 (AIF)',
        sw: 'ソフトウェア番号',
        flash: '書き込み回数',
        notRead: '未読み取り',
        disconnected: '未接続です。CONNECT で DME に接続すると読み取ります。',
        pending: '接続中です。識別情報は接続直後に読み取られます。',
        flashUnknown: 'フラッシュカウンタを読めていません（接続には影響しません）。',
    },
    en: {
        title: 'DME IDENTITY',
        close: 'Close',
        vin: 'VIN',
        aif: 'AIF',
        sw: 'Software number',
        flash: 'Flash counter',
        notRead: 'not read',
        disconnected: 'Not connected. CONNECT to the DME and this is read on the way in.',
        pending: 'Connecting. Identity is read as soon as the link is up.',
        flashUnknown: 'Flash counter could not be read (this never fails the connection).',
    },
};

/** One label/value pair. Values are monospace because they are all part numbers — a VIN read in a
 *  proportional face is hard to compare against the one on the strut tower. */
const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-baseline gap-4 py-2 border-b border-slate-800 last:border-b-0">
        <span className="w-40 shrink-0 text-[10px] uppercase tracking-widest text-slate-500">{label}</span>
        <span className="min-w-0 flex-1 font-mono text-[13px] text-slate-200 break-all">{children}</span>
    </div>
);

export const DmeIdentityDialog: React.FC<Props> = ({ identity, state, onClose }) => {
    const t = TEXT[useDialogLang()];
    const flash = identity?.flashCounter ?? null;

    // Same three-way reading as the header's FLASH colour: red once a processor is not 'available'
    // (a programming session is still open), amber inside the reference's low-slot band, otherwise
    // plain. Repeated rather than shared because the header folds both processors into one number
    // and this dialog is the place that does not have to.
    const regions = flash ? [flash.master, flash.slave] : [];
    const flashColor = regions.some(r => r.state !== 'available') ? 'text-red-400'
        : regions.some(r => r.remaining < LOW_SLOT_WARNING_THRESHOLD) ? 'text-amber-400'
            : 'text-slate-200';

    const dash = <span className="text-slate-600">{t.notRead}</span>;

    return (
        <DialogFrame
            icon={<Fingerprint className="w-3 h-3" />}
            title={t.title}
            closeLabel={t.close}
            onClose={onClose}
            autoHeight
        >
            <div className="overflow-y-auto">
                <Row label={t.vin}>{identity?.vin ?? dash}</Row>
                <Row label={t.aif}>{identity?.aif ?? dash}</Row>
                <Row label={t.sw}>{identity?.softwareVersion ?? dash}</Row>
                <Row label={t.flash}>
                    {flash ? (
                        <span className="flex flex-col gap-0.5">
                            {regions.map(r => (
                                <span key={r.name} className={flashColor}>
                                    {r.name} {r.used}/{ServiceBlockLayout.limitPerProcessor}
                                    <span className="text-slate-500"> — {r.remaining} left</span>
                                </span>
                            ))}
                        </span>
                    ) : dash}
                </Row>
            </div>

            {/* Why the fields are empty, when they are. Without this the dialog answers "not read" to
                a question the user cannot act on — the fix is different depending on whether the link
                is down or the read simply failed. */}
            {!identity && (
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                    {state === 'disconnected' ? t.disconnected : t.pending}
                </p>
            )}
            {identity && !flash && (
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{t.flashUnknown}</p>
            )}
        </DialogFrame>
    );
};
