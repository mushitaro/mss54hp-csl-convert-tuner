import React, { useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import {
    FieldKey, LOG_FIELD_REGISTRY, fieldGroupsFor, fieldsIn, describeField, isLastOfRequiredGroup,
} from '@/lib/field-registry/registry';
import { useIsPreviewBuild } from '@/lib/build-variant';
import { DEV_VARIANT_IS_PREVIEW } from '@/lib/features';

/** Why the last lambda bank cannot be switched off. Shown ON the checkbox, because a control that
 *  refuses a tap and says nothing is indistinguishable from one that is broken. */
const REQUIRED_REASON = 'At least one lambda controller factor has to stay on screen — it is the '
    + 'only input the VE correction has. Switch the other bank on first.';

interface Props {
    visibleFields: Record<FieldKey, boolean>;
    onToggle: (key: FieldKey) => void;
    onShowCoreOnly: () => void;
    onShowDefaults: () => void;
    /** Open above the trigger instead of below it. The mobile footer sits at the bottom edge, so a
     *  popover hanging `top-10` off a control down there opens off-screen. */
    openUp?: boolean;

}

/**
 * Every label in here is English, and stays English.
 *
 * The app switches language for one class of text only — errors, explanations and dialog copy,
 * routed through lib/dialog-text and useDialogLang. Everything else is an instrument face: labels,
 * headings, field names, button words. That line is the design language, not an omission, and a
 * translated field list was tried here and reverted for crossing it.
 *
 * The place a Japanese reader gets the explanation is `describeField` on hover — which is the class
 * of text that does translate, if it ever needs to.
 */
export const FieldVisibilityPanel: React.FC<Props> = ({ visibleFields, onToggle, onShowCoreOnly, onShowDefaults, openUp }) => {
    const [isOpen, setIsOpen] = useState(false);
    /** Read here rather than passed in: the panel is rendered from two places in the page and a prop
     *  threaded twice is a prop one of them will eventually forget. Same bit the tabs are gated on. */
    const groups = fieldGroupsFor(useIsPreviewBuild() || DEV_VARIANT_IS_PREVIEW);

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`p-2 rounded text-slate-400 hover:text-blue-400 transition-colors ${isOpen ? 'text-blue-400 bg-slate-800' : 'hover:bg-slate-800'}`}
                title="Log Fields"
            >
                <SlidersHorizontal className="w-4 h-4" />
            </button>

            {isOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />

                    {/* Sized like ROW FILTER, which is the panel beside it in the same cluster and the
                        one this is read against. It used to cap at 172px — three and a bit rows of a
                        thirteen-row list, on a control whose entire job is choosing among thirteen
                        things. 494px is FilterConfigPanel's cap, and 280px its width; matching both
                        makes the two popovers one control repeated rather than two sizes. */}
                    <div className={`${openUp ? 'fixed inset-x-3 bottom-[60px] max-h-[min(calc(100svh-72px),494px)] overflow-y-auto overscroll-contain' : 'absolute right-0 top-10 w-[280px] max-h-[min(70dvh,494px)] overflow-y-auto overscroll-contain'} bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 p-4 animate-in fade-in zoom-in-95 duration-200`}>
                        <div className="flex justify-between items-center mb-3 border-b border-slate-800 pb-2">
                            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                                <SlidersHorizontal className="w-3 h-3" />
                                LOG FIELDS
                            </h3>
                            <button onClick={() => setIsOpen(false)} className="text-slate-500 hover:text-slate-300">
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Two sections, because twenty checkboxes in one list put the eight a
                            tune is actually read from wherever the registry happened to declare
                            them. The heading is the instrument's vocabulary and stays English; the
                            sentence under it is an explanation, which is the class of text that
                            would translate if it ever needs to. */}
                        {groups.map(group => (
                        <div key={group.relevance} className="space-y-1 mb-3 last:mb-0">
                            <div className="pt-1">
                                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                                    {group.title}
                                </div>
                                <p className="text-[9px] leading-snug text-slate-600 mt-0.5">{group.hint}</p>
                            </div>
                            {fieldsIn(group.relevance).map(key => {
                                const meta = LOG_FIELD_REGISTRY[key];
                                const on = visibleFields[key];
                                // The last remaining member of a required group. Drawn checked and
                                // disabled rather than simply ignoring the tap: the rule is that
                                // one of the two banks stays, and a checkbox that silently declines
                                // is how a rule becomes a bug report.
                                const locked = isLastOfRequiredGroup(key, visibleFields);
                                return (
                                    <label
                                        key={key}
                                        title={locked ? `${describeField(meta)}\n\n${REQUIRED_REASON}` : describeField(meta)}
                                        className={`flex items-start gap-2 py-1.5 px-1 -mx-1 rounded ${locked ? 'cursor-default' : 'cursor-pointer hover:bg-slate-800/60'}`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={on}
                                            disabled={locked}
                                            onChange={() => onToggle(key)}
                                            className="mt-0.5 w-3.5 h-3.5 shrink-0 accent-blue-500 rounded bg-slate-700 border-none disabled:opacity-60"
                                        />
                                        <span className="min-w-0 flex flex-col gap-0.5">
                                            {/* What the channel IS, first — the registry's `name`, which is
                                                the readable half of karter16's Symbol/Name pair and until now
                                                only existed on hover. A list whose whole job is choosing among
                                                thirteen channels cannot spell them all `tefc_ll_st`.

                                                The colour is the one this channel is drawn in on the chart, so
                                                the list and the trace agree without a legend. */}
                                            <span
                                                className="text-[11px] leading-tight text-slate-300"
                                                style={{ color: on ? meta.color : undefined }}
                                            >
                                                {meta.name}
                                            </span>
                                            <span className="flex items-baseline gap-1.5 text-[10px] leading-tight">
                                                {/* Symbols are lowercase DME identifiers, so this list must NOT
                                                    uppercase them the way the rest of the app's labels are
                                                    uppercased — `la_f_regler1` shouted as `LA_F_REGLER1` stops
                                                    matching the reference tool, the Funktionsrahmen and the
                                                    disassembly, which is the whole point of using the symbol.
                                                    Computed fields carry a `calc` tag instead, so a name that
                                                    looks like a symbol but is not one cannot be mistaken for
                                                    one. */}
                                                <span className="font-mono text-slate-500">{meta.symbol}</span>
                                                {meta.source === 'derived' && (
                                                    <span className="text-slate-600 text-[9px]" title="Computed by this app">calc</span>
                                                )}
                                            </span>
                                        </span>
                                    </label>
                                );
                            })}
                        </div>
                        ))}

                        <div className="mt-3 pt-3 border-t border-slate-800 flex justify-between text-[10px]">
                            <button onClick={onShowCoreOnly} className="text-slate-500 hover:text-blue-400 uppercase tracking-wider">Core Only</button>
                            <button onClick={onShowDefaults} className="text-slate-500 hover:text-blue-400 uppercase tracking-wider">Defaults</button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};
