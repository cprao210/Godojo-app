import { describe, it, expect } from 'vitest';
import { clampResponse, validateResponse } from '../postProcessor';

describe('clampResponse', () => {

  it('returns empty string for empty string input', () => {
    expect(clampResponse('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(clampResponse('   ')).toBe('');
  });

  it('passes through a single short sentence unchanged', () => {
    const input = 'That is a great question.';
    expect(clampResponse(input)).toBe('That is a great question.');
  });

  it('preserves two short sentences under default limits', () => {
    const input = 'We help you close deals faster. Let me show you how.';
    expect(clampResponse(input)).toBe('We help you close deals faster. Let me show you how.');
  });

  it('truncates to maxSentences when input exceeds sentence limit', () => {
    const input = 'First sentence here. Second sentence here. Third sentence here. Fourth sentence here. Fifth sentence here.';
    const result = clampResponse(input);
    const sentenceCount = (result.match(/[.!?]+/g) || []).length;
    expect(sentenceCount).toBeLessThanOrEqual(3);
  });

  it('respects a custom maxSentences=1', () => {
    const input = 'First sentence. Second sentence. Third sentence.';
    const result = clampResponse(input, 1);
    const sentenceCount = (result.match(/[.!?]+/g) || []).length;
    expect(sentenceCount).toBeLessThanOrEqual(1);
  });

  it('truncates to maxWords when a sentence exceeds the word limit', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
    const input = words.join(' ') + '.';
    const result = clampResponse(input);
    const wordCount = result.replace(/\.\.\.$/, '').split(/\s+/).length;
    expect(wordCount).toBeLessThanOrEqual(65);
  });

  it('respects a custom maxWords=10', () => {
    const input = 'one two three four five six seven eight nine ten eleven twelve thirteen.';
    const result = clampResponse(input, 3, 10);
    const wordCount = result.replace(/\.\.\.$/, '').split(/\s+/).length;
    expect(wordCount).toBeLessThanOrEqual(12);
  });

  it('strips bold markdown (**text**)', () => {
    const input = 'This is **bold text** here.';
    const result = clampResponse(input);
    expect(result).not.toContain('**');
    expect(result).toContain('bold text');
  });

  it('strips italic markdown (*text*)', () => {
    const input = 'This is *italic text* here.';
    const result = clampResponse(input);
    expect(result).not.toContain('*italic text*');
    expect(result).toContain('italic text');
  });

  it('strips markdown headers (#)', () => {
    const input = '# Header\nSome prose below.';
    const result = clampResponse(input);
    expect(result).not.toMatch(/^#/);
    expect(result).toContain('Some prose below');
  });

  it('strips bullet points', () => {
    const input = '- First point\n- Second point\n- Third point.';
    const result = clampResponse(input);
    expect(result).not.toContain('- ');
    expect(result).toContain('First point');
  });

  it('strips numbered lists', () => {
    const input = '1. First item\n2. Second item\n3. Third item.';
    const result = clampResponse(input);
    expect(result).not.toMatch(/\d\.\s/);
    expect(result).toContain('First item');
  });

  it('strips markdown links and preserves link text', () => {
    const input = 'Visit [our website](https://example.com) for more.';
    const result = clampResponse(input);
    expect(result).not.toContain('](');
    expect(result).toContain('our website');
  });

  it('handles mixed markdown and prose', () => {
    const input = '**Important:**\nThis is a short answer.';
    const result = clampResponse(input);
    expect(result).not.toContain('**');
    expect(result).toContain('Important');
    expect(result).toContain('This is a short answer');
  });

  it('handles a rich markdown block within word limit', () => {
    const input = [
      '## Summary',
      '',
      '**Key point:** The pricing is flexible.',
      '',
      '- Option A is cheaper.',
      '- Option B has more features.',
    ].join('\n');
    const result = clampResponse(input);
    expect(result).not.toMatch(/^##/m);
    expect(result).not.toContain('**');
    expect(result).not.toContain('- ');
    expect(result).toContain('Key point');
    expect(result).toContain('pricing is flexible');
  });

  it('preserves code blocks through clampResponse (placeholder bug fixed)', () => {
    const codeInput = [
      'Here is the solution:',
      '```typescript',
      'function greet(name: string): string {',
      '  return `Hello, ${name}!`;',
      '}',
      '```',
      'This function takes a name. This is a fourth sentence. This is a fifth sentence.',
    ].join('\n');
    // Even with very tight limits, the code block must survive intact
    const result = clampResponse(codeInput, 2, 20);
    expect(result).toContain('```typescript');
    expect(result).toContain('function greet');
    // The raw placeholder must NOT appear in the output
    expect(result).not.toContain('XCODEBLOCKX');
  });

  it('returns a code-block-only response intact', () => {
    const input = '```python\nprint("hello world")\n```';
    const result = clampResponse(input, 1, 5);
    expect(result).toContain('```python');
    expect(result).toContain('print("hello world")');
    expect(result).not.toContain('XCODEBLOCKX');
  });

  it('strips trailing filler phrase "I hope this helps"', () => {
    const input = 'Our solution integrates in under a day. I hope this helps.';
    expect(clampResponse(input).toLowerCase()).not.toContain('i hope this helps');
  });

  it('strips trailing filler phrase "Let me know if you"', () => {
    const input = 'We can schedule a demo this week. Let me know if you need anything else.';
    expect(clampResponse(input).toLowerCase()).not.toContain('let me know if you');
  });

  it('strips trailing filler phrase "Feel free to"', () => {
    const input = 'That is a fair point about budget. Feel free to reach out.';
    expect(clampResponse(input).toLowerCase()).not.toContain('feel free to');
  });

  it('strips trailing filler phrase "Does that make sense"', () => {
    const input = 'We reduce your sales cycle by thirty percent. Does that make sense?';
    expect(clampResponse(input).toLowerCase()).not.toContain('does that make sense');
  });

  it('strips "Answer:" prefix', () => {
    const result = clampResponse('Answer: We can close by end of quarter.');
    expect(result).not.toMatch(/^Answer:/i);
    expect(result).toContain('We can close by end of quarter');
  });

  it('strips "Refined:" prefix', () => {
    const result = clampResponse('Refined: The solution is modular.');
    expect(result).not.toMatch(/^Refined:/i);
    expect(result).toContain('The solution is modular');
  });

  it('strips "Suggestion:" prefix', () => {
    const result = clampResponse('Suggestion: Ask about their current process.');
    expect(result).not.toMatch(/^Suggestion:/i);
    expect(result).toContain('Ask about their current process');
  });

  it('strips "Refined (rephrase):" prefix', () => {
    const result = clampResponse('Refined (rephrase): We can deliver that by Friday.');
    expect(result).not.toMatch(/^Refined \(rephrase\):/i);
    expect(result).toContain('We can deliver that by Friday');
  });

  it('strips arbitrary "Refined (...): " regex pattern', () => {
    const result = clampResponse('Refined (expand): Let me elaborate on the timeline.');
    expect(result).not.toMatch(/^Refined \([^)]+\):/i);
    expect(result).toContain('Let me elaborate on the timeline');
  });

});


describe('validateResponse', () => {

  it('returns valid=true and empty issues array for a clean short response', () => {
    const result = validateResponse('That is a solid question.');
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('always returns an object with valid boolean and issues array', () => {
    const result = validateResponse('Hello world.');
    expect(typeof result.valid).toBe('boolean');
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it('issues array is empty (not null/undefined) when response is valid', () => {
    const result = validateResponse('Clean response.');
    expect(result.issues).toEqual([]);
  });

  it('reports "Contains markdown" for input with # header', () => {
    const result = validateResponse('# This is a header\nSome text.');
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Contains markdown');
  });

  it('reports "Contains markdown" for input with **bold**', () => {
    const result = validateResponse('This has **bold** text.');
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Contains markdown');
  });

  it('reports "Contains markdown" for input with backtick inline code', () => {
    const result = validateResponse('Call the `greet()` function.');
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Contains markdown');
  });

  it('reports "Contains markdown" for input with _italic_', () => {
    const result = validateResponse('This is _italicized_ text.');
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Contains markdown');
  });

  it('reports too-many-sentences issue when count exceeds maxSentences', () => {
    const input = 'One. Two. Three. Four.';
    const result = validateResponse(input);
    expect(result.valid).toBe(false);
    const issue = result.issues.find(i => i.startsWith('Too many sentences'));
    expect(issue).toBeDefined();
    expect(issue).toMatch(/4\/3/);
  });

  it('sentence issue message includes actual/max counts', () => {
    const input = 'A. B. C. D. E.';
    const result = validateResponse(input, 2);
    const issue = result.issues.find(i => i.startsWith('Too many sentences'));
    expect(issue).toMatch(/5\/2/);
  });

  it('reports too-many-words issue when word count exceeds maxWords', () => {
    const words = Array.from({ length: 65 }, (_, i) => `w${i}`).join(' ') + '.';
    const result = validateResponse(words);
    expect(result.valid).toBe(false);
    const issue = result.issues.find(i => i.startsWith('Too many words'));
    expect(issue).toBeDefined();
    expect(issue).toMatch(/65\/60/);
  });

  it('word issue message includes actual/max counts with custom limit', () => {
    const words = Array.from({ length: 15 }, (_, i) => `w${i}`).join(' ') + '.';
    const result = validateResponse(words, 3, 10);
    const issue = result.issues.find(i => i.startsWith('Too many words'));
    expect(issue).toMatch(/15\/10/);
  });

  it('reports all violated issues simultaneously', () => {
    const words = Array.from({ length: 14 }, (_, i) => `word${i}`).join(' ');
    const input = [
      `**Header:** ${words}.`,
      `${words}.`,
      `${words}.`,
      `${words}.`,
      `${words}.`,
    ].join(' ');
    const result = validateResponse(input, 3, 60);
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Contains markdown');
    expect(result.issues.some(i => i.startsWith('Too many sentences'))).toBe(true);
    expect(result.issues.some(i => i.startsWith('Too many words'))).toBe(true);
  });

  it('respects custom maxSentences and maxWords thresholds', () => {
    const input = 'This is sentence one with several words. This is sentence two with several more words.';
    const resultDefault = validateResponse(input);
    expect(resultDefault.valid).toBe(true);

    const resultTight = validateResponse(input, 1, 10);
    expect(resultTight.valid).toBe(false);
  });

});
