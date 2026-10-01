// src/lib/liveAnalysisV2.ts
//
// Pure logic for live analysis v2 (godojo-apis docs/LIVE_ANALYSIS_V2_PLAN.md): wire types, the
// transcript → turns mapping, the event reducer, the settled-speech tick cadence, and the
// projection of the app-held state onto the `LiveAnalysisData` shape the panel already renders.
//
// The app is the store (plan §3.5): each tick posts the state + signature from the last `done`,
// and `done` returns the updated, re-signed state which REPLACES the local copy. The earlier
// events only exist so the panel can update (and flash changed fields) before `done` lands.

import type {
    BANTField,
    DealOptimizerAlert,
    LiveAnalysisData,
    LiveTranscriptEntry,
    MEDDICField,
    Objection,
    Signal,
} from '@/types';
import { MAX_SAVED_OBJECTIONS, quotesOverlap, stableId } from '@/lib/objections';

// ── wire types ───────────────────────────────────────────────────────────────

export type V2Role = 'seller' | 'prospect' | 'other';

export interface V2Turn {
    turn_id: string;
    role: V2Role;
    speaker?: string;
    speaker_index?: number | null;
    /** ORIGINAL recognized text — the only thing the backend grounds evidence on. */
    text: string;
    /** Display translation, sent only when it differs from `text`. */
    text_en?: string;
    lang?: string;
    asr_suspect?: boolean;
    after_close?: boolean;
    t_start_ms?: number;
    t_end_ms?: number;
}

export interface V2Field {
    emoji: string;
    status: 'confirmed' | 'partial' | 'missing';
    evidence: string[];
    evidence_refs: Array<{ turn_id?: string; t_start_ms?: number }>;
    summary: string;
    suggested_question: string;
    updated_version: number;
    updated_turn_id: string;
}

export interface V2Signal extends Signal {
    id: string;
    turn_id?: string;
    t_start_ms?: number;
}

export interface V2State {
    v: number;
    session_id: string;
    version: number;
    bant: Record<string, V2Field>;
    meddic: Record<string, V2Field>;
    signals: V2Signal[];
    recent_turns: V2Turn[];
    seen_turn_ids: string[];
    meta: Record<string, unknown>;
}

export interface V2Change {
    path: string;
    from: string;
    to: string;
    kind: 'upgrade' | 'downgrade' | 'correction' | 'evidence_update';
    capped?: boolean;
    field: V2Field;
}

export interface V2Done {
    version: number;
    state: V2State;
    state_sig: string;
    state_trusted: boolean;
    trace_id: string | null;
    timings_ms?: Record<string, number>;
    route?: { fields_in_scope?: string[]; sweep?: boolean; widened?: boolean };
}

export interface V2TickRequest {
    session_id: string;
    tick_id: string;
    meeting_id?: string | null;
    state: V2State | null;
    state_sig: string | null;
    meeting_types: string[];
    turns: V2Turn[];
    force_sweep?: boolean;
    final?: boolean;
}

/** POST /intelligence/live-analysis/v2/end — the final analysis of a finished call. */
export interface V2EndRequest {
    session_id: string;
    meeting_id?: string | null;
    state: V2State | null;
    state_sig: string | null;
    meeting_types: string[];
    turns: V2Turn[];
    persist?: boolean;
    /** What the live panel showed, for the pass to grade (the live signals ride in `state`). */
    live_objections?: Array<{ quote: string; type: Objection['type'] }>;
}

export interface V2EndObjection extends Omit<Objection, 'id' | 'resolved'> {
    topic?: string;
    rep_response?: string;
    handled?: 'resolved' | 'partially' | 'unresolved';
    turn_id?: string;
    t_start_ms?: number;
}

export interface V2EndResponse {
    analysis: {
        signals: V2Signal[];
        objections: V2EndObjection[];
        objectionCount?: number;
        source?: string;
    };
    state: V2State;
    state_sig: string;
    state_trusted: boolean;
    trace_id: string | null;
    timings_ms: Record<string, number>;
    /** Lanes that fell back: 'qualify' keeps the live grades, 'insights' keeps the live signals. */
    degraded: string[];
    persisted?: boolean;
    turns: number;
}

/** The backend's cap on turns per end-of-call request (EndRequest.turns). */
export const V2_END_MAX_TURNS = 3000;

export const BANT_KEYS = ['budget', 'authority', 'need', 'timeline'] as const;
export const MEDDIC_KEYS = [
    'metrics',
    'economic_buyer',
    'decision_criteria',
    'decision_process',
    'identify_pain',
    'champion',
    'competition',
] as const;

// ── transcript → turns ──────────────────────────────────────────────────────

const NON_HUMAN = new Set(['system', 'ai', 'assistant', 'model']);

/**
 * Map liveTranscriptRef entries (from `fromIndex`) to v2 turns. `user` is the rep; every other
 * human speaker is the prospect side. `callStartMs` makes `t_start_ms` call-relative so evidence
 * chips can show "12:43". Entries without a main-process turn id (older main build) get a stable
 * index-based one, so the server's dedupe still works.
 */
export function buildTurns(
    entries: LiveTranscriptEntry[],
    fromIndex: number,
    callStartMs: number,
    maxTurns = 60,
): { turns: V2Turn[]; endIndex: number } {
    const turns: V2Turn[] = [];
    let i = Math.max(0, fromIndex);
    for (; i < entries.length && turns.length < maxTurns; i++) {
        const e = entries[i];
        if (!e || NON_HUMAN.has((e.speaker || '').toLowerCase())) continue;
        const original = (e.textOriginal ?? e.text ?? '').trim();
        if (!original) continue;
        const display = (e.text ?? '').trim();
        const at = (e.arrivalMs ?? e.timestamp ?? callStartMs) - callStartMs;
        turns.push({
            turn_id: e.turnId || `r_${i}`,
            role: e.speaker === 'user' ? 'seller' : 'prospect',
            speaker: e.displayName || '',
            speaker_index: e.speakerIndex ?? null,
            text: original.slice(0, 4000),
            ...(display && display !== original ? { text_en: display.slice(0, 4000) } : {}),
            ...(e.lang ? { lang: e.lang } : {}),
            asr_suspect: Boolean(e.asrSuspect),
            t_start_ms: Math.max(0, Math.round(at)),
        });
    }
    return { turns, endIndex: i };
}

// ── cadence ─────────────────────────────────────────────────────────────────

export const V2_POLL_MS = 1_000;
export const V2_MIN_TICK_MS = 8_000;
/** A prospect turn this old has "ended" — the speaker has paused. */
export const V2_SETTLE_MS = 1_500;
export const V2_MIN_PENDING_CHARS = 200;

export interface V2TickDecisionArgs {
    now: number;
    inFlight: boolean;
    lastTickStartedAt: number;
    /** Pending entries not yet covered by a successful `done`. */
    pending: LiveTranscriptEntry[];
    force?: boolean;
}

/** Fire a tick when prospect speech is pending AND has settled (or piled up), at most every 8s. */
export function shouldTickV2(a: V2TickDecisionArgs): boolean {
    if (a.inFlight) return false;
    if (a.force) return true;
    const prospect = a.pending.filter(e => e.speaker !== 'user' && !NON_HUMAN.has((e.speaker || '').toLowerCase()));
    if (prospect.length === 0) return false;
    if (a.now - a.lastTickStartedAt < V2_MIN_TICK_MS) return false;
    const last = prospect[prospect.length - 1];
    const lastAt = last.arrivalMs ?? last.timestamp ?? a.now;
    const chars = prospect.reduce((n, e) => n + (e.text?.length || 0), 0);
    return a.now - lastAt >= V2_SETTLE_MS || chars >= V2_MIN_PENDING_CHARS;
}

// ── reducer ─────────────────────────────────────────────────────────────────

export interface V2View {
    state: V2State | null;
    sig: string | null;
    traceId: string | null;
    /** Field paths changed by the latest tick, for the "updated" highlight. */
    changed: Record<string, V2Change['kind']>;
    /** Monotonic, so the UI can tell ticks apart even when versions repeat. */
    tick: number;
}

export const EMPTY_VIEW: V2View = { state: null, sig: null, traceId: null, changed: {}, tick: 0 };

function setField(state: V2State, path: string, field: V2Field): void {
    const [group, name] = path.split('.') as ['bant' | 'meddic', string];
    if (group !== 'bant' && group !== 'meddic') return;
    state[group] = { ...state[group], [name]: field };
}

/**
 * Apply one stream event. `qualification_update` / `signals_update` / `questions_update` patch
 * the local copy for early display; `done` replaces it wholesale with the server's signed state.
 */
export function applyV2Event(view: V2View, event: string, data: any, tickNo: number): V2View {
    switch (event) {
        case 'qualification_update': {
            if (!view.state) return view;
            const state: V2State = { ...view.state };
            const changed = tickNo === view.tick ? { ...view.changed } : {};
            for (const c of (data?.changes || []) as V2Change[]) {
                setField(state, c.path, c.field);
                changed[c.path] = c.kind;
            }
            return { ...view, state, changed, tick: tickNo };
        }
        case 'signals_update': {
            if (!view.state) return view;
            const incoming = ((data?.items || []) as V2Signal[]).filter(
                s => !view.state!.signals.some(x => x.id === s.id),
            );
            if (incoming.length === 0) return view;
            return { ...view, state: { ...view.state, signals: [...incoming, ...view.state.signals] } };
        }
        case 'questions_update': {
            if (!view.state) return view;
            const state: V2State = { ...view.state };
            for (const [path, q] of Object.entries((data?.questions || {}) as Record<string, string>)) {
                const [group, name] = path.split('.') as ['bant' | 'meddic', string];
                const f = state[group]?.[name];
                if (f) setField(state, path, { ...f, suggested_question: q });
            }
            return { ...view, state };
        }
        case 'done': {
            const d = data as V2Done;
            if (!d?.state) return view;
            return {
                state: d.state,
                sig: d.state_sig,
                traceId: d.trace_id ?? null,
                changed: tickNo === view.tick ? view.changed : {},
                tick: tickNo,
            };
        }
        default:
            return view;
    }
}

// ── projection onto the panel's LiveAnalysisData ────────────────────────────

function toField(f: V2Field | undefined): BANTField & MEDDICField {
    if (!f) return { emoji: '❌', status: 'missing', evidence: [], summary: '', suggested_question: '' };
    return {
        emoji: (f.emoji as BANTField['emoji']) || '❌',
        status: f.status,
        evidence: f.evidence || [],
        summary: f.summary || '',
        suggested_question: f.suggested_question || '',
        evidence_refs: f.evidence_refs || [],
        updated_version: f.updated_version,
    };
}

export function stateToAnalysis(
    state: V2State,
    objections: Objection[] = [],
    dealOptimizer: DealOptimizerAlert[] = [],
): LiveAnalysisData {
    return {
        bant: {
            budget: toField(state.bant.budget),
            authority: toField(state.bant.authority),
            need: toField(state.bant.need),
            timeline: toField(state.bant.timeline),
        },
        meddic: {
            metrics: toField(state.meddic.metrics),
            economic_buyer: toField(state.meddic.economic_buyer),
            decision_criteria: toField(state.meddic.decision_criteria),
            decision_process: toField(state.meddic.decision_process),
            identify_pain: toField(state.meddic.identify_pain),
            champion: toField(state.meddic.champion),
            competition: toField(state.meddic.competition),
        },
        objections,
        signals: (state.signals || []).map(({ turn_id: _t, t_start_ms: _s, ...s }) => s),
        dealOptimizer,
    };
}

/** "12:43" for an evidence chip, from call-relative ms. */
export function formatCallTime(ms?: number): string {
    if (ms === undefined || ms === null || !Number.isFinite(ms)) return '';
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}


// ── end of call ─────────────────────────────────────────────────────────────

/**
 * Project a /v2/end response onto `LiveAnalysisData`. BANT/MEDDIC come from the final signed
 * state; signals are the CONSOLIDATED final list (a live call then puts the live list back in
 * front of it — `keepLiveAddMissed`); objections
 * are the final pass's, with a stable id and `resolved` set for the ones the rep closed on the
 * call — the existing objection cards collapse those into the Resolved group.
 */
export function endResponseToAnalysis(
    res: V2EndResponse,
    dealOptimizer: DealOptimizerAlert[] = [],
): LiveAnalysisData {
    const objections: Objection[] = (res.analysis?.objections || []).map(o => ({
        ...o,
        id: stableId(o.quote),
        resolved: o.handled === 'resolved',
    }));
    const base = stateToAnalysis(res.state, objections, dealOptimizer);
    const finalSignals = res.analysis?.signals;
    return {
        ...base,
        signals: finalSignals && finalSignals.length
            ? finalSignals.map(({ turn_id: _t, t_start_ms: _s, id: _i, ...sig }) => sig)
            : base.signals,
        source: res.analysis?.source || 'v2_end',
    };
}

// ── live list + what the end-of-call pass adds ─────────────────────────────

/** Signals the saved meeting holds when the live list is shorter (the end pass's own cap). */
export const MAX_SAVED_SIGNALS = 8;
/** Backend cap: EndRequest.live_objections max_length. */
export const MAX_LIVE_OBJECTIONS_SENT = 30;

/** The live objections as the end-of-call request carries them. */
export function liveObjectionsForEnd(live: Objection[]): NonNullable<V2EndRequest['live_objections']> {
    return live
        .filter(o => o.quote?.trim())
        .slice(0, MAX_LIVE_OBJECTIONS_SENT)
        .map(o => ({ quote: o.quote, type: o.type }));
}

/** Every live item, in live order, graded by its end-pass match; then end-pass items that match
 *  nothing, while the list is under `max` (never cutting a live item). */
function mergeByQuote<T extends { quote: string }>(
    live: T[],
    final: T[],
    max: number,
    grade: (liveItem: T, graded: T) => T,
): T[] {
    const taken = new Set<number>();
    const out = live.map(item => {
        const i = final.findIndex((f, idx) => !taken.has(idx) && quotesOverlap(item.quote, f.quote));
        if (i < 0) return item;
        taken.add(i);
        return grade(item, final[i]);
    });
    const cap = Math.max(max, live.length);
    final.forEach((f, idx) => {
        if (taken.has(idx) || out.length >= cap) return;
        if (out.some(o => quotesOverlap(o.quote, f.quote))) return;
        out.push(f);
    });
    return out;
}

const gradeObjection = (liveObj: Objection, graded: Objection): Objection => {
    const resolved = liveObj.resolved === true || graded.handled === 'resolved';
    // A grade that contradicts the panel ("unresolved" on one the rep saw close) is left off
    // rather than shown next to it.
    const handled = liveObj.resolved === true && graded.handled === 'unresolved' ? undefined : graded.handled;
    return {
        ...liveObj,
        ...(handled ? { handled } : {}),
        ...(graded.rep_response ? { rep_response: graded.rep_response } : {}),
        ...(!liveObj.topic && graded.topic ? { topic: graded.topic } : {}),
        ...(!liveObj.category && graded.category
            ? { category: graded.category, category_label: graded.category_label }
            : {}),
        suggested_answer: liveObj.suggested_answer || graded.suggested_answer,
        ...(resolved ? { resolved: true } : {}),
    };
};

const gradeSignal = (liveSignal: Signal, graded: Signal): Signal =>
    liveSignal.ask_now?.trim() ? liveSignal : { ...liveSignal, ask_now: graded.ask_now };

/**
 * The saved meeting's objections and buying signals: EVERY item the rep saw on the live panel,
 * graded by the end-of-call pass (how each objection was handled, the rep's reply), followed by
 * what that pass found beyond them. The pass used to re-pick both lists from scratch, so the
 * meeting page disagreed with the panel the rep had just watched.
 *
 * Uploaded calls have no live lists, and get the end pass's lists unchanged.
 */
export function keepLiveAddMissed(
    final: LiveAnalysisData,
    live: { objections: Objection[]; signals: Signal[] },
): LiveAnalysisData {
    return {
        ...final,
        objections: mergeByQuote(live.objections, final.objections, MAX_SAVED_OBJECTIONS, gradeObjection),
        signals: mergeByQuote(live.signals, final.signals, MAX_SAVED_SIGNALS, gradeSignal),
    };
}

/** Uploaded / imported transcripts (no live turn ids): `user` is the rep, everyone else the prospect side. */
export function buildTurnsFromSegments(
    segments: Array<{ speaker: string; text: string; timestamp?: number }>,
    maxTurns = V2_END_MAX_TURNS,
): V2Turn[] {
    const turns: V2Turn[] = [];
    const first = segments.find(s => typeof s.timestamp === 'number')?.timestamp;
    for (const seg of segments) {
        if (turns.length >= maxTurns) break;
        if (!seg || NON_HUMAN.has((seg.speaker || '').toLowerCase())) continue;
        const text = (seg.text || '').trim();
        if (!text) continue;
        turns.push({
            turn_id: `u_${String(turns.length + 1).padStart(5, '0')}`,
            role: seg.speaker === 'user' ? 'seller' : 'prospect',
            text: text.slice(0, 4000),
            t_start_ms: typeof seg.timestamp === 'number' && typeof first === 'number'
                ? Math.max(0, seg.timestamp - first) : 0,
        });
    }
    return turns;
}
