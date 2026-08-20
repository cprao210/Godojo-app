
// Mirrors AuthManager's role but for the resolved tenantId (set by the
// launcher/default window via tenant:set-current). Exists so main-process
// consumers other than the IPC handler itself — chiefly PostHogMainService,
// for tagging exceptions with the right tenant — can read the current value
// without depending on ipcHandlers.ts internals.

class TenantContext {
    private static instance: TenantContext;
    private tenantId: string | null = null;

    private constructor() { }

    static getInstance(): TenantContext {
        if (!this.instance) this.instance = new TenantContext();
        return this.instance;
    }

    set(tenantId: string | null): void {
        this.tenantId = tenantId;
    }

    get(): string | null {
        return this.tenantId;
    }
}

export const tenantContext = TenantContext.getInstance();