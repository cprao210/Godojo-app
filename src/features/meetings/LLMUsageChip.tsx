import { Zap } from 'lucide-react';
import type { LLMUsagePayload } from '@/electron.d';
import { useLLMUsage } from '@/lib/llmUsageStore';

/**
 * LLMUsageChip — DEV-ONLY indicator (import.meta.env.DEV) showing the real
 * input/output token consumption and provider/model behind the latest
 * summary generation, regeneration, follow-up email, sales brief or company
 * insights generation for this meeting / company.
 * Hover for the full per-call breakdown. Renders nothing in production
 * builds and nothing when no usage has been recorded this session.
 *
 * Data: electron/utils/llmUsageBus.ts → main.ts broadcast → llmUsageStore.
 */

const KIND_LABELS: Record<LLMUsagePayload['kind'], string> = {
    summary_initial: 'Summary generated',
    summary_regenerate: 'Summary regenerated',
    followup_email: 'Follow-up email',
    company_insights: 'Company insights',
    sales_brief: 'Sales brief',
};

const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function tooltipText(payload: LLMUsagePayload): string {
    const lines = [
        `${KIND_LABELS[payload.kind]} — ${new Date(payload.at).toLocaleTimeString()}`,
        ...payload.calls.map((c, i) =>
            `  call ${i + 1}: ${c.provider}${c.model ? ` (${c.model})` : ''} — in ${c.inputTokens.toLocaleString()} / out ${c.outputTokens.toLocaleString()} tokens${c.estimated ? ' [estimated]' : ''}`
        ),
        `  total: in ${payload.totalInputTokens.toLocaleString()} / out ${payload.totalOutputTokens.toLocaleString()}`,
    ];
    if (payload.attempts !== undefined) lines.push(`  attempts: ${payload.attempts}`);
    if (payload.confidence !== null && payload.confidence !== undefined) lines.push(`  grounding confidence: ${payload.confidence}`);
    if (payload.durationMs !== undefined) lines.push(`  duration: ${(payload.durationMs / 1000).toFixed(1)}s`);
    if (payload.callType) lines.push(`  call type: ${payload.callType}`);
    if (payload.company) lines.push(`  company: ${payload.company}`);
    if (payload.tavily) {
        const t = payload.tavily;
        lines.push(
            `  tavily: ${t.searches} searches (${t.advanced} advanced, ${t.basic} basic${t.failed ? `, ${t.failed} failed` : ''}${t.retries ? `, ${t.retries} retries` : ''}) — ~${t.creditsEstimated} credits [estimated]`,
        );
    }
    return lines.join('\n');
}

export default function LLMUsageChip({ meetingId, kinds, isLight, className = '' }: {
    meetingId?: string;
    /** Restrict the chip to certain generation kinds (default: all). */
    kinds?: LLMUsagePayload['kind'][];
    isLight: boolean;
    className?: string;
}) {
    if (!import.meta.env.DEV) return null;

    const history = useLLMUsage(meetingId);
    const relevant = kinds ? history.filter((p) => kinds.includes(p.kind)) : history;
    const latest = relevant[relevant.length - 1];
    if (!latest) return null;

    return (
        <span
            title={tooltipText(latest)}
            className={`inline-flex shrink-0 cursor-help items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${isLight
                ? 'border-amber-200 bg-amber-50 text-amber-700'
                : 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                } ${className}`}
        >
            <Zap size={10} className="fill-current" />
            {fmt(latest.totalInputTokens)}↓ {fmt(latest.totalOutputTokens)}↑
            {latest.tavily ? ` · ${latest.tavily.creditsEstimated}cr` : ''}
            {relevant.length > 1 ? ` ×${relevant.length}` : ''}
        </span>
    );
}