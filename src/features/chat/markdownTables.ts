// A markdown table only renders when a blank line separates it from the text
// above. Models regularly write a label or bullet and start the table on the
// very next line ("* Metrics: Missing in 9 of 14 calls." then "| Call | … |"),
// and the whole table then shows as raw pipes. This puts the missing blank
// line back, before the text reaches the markdown parser, so every chat
// surface renders such an answer as a table.

const SEPARATOR_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const isTableRow = (line: string): boolean => line.trim().startsWith('|');

/** Inserts a blank line before a table header that directly follows other
 * text. A table that is already set off, and text that merely contains a
 * pipe, are left exactly as they are. Safe on a partial (streaming) answer:
 * a header is only treated as one once its separator row has arrived. */
export function ensureTableSpacing(text: string): string {
    if (!text || !text.includes('|')) return text;
    const lines = text.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const startsTable =
            isTableRow(line) && i + 1 < lines.length && SEPARATOR_ROW.test(lines[i + 1]) && lines[i + 1].includes('-');
        if (startsTable && out.length > 0) {
            const prev = out[out.length - 1];
            if (prev.trim() !== '' && !isTableRow(prev)) out.push('');
        }
        out.push(line);
    }
    return out.join('\n');
}
