// supabasePaging.ts
//
// PostgREST (Supabase's REST API) caps every response at the project's "Max rows" setting —
// 1,000 by default — and does it silently: no error, just the first N rows. A meeting's
// transcript regularly runs past that (an hour of speech-to-text finals), so an unpaged read
// showed only the start of long calls on the meeting page.
//
// fetchAllPages reads a query in consecutive `.range()` pages until it has every row. It asks
// for the exact total on each page and advances by the rows actually returned, so it still
// gets everything when the project's cap is smaller than the page size we ask for.

export const SUPABASE_PAGE_SIZE = 1000;
/** Safety stop: 100 pages = 100k rows at the default page size. */
export const SUPABASE_MAX_PAGES = 100;

export interface PageResult<T> {
    data: T[] | null;
    error: unknown;
    count?: number | null;
}

/**
 * `fetchPage(from, to)` must build a FRESH query each call (supabase-js builders are single-use),
 * with a stable order (add a unique tie-breaker such as `id`) and `{ count: 'exact' }` on the
 * select, then apply `.range(from, to)`.
 *
 * Returns every row in order. On an error the rows read so far are returned with the error, so
 * callers keep today's behaviour of failing the read.
 */
export async function fetchAllPages<T>(
    fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
    pageSize: number = SUPABASE_PAGE_SIZE,
    maxPages: number = SUPABASE_MAX_PAGES,
): Promise<{ data: T[]; error: unknown }> {
    const all: T[] = [];
    let from = 0;
    let total: number | null = null;
    for (let page = 0; page < maxPages; page++) {
        const { data, error, count } = await fetchPage(from, from + pageSize - 1);
        if (error) return { data: all, error };
        const rows = data ?? [];
        if (typeof count === 'number') total = count;
        all.push(...rows);
        from += rows.length;
        if (rows.length === 0) break;
        // With a total we can finish exactly; without one, a short page is the last page.
        if (total !== null ? all.length >= total : rows.length < pageSize) break;
        if (page === maxPages - 1) {
            console.warn(`[supabasePaging] stopped after ${maxPages} pages (${all.length} rows)`);
        }
    }
    return { data: all, error: null };
}
