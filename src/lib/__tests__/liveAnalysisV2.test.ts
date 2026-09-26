import { describe, expect, it } from 'vitest';
import {
    applyV2Event,
    buildTurns,
    buildTurnsFromSegments,
    EMPTY_VIEW,
    endResponseToAnalysis,
    formatCallTime,
    shouldTickV2,
    stateToAnalysis,
    V2_MIN_TICK_MS,
    V2State,
} from '@/lib/liveAnalysisV2';
import { SSEParser, parseFrame } from '@/lib/sse';
import { mergeDealAlerts } from '@/lib/dealAlerts';
import type { LiveTranscriptEntry } from '@/types';

const field = (status: 'confirmed' | 'partial' | 'missing' = 'missing', evidence: string[] = []) => ({
    emoji: status === 'confirmed' ? '✅' : status === 'partial' ? '⚠️' : '❌',
    status,
    evidence,
    evidence_refs: evidence.map((_, i) => ({ turn_id: `t${i}`, t_start_ms: 83_000 })),
    summary: '',
    suggested_question: '',
    updated_version: 0,
    updated_turn_id: '',
});

const emptyState = (): V2State => ({
    v: 2,
    session_id: 's1',
    version: 0,
    bant: { budget: field(), authority: field(), need: field(), timeline: field() },
    meddic: {
        metrics: field(), economic_buyer: field(), decision_criteria: field(), decision_process: field(),
        identify_pain: field(), champion: field(), competition: field(),
    },
    signals: [],
    recent_turns: [],
    seen_turn_ids: [],
    meta: {},
});

describe('buildTurns', () => {
    const entries: LiveTranscriptEntry[] = [
        { speaker: 'system', text: 'Meeting started', timestamp: 1000 },
        { speaker: 'user', text: 'How many guards do you have?', timestamp: 2000, turnId: 't_1_00001', arrivalMs: 2000 },
        {
            speaker: 'client', text: 'We have about 1500 guards', textOriginal: 'हमारे पास लगभग पंद्रह सौ guards हैं',
            timestamp: 5000, turnId: 't_1_00002', arrivalMs: 4000, lang: 'hi', speakerIndex: 0,
        },
        { speaker: 'client', text: 'Déjame ver.', timestamp: 6000, asrSuspect: true },
    ];

    it('sends the ORIGINAL text as evidence source and the translation separately', () => {
        const { turns, endIndex } = buildTurns(entries, 0, 1000);
        expect(endIndex).toBe(4);
        expect(turns.map(t => t.role)).toEqual(['seller', 'prospect', 'prospect']);
        expect(turns[1].text).toBe('हमारे पास लगभग पंद्रह सौ guards हैं');
        expect(turns[1].text_en).toBe('We have about 1500 guards');
        expect(turns[1].t_start_ms).toBe(3000);
        expect(turns[1].turn_id).toBe('t_1_00002');
    });

    it('keeps the suspect flag and gives legacy entries an index-based id', () => {
        const { turns } = buildTurns(entries, 3, 1000);
        expect(turns[0]).toMatchObject({ turn_id: 'r_3', asr_suspect: true });
        expect(turns[0].text_en).toBeUndefined();
    });
});

describe('shouldTickV2', () => {
    const prospect = (t: number, text = 'we lose deals every week'): LiveTranscriptEntry =>
        ({ speaker: 'client', text, timestamp: t, arrivalMs: t });

    it('waits for settled prospect speech and the 8s floor', () => {
        const now = 100_000;
        expect(shouldTickV2({ now, inFlight: false, lastTickStartedAt: 0, pending: [prospect(now - 2000)] })).toBe(true);
        expect(shouldTickV2({ now, inFlight: false, lastTickStartedAt: 0, pending: [prospect(now - 200)] })).toBe(false);
        expect(shouldTickV2({ now, inFlight: false, lastTickStartedAt: now - V2_MIN_TICK_MS + 10, pending: [prospect(now - 2000)] })).toBe(false);
    });

    it('never ticks on rep-only speech or while in flight, but force wins', () => {
        const now = 100_000;
        const rep = { speaker: 'user', text: 'let me show you', timestamp: now - 5000 };
        expect(shouldTickV2({ now, inFlight: false, lastTickStartedAt: 0, pending: [rep] })).toBe(false);
        expect(shouldTickV2({ now, inFlight: true, lastTickStartedAt: 0, pending: [prospect(now - 5000)] })).toBe(false);
        expect(shouldTickV2({ now, inFlight: false, lastTickStartedAt: now, pending: [], force: true })).toBe(true);
    });

    it('fires early when a lot of prospect speech piles up', () => {
        const now = 100_000;
        const long = prospect(now - 100, 'x'.repeat(250));
        expect(shouldTickV2({ now, inFlight: false, lastTickStartedAt: 0, pending: [long] })).toBe(true);
    });
});

describe('applyV2Event', () => {
    it('patches early, then done replaces the state and keeps this tick highlights', () => {
        const base = { ...EMPTY_VIEW, state: emptyState(), sig: 'v2:old', tick: 1 };
        const upgraded = field('confirmed', ['ring-fenced 80k']);
        let v = applyV2Event(base, 'qualification_update', {
            version: 1, changes: [{ path: 'bant.budget', from: 'missing', to: 'confirmed', kind: 'upgrade', field: upgraded }],
        }, 2);
        expect(v.state!.bant.budget.status).toBe('confirmed');
        expect(v.changed).toEqual({ 'bant.budget': 'upgrade' });

        v = applyV2Event(v, 'signals_update', { items: [{ id: 'a1', quote: 'q', signal_type: ['risk'], ask_now: '', intensity: 'low', category: 'negative' }] }, 2);
        v = applyV2Event(v, 'signals_update', { items: [{ id: 'a1', quote: 'q', signal_type: ['risk'], ask_now: '', intensity: 'low', category: 'negative' }] }, 2);
        expect(v.state!.signals).toHaveLength(1);

        v = applyV2Event(v, 'questions_update', { questions: { 'bant.authority': 'Who signs off?' } }, 2);
        expect(v.state!.bant.authority.suggested_question).toBe('Who signs off?');

        const serverState = { ...emptyState(), version: 1 };
        serverState.bant.budget = upgraded;
        v = applyV2Event(v, 'done', { version: 1, state: serverState, state_sig: 'v2:new', state_trusted: true, trace_id: 'tr1' }, 2);
        expect(v.sig).toBe('v2:new');
        expect(v.traceId).toBe('tr1');
        expect(v.state).toBe(serverState);
        expect(v.changed).toEqual({ 'bant.budget': 'upgrade' });
    });

    it('a new tick without changes clears the highlight', () => {
        const base = { ...EMPTY_VIEW, state: emptyState(), changed: { 'bant.need': 'upgrade' as const }, tick: 1 };
        const v = applyV2Event(base, 'done', { version: 2, state: emptyState(), state_sig: 'v2:x', state_trusted: true, trace_id: null }, 2);
        expect(v.changed).toEqual({});
    });
});

describe('stateToAnalysis', () => {
    it('projects onto the LiveAnalysisData shape the panel renders', () => {
        const st = emptyState();
        st.meddic.metrics = field('partial', ['बीस site देखनी है']);
        st.signals = [{ id: 's1', quote: 'q', signal_type: ['buying_intent'], ask_now: 'ask', intensity: 'high', category: 'positive', turn_id: 't1' }];
        const a = stateToAnalysis(st, [], []);
        expect(a.meddic.metrics.status).toBe('partial');
        expect(a.meddic.metrics.evidence_refs?.[0].t_start_ms).toBe(83_000);
        expect(a.signals[0]).not.toHaveProperty('turn_id');
        expect(a.objections).toEqual([]);
    });

    it('formats call-relative time for evidence chips', () => {
        expect(formatCallTime(83_000)).toBe('1:23');
        expect(formatCallTime(undefined)).toBe('');
    });
});

describe('SSE parsing', () => {
    it('handles chunk boundaries, CRLF, heartbeats and a trailing frame', () => {
        const p = new SSEParser();
        const out = [
            ...p.push('event: ack\ndata: {"tick_id"'),
            ...p.push(':"k1"}\r\n\r\n: ping\n\nevent: done\n'),
            ...p.push('data: {"version":3}'),
            ...p.flush(),
        ];
        expect(out).toEqual([
            { event: 'ack', data: { tick_id: 'k1' } },
            { event: 'done', data: { version: 3 } },
        ]);
    });

    it('ignores comment-only frames', () => {
        expect(parseFrame(': ping')).toBeNull();
    });
});

describe('mergeDealAlerts', () => {
    it('prepends new alerts and dedupes by id and quote', () => {
        const a = { id: 'x', trigger: 'discount_request' as const, quote: 'Can you do better on price?', headline: '', moves: ['m'], intensity: 'high' as const };
        const b = { ...a, id: 'y', quote: 'can you do better on price?' };
        const c = { ...a, id: 'z', quote: 'Your competitor is cheaper' };
        const merged = mergeDealAlerts([a], [b, c]);
        expect(merged.map(x => x.id)).toEqual(['z', 'x']);
    });
});

describe('end of call', () => {
    const endResponse = (): any => {
        const st = emptyState();
        st.bant.budget = field('confirmed', ['kept aside about eight lakh rupees']);
        st.signals = [{ id: 'old', quote: 'live running signal', signal_type: ['risk'], ask_now: '', intensity: 'low', category: 'negative' }];
        return {
            analysis: {
                signals: [{ id: 'x', quote: 'we will roll out to all 85 sites', signal_type: ['buying_intent'], ask_now: 'Agree pilot criteria',
                            intensity: 'high', category: 'positive', turn_id: 't7', t_start_ms: 414000 }],
                objections: [
                    { type: 'customer_question', quote: 'Can you do better on the price?', owner: 'customer', status: 'open',
                      handled: 'partially', rep_response: "Let's look at the penalties", topic: 'price' },
                    { type: 'customer_question', quote: 'Offline was a problem', owner: 'customer', status: 'open', handled: 'resolved' },
                ],
                source: 'v2_end',
            },
            state: st, state_sig: 'v2:s', state_trusted: true, trace_id: 'tr', timings_ms: {}, degraded: [], turns: 59,
        };
    };

    it('uses the final state for BANT/MEDDIC and the consolidated signals, not the live list', () => {
        const a = endResponseToAnalysis(endResponse());
        expect(a.bant.budget.status).toBe('confirmed');
        expect(a.signals.map(s => s.quote)).toEqual(['we will roll out to all 85 sites']);
        expect(a.signals[0]).not.toHaveProperty('turn_id');
        expect(a.source).toBe('v2_end');
    });

    it('stamps objection ids and marks the resolved ones for the collapsed group', () => {
        const a = endResponseToAnalysis(endResponse());
        expect(a.objections.map(o => o.resolved)).toEqual([false, true]);
        expect(a.objections[0].id).toMatch(/^[0-9a-z]{1,6}$/);
        expect(a.objections[0].rep_response).toBe("Let's look at the penalties");
    });

    it('falls back to the live signals when the final list is empty', () => {
        const res = endResponse();
        res.analysis.signals = [];
        expect(endResponseToAnalysis(res).signals.map(s => s.quote)).toEqual(['live running signal']);
    });

    it('turns an uploaded transcript into v2 turns', () => {
        const turns = buildTurnsFromSegments([
            { speaker: 'system', text: 'Meeting started', timestamp: 1000 },
            { speaker: 'user', text: 'How many guards?', timestamp: 2000 },
            { speaker: 'client', text: '  About 1200.  ', timestamp: 7000 },
            { speaker: 'client', text: '   ' },
        ]);
        expect(turns).toEqual([
            { turn_id: 'u_00001', role: 'seller', text: 'How many guards?', t_start_ms: 1000 },
            { turn_id: 'u_00002', role: 'prospect', text: 'About 1200.', t_start_ms: 6000 },
        ]);
    });
});
