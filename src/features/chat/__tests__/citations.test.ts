import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { visit } from 'unist-util-visit';
import { citationLabels, rehypeCitations } from '../citations';

// The backend's [n] is the index of the context block the model cited, so a one-source answer
// showed a lone "9". Chips now count 1…n by first appearance; the lookup keeps the real index.
function cites(md: string): { indices: number[]; labels: number[] }[] {
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
    const tree = processor.runSync(processor.parse(md));
    rehypeCitations()(tree);
    const out: { indices: number[]; labels: number[] }[] = [];
    visit(tree, 'element', (n: any) => {
        if (n.tagName === 'cite') out.push({ indices: n.properties.indices, labels: n.properties.labels });
    });
    return out;
}

describe('citation numbering', () => {
    it('shows 1 for a single-source answer', () => {
        expect(cites('Stage: Qualification [9]')).toEqual([{ indices: [9], labels: [1] }]);
    });

    it('numbers sources by first appearance and reuses the number', () => {
        expect(cites('Pilot agreed [7]. Usage pricing [3, 7]. Volume missing [3].')).toEqual([
            { indices: [7], labels: [1] },
            { indices: [3, 7], labels: [2, 1] },
            { indices: [3], labels: [2] },
        ]);
    });

    it('orders by document position even inside bold text', () => {
        expect(cites('**Risk [5]** then plain [2]').map((c) => c.labels)).toEqual([[1], [2]]);
    });

    it('skips markers in code but chips them in table cells', () => {
        const md = '`[4]` text [8]\n\n| a |\n|---|\n| [6] |\n';
        expect(cites(md)).toEqual([{ indices: [8], labels: [1] }, { indices: [6], labels: [2] }]);
    });

    it('chips the citation at the end of a table row', () => {
        const md = '| Company | Impact |\n|---|---|\n| Pulcra Chemicals | Improves efficiency & savings [1] |\n';
        expect(cites(md)).toEqual([{ indices: [1], labels: [1] }]);
    });

    it('gives the sources row the same numbers from the raw text', () => {
        expect([...citationLabels('a [9] b [2, 9] c [4]')]).toEqual([[9, 1], [2, 2], [4, 3]]);
    });
});
