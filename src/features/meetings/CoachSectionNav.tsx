import { useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import type { Meeting } from '@/types';

/**
 * CoachSectionNav — the sticky "Coach sections" rail beside the Coach tab's
 * content (mirrors the Transcript tab's two-column layout).
 *
 * The rail is data-driven: it lists only the sections that actually rendered
 * on this meeting, so mixed meeting types (demo panel present, negotiation
 * panel present, legacy action items instead of Game Plan, …) are handled
 * automatically. Clicking an item scrolls that section into view under the
 * sticky header; the active item follows scroll position, and the counter
 * shows which section you're on.
 */

type NavSection = { id: string; label: string };

const CANDIDATE_SECTIONS: NavSection[] = [
    { id: 'coach-call-summary', label: 'Call Summary' },
    { id: 'coach-demo', label: 'Follow up on the demo' },
    { id: 'coach-negotiation', label: 'Move the deal to signature' },
    { id: 'coach-game-plan', label: 'Your game plan' },
    { id: 'coach-notes', label: 'Coach\u2019s notes' },
    { id: 'coach-action-items', label: 'Action items' },
    { id: 'coach-key-points', label: 'Key points' },
];

/** Nearest ancestor that actually scrolls (the details pane, not window). */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
    let node = el?.parentElement ?? null;
    while (node && node !== document.body) {
        const overflowY = getComputedStyle(node).overflowY;
        if (node.scrollHeight > node.clientHeight && (overflowY === 'auto' || overflowY === 'scroll')) {
            return node;
        }
        node = node.parentElement;
    }
    return null;
}

export default function CoachSectionNav({ isLight, stickyTop, meeting, candidates = CANDIDATE_SECTIONS, sections: explicitSections, title = 'Coach sections' }: {
    isLight: boolean;
    /** Sections to look for in the DOM (defaults to the Coach tab's). */
    candidates?: NavSection[];
    /** The exact sections to list. When given, the DOM is not scanned — the caller decides what
     *  is on screen (Call Analysis tab), so the rail can never drift from what rendered. */
    sections?: NavSection[];
    /** Rail heading + aria-label (e.g. "Analysis sections"). */
    title?: string;
    /** Sticky header height — keeps scrolled sections clear of it. */
    stickyTop: number;
    /** Re-discovery trigger: a new object arrives on refetch/regeneration. */
    meeting: Meeting;
}) {
    const asideRef = useRef<HTMLElement>(null);
    const [discovered, setDiscovered] = useState<NavSection[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const sections = explicitSections ?? discovered;
    // Stable identity for "which sections", so a new array with the same ids doesn't re-run effects.
    const sectionKey = sections.map((x) => x.id).join('|');

    // Discover which candidate sections exist in the DOM (a section that
    // rendered nothing returns null and leaves no element behind).
    useEffect(() => {
        if (explicitSections) return;
        const found = candidates.filter((s) => document.getElementById(s.id));
        setDiscovered(found);
        setActiveId((prev) => (found.some((s) => s.id === prev) ? prev : found[0]?.id ?? null));
    }, [meeting, candidates, explicitSections]);

    // Explicit list changed (a section appeared/disappeared) — keep the active item valid.
    useEffect(() => {
        if (!explicitSections) return;
        setActiveId((prev) => (explicitSections.some((s) => s.id === prev) ? prev : explicitSections[0]?.id ?? null));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sectionKey]);

    // Follow scroll: the active section is the last one whose top has passed
    // a mark ~28% down the pane. Computed on every scroll AND resize — unlike
    // an IntersectionObserver band, this can't get stuck when the last section
    // is too short to ever reach the top of the viewport, and pinning the
    // scroll to the bottom always activates the final section.
    useEffect(() => {
        if (sections.length === 0) return;
        const els = sections
            .map((s) => document.getElementById(s.id))
            .filter((el): el is HTMLElement => el !== null);
        if (els.length === 0) return;

        const scroller = findScrollParent(asideRef.current) ?? document.documentElement;

        const update = () => {
            const scrollerTop = scroller === document.documentElement ? 0 : scroller.getBoundingClientRect().top;
            const mark = scrollerTop + scroller.clientHeight * 0.28;
            let current = els[0];
            for (const el of els) {
                if (el.getBoundingClientRect().top <= mark) current = el;
            }
            // Bottomed out → the last section is active even if its top
            // never crossed the mark (short trailing sections).
            const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
            if (atBottom) current = els[els.length - 1];
            setActiveId(current.id);
        };

        update();
        scroller.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        return () => {
            scroller.removeEventListener('scroll', update);
            window.removeEventListener('resize', update);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sectionKey]);

    // Nothing to navigate (or fewer than two sections) — hide the rail.
    if (sections.length < 2) return null;

    const scrollToSection = (id: string) => {
        const el = document.getElementById(id);
        if (!el) return;
        const scroller = findScrollParent(asideRef.current);
        if (scroller) {
            const y = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
                + scroller.scrollTop - (stickyTop + 12);
            scroller.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
        } else {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    };

    const backToTop = () => {
        const scroller = findScrollParent(asideRef.current);
        if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
        else window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const activeIndex = sections.findIndex((s) => s.id === activeId);

    return (
        <aside
            ref={asideRef}
            aria-label={title}
            style={{ top: stickyTop + 16, maxHeight: `calc(100vh - ${stickyTop + 32}px)` }}
            className="custom-scrollbar hidden overflow-y-auto lg:sticky lg:block"
        >
            <div className={`rounded-2xl border p-4 ${isLight
                ? 'border-slate-200/80 bg-white shadow-[0_20px_60px_-25px_rgba(30,58,138,0.15)]'
                : 'border-white/[0.07] bg-gray-800/20'
                }`}>
                <div className="mb-2 flex items-center justify-between px-1">
                    <span className={`text-[12px] font-semibold ${isLight ? 'text-slate-600' : 'text-white/70'}`}>
                        {title}
                    </span>
                    <span className={`text-[11px] font-medium tabular-nums ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                        {activeIndex >= 0 ? activeIndex + 1 : '–'} / {sections.length}
                    </span>
                </div>
                <nav>
                    <ol className="relative">
                        <span
                            aria-hidden
                            className={`absolute bottom-[13px] left-[16px] top-[13px] w-px ${isLight ? 'bg-slate-200' : 'bg-white/[0.08]'}`}
                        />
                        {sections.map((s, i) => {
                            const active = s.id === activeId;
                            return (
                                <li key={s.id} className="relative">
                                    <button
                                        type="button"
                                        onClick={() => scrollToSection(s.id)}
                                        aria-current={active ? 'location' : undefined}
                                        className="group flex w-full items-center gap-3 rounded-lg py-1.5 pl-1 pr-2 text-left"
                                    >
                                        <span className={`relative z-10 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition-colors ${active
                                            ? 'border-blue-500 bg-blue-500 text-white'
                                            : isLight
                                                ? 'border-slate-300 bg-white text-slate-400 group-hover:border-blue-300 group-hover:text-blue-500'
                                                : 'border-white/15 bg-gray-800 text-white/40 group-hover:border-blue-500/50 group-hover:text-blue-300'
                                            }`}>
                                            {i + 1}
                                        </span>
                                        <span className={`min-w-0 text-[13px] leading-snug transition-colors ${active
                                            ? `font-semibold ${isLight ? 'text-slate-900' : 'text-white'}`
                                            : isLight
                                                ? 'text-slate-400 group-hover:text-slate-600'
                                                : 'text-white/35 group-hover:text-white/70'
                                            }`}>
                                            {s.label}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ol>
                </nav>
                <button
                    type="button"
                    onClick={backToTop}
                    className={`mt-2 flex w-full items-center gap-2 border-t pt-3 text-[12px] font-medium transition-colors ${isLight
                        ? 'border-slate-100 text-slate-400 hover:text-blue-600'
                        : 'border-white/[0.06] text-white/35 hover:text-blue-300'
                        }`}
                >
                    <ArrowUp size={13} />
                    Back to top
                </button>
            </div>
        </aside>
    );
}