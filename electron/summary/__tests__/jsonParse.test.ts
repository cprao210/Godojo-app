import { describe, it, expect } from 'vitest';
import {
    extractJsonObject,
    findBalancedObject,
    stripCodeFences,
    stripTrailingCommas,
} from '../jsonParse';

describe('stripCodeFences', () => {
    it('strips a fence followed by a newline', () => {
        expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    });

    // This is the exact shape the old /```json\n(...)\n```/ regex could not match.
    it('strips a fence with NO newline after it', () => {
        expect(stripCodeFences('```json{"a":1}```')).toBe('{"a":1}');
    });

    it('handles CRLF line endings', () => {
        expect(stripCodeFences('```json\r\n{"a":1}\r\n```')).toBe('{"a":1}');
    });

    it('strips a bare fence with no language tag', () => {
        expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('leaves unfenced text alone', () => {
        expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
    });
});

describe('findBalancedObject', () => {
    it('extracts an object buried in prose', () => {
        expect(findBalancedObject('Here is the summary:\n{"a":1}\nHope that helps!')).toBe('{"a":1}');
    });

    it('handles nested objects', () => {
        expect(findBalancedObject('{"a":{"b":{"c":1}}}')).toBe('{"a":{"b":{"c":1}}}');
    });

    it('ignores braces inside string values', () => {
        const src = '{"note":"a } brace and a { brace"}';
        expect(findBalancedObject(src)).toBe(src);
    });

    it('ignores escaped quotes when tracking strings', () => {
        const src = '{"note":"he said \\"} \\" out loud"}';
        expect(findBalancedObject(src)).toBe(src);
    });

    it('returns null on a truncated object', () => {
        expect(findBalancedObject('{"a":1,"b":')).toBeNull();
    });

    it('returns null when there is no object at all', () => {
        expect(findBalancedObject('no json here')).toBeNull();
    });
});

describe('stripTrailingCommas', () => {
    it('removes a trailing comma before }', () => {
        expect(stripTrailingCommas('{"a":1,}')).toBe('{"a":1}');
    });

    it('removes a trailing comma before ]', () => {
        expect(stripTrailingCommas('{"a":[1,2,]}')).toBe('{"a":[1,2]}');
    });

    it('leaves commas inside strings alone', () => {
        expect(stripTrailingCommas('{"a":"x, y"}')).toBe('{"a":"x, y"}');
    });
});

describe('extractJsonObject', () => {
    it('parses clean JSON directly', () => {
        const r = extractJsonObject('{"keyPoints":["a"]}');
        expect(r.value).toEqual({ keyPoints: ['a'] });
        expect(r.strategy).toBe('direct');
    });

    it('recovers fenced JSON with no newline — the live empty-summary bug', () => {
        const r = extractJsonObject('```json{"keyPoints":["a"],"actionItems":[]}```');
        expect(r.value).toEqual({ keyPoints: ['a'], actionItems: [] });
        expect(r.value).not.toBeNull();
    });

    it('recovers JSON behind a prose preamble', () => {
        const r = extractJsonObject('Sure! Here is the summary you asked for:\n\n{"overview":"ok"}');
        expect(r.value).toEqual({ overview: 'ok' });
        expect(r.strategy).toBe('braces');
    });

    it('recovers JSON with trailing commas', () => {
        const r = extractJsonObject('{"a":1,"b":[1,2,],}');
        expect(r.value).toEqual({ a: 1, b: [1, 2] });
        expect(r.notes.join(' ')).toContain('trailing commas');
    });

    it('recovers a truncated object by closing it', () => {
        const r = extractJsonObject('{"overview":"we discussed pricing","keyPoints":["budget confirmed"');
        expect(r.strategy).toBe('repaired');
        expect(r.value?.overview).toBe('we discussed pricing');
    });

    it('closes a string cut off mid-token', () => {
        const r = extractJsonObject('{"overview":"we discussed pri');
        expect(r.value).not.toBeNull();
        expect(r.strategy).toBe('repaired');
    });

    it('returns null (never throws) on unrecoverable input', () => {
        const r = extractJsonObject('I cannot help with that request.');
        expect(r.value).toBeNull();
        expect(r.strategy).toBe('none');
        expect(r.error).toBeTruthy();
    });

    it('returns null on empty input', () => {
        expect(extractJsonObject('').value).toBeNull();
        expect(extractJsonObject('   ').value).toBeNull();
    });

    it('preserves a JSON string containing a code fence', () => {
        const r = extractJsonObject('{"note":"use ``` for code"}');
        expect(r.value).toEqual({ note: 'use ``` for code' });
    });
});
