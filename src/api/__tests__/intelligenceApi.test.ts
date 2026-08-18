// Locks the live-analysis wire contract: speaker-label formatting and the request body
// fields the backend gates on (`meeting_types` → dealOptimizer, `mode` → fast/deep).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

import { apiFetch } from '@/lib/apiClient';
import { intelligenceApi } from '@/api';

const mockedApiFetch = vi.mocked(apiFetch);

const bodyOfCall = (i = 0) =>
  JSON.parse((mockedApiFetch.mock.calls[i][1] as RequestInit).body as string);

describe('intelligenceApi.analyzeLive', () => {
  beforeEach(() => mockedApiFetch.mockClear());

  it('formats speaker labels and sends fast mode + empty meeting_types by default', async () => {
    await intelligenceApi.analyzeLive([
      { speaker: 'user', text: ' hi there ' },
      { speaker: 'client', text: 'the price is too high' },
    ]);
    expect(mockedApiFetch.mock.calls[0][0]).toBe('/intelligence/live-analysis');
    const body = bodyOfCall();
    expect(body.transcript).toBe('SALES PERSON: hi there\nPROSPECT: the price is too high');
    expect(body.meeting_id).toBeNull();
    expect(body.mode).toBe('fast');
    expect(body.meeting_types).toEqual([]);
  });

  it('sends the selected meeting_types (negotiation gates dealOptimizer server-side)', async () => {
    await intelligenceApi.analyzeLive([{ speaker: 'client', text: 'x' }], null, {
      meetingTypes: ['discovery', 'negotiation'],
    });
    expect(bodyOfCall().meeting_types).toEqual(['discovery', 'negotiation']);
  });

  it('passes mode through when specified', async () => {
    await intelligenceApi.analyzeLive([{ speaker: 'client', text: 'x' }], null, {
      mode: 'deep',
      meetingTypes: ['demo'],
    });
    const body = bodyOfCall();
    expect(body.mode).toBe('deep');
    expect(body.meeting_types).toEqual(['demo']);
  });

  it('sends the delta transcript + previous_analysis on incremental calls', async () => {
    const prev = {
      bant: {
        budget: {
          emoji: '✅',
          status: 'confirmed',
          evidence: 'our budget is 80k',
          suggested_question: '',
        },
      },
      objections: [],
      signals: [],
    } as any;
    await intelligenceApi.analyzeLive(
      [{ speaker: 'client', text: "let's meet Tuesday" }],
      null,
      { previousAnalysis: prev },
    );
    const body = bodyOfCall();
    // `transcript` carries ONLY the delta turn, not the whole call.
    expect(body.transcript).toBe("PROSPECT: let's meet Tuesday");
    expect(body.previous_analysis).toEqual(prev);
  });

  it('omits previous_analysis on fresh (first-run) calls', async () => {
    await intelligenceApi.analyzeLive([{ speaker: 'client', text: 'x' }]);
    expect(bodyOfCall()).not.toHaveProperty('previous_analysis');
  });
});

describe('intelligenceApi.detectObjections', () => {
  beforeEach(() => mockedApiFetch.mockClear());

  it('POSTs the delta contract to the objection-handler route', async () => {
    await intelligenceApi.detectObjections(
      [
        { speaker: 'user', text: ' so about pricing ' },
        { speaker: 'client', text: 'the price is too high' },
      ],
      ['we already use Salesforce'],
    );

    expect(mockedApiFetch.mock.calls[0][0]).toBe('/intelligence/objection-handler');
    const body = bodyOfCall();
    // AE turns are included — the backend needs them to detect ae_deferrals and to
    // judge whether an open objection was actually answered.
    expect(body.transcript).toBe('SALES PERSON: so about pricing\nPROSPECT: the price is too high');
    expect(body.meeting_id).toBeNull();
    expect(body.open_objections).toEqual(['we already use Salesforce']);
    // No BANT/MEDDIC knobs on this route.
    expect(body).not.toHaveProperty('mode');
    expect(body).not.toHaveProperty('meeting_types');
    expect(body).not.toHaveProperty('previous_analysis');
  });

  it('sends only the recent window, not the whole call', async () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({ speaker: 'client', text: `turn ${i}` }));
    await intelligenceApi.detectObjections(turns);

    const lines = bodyOfCall().transcript.split('\n');
    expect(lines).toHaveLength(16);            // OBJECTION_WINDOW_TURNS
    expect(lines[0]).toBe('PROSPECT: turn 24'); // trailing window
    expect(lines[15]).toBe('PROSPECT: turn 39');
  });

  it('truncates open_objections to the backend max_length of 25', async () => {
    const open = Array.from({ length: 40 }, (_, i) => `objection ${i}`);
    await intelligenceApi.detectObjections([{ speaker: 'client', text: 'x' }], open);

    expect(bodyOfCall().open_objections).toHaveLength(25);
  });

  it('defaults open_objections to empty and forwards the abort signal', async () => {
    const controller = new AbortController();
    await intelligenceApi.detectObjections(
      [{ speaker: 'client', text: 'x' }],
      undefined,
      null,
      controller.signal,
    );

    expect(bodyOfCall().open_objections).toEqual([]);
    expect((mockedApiFetch.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });
});

describe('intelligenceApi.reindexCompanyAssets', () => {
  beforeEach(() => mockedApiFetch.mockClear());

  it('POSTs to the reindex route with no body', async () => {
    await intelligenceApi.reindexCompanyAssets();
    expect(mockedApiFetch).toHaveBeenCalledWith('/intelligence/company-assets/reindex', {
      method: 'POST',
    });
  });

  it('resolves even when the backend returns no content', async () => {
    mockedApiFetch.mockResolvedValueOnce(undefined);
    await expect(intelligenceApi.reindexCompanyAssets()).resolves.toBeUndefined();
  });
});