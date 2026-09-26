// useUploadAnalysisBridge.ts
//
// Serves main's call-analysis requests for uploaded transcripts.
//
// Main processes an uploaded meeting in the background, but the live-analysis
// API only exists in the renderer (intelligenceApi → apiClient owns the
// Firebase token, the 401 refresh-and-retry and the error envelope). So main
// sends the turns here, this hook runs ONE live analysis v2 end-of-call pass
// (POST /v2/end) over the whole transcript, and posts the result back.
//
// Mounted in the LAUNCHER window only. Main targets that window specifically,
// and the gate keeps a second window (overlay, settings) from answering the
// same request twice.

import { useEffect } from 'react';
import { intelligenceApi } from '@/api/intelligenceApi';
import { buildTurnsFromSegments, endResponseToAnalysis } from '@/lib/liveAnalysisV2';
import type { LiveAnalysisData, LiveAnalysisTurn, MeetingType } from '@/types';

/**
 * Live analysis v2: one end-of-call pass (POST /v2/end) over the whole upload — final
 * BANT/MEDDIC, buying signals and objections in one round trip.
 * Null when the qualification lane degraded (all fields would read "missing") or nobody but
 * the rep spoke: main then falls back to its local analyser.
 */
export async function analyzeUploadV2(
    requestId: string,
    turns: LiveAnalysisTurn[],
    meetingTypes: MeetingType[],
): Promise<LiveAnalysisData | null> {
    const v2Turns = buildTurnsFromSegments(turns as any);
    if (!v2Turns.some(t => t.role === 'prospect')) return null;
    const res = await intelligenceApi.endLiveAnalysisV2({
        session_id: `upload-${requestId}`.slice(0, 64),
        state: null,
        state_sig: null,
        meeting_types: meetingTypes,
        turns: v2Turns,
    });
    if (res.degraded?.includes('qualify')) return null;
    return endResponseToAnalysis(res);
}

export function useUploadAnalysisBridge(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) return;

        const off = window.electronAPI?.onRunUploadAnalysis?.((request) => {
            const { requestId, turns, meetingTypes } = request ?? ({} as any);
            if (!requestId) return;

            (async () => {
                const startedAt = Date.now();
                try {
                    const data = await analyzeUploadV2(requestId, turns ?? [], meetingTypes ?? []);
                    console.log(
                        `[useUploadAnalysisBridge] v2 end-of-call pass for ${requestId} finished in ${Date.now() - startedAt}ms ` +
                        `(${data ? 'produced' : 'nothing analysable'}).`,
                    );
                    window.electronAPI?.respondUploadAnalysis?.(requestId, { ok: true, data });
                } catch (e: any) {
                    // Main falls back to its local analyser — this is a quality
                    // regression for that meeting, never a lost meeting.
                    console.error(
                        `[useUploadAnalysisBridge] v2 end-of-call pass for ${requestId} failed after ${Date.now() - startedAt}ms ` +
                        `(status=${e?.status ?? '-'}): ${e?.message ?? e}`,
                    );
                    window.electronAPI?.respondUploadAnalysis?.(requestId, {
                        ok: false,
                        error: e?.message ?? 'upload analysis failed',
                    });
                }
            })();
        });

        return () => off?.();
    }, [enabled]);
}
