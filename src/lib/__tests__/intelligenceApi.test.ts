// Locks the live-analysis wire contract: speaker-label formatting and the request body
// fields the backend gates on (`meeting_types` → dealOptimizer, `mode` → fast/deep).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

import { apiFetch } from '../apiClient';
import { intelligenceApi } from '../intelligenceApi';

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
});
