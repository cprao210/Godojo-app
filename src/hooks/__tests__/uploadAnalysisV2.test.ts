import { beforeEach, describe, expect, it, vi } from 'vitest';

const endLiveAnalysisV2 = vi.fn();
vi.mock('@/api/intelligenceApi', () => ({ intelligenceApi: { endLiveAnalysisV2: (...a: any[]) => endLiveAnalysisV2(...a) } }));

import { analyzeUploadV2 } from '@/hooks/useUploadAnalysisBridge';

const emptyField = { emoji: '❌', status: 'missing', evidence: [], evidence_refs: [], summary: '', suggested_question: '', updated_version: 0, updated_turn_id: '' };
const state = () => ({
    v: 2, session_id: 'upload-r1', version: 1, signals: [], recent_turns: [], seen_turn_ids: [], meta: {},
    bant: { budget: { ...emptyField, status: 'confirmed', emoji: '✅', evidence: ['8 lakh approved'] }, authority: emptyField, need: emptyField, timeline: emptyField },
    meddic: { metrics: emptyField, economic_buyer: emptyField, decision_criteria: emptyField, decision_process: emptyField,
              identify_pain: emptyField, champion: emptyField, competition: emptyField },
});

describe('analyzeUploadV2', () => {
    beforeEach(() => endLiveAnalysisV2.mockReset());

    it('sends the upload as stateless turns and maps the final analysis', async () => {
        endLiveAnalysisV2.mockResolvedValueOnce({
            analysis: { signals: [], objections: [{ type: 'customer_question', quote: 'too pricey', owner: 'customer', status: 'open', handled: 'unresolved' }] },
            state: state(), state_sig: 'v2:x', state_trusted: true, trace_id: null, timings_ms: {}, degraded: [], turns: 2,
        });
        const a = await analyzeUploadV2('r1', [{ speaker: 'user', text: 'price is 60' }, { speaker: 'client', text: 'too pricey' }] as any, ['negotiation']);
        const body = endLiveAnalysisV2.mock.calls[0][0];
        expect(body.state).toBeNull();
        expect(body.session_id).toBe('upload-r1');
        expect(body.turns.map((t: any) => t.role)).toEqual(['seller', 'prospect']);
        expect(a!.bant.budget.status).toBe('confirmed');
        expect(a!.objections[0].quote).toBe('too pricey');
    });

    it('returns null (so main falls back to the local analyser) when grading degraded or nobody else spoke', async () => {
        endLiveAnalysisV2.mockResolvedValueOnce({ analysis: { signals: [], objections: [] }, state: state(), degraded: ['qualify'] });
        expect(await analyzeUploadV2('r2', [{ speaker: 'client', text: 'hi' }] as any, [])).toBeNull();
        expect(await analyzeUploadV2('r3', [{ speaker: 'user', text: 'hello?' }] as any, [])).toBeNull();
        expect(endLiveAnalysisV2).toHaveBeenCalledTimes(1);
    });
});
