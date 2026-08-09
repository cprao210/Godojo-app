import Store from 'electron-store';

// /chat/live returns an interaction_id per turn, but has no real meeting_id
// to attach to at query time — the meeting isn't persisted to the BACKEND
// (Supabase mirror) until well after the call ends and local processing
// finishes. Calling POST /live/link-meeting right at call-end 404s with
// "Meeting not found" because the backend doesn't know about the meeting yet.
//
// So instead: stash the collected interaction_ids here, durably, keyed by
// meetingId, the moment the call ends (local SQLite already has the id by
// then). Then call link-meeting lazily, the next time this specific meeting
// is actually fetched from the backend (useMeetingDetails.ts) — by which
// point meetingsApi.get() succeeding is itself proof the backend has the row.
//
// electron-store (not the SQLite DB) because this is disposable bookkeeping,
// not meeting content — same rationale as DonationManager's use of it.
interface PendingLiveChatState {
    // meetingId -> interaction_ids collected during that call, not yet linked
    pending: Record<string, number[]>;
}

export class PendingLiveChatStore {
    private static instance: PendingLiveChatStore;
    private store: Store<PendingLiveChatState>;

    private constructor() {
        this.store = new Store<PendingLiveChatState>({
            name: 'natively-pending-live-chat',
            defaults: { pending: {} },
        });
    }

    public static getInstance(): PendingLiveChatStore {
        if (!PendingLiveChatStore.instance) {
            PendingLiveChatStore.instance = new PendingLiveChatStore();
        }
        return PendingLiveChatStore.instance;
    }

    public save(meetingId: string, interactionIds: number[]): void {
        if (!meetingId || interactionIds.length === 0) return;
        const pending = this.store.get('pending');
        const existing = pending[meetingId] ?? [];
        pending[meetingId] = [...new Set([...existing, ...interactionIds])];
        this.store.set('pending', pending);
    }

    public getPending(meetingId: string): number[] {
        return this.store.get('pending')[meetingId] ?? [];
    }

    public clearPending(meetingId: string): void {
        const pending = this.store.get('pending');
        if (!(meetingId in pending)) return;
        delete pending[meetingId];
        this.store.set('pending', pending);
    }
}