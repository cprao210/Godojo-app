import { describe, expect, it } from 'vitest';

import { analysisSectionFlags, visibleAnalysisSections } from '../analysisSections';

const ids = (d: Parameters<typeof visibleAnalysisSections>[0]) => visibleAnalysisSections(d).map((s) => s.id);
const obj = { quote: 'too expensive' } as any;

describe('visibleAnalysisSections', () => {
    it('always lists Overview, MEDDICC and BANT', () => {
        expect(ids({})).toEqual(['analysis-overview', 'analysis-meddicc', 'analysis-bant']);
    });

    it('drops Objections when there are none', () => {
        expect(ids({ signals: [{} as any], objections: [] })).toEqual([
            'analysis-overview', 'analysis-meddicc', 'analysis-bant', 'analysis-signals',
        ]);
    });

    it('lists Objections when present, in page order, and follows data changes', () => {
        expect(ids({ objections: [obj], signals: [{} as any], dealOptimizer: [{} as any] })).toEqual([
            'analysis-overview', 'analysis-meddicc', 'analysis-bant',
            'analysis-signals', 'analysis-objections', 'analysis-deal-alerts',
        ]);
        expect(ids({ objections: [obj] })).toContain('analysis-objections');
        expect(ids({ objections: [] })).not.toContain('analysis-objections');
    });

    it('keeps Objections for internal meetings (the section shows a "detection is off" note)', () => {
        expect(analysisSectionFlags({ objections: [], objectionDetectionOff: 'internal' }).objections).toBe(true);
    });
});