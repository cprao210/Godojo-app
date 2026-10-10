import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { ensureTableSpacing } from '../markdownTables';

const tableCount = (md: string): number => {
    const tree = unified().use(remarkParse).use(remarkGfm).parse(md) as any;
    let n = 0;
    const walk = (node: any) => {
        if (node.type === 'table') n += 1;
        (node.children ?? []).forEach(walk);
    };
    walk(tree);
    return n;
};

// The answer that showed as raw pipes: each table starts on the line after a bullet.
const BROKEN = [
    'The team was missing Metrics and Champion most often.',
    '',
    '* Metrics: Missing in 9 of 14 calls.',
    '| Call | Company | Detail |',
    '| --- | --- | --- |',
    '| Discovery call with ELPEE (Sep 29, 2026) | ELPEE | nothing recorded |',
    '* Champion: Missing in 9 of 14 calls.',
    '| Call | Company | Detail |',
    '| --- | --- | --- |',
    '| discovery call-bolna (Oct 03, 2026) | Bolna AI | nothing recorded |',
].join('\n');

describe('ensureTableSpacing', () => {
    it('makes a table that follows a bullet render as a table', () => {
        expect(tableCount(BROKEN)).toBe(0);
        expect(tableCount(ensureTableSpacing(BROKEN))).toBe(2);
    });

    it('leaves a correctly spaced table and plain text untouched', () => {
        const good = 'Budget came up in 2 calls.\n\n| Call | Company |\n| --- | --- |\n| A | Acme |\n\nDone.';
        expect(ensureTableSpacing(good)).toBe(good);
        expect(ensureTableSpacing('a | b is not a table')).toBe('a | b is not a table');
        expect(ensureTableSpacing('')).toBe('');
    });

    it('waits for the separator row while the answer is still streaming', () => {
        const partial = 'Metrics: missing in 9 calls.\n| Call | Company |';
        expect(ensureTableSpacing(partial)).toBe(partial);
        expect(ensureTableSpacing(partial + '\n| --- | --- |')).toBe(
            'Metrics: missing in 9 calls.\n\n| Call | Company |\n| --- | --- |',
        );
    });
});
