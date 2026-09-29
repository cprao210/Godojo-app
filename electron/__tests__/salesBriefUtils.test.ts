import { describe, it, expect } from 'vitest';

import { buildCompanyContextBlock } from '../utils/salesBriefUtils';

const base = { companyName: 'Raksham', industry: 'Workforce Management Software', foundedYear: 2019 };

describe('buildCompanyContextBlock', () => {
    it('returns nothing without intel', () => {
        expect(buildCompanyContextBlock(null)).toBe('');
    });

    it('returns nothing for low-confidence intel — a guessed/colliding company must not reach chat, emails or summaries', () => {
        expect(buildCompanyContextBlock({ ...base, _confidence: 'low' })).toBe('');
    });

    it('labels high-confidence intel as unverified background', () => {
        const block = buildCompanyContextBlock({ ...base, _confidence: 'high' });
        expect(block).toContain('Company:        Raksham');
        expect(block).toContain('Industry:       Workforce Management Software');
        expect(block).toMatch(/unverified background/i);
        expect(block).not.toContain('Reliability:');
    });

    it('spells out the warnings for medium-confidence intel', () => {
        const block = buildCompanyContextBlock({
            ...base,
            _confidence: 'medium',
            _warnings: ["Couldn't read the company's website, so these details rely on third-party sources only."],
        });
        expect(block).toContain('Reliability: MEDIUM');
        expect(block).toContain("Couldn't read the company's website");
    });

    it('still works for intel that predates confidence tracking', () => {
        expect(buildCompanyContextBlock({ ...base })).toContain('Company:        Raksham');
    });
});