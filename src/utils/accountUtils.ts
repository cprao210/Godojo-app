// Groups meetings by the prospect company extracted in each meeting summary and
// rolls them up into a single sales-oriented account view (stage, qualification
// coverage, stakeholders, risks, next steps).

export type QualStatus = 'clear' | 'partial' | 'missing';

export interface QualField {
    status: string;
    detail: string;
}

export interface AccountMeeting {
    id: string;
    title: string;
    date: string;
    duration?: string;
    summary?: string;
    isProcessed?: boolean;
    participants?: { email: string | null; name: string | null; self?: boolean }[];
    detailedSummary?: {
        overview?: string;
        actionItems?: string[];
        keyPoints?: string[];
        leadName?: string | null;
        company?: string | null;
        dealStatus?: { stage?: string; summary?: string };
        bant?: Partial<Record<BantKey, QualField>>;
        meddicc?: Partial<Record<MeddiccKey, QualField>> & { gaps?: string[] };
        followUpEmail?: {
            sections?: {
                scopeOfImprovement?: string[];
                expectedBusinessImpact?: string[];
                nextSteps?: string[];
            };
        };
        nextCallPlaybook?: {
            openingRecap?: string;
            questionsToAsk?: string[];
        };
    };
}

export type BantKey = 'budget' | 'authority' | 'need' | 'timeline';
export type MeddiccKey =
    | 'metrics' | 'economicBuyer' | 'decisionCriteria' | 'decisionProcess'
    | 'identifyPain' | 'champion' | 'competition';

export const BANT_FIELDS: { key: BantKey; label: string }[] = [
    { key: 'budget', label: 'Budget' },
    { key: 'authority', label: 'Authority' },
    { key: 'need', label: 'Need' },
    { key: 'timeline', label: 'Timeline' },
];

export const MEDDICC_FIELDS: { key: MeddiccKey; label: string }[] = [
    { key: 'metrics', label: 'Metrics' },
    { key: 'economicBuyer', label: 'Economic Buyer' },
    { key: 'decisionCriteria', label: 'Decision Criteria' },
    { key: 'decisionProcess', label: 'Decision Process' },
    { key: 'identifyPain', label: 'Identify Pain' },
    { key: 'champion', label: 'Champion' },
    { key: 'competition', label: 'Competition' },
];

export const PIPELINE_STAGES = ['Discovery', 'Qualification', 'Demo', 'Proposal', 'Negotiation', 'Closed'] as const;

export interface RolledUpField {
    status: QualStatus;
    detail: string;
    /** Meeting where the best evidence for this field came from */
    meetingId?: string;
}

export interface Stakeholder {
    name: string;
    email?: string;
    meetings: number;
    lastSeen: string;
}

export interface AccountRisk {
    level: 'high' | 'medium';
    text: string;
}

export interface Account {
    key: string;
    name: string;
    /** Meetings newest first */
    meetings: AccountMeeting[];
    firstTouch: string;
    lastTouch: string;
    daysSinceLastTouch: number;
    stage: string;
    stageSummary: string;
    overview: string;
    bant: Record<BantKey, RolledUpField>;
    meddicc: Record<MeddiccKey, RolledUpField>;
    /** 0–100 qualification coverage using the same weights as the live deal score */
    healthScore: number;
    stakeholders: Stakeholder[];
    risks: AccountRisk[];
    nextSteps: string[];
    questionsToAsk: string[];
    openingRecap: string;
    painPoints: string[];
    businessImpact: string[];
}

const COMPANY_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|pvt|private|sa|ag|bv|pty)\b\.?/g;

export function normalizeCompanyKey(name: string): string {
    return name
        .toLowerCase()
        .replace(/[.,]/g, ' ')
        .replace(COMPANY_SUFFIXES, ' ')
        .replace(/[^a-z0-9&]+/g, ' ')
        .trim();
}

export function getMeetingCompany(m: AccountMeeting): string | null {
    const raw = m.detailedSummary?.company;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || /^(null|unknown|n\/a|none)$/i.test(trimmed)) return null;
    return normalizeCompanyKey(trimmed) ? trimmed : null;
}

export function normalizeStatus(status: string | undefined | null): QualStatus {
    const s = (status || '').toLowerCase();
    if (s === 'clear' || s === 'confirmed') return 'clear';
    if (s === 'partial') return 'partial';
    return 'missing';
}

const STATUS_RANK: Record<QualStatus, number> = { missing: 0, partial: 1, clear: 2 };

function rollUp(meetingsNewestFirst: AccountMeeting[], pick: (m: AccountMeeting) => QualField | undefined): RolledUpField {
    let best: RolledUpField = { status: 'missing', detail: '' };
    for (const m of meetingsNewestFirst) {
        const field = pick(m);
        if (!field) continue;
        const status = normalizeStatus(field.status);
        // Newest meeting wins ties so the detail reflects the latest state.
        if (STATUS_RANK[status] > STATUS_RANK[best.status] || (!best.detail && field.detail && status === best.status)) {
            best = { status, detail: field.detail || '', meetingId: m.id };
        }
    }
    return best;
}

function statusPoints(status: QualStatus, weight: number): number {
    if (status === 'clear') return weight;
    if (status === 'partial') return weight / 2;
    return 0;
}

export function computeAccountHealth(bant: Record<BantKey, RolledUpField>, meddicc: Record<MeddiccKey, RolledUpField>): number {
    // Mirrors DealHealthScore weights (BANT 10 each, MEDDICC 6 each = 82 max) scaled to 100.
    const raw =
        BANT_FIELDS.reduce((acc, f) => acc + statusPoints(bant[f.key].status, 10), 0) +
        MEDDICC_FIELDS.reduce((acc, f) => acc + statusPoints(meddicc[f.key].status, 6), 0);
    return Math.round((raw / 82) * 100);
}

function daysBetween(fromIso: string, to: Date): number {
    const t = new Date(fromIso).getTime();
    if (Number.isNaN(t)) return 0;
    return Math.max(0, Math.floor((to.getTime() - t) / 86_400_000));
}

function dedupe(items: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items) {
        const text = (item || '').trim();
        const k = text.toLowerCase();
        if (!text || seen.has(k)) continue;
        seen.add(k);
        out.push(text);
    }
    return out;
}

function buildStakeholders(meetings: AccountMeeting[]): Stakeholder[] {
    const map = new Map<string, Stakeholder>();
    const add = (name: string | null | undefined, email: string | null | undefined, date: string) => {
        const display = (name || email || '').trim();
        if (!display || /^(null|unknown)$/i.test(display)) return;
        const k = (email || display).toLowerCase();
        const existing = map.get(k);
        if (existing) {
            existing.meetings += 1;
            if (new Date(date) > new Date(existing.lastSeen)) existing.lastSeen = date;
            if (!existing.email && email) existing.email = email;
        } else {
            map.set(k, { name: display, email: email || undefined, meetings: 1, lastSeen: date });
        }
    };
    for (const m of meetings) {
        const seenInMeeting = new Set<string>();
        const lead = m.detailedSummary?.leadName;
        if (lead) {
            seenInMeeting.add(lead.trim().toLowerCase());
            add(lead, null, m.date);
        }
        for (const p of m.participants || []) {
            if (p.self) continue;
            const k = (p.name || '').trim().toLowerCase();
            if (k && seenInMeeting.has(k)) continue;
            add(p.name, p.email, m.date);
        }
    }
    return [...map.values()].sort((a, b) => b.meetings - a.meetings || +new Date(b.lastSeen) - +new Date(a.lastSeen));
}

function buildRisks(a: Omit<Account, 'risks'>): AccountRisk[] {
    const risks: AccountRisk[] = [];
    const closed = /closed/i.test(a.stage);
    if (!closed && a.daysSinceLastTouch > 21) {
        risks.push({ level: 'high', text: `No contact in ${a.daysSinceLastTouch} days — deal is going cold.` });
    } else if (!closed && a.daysSinceLastTouch > 10) {
        risks.push({ level: 'medium', text: `${a.daysSinceLastTouch} days since the last meeting — schedule a touchpoint.` });
    }
    if (a.meddicc.economicBuyer.status === 'missing') risks.push({ level: 'high', text: 'Economic buyer not identified — nobody who owns the budget has been engaged.' });
    if (a.meddicc.champion.status === 'missing') risks.push({ level: 'high', text: 'No internal champion identified.' });
    if (a.bant.budget.status === 'missing') risks.push({ level: 'medium', text: 'Budget has not been discussed.' });
    if (a.bant.timeline.status === 'missing') risks.push({ level: 'medium', text: 'No buying timeline established.' });
    if (a.meddicc.decisionProcess.status === 'missing') risks.push({ level: 'medium', text: 'Decision process is unknown.' });
    if (a.stakeholders.length <= 1 && !closed) risks.push({ level: 'medium', text: 'Single-threaded — only one contact engaged at this account.' });
    return risks;
}

export function buildAccount(key: string, meetingsInput: AccountMeeting[], now: Date = new Date()): Account {
    const meetings = [...meetingsInput].sort((a, b) => +new Date(b.date) - +new Date(a.date));
    const latest = meetings[0];
    const ds = latest?.detailedSummary;

    // Most frequent spelling wins; latest breaks ties.
    const nameCounts = new Map<string, number>();
    for (const m of meetings) {
        const n = getMeetingCompany(m);
        if (n) nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
    }
    const name = [...nameCounts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || key;

    const stageMeeting = meetings.find(m => {
        const s = m.detailedSummary?.dealStatus?.stage;
        return s && !/unknown/i.test(s);
    });

    const bant = Object.fromEntries(
        BANT_FIELDS.map(f => [f.key, rollUp(meetings, m => m.detailedSummary?.bant?.[f.key])]),
    ) as Record<BantKey, RolledUpField>;
    const meddicc = Object.fromEntries(
        MEDDICC_FIELDS.map(f => [f.key, rollUp(meetings, m => m.detailedSummary?.meddicc?.[f.key])]),
    ) as Record<MeddiccKey, RolledUpField>;

    const nextStepsSource = meetings.find(m =>
        (m.detailedSummary?.followUpEmail?.sections?.nextSteps?.length || 0) > 0 ||
        (m.detailedSummary?.actionItems?.length || 0) > 0,
    )?.detailedSummary;

    const base = {
        key,
        name,
        meetings,
        firstTouch: meetings[meetings.length - 1]?.date || '',
        lastTouch: latest?.date || '',
        daysSinceLastTouch: latest ? daysBetween(latest.date, now) : 0,
        stage: stageMeeting?.detailedSummary?.dealStatus?.stage || 'Unknown',
        stageSummary: stageMeeting?.detailedSummary?.dealStatus?.summary || '',
        overview: ds?.overview || latest?.summary || '',
        bant,
        meddicc,
        healthScore: computeAccountHealth(bant, meddicc),
        stakeholders: buildStakeholders(meetings),
        nextSteps: dedupe(
            nextStepsSource?.followUpEmail?.sections?.nextSteps?.length
                ? nextStepsSource.followUpEmail.sections.nextSteps
                : nextStepsSource?.actionItems || [],
        ),
        questionsToAsk: dedupe(meetings.find(m => m.detailedSummary?.nextCallPlaybook?.questionsToAsk?.length)?.detailedSummary?.nextCallPlaybook?.questionsToAsk || []),
        openingRecap: meetings.find(m => m.detailedSummary?.nextCallPlaybook?.openingRecap)?.detailedSummary?.nextCallPlaybook?.openingRecap || '',
        painPoints: dedupe(meetings.flatMap(m => m.detailedSummary?.followUpEmail?.sections?.scopeOfImprovement || [])).slice(0, 6),
        businessImpact: dedupe(meetings.flatMap(m => m.detailedSummary?.followUpEmail?.sections?.expectedBusinessImpact || [])).slice(0, 6),
    };

    return { ...base, risks: buildRisks(base) };
}

/** Groups meetings into accounts, most recently active first. Meetings with no detected company are skipped. */
export function groupMeetingsByCompany(meetings: AccountMeeting[], now: Date = new Date()): Account[] {
    const groups = new Map<string, AccountMeeting[]>();
    for (const m of meetings) {
        if (m.isProcessed === false) continue;
        const company = getMeetingCompany(m);
        if (!company) continue;
        const key = normalizeCompanyKey(company);
        const list = groups.get(key);
        if (list) list.push(m);
        else groups.set(key, [m]);
    }
    return [...groups.entries()]
        .map(([key, list]) => buildAccount(key, list, now))
        .sort((a, b) => +new Date(b.lastTouch) - +new Date(a.lastTouch));
}

/** Index of the stage in PIPELINE_STAGES, or -1 when unknown. Closed Won/Lost map to the final step. */
export function stageIndex(stage: string): number {
    if (/closed/i.test(stage)) return PIPELINE_STAGES.length - 1;
    return PIPELINE_STAGES.findIndex(s => s.toLowerCase() === stage.trim().toLowerCase());
}
