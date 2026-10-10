import { describe, expect, it } from 'vitest';
import { fetchAllPages } from '../db/supabasePaging';

// A fake PostgREST: `cap` is the project's "Max rows"; `count` mimics { count: 'exact' }.
const fakeTable = (total: number, cap: number, withCount = true) => {
    const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
    const calls: Array<[number, number]> = [];
    const fetchPage = async (from: number, to: number) => {
        calls.push([from, to]);
        const end = Math.min(to + 1, from + cap, total);
        return { data: rows.slice(from, end), error: null as unknown, count: withCount ? total : null };
    };
    return { rows, calls, fetchPage };
};

describe('fetchAllPages', () => {
    it('reads past the 1,000-row cap', async () => {
        const t = fakeTable(2_345, 1_000);
        const { data, error } = await fetchAllPages(t.fetchPage);
        expect(error).toBeNull();
        expect(data.map((r) => r.id)).toEqual(t.rows.map((r) => r.id));
        expect(t.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    });

    it('gets every row when the project cap is smaller than the page size', async () => {
        const t = fakeTable(1_200, 500);
        const { data } = await fetchAllPages(t.fetchPage);
        expect(data).toHaveLength(1_200);
    });

    it('stops on a short page when no count comes back', async () => {
        const t = fakeTable(1_500, 1_000, false);
        const { data } = await fetchAllPages(t.fetchPage);
        expect(data).toHaveLength(1_500);
        expect(t.calls).toHaveLength(2);
    });

    it('handles an empty table and exact multiples', async () => {
        expect((await fetchAllPages(fakeTable(0, 1_000).fetchPage)).data).toEqual([]);
        const t = fakeTable(2_000, 1_000);
        expect((await fetchAllPages(t.fetchPage)).data).toHaveLength(2_000);
        expect(t.calls).toHaveLength(2);                     // the count avoids a third, empty read
    });

    it('returns the error and the rows read so far', async () => {
        let n = 0;
        const res = await fetchAllPages(async () => (n++ === 0
            ? { data: Array.from({ length: 1_000 }, (_, i) => ({ id: i })), error: null, count: 3_000 }
            : { data: null, error: new Error('boom'), count: null }));
        expect(res.error).toBeInstanceOf(Error);
        expect(res.data).toHaveLength(1_000);
    });
});
