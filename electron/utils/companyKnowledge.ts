/**
 * companyKnowledge.ts
 *
 * Single source of truth for converting a hydrated KnowledgeOrchestrator
 * company context into a prompt-ready text block.
 *
 * Rules:
 *  - Reads only from the orchestrator's in-memory state (identity, coreValueProposition,
 *    assets, targetPersonas, competitors).
 *  - Respects identity.personaEngineEnabled when including persona context.
 *  - Returns '' when the orchestrator is null or has no meaningful content.
 *  - Does NOT touch DatabaseManager directly — that is the orchestrator's job.
 */

export interface CompanyKnowledgeContext {
    identity: {
        name: string;
        website?: string;
        industry?: string;
        personaEngineEnabled: boolean;
    };
    coreValueProposition: string;
    assets: Array<{ id: string; type: string; label: string; status: string }>;
    targetPersonas: Array<{ id: string; role: string; description: string }>;
    competitors: Array<{ id: string; name: string; moat: string; winRate: number }>;
}

/**
 * Build a structured prompt block from the company context held by the
 * KnowledgeOrchestrator.  Pass the raw context object returned by
 * `orchestrator.getContext()` (or equivalent accessor).
 *
 * Returns an empty string when ctx is null/undefined or lacks meaningful data.
 */
export function buildOwnCompanyContextBlock(ctx: CompanyKnowledgeContext | null | undefined): string {
    if (!ctx) return '';

    const { identity, coreValueProposition, assets, targetPersonas, competitors } = ctx;
    if (!identity?.name) return '';

    const lines: string[] = [
        '═══════════════════════════════════════',
        'OWN COMPANY CONTEXT (use to frame your responses from a seller perspective)',
        '═══════════════════════════════════════',
    ];

    lines.push(`Company:   ${identity.name}`);
    if (identity.industry) lines.push(`Industry:  ${identity.industry}`);
    if (identity.website) lines.push(`Website:   ${identity.website}`);

    if (coreValueProposition?.trim()) {
        lines.push('');
        lines.push('Value Proposition:');
        lines.push(`  ${coreValueProposition.trim()}`);
    }

    // Mapped assets (documents that were successfully ingested into the RAG pipeline)
    const mappedAssets = (assets ?? []).filter(a => a.status === 'mapped');
    if (mappedAssets.length > 0) {
        lines.push('');
        lines.push('Knowledge Assets:');
        mappedAssets.forEach(a => lines.push(`  • [${a.type}] ${a.label}`));
    }

    console.log('[companyKnowledge] personaEngineEnabled:', identity.personaEngineEnabled, '| personas:', (targetPersonas ?? []).length);

    // Target personas — only when persona engine is enabled
    if (identity.personaEngineEnabled && (targetPersonas ?? []).length > 0) {
        lines.push('');
        lines.push('Target Buyer Personas (infer which best matches the prospect from the conversation and frame responses toward their priorities):');
        targetPersonas.forEach(p => {
            lines.push(`  • ${p.role}${p.description ? `: ${p.description}` : ''}`);
        });
    }

    // Competitors
    if ((competitors ?? []).length > 0) {
        lines.push('');
        lines.push('Known Competitors:');
        competitors.forEach(c => {
            const wr = c.winRate != null ? ` (win rate: ${c.winRate}%)` : '';
            lines.push(`  • ${c.name}${c.moat ? ` — ${c.moat}` : ''}${wr}`);
        });
    }

    lines.push('═══════════════════════════════════════');
    return lines.join('\n');
}

/**
 * Pull the current company context from the orchestrator and build the prompt block.
 *
 * `orchestrator` is typed `any` to avoid importing the premium module directly;
 * callers pass `appState.getKnowledgeOrchestrator()`.
 *
 * Returns '' when:
 *  - orchestrator is null (premium not available)
 *  - orchestrator has no `getContext` method (API mismatch)
 *  - context is empty / company has no name yet
 */
export function buildOwnCompanyBlockFromOrchestrator(orchestrator: any): string {
    if (!orchestrator) return '';
    try {
        // KnowledgeOrchestrator exposes getContext() → CompanyKnowledgeContext | null
        const ctx: CompanyKnowledgeContext | null =
            typeof orchestrator.getContext === 'function' ? orchestrator.getContext() : null;
        return buildOwnCompanyContextBlock(ctx);
    } catch (err: any) {
        console.warn('[companyKnowledge] buildOwnCompanyBlockFromOrchestrator failed:', err.message);
        return '';
    }
}

/**
 * Hydrate the orchestrator with a full company context object.
 * Called on startup and on every company:saveContext.
 *
 * `orchestrator.hydrate(ctx)` is expected to:
 *   1. Store identity, coreValueProposition, targetPersonas, competitors in memory.
 *   2. NOT re-ingest assets that are already indexed (asset linkage is done separately
 *      via orchestrator.ingestDocument — see ipcHandlers company:uploadAsset).
 *   3. Apply the personaEngineEnabled flag immediately.
 */
export function hydrateOrchestratorFromContext(
    orchestrator: any,
    ctx: CompanyKnowledgeContext | null
): void {
    if (!orchestrator || !ctx) return;
    try {
        if (typeof orchestrator.hydrate === 'function') {
            orchestrator.hydrate(ctx);
            console.log('[companyKnowledge] Orchestrator hydrated with company context:', ctx.identity?.name);
        } else {
            // Fallback: set fields individually if the orchestrator exposes granular setters
            if (typeof orchestrator.setIdentity === 'function') orchestrator.setIdentity(ctx.identity);
            if (typeof orchestrator.setCoreValueProposition === 'function') orchestrator.setCoreValueProposition(ctx.coreValueProposition);
            if (typeof orchestrator.setAssets === 'function') orchestrator.setAssets(ctx.assets);
            if (typeof orchestrator.setTargetPersonas === 'function') orchestrator.setTargetPersonas(ctx.targetPersonas);
            if (typeof orchestrator.setCompetitors === 'function') orchestrator.setCompetitors(ctx.competitors);
            console.log('[companyKnowledge] Orchestrator hydrated (granular setters) for:', ctx.identity?.name);
        }
    } catch (err: any) {
        console.error('[companyKnowledge] hydrateOrchestratorFromContext failed:', err.message);
    }
}