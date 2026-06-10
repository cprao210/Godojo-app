/**
 * TavilySearchProvider.ts
 *
 * Search provider stub.  The profile:research-company IPC handler wires this
 * into the company research engine when a Tavily API key is configured.
 * In the company knowledge mode context the research engine itself is a stub,
 * so this class never actually executes a search — it simply satisfies the
 * require() call in ipcHandlers without throwing.
 */

export class TavilySearchProvider {
    private readonly apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    public async search(_query: string): Promise<{ results: any[] }> {
        // No-op in this context — the KnowledgeOrchestrator.getCompanyResearchEngine()
        // stub never calls search().
        return { results: [] };
    }
}