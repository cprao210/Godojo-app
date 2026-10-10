// Post-meeting background-process loader.
//
// Shown ONLY while a finished meeting is still being processed in the
// background (analysis → title → summary → save). It renders the real steps main
// reports (see lib/postMeetingProgress) — no timers, no guessed percentages,
// and nothing from the meeting-details read.
//
// Cheap on low-end / Windows machines:
//   - no framer-motion, no backdrop-filter, no animated shadow/filter
//   - the bar animates `transform: scaleX` (compositor-only, no layout)
//   - one 1s timer for the elapsed clock, paused while the window is hidden
//   - Performance Mode / prefers-reduced-motion: spinner + shimmer become static

import React, { useEffect, useReducer, useRef } from 'react';
import { Check, Circle } from 'lucide-react';
import { usePerformanceMode } from '@/hooks';
import {
    STEP_META,
    computeProgressPercent,
    type MeetingProcessingSnapshot,
    type ProcessingStepStatus,
} from '@/lib/postMeetingProgress';

const STYLE_ID = 'pmp-loader-styles';
const CSS = `
.pmp-bar{transform-origin:left center;transition:transform .6s cubic-bezier(.22,.61,.36,1);will-change:transform}
.pmp-spin{border-radius:9999px;border:2px solid rgba(59,130,246,.25);border-top-color:#3b82f6;animation:pmp-rot .9s linear infinite}
.pmp-shimmer{position:absolute;inset:0;width:40%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);animation:pmp-slide 1.8s ease-in-out infinite}
@keyframes pmp-rot{to{transform:rotate(360deg)}}
@keyframes pmp-slide{from{transform:translateX(-100%)}to{transform:translateX(350%)}}
.perf-mode .pmp-spin,.perf-mode .pmp-shimmer{animation:none}
.perf-mode .pmp-shimmer{display:none}
.perf-mode .pmp-bar{transition:none}
@media (prefers-reduced-motion:reduce){.pmp-spin,.pmp-shimmer{animation:none}.pmp-shimmer{display:none}.pmp-bar{transition:none}}
`;
function ensureStyles(): void {
    if (typeof document === 'undefined') return;
    let el = document.getElementById(STYLE_ID);
    if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
    }
    if (el.textContent !== CSS) el.textContent = CSS;
}
ensureStyles();

export interface PostMeetingProcessingLoaderProps {
    /** Live steps from main; null until the first report arrives. */
    snapshot: MeetingProcessingSnapshot | null;
    /** Fallback clock origin (meeting end time) while there is no snapshot yet. */
    fallbackStartedAt: number;
    isLight: boolean;
}

const formatElapsed = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

const StepIcon: React.FC<{ status: ProcessingStepStatus; lite: boolean }> = ({ status, lite }) => {
    if (status === 'done') {
        return (
            <span className="w-5 h-5 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                <Check size={12} strokeWidth={3} className="text-emerald-500" />
            </span>
        );
    }
    if (status === 'active') {
        return (
            <span className="w-5 h-5 flex items-center justify-center shrink-0">
                {lite
                    ? <span className="w-2.5 h-2.5 rounded-full bg-blue-500 perf-pulse-dot" />
                    : <span className="pmp-spin w-4 h-4" />}
            </span>
        );
    }
    return (
        <span className="w-5 h-5 flex items-center justify-center shrink-0">
            <Circle size={12} strokeWidth={2} className="text-slate-400/50" />
        </span>
    );
};

const PostMeetingProcessingLoader: React.FC<PostMeetingProcessingLoaderProps> = ({ snapshot, fallbackStartedAt, isLight }) => {
    const { isPerformanceMode } = usePerformanceMode();
    const [, tick] = useReducer((n: number) => n + 1, 0);

    // 1s heartbeat for the elapsed clock only; skipped while hidden.
    useEffect(() => {
        const id = window.setInterval(() => {
            if (!document.hidden) tick();
        }, 1000);
        return () => window.clearInterval(id);
    }, []);

    const mountedAt = useRef(Date.now());
    const maxPercent = useRef(0);

    const now = Date.now();
    const steps = snapshot?.steps ?? [];
    const rawStart = snapshot?.startedAt ?? fallbackStartedAt;
    const start = Number.isFinite(rawStart) && rawStart <= now ? rawStart : mountedAt.current;

    // Monotonic: a re-activated step (analysis can run twice) never moves the bar back.
    const percent = Math.max(maxPercent.current, computeProgressPercent(steps));
    maxPercent.current = percent;

    const active = steps.filter(s => s.status === 'active');
    const headline = active.length
        ? active.map(s => STEP_META[s.id].label).join(' · ')
        : snapshot ? 'Almost there' : 'Getting started';

    const card = isLight ? 'bg-white border-slate-200' : 'bg-white/[0.03] border-white/[0.08]';
    const title = isLight ? 'text-slate-800' : 'text-white/85';
    const sub = isLight ? 'text-slate-500' : 'text-white/40';
    const track = isLight ? 'bg-slate-100' : 'bg-white/[0.07]';
    const doneCount = steps.filter(s => s.status === 'done').length;

    return (
        <div className={`rounded-2xl border p-5 mb-6 ${card}`}>
            <div className="flex items-start justify-between gap-4 mb-4">
                <div className="min-w-0">
                    <p className={`text-[14px] font-semibold ${title}`}>Processing your meeting</p>
                    <p className={`text-[12px] mt-0.5 ${sub}`} aria-live="polite">{headline}</p>
                </div>
                <div className="text-right shrink-0">
                    <p className={`text-[18px] font-semibold tabular-nums leading-none ${title}`}>{percent}%</p>
                    <p className={`text-[11px] mt-1 tabular-nums ${sub}`}>{formatElapsed(now - start)}</p>
                </div>
            </div>

            <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label="Meeting processing progress"
                className={`relative h-1.5 w-full rounded-full overflow-hidden ${track}`}
            >
                <div
                    className="pmp-bar absolute inset-0 rounded-full bg-gradient-to-r from-blue-500 to-sky-400 overflow-hidden"
                    style={{ transform: `scaleX(${percent / 100})` }}
                >
                    <span className="pmp-shimmer" />
                </div>
            </div>

            {steps.length > 0 && (
                <ul className="mt-5 space-y-3">
                    {steps.map(step => (
                        <li key={step.id} className="flex items-start gap-3">
                            <div className="mt-0.5"><StepIcon status={step.status} lite={isPerformanceMode} /></div>
                            <div className="min-w-0">
                                <p className={`text-[13px] font-medium ${step.status === 'pending' ? (isLight ? 'text-slate-400' : 'text-white/25') : title}`}>
                                    {STEP_META[step.id].label}
                                </p>
                                {step.status === 'active' && (
                                    <p className={`text-[12px] leading-relaxed ${sub}`}>
                                        {step.detail ?? STEP_META[step.id].idleDetail}
                                    </p>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            <p className={`text-[11px] mt-5 ${sub}`}>
                {steps.length > 0 ? `${doneCount} of ${steps.length} steps complete · ` : ''}
                You can leave this page — it keeps running in the background.
            </p>
        </div>
    );
};

export default PostMeetingProcessingLoader;