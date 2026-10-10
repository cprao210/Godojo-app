// Locks the company-documents contract the Knowledge Base panel and the citation viewer rely on:
// route shapes, and the quality report → warning text mapping.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
  getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'Bearer t' }),
  API_BASE: 'http://api/api/v1',
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));

import { apiFetch } from '@/lib/apiClient';
import { documentsApi, qualityWarnings, type DocumentStatus } from '@/api/documentsApi';

const mockedApiFetch = vi.mocked(apiFetch);

describe('documentsApi routes', () => {
  beforeEach(() => mockedApiFetch.mockClear());

  it('reads status, versions and re-indexes by asset id', async () => {
    await documentsApi.status('a 1');
    await documentsApi.versions('a1');
    await documentsApi.reindex('a1');
    expect(mockedApiFetch.mock.calls.map((c) => c[0])).toEqual([
      '/intelligence/company-assets/upload/status/a%201',
      '/intelligence/company-assets/a1/versions',
      '/intelligence/company-assets/a1/reindex',
    ]);
    expect((mockedApiFetch.mock.calls[2][1] as RequestInit).method).toBe('POST');
  });

  it('patches visibility with the backend literal', async () => {
    await documentsApi.update('a1', { visibility: 'tenant' });
    const [path, init] = mockedApiFetch.mock.calls[0];
    expect(path).toBe('/intelligence/company-assets/a1');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ visibility: 'tenant' });
  });

  it('fetches the stored original with auth and returns bytes + filename', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70]), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="tpl.pdf"' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await documentsApi.file('a1', 2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://api/api/v1/intelligence/company-assets/a1/file?version=2');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer t' });
    expect(out.mime).toBe('application/pdf');
    expect(out.filename).toBe('tpl.pdf');
    expect(out.data.byteLength).toBe(4);
    vi.unstubAllGlobals();
  });

  it('turns a 404 into a readable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(documentsApi.file('a1')).rejects.toThrow(/No stored copy/);
    vi.unstubAllGlobals();
  });
});

describe('qualityWarnings', () => {
  const base: DocumentStatus = { asset_id: 'a1', status: 'indexed' };

  it('is empty for a clean document', () => {
    expect(qualityWarnings(base)).toEqual([]);
    expect(qualityWarnings(null)).toEqual([]);
  });

  it('flags missing pages, merged cells, injection, conflicts and supersession', () => {
    const w = qualityWarnings({
      ...base,
      is_current: false,
      pages_missing: [6, 7],
      quality: {
        merged_cells_filled: 2,
        injection: [{ page: 3 }],
        conflicts: [{ label: 'March proposal', field: 'total_recurring', this: '20,00,000', other: '18,00,000' }],
      },
    });
    expect(w).toEqual([
      'Pages 6, 7 produced no searchable text.',
      'A table has merged cells — verify pricing answers against the page.',
      'Page 3 contains instruction-like text (treated as content, never followed).',
      'Conflicts with "March proposal": total_recurring is 20,00,000 here, 18,00,000 there.',
      'Superseded by a newer version — used only for questions about the old one.',
    ]);
  });

  it('explains failed, empty and truncated indexing', () => {
    expect(qualityWarnings({ ...base, status: 'failed', error: 'Indexing kept failing; re-upload the file.' }))
      .toEqual(['Indexing kept failing; re-upload the file.']);
    expect(qualityWarnings({ ...base, status: 'empty' })).toEqual(['No searchable text was found in this file.']);
    expect(qualityWarnings({ ...base, quality: { issues: ['truncated'], pages_indexed: 300, pages_total: 412 } }))
      .toEqual(['Only the first 300 of 412 pages were indexed.']);
  });
});
