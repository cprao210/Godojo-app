/**
 * Which sections the Call Analysis tab renders — and therefore which ones its right-hand
 * navigation rail lists. The panel and the rail both read THIS, so a section that isn't on
 * screen can never be offered in the rail (and one that is on screen is never left out).
 */
import type { LiveAnalysisData } from '@/types';

export type AnalysisSectionId =
    | 'analysis-overview'
    | 'analysis-meddicc'
    | 'analysis-bant'
    | 'analysis-signals'
    | 'analysis-objections'
    | 'analysis-deal-alerts';

/** Every section the tab can show, in page order. */
export const ANALYSIS_SECTIONS: Array<{ id: AnalysisSectionId; label: string }> = [
    { id: 'analysis-overview', label: 'Overview' },
    { id: 'analysis-meddicc', label: 'MEDDICC' },
    { id: 'analysis-bant', label: 'BANT' },
    { id: 'analysis-signals', label: 'Signals' },
    { id: 'analysis-objections', label: 'Objections' },
    { id: 'analysis-deal-alerts', label: 'Deal alerts' },
];

type AnalysisSectionSource = Pick<LiveAnalysisData, 'signals' | 'objections' | 'objectionDetectionOff' | 'dealOptimizer'>;

/** Overview, MEDDICC and BANT always render; the rest only when there is something to show. */
export function analysisSectionFlags(data: Partial<AnalysisSectionSource>) {
    return {
        signals: (data.signals?.length ?? 0) > 0,
        // Internal-only meetings show the Objections section with a "detection is off" note.
        objections: (data.objections?.length ?? 0) > 0 || data.objectionDetectionOff === 'internal',
        dealAlerts: (data.dealOptimizer?.length ?? 0) > 0,
    };
}

/** The sections on screen for this analysis, in page order — what the nav rail should list. */
export function visibleAnalysisSections(data: Partial<AnalysisSectionSource>) {
    const f = analysisSectionFlags(data);
    return ANALYSIS_SECTIONS.filter((s) => {
        if (s.id === 'analysis-signals') return f.signals;
        if (s.id === 'analysis-objections') return f.objections;
        if (s.id === 'analysis-deal-alerts') return f.dealAlerts;
        return true;
    });
}