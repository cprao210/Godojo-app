import { useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight, /* Check, */ ChevronDown, ChevronUp, Play } from 'lucide-react';
import type { MeetingDetailedSummary } from '@/types';
import { parseCoachNoteItem, /* parseCoachHighlight, */ type ParsedCoachNote } from '@/lib/coachSummary';
import { CopyButton, EmptySectionNote } from './coachShared';

/**
 * Coach's Notes — the post-call coaching panel below the Game Plan.
 *
 * Currently a single "Try next time" column over salesCoachReview data:
 *   "Try next time" ← whatICouldHaveDoneBetter (the miss + how to do it better
 *                     next time, with a copyable "Try saying" script). The number of
 *                     points is whatever the summary genuinely supports.
 * Items are skill labelled ("Questioning: …"); legacy meetings carry
 * framework-prefixed labels, handled by the shared parser. The whole panel
 * hides when there is nothing to try next time.
 *
 * "Replay these moments" (whatIDidRight, timestamped film-review highlights) is
 * temporarily commented out below — search for "REPLAY (disabled)" to restore it.
 */

const NOTES_PREVIEW_COUNT = 3;

function NoteCard({ note, isLight }: { note: ParsedCoachNote; isLight: boolean }) {
    return (
        <div className={`rounded-xl border p-4 ${isLight
            ? 'border-slate-200 bg-slate-50/70'
            : 'border-white/[0.07] bg-white/[0.03]'
            }`}>
            {(note.time || note.label) && (
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    {note.time && (
                        <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${isLight
                            ? 'border-blue-200 bg-blue-50 text-blue-600'
                            : 'border-blue-500/25 bg-blue-500/10 text-blue-300'
                            }`}>
                            <Play size={9} className="fill-current" />
                            {note.time}
                        </span>
                    )}
                    {note.label && (
                        <span className={`rounded-md border px-2 py-0.5 text-[10.5px] font-semibold ${isLight
                            ? 'border-slate-200 bg-slate-100 text-slate-500'
                            : 'border-white/10 bg-white/[0.06] text-white/50'
                            }`}>
                            {note.label}
                        </span>
                    )}
                </div>
            )}
            {note.content && (
                <p className={`text-[13.5px] leading-relaxed ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                    {note.content}
                </p>
            )}
            {note.quote && (
                <div className={`mt-2.5 flex items-start gap-2.5 rounded-lg border p-3 ${isLight
                    ? 'border-blue-200 bg-blue-50'
                    : 'border-blue-500/20 bg-blue-500/[0.08]'
                    }`}>
                    <p className={`min-w-0 flex-1 text-[13px] italic leading-relaxed ${isLight ? 'text-blue-700' : 'text-blue-200/90'}`}>
                        &ldquo;{note.quote}&rdquo;
                    </p>
                    <CopyButton text={note.quote} label="suggestion" isLight={isLight} />
                </div>
            )}
        </div>
    );
}

function NotesColumn({ title, icon, notes, placeholder, isLight }: {
    title: string;
    icon: ReactNode;
    notes: ParsedCoachNote[];
    /** Shown when this column is empty but the other one has content. */
    placeholder: string;
    isLight: boolean;
}) {
    const [expanded, setExpanded] = useState(false);
    const visible = expanded ? notes : notes.slice(0, NOTES_PREVIEW_COUNT);
    const hiddenCount = notes.length - NOTES_PREVIEW_COUNT;

    return (
        <div>
            <div className="mb-4 flex items-center gap-2.5">
                {icon}
                <h4 className={`text-[15px] font-semibold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                    {title}
                </h4>
                <span className={`text-[11.5px] font-medium tabular-nums ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                    {notes.length}
                </span>
            </div>
            {notes.length === 0 ? (
                <EmptySectionNote text={placeholder} isLight={isLight} />
            ) : (
                <>
                    <div className="space-y-3">
                        {visible.map((note, i) => (
                            <NoteCard key={i} note={note} isLight={isLight} />
                        ))}
                    </div>
                    {hiddenCount > 0 && (
                        <button
                            type="button"
                            onClick={() => setExpanded(prev => !prev)}
                            aria-expanded={expanded}
                            className={`mt-3 flex items-center gap-1.5 text-[12px] font-medium transition-colors ${isLight
                                ? 'text-blue-600 hover:text-blue-700'
                                : 'text-blue-300 hover:text-blue-200'
                                }`}>
                            {expanded
                                ? <>Show fewer <ChevronUp size={13} /></>
                                : <>Show {hiddenCount} more <ChevronDown size={13} /></>}
                        </button>
                    )}
                </>
            )}
        </div>
    );
}

export default function CoachNotes({ summary, isLight }: { summary: MeetingDetailedSummary; isLight: boolean }) {
    // REPLAY (disabled): "Replay these moments" is hidden for now.
    // const keepDoing = (summary.salesCoachReview?.whatIDidRight ?? [])
    //     .map(parseCoachHighlight)
    //     .filter((n): n is ParsedCoachNote => n !== null);
    const tryNextTime = (summary.salesCoachReview?.whatICouldHaveDoneBetter ?? [])
        .map(parseCoachNoteItem)
        .filter((n): n is ParsedCoachNote => n !== null);

    if (tryNextTime.length === 0) return null;

    return (
        <section id="coach-notes" className="mb-10">
            <div className={`rounded-2xl border ${isLight
                ? 'border-slate-200/80 bg-white shadow-[0_20px_60px_-25px_rgba(30,58,138,0.15)]'
                : 'border-white/[0.07] bg-gray-800/20'
                }`}>
                <div className="p-6 sm:p-7">
                    {/* Header */}
                    <div className={`border-b pb-5 ${isLight ? 'border-slate-100' : 'border-white/[0.06]'}`}>
                        <h3 className={`text-[19px] font-bold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                            Coach&rsquo;s notes
                        </h3>
                        <p className={`mt-1 text-[13px] ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                            What to try next time
                        </p>
                    </div>

                    {/* Coaching suggestions (single column while "Replay these moments" is disabled) */}
                    <div className="mt-5 grid gap-6">
                        {/* REPLAY (disabled): strengths column — restore together with keepDoing, the
                            Check / parseCoachHighlight imports, and the md:grid-cols-2 grid above.
                        <NotesColumn
                            title="Replay these moments"
                            placeholder="No coach-worthy moments were captured on this call."
                            icon={
                                <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-emerald-500/40">
                                    <Check size={11} className="text-emerald-400" />
                                </span>
                            }
                            notes={keepDoing}
                            isLight={isLight}
                        />
                        */}
                        <NotesColumn
                            title="Try next time"
                            placeholder="Nothing to change — this call was executed cleanly."
                            icon={<ArrowUpRight size={16} className="shrink-0 text-amber-400" />}
                            notes={tryNextTime}
                            isLight={isLight}
                        />
                    </div>
                </div>
            </div>
        </section>
    );
}