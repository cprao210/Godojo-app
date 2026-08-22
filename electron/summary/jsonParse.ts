// electron/summary/jsonParse.ts
//
// Tolerant JSON extraction for LLM responses.
//
// The previous approach — `text.match(/```json\n([\s\S]*?)\n```/)` in
// MeetingPersistence, `replace(/```json|```/g, '')` in the scorecard path, and
// LLMHelper.cleanJsonResponse's anchored `^```(?:json)?\n` — each fail on a
// different real-world shape:
//   • ```json{...}```            no newline after the fence
//   • "Here is the summary:\n{"  a prose preamble
//   • trailing "\r\n```"         CRLF line endings
//   • a ``` fence inside a JSON string value
// Every one of those fell through to JSON.parse on the raw text, threw, and was
// swallowed — producing a silently empty summary.
//
// This module is intentionally dependency-free and pure so it is unit-testable
// under vitest's `environment: 'node'`.

export interface JsonExtractResult<T = any> {
    value: T | null;
    /** How the object was recovered — useful for diagnostics/telemetry. */
    strategy: 'direct' | 'fence' | 'braces' | 'repaired' | 'none';
    /** Non-fatal notes about what had to be fixed. */
    notes: string[];
    error?: string;
}

/**
 * Strips markdown code fences wherever they appear, tolerating a missing
 * newline after the opening fence and CRLF line endings.
 */
export function stripCodeFences(text: string): string {
    let out = text.trim();
    // Opening fence: ``` or ```json, optionally followed by whitespace/newline.
    out = out.replace(/^`{3,}[ \t]*[a-zA-Z0-9_-]*[ \t]*\r?\n?/, '');
    // Closing fence at the very end.
    out = out.replace(/\r?\n?[ \t]*`{3,}[ \t]*$/, '');
    return out.trim();
}

/**
 * Finds the outermost balanced {...} span, ignoring braces that appear inside
 * JSON string literals (and honouring backslash escapes). Returns null when no
 * balanced object exists.
 */
export function findBalancedObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];

        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { if (inString) escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }

    // Unbalanced — the response was truncated mid-object.
    return null;
}

/** Removes trailing commas before } or ], which models emit routinely. */
export function stripTrailingCommas(text: string): string {
    let out = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (escaped) { out += ch; escaped = false; continue; }
        if (ch === '\\') { out += ch; if (inString) escaped = true; continue; }
        if (ch === '"') { inString = !inString; out += ch; continue; }

        if (!inString && ch === ',') {
            // Look ahead past whitespace for a closing bracket.
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            if (j < text.length && (text[j] === '}' || text[j] === ']')) continue; // drop it
        }
        out += ch;
    }
    return out;
}

/**
 * Closes unterminated strings/arrays/objects on a truncated response so a
 * partially-complete object can still be recovered. Best effort: the caller
 * must treat a 'repaired' result as lower confidence.
 */
export function closeTruncated(text: string): string {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { if (inString) escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') stack.pop();
    }

    let out = text;
    // Drop a dangling partial token (e.g. `"overview": "half a sen`) cleanly.
    if (inString) out += '"';
    // Remove a trailing comma or a dangling `"key":` with no value.
    out = out.replace(/,\s*$/, '').replace(/,?\s*"[^"]*"\s*:\s*$/, '');
    while (stack.length) {
        const open = stack.pop();
        out += open === '{' ? '}' : ']';
    }
    return out;
}

/**
 * Extracts a JSON object from an LLM response, trying progressively more
 * forgiving strategies. Never throws.
 */
export function extractJsonObject<T = any>(raw: string): JsonExtractResult<T> {
    const notes: string[] = [];

    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { value: null, strategy: 'none', notes, error: 'empty response' };
    }

    const attempts: Array<{ text: string; strategy: JsonExtractResult['strategy'] }> = [];

    const trimmed = raw.trim();
    attempts.push({ text: trimmed, strategy: 'direct' });

    const defenced = stripCodeFences(trimmed);
    if (defenced !== trimmed) {
        notes.push('stripped code fence');
        attempts.push({ text: defenced, strategy: 'fence' });
    }

    const balanced = findBalancedObject(defenced);
    if (balanced && balanced !== defenced) {
        notes.push('extracted balanced object from surrounding text');
        attempts.push({ text: balanced, strategy: 'braces' });
    }

    for (const { text, strategy } of attempts) {
        try {
            return { value: JSON.parse(text) as T, strategy, notes };
        } catch { /* try the next strategy */ }
        try {
            const noCommas = stripTrailingCommas(text);
            if (noCommas !== text) {
                const value = JSON.parse(noCommas) as T;
                notes.push('removed trailing commas');
                return { value, strategy, notes };
            }
        } catch { /* keep going */ }
    }

    // Last resort: the response was cut off mid-object.
    const base = balanced ?? defenced;
    try {
        const repaired = stripTrailingCommas(closeTruncated(base));
        const value = JSON.parse(repaired) as T;
        notes.push('closed a truncated object — content may be incomplete');
        return { value, strategy: 'repaired', notes };
    } catch (e: any) {
        return { value: null, strategy: 'none', notes, error: e?.message || 'unparseable' };
    }
}
