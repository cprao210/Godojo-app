/**
 * pdfGenerator.ts — Meeting Details → PDF export.
 *
 * Mirrors the four Meeting Details tabs, in order:
 *   1. Coach          (call summary, demo / negotiation panels, game plan, coach's notes)
 *   2. Transcript     (Speaking Balance + full transcript table)
 *   3. Ask Dojo       (every question / answer, markdown rendered)
 *   4. Call Analysis  (BANT / MEDDICC tables, objections, signals, deal optimizer)
 *
 * Why this file looks the way it does
 * ───────────────────────────────────
 * jsPDF's built-in fonts (Helvetica / Courier) are WinAnsi (Windows-1252) only. The moment a string
 * contains one character outside that set (→, a non-breaking hyphen, a narrow no-break space, an
 * emoji, a Hindi letter …) jsPDF silently switches that whole string to 16-bit output, which is
 * exactly the "extra space between every letter" and clipped-line bug. So:
 *   • every string goes through `pdfSafe()` (normalise + transliterate + drop what can't be drawn);
 *   • text in scripts the built-in fonts can't draw (Devanagari, Gujarati, Arabic, CJK, Cyrillic …)
 *     is rasterised through a canvas using the OS fonts instead of being mangled;
 *   • line wrapping is done here (measure → break, incl. very long words / URLs) instead of
 *     `splitTextToSize`, so text can never overflow a column or the page edge.
 *
 * Layout engine: flowing paragraphs / bullets / callouts that split across pages without orphans,
 * and a bordered table engine with repeating header rows and row splitting for very long cells.
 */
import jsPDF from 'jspdf';
import type { LiveAnalysisData, CoachHighlight, CoachQuestion, AiInteractionItem } from '@/types';
import { callInvolves, coachQuestionText, coachPromises, parseCoachNoteItem /*, parseCoachHighlight */ } from '@/lib/coachSummary';
import {
    createSpeakerLabeler,
    formatTranscriptTime,
    isHiddenSpeaker,
    transcriptTimesAreRelative,
} from '@/lib/transcriptLabels';
import { BANT_ORDER, MEDDICC_ORDER, fieldEvidenceList, normalizeBant, normalizeMeddicc } from '@/lib/bantMeddic';
import { partitionObjections, splitRepFollowUps } from '@/lib/objections';
import { computeTalkTime } from '@/hooks/useMeetingDetails';
import { meetingsApi } from '@/api';

// ═════════════════════════════════════════════════════════════════════════════
// Input types (kept loose on purpose — older meetings miss many of these fields)
// ═════════════════════════════════════════════════════════════════════════════

type BantMeddicField = { status: string; detail: string };

interface Meeting {
    id: string;
    title: string;
    date: string;
    duration: string;
    summary: string;
    /** Call types selected during the live call — gates the demo/negotiation panels. */
    meetingTypes?: string[];
    company?: { name?: string } | null;
    detailedSummary?: {
        overview?: string;
        actionItems: string[];
        keyPoints: string[];
        actionItemsTitle?: string;
        keyPointsTitle?: string;

        leadName?: string;
        company?: string;

        speakerNames?: { user: string; client: string; clientDiarized?: string };
        liveAnalysis?: LiveAnalysisData;
        scorecard?: { detectedTypes?: string[] };

        coachCallType?: string;
        dealStatus?: { stage?: string; summary?: string };
        bant?: {
            budget?: BantMeddicField;
            authority?: BantMeddicField;
            need?: BantMeddicField;
            timeline?: BantMeddicField;
        };
        meddicc?: {
            metrics?: BantMeddicField;
            economicBuyer?: BantMeddicField;
            decisionCriteria?: BantMeddicField;
            decisionProcess?: BantMeddicField;
            identifyPain?: BantMeddicField;
            champion?: BantMeddicField;
            competition?: BantMeddicField;
            gaps?: string[];
        };
        followUpEmail?: {
            subject?: string;
            sections?: Record<string, string[] | string | undefined>;
            fullEmail?: string;
        };
        salesCoachReview?: {
            whatIDidRight?: (string | CoachHighlight)[];
            whatICouldHaveDoneBetter?: string[];
            whatIMissedCompletely?: string[];
        };
        nextCallPlaybook?: {
            openingRecap?: string;
            callGoal?: string;
            questionsToAsk?: CoachQuestion[];
            valueAndROI?: { quantitative?: string[]; qualitative?: string[] };
        };
        openLoops?: Array<{ concern: string; suggestedAnswer?: string }>;
        demoReview?: {
            reactions?: Array<{
                feature: string;
                verdict: 'landed' | 'follow_up' | string;
                quote: string;
                speaker: string;
                timestamp?: string;
            }>;
            successCriteria?: Array<{ metric: string; target: string; owner?: string }>;
        };
        stakeholders?: Array<{ name: string; role: string; stance: string; note?: string }>;
        negotiation?: {
            terms?: Array<{ term: string; theyAsked: string; youOffered: string; status: string }>;
            trades?: Array<{ give: string; get: string }>;
            limit?: string;
            pathToSignature?: Array<{ date?: string; step: string; owner?: string }>;
        };
        promises?: Array<{ text: string; owner?: string; dueDate?: string }>;
    };
    transcript?: Array<{
        speaker: string;
        displayName?: string;
        speakerIndex?: number | null;
        text: string;
        timestamp: number;
    }>;
    /** Legacy inline Q&A (the live Ask Dojo history is fetched from /ai-interactions instead). */
    usage?: Array<{
        type: string;
        timestamp: number;
        question?: string;
        answer?: string;
        items?: string[];
    }>;
}

export interface PdfExportOptions {
    /**
     * Ask Dojo history the caller already holds. Used only as a fallback when the generator cannot
     * fetch the full history itself (offline, placeholder meeting id …).
     */
    aiInteractions?: AiInteractionItem[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Text safety
// ═════════════════════════════════════════════════════════════════════════════

const MM_PER_PT = 0.3528;

// Characters outside Latin-1 that WinAnsi (Windows-1252) still covers — jsPDF draws these correctly.
const WIN1252_EXTRA = new Set<number>([
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
    0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
    0x0153, 0x017e, 0x0178,
]);

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\uFE0E\uFE0F\u00AD]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const SYMBOL_MAP: Array<[RegExp, string]> = [
    [/[\u2028\u2029]/g, '\n'],
    [/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'"],
    [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
    [/[\u2010\u2011\u2012\u2015\u2212\u2043]/g, '-'],
    [/[\u2000-\u200A\u202F\u205F\u3000\u00A0]/g, ' '],
    [/\u2044/g, '/'],
    [/[\u2192\u21D2\u27F6\u279C\u2794\u27A1]/g, '->'],
    [/[\u2190\u21D0]/g, '<-'],
    [/\u2194/g, '<->'],
    [/\u2265/g, '>='],
    [/\u2264/g, '<='],
    [/\u2260/g, '!='],
    [/\u2248/g, '~'],
    [/[\u25AA\u25AB\u25CF\u25E6\u2023\u25A0]/g, '\u2022'],
];

/** Removes invisible / control characters but keeps every real letter (any script). */
const lightClean = (input: unknown): string =>
    String(input ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\t/g, '    ')
        .replace(ZERO_WIDTH, '')
        .replace(CONTROL_CHARS, '');

/** Text that jsPDF's WinAnsi fonts can draw without the 16-bit "spaced letters" fallback. */
const pdfSafe = (input: unknown): string => {
    let s = lightClean(input).normalize('NFKC');
    for (const [re, rep] of SYMBOL_MAP) s = s.replace(re, rep);
    let out = '';
    for (const ch of s) {
        const cp = ch.codePointAt(0) as number;
        if (cp === 10 || (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN1252_EXTRA.has(cp)) out += ch;
    }
    return out.replace(/ {2,}/g, ' ').replace(/ +\n/g, '\n');
};

// Scripts the built-in fonts cannot draw → canvas fallback (needs a DOM, i.e. the Electron renderer).
const NEEDS_RASTER = /[\u0370-\u1FFF\u2C00-\uD7FF\uF900-\uFDFF\uFE70-\uFEFF]/;
const canRaster = (): boolean => typeof document !== 'undefined' && typeof document.createElement === 'function';
const RASTER_FONTS =
    '"Segoe UI","Noto Sans","Noto Sans Devanagari","Noto Sans Gujarati","Nirmala UI","Mangal","Helvetica Neue","Arial","Arial Unicode MS","Hiragino Sans","Microsoft YaHei","Malgun Gothic",sans-serif';
const PX_PER_MM = 12; // ≈ 300 dpi

// ═════════════════════════════════════════════════════════════════════════════
// Design tokens
// ═════════════════════════════════════════════════════════════════════════════

const C = {
    navy: '#1e3a8a',
    blue: '#2563eb',
    blueSoft: '#eff6ff',
    ink: '#0f172a',
    body: '#334155',
    muted: '#64748b',
    faint: '#94a3b8',
    line: '#cbd5e1',
    grid: '#94a3b8',
    zebra: '#f8fafc',
    track: '#e2e8f0',
    white: '#ffffff',
    green: '#15803d',
    amber: '#b45309',
    red: '#b91c1c',
};

type Tone = 'blue' | 'green' | 'amber' | 'red' | 'slate';
const TONES: Record<Tone, { fg: string; bg: string; border: string }> = {
    blue: { fg: C.blue, bg: '#eff6ff', border: '#bfdbfe' },
    green: { fg: C.green, bg: '#ecfdf5', border: '#a7f3d0' },
    amber: { fg: C.amber, bg: '#fffbeb', border: '#fde68a' },
    red: { fg: C.red, bg: '#fef2f2', border: '#fecaca' },
    slate: { fg: C.muted, bg: '#f1f5f9', border: '#cbd5e1' },
};

const SPEAKER_PALETTE = ['#64748b', '#0d9488', '#7c3aed', '#d97706', '#db2777', '#0891b2'];

const normKey = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[\s_-]+/g, '');

const statusTone = (status: unknown): Tone => {
    switch (normKey(status)) {
        case 'clear': case 'confirmed': case 'landed': case 'agreed': case 'resolved': case 'positive':
            return 'green';
        case 'partial': case 'partially': case 'followup': case 'open': case 'deferred':
            return 'amber';
        case 'leaning': case 'leaningyes':
            return 'blue';
        case 'missing': case 'musthave': case 'unresolved': case 'negative':
            return 'red';
        default:
            return 'slate';
    }
};

const intensityTone = (v: unknown): Tone =>
    normKey(v) === 'high' ? 'red' : normKey(v) === 'medium' ? 'amber' : 'slate';

const titleCase = (s: string): string => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const humanizeKey = (key: string): string => {
    const t = key.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim().toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// ═════════════════════════════════════════════════════════════════════════════
// Rich-text model + inline markdown
// ═════════════════════════════════════════════════════════════════════════════

interface Run {
    text: string;
    bold?: boolean;
    italic?: boolean;
    mono?: boolean;
    color?: string;
}

const CITATION_RE = /\s?\[\d{1,2}(?:\s*,\s*\d{1,2})*\]/g;
const INLINE_RE =
    /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+`|\*[^*\s][^*\n]*?\*|(?<![A-Za-z0-9_])_[^_\s][^_\n]*?_(?![A-Za-z0-9_])|\[[^\]\n]+\]\([^)\n]+\))/g;

/** `**bold**`, `*italic*`, `` `code` ``, `[text](url)`; citation markers like [1] are dropped. */
function parseInline(src: string): Run[] {
    const s = src.replace(CITATION_RE, '');
    const out: Run[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(s))) {
        if (m.index > last) out.push({ text: s.slice(last, m.index) });
        const tok = m[0];
        if (tok.startsWith('**') || tok.startsWith('__')) out.push({ text: tok.slice(2, -2), bold: true });
        else if (tok.startsWith('`')) out.push({ text: tok.slice(1, -1), mono: true });
        else if (tok.startsWith('[')) {
            const mm = tok.match(/^\[([^\]]+)\]/);
            out.push({ text: mm ? mm[1] : tok, color: C.blue });
        } else out.push({ text: tok.slice(1, -1), italic: true });
        last = m.index + tok.length;
    }
    if (last < s.length) out.push({ text: s.slice(last) });
    return out;
}

const stripInline = (s: string): string => parseInline(s).map((r) => r.text).join('');

// ═════════════════════════════════════════════════════════════════════════════
// Layout primitives
// ═════════════════════════════════════════════════════════════════════════════

interface TextStyle {
    size: number;
    bold?: boolean;
    italic?: boolean;
    mono?: boolean;
    color?: string;
    align?: 'left' | 'center' | 'right';
    md?: boolean;
}

interface TextLayout {
    lineCount: number;
    lineHeight: number;
    /** Draws lines [from, to) with the first line's top edge at `top`. */
    draw(x: number, top: number, from: number, to: number, width: number): void;
}

interface Cell {
    text?: string | Run[];
    bold?: boolean;
    italic?: boolean;
    mono?: boolean;
    color?: string;
    size?: number;
    align?: 'left' | 'center' | 'right';
    fill?: string;
    md?: boolean;
    badge?: Tone;
    bar?: { percent: number; color: string; label?: string };
}
type CellInput = Cell | string;

interface Column {
    header: string;
    /** Relative width. */
    w: number;
    align?: 'left' | 'center' | 'right';
}

interface TableOptions {
    size?: number;
    header?: boolean;
    headerFill?: string;
    zebra?: boolean;
    firstColBold?: boolean;
}

interface PreparedCell {
    cell: Cell;
    layout: TextLayout | null;
    lineCount: number;
    lh: number;
}

const LINE_FACTOR = 1.38;

class Report {
    readonly doc: jsPDF;
    readonly W: number;
    readonly H: number;
    readonly ML = 14;
    readonly CW: number;
    readonly TOP = 20;
    readonly bottom: number;
    y = 16;
    readonly sections: Array<{ label: string; page: number }> = [];

    private widthCache = new Map<string, number>();

    constructor() {
        this.doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
        this.W = this.doc.internal.pageSize.getWidth();
        this.H = this.doc.internal.pageSize.getHeight();
        this.CW = this.W - this.ML * 2;
        this.bottom = this.H - 17;
    }

    // ── fonts & measuring ────────────────────────────────────────────────────

    private setFont(s: { bold?: boolean; italic?: boolean; mono?: boolean }, size: number) {
        const family = s.mono ? 'courier' : 'helvetica';
        const style = s.bold && s.italic ? 'bolditalic' : s.bold ? 'bold' : s.italic ? 'italic' : 'normal';
        this.doc.setFont(family, style);
        this.doc.setFontSize(size);
    }

    private tw(text: string, s: { bold?: boolean; italic?: boolean; mono?: boolean }, size: number): number {
        const key = `${s.mono ? 'm' : 'h'}${s.bold ? 'b' : ''}${s.italic ? 'i' : ''}|${size}|${text}`;
        const hit = this.widthCache.get(key);
        if (hit !== undefined) return hit;
        this.setFont(s, size);
        const w = this.doc.getTextWidth(text);
        if (this.widthCache.size > 60000) this.widthCache.clear();
        this.widthCache.set(key, w);
        return w;
    }

    // ── text layout (vector) ─────────────────────────────────────────────────

    private layoutVector(input: Run[], maxW: number, base: TextStyle): TextLayout {
        const size = base.size;
        const runs: Run[] = input
            .filter((r) => r.text !== '')
            .map((r) => ({
                text: r.text,
                bold: r.bold ?? base.bold,
                italic: r.italic ?? base.italic,
                mono: r.mono ?? base.mono,
                color: r.color ?? base.color ?? C.body,
            }));
        const same = (a: Run, b: Run) =>
            !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.mono === !!b.mono && a.color === b.color;

        const lines: Run[][] = [[]];
        let curW = 0;
        const push = (text: string, run: Run, w: number) => {
            const line = lines[lines.length - 1];
            const last = line[line.length - 1];
            if (last && same(last, run)) last.text += text;
            else line.push({ ...run, text });
            curW += w;
        };
        const newLine = () => {
            const line = lines[lines.length - 1];
            while (line.length) {
                const last = line[line.length - 1];
                last.text = last.text.replace(/\s+$/, '');
                if (last.text === '') line.pop();
                else break;
            }
            lines.push([]);
            curW = 0;
        };

        for (const run of runs) {
            const parts = run.text.split('\n');
            parts.forEach((part, pi) => {
                if (pi > 0) newLine();
                for (const tok of part.split(/(\s+)/)) {
                    if (!tok) continue;
                    if (/^\s+$/.test(tok)) {
                        if (curW === 0) continue;
                        const sw = this.tw(' ', run, size);
                        if (curW + sw <= maxW) push(' ', run, sw);
                        continue;
                    }
                    const w = this.tw(tok, run, size);
                    if (curW + w <= maxW + 0.01) { push(tok, run, w); continue; }
                    if (curW > 0) newLine();
                    if (w <= maxW) { push(tok, run, w); continue; }
                    // A single token wider than the line (URL, ID, long number): break it by characters.
                    let rest = Array.from(tok);
                    while (rest.length) {
                        let lo = 1;
                        let hi = rest.length;
                        while (lo < hi) {
                            const mid = Math.ceil((lo + hi) / 2);
                            if (this.tw(rest.slice(0, mid).join(''), run, size) <= maxW) lo = mid;
                            else hi = mid - 1;
                        }
                        const chunk = rest.slice(0, lo).join('');
                        push(chunk, run, this.tw(chunk, run, size));
                        rest = rest.slice(lo);
                        if (rest.length) newLine();
                    }
                }
            });
        }
        // Trim the last line and drop trailing empty lines.
        newLine();
        lines.pop();
        while (lines.length && lines[lines.length - 1].length === 0) lines.pop();

        const lh = size * MM_PER_PT * LINE_FACTOR;
        const fsMm = size * MM_PER_PT;
        const align = base.align ?? 'left';
        return {
            lineCount: lines.length,
            lineHeight: lh,
            draw: (x, top, from, to, width) => {
                for (let i = from; i < to && i < lines.length; i++) {
                    const line = lines[i];
                    const baseline = top + (i - from) * lh + (lh - fsMm) / 2 + fsMm * 0.8;
                    const lw = line.reduce((a, r) => a + this.tw(r.text, r, size), 0);
                    let cx = align === 'center' ? x + (width - lw) / 2 : align === 'right' ? x + width - lw : x;
                    for (const r of line) {
                        this.setFont(r, size);
                        this.doc.setTextColor(r.color ?? C.body);
                        this.doc.text(r.text, cx, baseline);
                        cx += this.tw(r.text, r, size);
                    }
                }
            },
        };
    }

    // ── text layout (canvas fallback for scripts the built-in fonts can't draw) ──

    private layoutRaster(text: string, maxW: number, base: TextStyle): TextLayout {
        const size = base.size;
        const fsPx = size * MM_PER_PT * PX_PER_MM;
        const fontStr = `${base.italic ? 'italic ' : ''}${base.bold ? 'bold ' : ''}${Math.round(fsPx)}px ${RASTER_FONTS}`;
        const measureCanvas = document.createElement('canvas');
        const mctx = measureCanvas.getContext('2d') as CanvasRenderingContext2D;
        mctx.font = fontStr;
        const mw = (s: string) => mctx.measureText(s).width / PX_PER_MM;

        const lines: string[] = [];
        for (const para of text.split('\n')) {
            let cur = '';
            let curW = 0;
            const flush = () => { lines.push(cur.replace(/\s+$/, '')); cur = ''; curW = 0; };
            for (const tok of para.split(/(\s+)/)) {
                if (!tok) continue;
                if (/^\s+$/.test(tok)) { if (cur) { cur += ' '; curW += mw(' '); } continue; }
                const w = mw(tok);
                if (curW + w <= maxW) { cur += tok; curW += w; continue; }
                if (cur) flush();
                if (w <= maxW) { cur = tok; curW = w; continue; }
                for (const ch of Array.from(tok)) {
                    const cw = mw(ch);
                    if (curW + cw > maxW && cur) flush();
                    cur += ch;
                    curW += cw;
                }
            }
            flush();
        }
        while (lines.length && lines[lines.length - 1] === '') lines.pop();

        const lh = size * MM_PER_PT * LINE_FACTOR;
        const lhPx = lh * PX_PER_MM;
        const align = base.align ?? 'left';
        return {
            lineCount: lines.length,
            lineHeight: lh,
            draw: (x, top, from, to, width) => {
                const count = Math.min(to, lines.length) - from;
                if (count <= 0) return;
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.ceil(width * PX_PER_MM));
                canvas.height = Math.max(1, Math.ceil(count * lhPx));
                const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
                ctx.font = fontStr;
                ctx.fillStyle = base.color ?? C.body;
                ctx.textBaseline = 'alphabetic';
                for (let i = 0; i < count; i++) {
                    const s = lines[from + i];
                    const w = ctx.measureText(s).width;
                    const dx = align === 'center' ? (canvas.width - w) / 2 : align === 'right' ? canvas.width - w : 0;
                    ctx.fillText(s, dx, i * lhPx + (lhPx - fsPx) / 2 + fsPx * 0.8);
                }
                this.doc.addImage(canvas.toDataURL('image/png'), 'PNG', x, top, width, count * lh, undefined, 'FAST');
            },
        };
    }

    layout(content: string | Run[], maxW: number, style: TextStyle): TextLayout {
        const plain = typeof content === 'string' ? content : content.map((r) => r.text).join('');
        const cleaned = lightClean(plain);
        if (canRaster() && NEEDS_RASTER.test(cleaned)) {
            return this.layoutRaster(style.md ? stripInline(cleaned) : cleaned, maxW, style);
        }
        const runs: Run[] =
            typeof content === 'string'
                ? style.md ? parseInline(pdfSafe(content)) : [{ text: pdfSafe(content) }]
                : content.map((r) => ({ ...r, text: pdfSafe(r.text) }));
        return this.layoutVector(runs, maxW, style);
    }

    // ── page management ──────────────────────────────────────────────────────

    newPage() {
        this.doc.addPage();
        this.y = this.TOP;
    }

    ensure(h: number) {
        if (this.y + h > this.bottom) this.newPage();
    }

    get pageCount(): number {
        return this.doc.getNumberOfPages();
    }

    /** Flows laid-out lines over as many pages as needed (no orphan / widow single lines). */
    private flow(
        L: TextLayout,
        x: number,
        w: number,
        onSegment?: (top: number, height: number, first: boolean, last: boolean) => void,
    ) {
        const n = L.lineCount;
        let i = 0;
        while (i < n) {
            const fit = Math.floor((this.bottom - this.y + 0.001) / L.lineHeight);
            if (fit < Math.min(n - i, 2)) { this.newPage(); continue; }
            let take = Math.min(fit, n - i);
            if (n - i - take === 1 && take > 2) take -= 1;
            const first = i === 0;
            const last = i + take >= n;
            onSegment?.(this.y, take * L.lineHeight, first, last);
            L.draw(x, this.y, i, i + take, w);
            this.y += take * L.lineHeight;
            i += take;
            if (i < n) this.newPage();
        }
    }

    // ── flowing blocks ───────────────────────────────────────────────────────

    para(
        content: string | Run[],
        o: { size?: number; bold?: boolean; italic?: boolean; color?: string; indent?: number; after?: number; md?: boolean; align?: 'left' | 'center' | 'right' } = {},
    ) {
        const indent = o.indent ?? 0;
        const w = this.CW - indent;
        const L = this.layout(content, w, {
            size: o.size ?? 10, bold: o.bold, italic: o.italic, color: o.color ?? C.body, md: o.md, align: o.align,
        });
        this.flow(L, this.ML + indent, w);
        this.y += o.after ?? 2.2;
    }

    bullets(
        items: Array<string | Run[]>,
        o: { size?: number; indent?: number; color?: string; marker?: 'dot' | 'number'; bulletColor?: string; md?: boolean; after?: number; gap?: number } = {},
    ) {
        const size = o.size ?? 10;
        const indent = o.indent ?? 0;
        const hang = o.marker === 'number' ? 7 : 5;
        const w = this.CW - indent - hang;
        items.forEach((item, idx) => {
            const L = this.layout(item, w, { size, color: o.color ?? C.body, md: o.md });
            if (L.lineCount === 0) return;
            this.flow(L, this.ML + indent + hang, w, (top, _h, first) => {
                if (!first) return;
                if (o.marker === 'number') {
                    this.setFont({ bold: true }, size);
                    this.doc.setTextColor(o.bulletColor ?? C.blue);
                    this.doc.text(`${idx + 1}.`, this.ML + indent, top + (L.lineHeight - size * MM_PER_PT) / 2 + size * MM_PER_PT * 0.8);
                } else {
                    this.doc.setFillColor(o.bulletColor ?? C.blue);
                    this.doc.circle(this.ML + indent + 1.6, top + L.lineHeight / 2, 0.75, 'F');
                }
            });
            this.y += o.gap ?? 1.4;
        });
        this.y += o.after ?? 1.5;
    }

    /** Left-ruled quote (customer quotes, scripts, blockquotes). */
    quote(text: string, o: { tone?: Tone; indent?: number; size?: number; after?: number } = {}) {
        const tone = TONES[o.tone ?? 'slate'];
        const indent = o.indent ?? 0;
        const barX = this.ML + indent;
        const x = barX + 4;
        const w = this.CW - indent - 4;
        const L = this.layout(text, w, { size: o.size ?? 9.5, italic: true, color: C.body, md: true });
        this.flow(L, x, w, (top, h) => {
            this.doc.setFillColor(tone.border);
            this.doc.rect(barX, top + 0.3, 1, Math.max(0, h - 0.6), 'F');
        });
        this.y += o.after ?? 2.2;
    }

    /** Tinted box with an accent bar. Kept on one page when it fits. */
    callout(title: string | null, body: string, tone: Tone, o: { size?: number; bold?: boolean; after?: number } = {}) {
        const t = TONES[tone];
        const pad = 3.2;
        const barW = 1.4;
        const innerW = this.CW - pad * 2 - barW;
        const titleL = title ? this.layout(title, innerW, { size: 7.5, bold: true, color: t.fg }) : null;
        const bodyL = this.layout(body, innerW, { size: o.size ?? 10, bold: o.bold, color: C.ink });
        const titleH = titleL ? titleL.lineCount * titleL.lineHeight + 1 : 0;
        const h = pad * 2 + titleH + bodyL.lineCount * bodyL.lineHeight;
        if (h > (this.bottom - this.TOP) * 0.7) {
            this.quote(body, { tone });
            return;
        }
        this.ensure(h);
        this.doc.setFillColor(t.bg);
        this.doc.setDrawColor(t.border);
        this.doc.setLineWidth(0.25);
        this.doc.roundedRect(this.ML, this.y, this.CW, h, 1.6, 1.6, 'FD');
        this.doc.setFillColor(t.fg);
        this.doc.rect(this.ML, this.y + 0.9, barW, h - 1.8, 'F');
        let cy = this.y + pad;
        const cx = this.ML + barW + pad;
        if (titleL) { titleL.draw(cx, cy, 0, titleL.lineCount, innerW); cy += titleH; }
        bodyL.draw(cx, cy, 0, bodyL.lineCount, innerW);
        this.y += h + (o.after ?? 3);
    }

    // ── headings ─────────────────────────────────────────────────────────────

    /** Full-width coloured band that opens each tab's section. */
    tabBanner(label: string, meta: string, isFirst: boolean) {
        if (!isFirst || this.y + 55 > this.bottom) this.newPage();
        const h = 10.5;
        this.sections.push({ label, page: this.pageCount });
        this.doc.setFillColor(C.navy);
        this.doc.roundedRect(this.ML, this.y, this.CW, h, 1.8, 1.8, 'F');
        this.setFont({ bold: true }, 13);
        this.doc.setTextColor(C.white);
        this.doc.text(pdfSafe(label), this.ML + 5, this.y + 7.1);
        if (meta) {
            this.setFont({}, 8.5);
            this.doc.setTextColor('#bfdbfe');
            this.doc.text(pdfSafe(meta), this.ML + this.CW - 5, this.y + 6.8, { align: 'right' });
        }
        this.y += h + 6;
    }

    /** Level-2 heading with an accent bar. */
    sectionTitle(text: string, tone: Tone = 'blue') {
        this.ensure(24);
        this.doc.setFillColor(TONES[tone].fg);
        this.doc.rect(this.ML, this.y, 1.4, 6.2, 'F');
        this.setFont({ bold: true }, 12.5);
        this.doc.setTextColor(C.navy);
        this.doc.text(pdfSafe(text), this.ML + 4, this.y + 4.7);
        this.y += 6.2;
        this.doc.setDrawColor(C.line);
        this.doc.setLineWidth(0.2);
        this.doc.line(this.ML, this.y + 1.6, this.ML + this.CW, this.y + 1.6);
        this.y += 5;
    }

    /** Level-3 heading. */
    subTitle(text: string, color: string = C.navy) {
        this.ensure(18);
        this.setFont({ bold: true }, 10.5);
        this.doc.setTextColor(color);
        this.doc.text(pdfSafe(text), this.ML, this.y + 3.6);
        this.y += 6.4;
    }

    /** Small muted caption. */
    caption(text: string, o: { italic?: boolean; after?: number } = {}) {
        this.para(text, { size: 8.5, color: C.muted, italic: o.italic, after: o.after ?? 2 });
    }

    rule(after = 4) {
        this.ensure(after + 1);
        this.doc.setDrawColor(C.line);
        this.doc.setLineWidth(0.25);
        this.doc.line(this.ML, this.y, this.ML + this.CW, this.y);
        this.y += after;
    }

    gap(mm: number) {
        this.y += mm;
    }

    // ── stat tiles & bars ────────────────────────────────────────────────────

    statTiles(tiles: Array<{ label: string; value: string; sub?: string; color?: string }>) {
        if (!tiles.length) return;
        const h = 19;
        this.ensure(h + 3);
        const gapX = 3;
        const w = (this.CW - gapX * (tiles.length - 1)) / tiles.length;
        tiles.forEach((t, i) => {
            const x = this.ML + i * (w + gapX);
            this.doc.setFillColor(C.white);
            this.doc.setDrawColor(C.line);
            this.doc.setLineWidth(0.3);
            this.doc.roundedRect(x, this.y, w, h, 1.8, 1.8, 'FD');
            this.doc.setFillColor(t.color ?? C.blue);
            this.doc.rect(x + 0.3, this.y + 3, 1, h - 6, 'F');
            this.setFont({ bold: true }, 15);
            this.doc.setTextColor(t.color ?? C.navy);
            this.doc.text(pdfSafe(t.value), x + 5, this.y + 9);
            this.setFont({ bold: true }, 7);
            this.doc.setTextColor(C.muted);
            this.doc.text(pdfSafe(t.label).toUpperCase(), x + 5, this.y + 13.4);
            if (t.sub) {
                this.setFont({}, 7.5);
                this.doc.setTextColor(C.faint);
                this.doc.text(pdfSafe(t.sub), x + 5, this.y + 16.8);
            }
        });
        this.y += h + 4;
    }

    stackedBar(segments: Array<{ label: string; value: number; color: string }>) {
        const total = segments.reduce((a, s) => a + s.value, 0);
        if (total <= 0) return;
        const h = 7;
        this.ensure(h + 14);
        let x = this.ML;
        segments.forEach((s, i) => {
            const w = (s.value / total) * this.CW;
            if (w <= 0) return;
            this.doc.setFillColor(s.color);
            if (segments.length === 1) this.doc.roundedRect(x, this.y, w, h, 1.5, 1.5, 'F');
            else this.doc.rect(x, this.y, w, h, 'F');
            if (w > 12) {
                this.setFont({ bold: true }, 8);
                this.doc.setTextColor(C.white);
                this.doc.text(`${Math.round((s.value / total) * 100)}%`, x + w / 2, this.y + 4.7, { align: 'center' });
            }
            if (i < segments.length - 1) {
                this.doc.setDrawColor(C.white);
                this.doc.setLineWidth(0.4);
                this.doc.line(x + w, this.y, x + w, this.y + h);
            }
            x += w;
        });
        this.y += h + 3.5;
        // Legend (wraps onto extra rows when there are many speakers).
        let lx = this.ML;
        segments.forEach((s) => {
            const label = pdfSafe(s.label) || 'Speaker';
            const room = this.CW * 0.45;
            let shown = label;
            while (shown.length > 3 && this.tw(shown, {}, 8.5) > room) shown = shown.slice(0, -2);
            if (shown !== label) shown = `${shown.trimEnd()}...`;
            const lw = 5 + this.tw(shown, {}, 8.5) + 6;
            if (lx + lw > this.ML + this.CW) { lx = this.ML; this.y += 5; this.ensure(6); }
            this.doc.setFillColor(s.color);
            this.doc.roundedRect(lx, this.y - 2.6, 3, 3, 0.6, 0.6, 'F');
            this.setFont({}, 8.5);
            this.doc.setTextColor(C.body);
            this.doc.text(shown, lx + 4.6, this.y);
            lx += lw;
        });
        this.y += 6;
    }

    // ── tables ───────────────────────────────────────────────────────────────

    table(cols: Column[], rows: CellInput[][], o: TableOptions = {}) {
        if (!rows.length) return;
        const size = o.size ?? 8.5;
        const padX = 2.2;
        const padY = 1.7;
        const showHeader = o.header !== false;
        const sum = cols.reduce((a, c) => a + c.w, 0);
        const widths = cols.map((c) => (c.w / sum) * this.CW);
        const xs = widths.map((_, i) => this.ML + widths.slice(0, i).reduce((a, b) => a + b, 0));
        const headerFill = o.headerFill ?? C.navy;

        const prepare = (input: CellInput, ci: number, isHeader: boolean): PreparedCell => {
            const cell: Cell = typeof input === 'string' ? { text: input } : { ...input };
            const cw = widths[ci] - padX * 2;
            if (isHeader) {
                cell.bold = true; cell.color = C.white; cell.fill = headerFill; cell.size = Math.min(size, 8); cell.align = cols[ci].align;
            }
            if (cell.bar) return { cell, layout: null, lineCount: 1, lh: 5.4 };
            if (cell.badge) return { cell, layout: null, lineCount: 1, lh: 6 };
            const l = this.layout(cell.text ?? '', cw, {
                size: cell.size ?? size,
                bold: cell.bold ?? (ci === 0 && !!o.firstColBold),
                italic: cell.italic,
                mono: cell.mono,
                color: cell.color ?? C.body,
                align: cell.align ?? cols[ci].align,
                md: cell.md,
            });
            return { cell, layout: l, lineCount: Math.max(1, l.lineCount), lh: l.lineHeight };
        };

        const header: PreparedCell[] | null = showHeader ? cols.map((c, ci) => prepare(c.header, ci, true)) : null;
        const headerH = header ? Math.max(...header.map((p) => p.lh * p.lineCount)) + padY * 2 : 0;
        const prepared = rows.map((row) => cols.map((_, ci) => prepare(row[ci] ?? '', ci, false)));

        const rowHeight = (cells: PreparedCell[]) => Math.max(...cells.map((p) => p.lh * p.lineCount)) + padY * 2;

        const drawSegment = (cells: PreparedCell[], from: number[], count: number[], rowIndex: number, isHeader: boolean) => {
            const segH = Math.max(...cells.map((p, i) => p.lh * count[i])) + padY * 2;
            cells.forEach((p, ci) => {
                const x = xs[ci];
                const w = widths[ci];
                const fill = p.cell.fill ?? (o.zebra && !isHeader && rowIndex % 2 === 1 ? C.zebra : null);
                if (fill) { this.doc.setFillColor(fill); this.doc.rect(x, this.y, w, segH, 'F'); }
                if (count[ci] > 0) {
                    const top = this.y + padY;
                    if (p.cell.bar) {
                        const trackW = w - padX * 2 - (p.cell.bar.label ? 11 : 0);
                        const pct = Math.max(0, Math.min(1, p.cell.bar.percent / 100));
                        this.doc.setFillColor(C.track);
                        this.doc.roundedRect(x + padX, top + 1.3, trackW, 2.6, 1.3, 1.3, 'F');
                        if (pct > 0) {
                            this.doc.setFillColor(p.cell.bar.color);
                            this.doc.roundedRect(x + padX, top + 1.3, Math.max(2.6, trackW * pct), 2.6, 1.3, 1.3, 'F');
                        }
                        if (p.cell.bar.label) {
                            this.setFont({ bold: true }, 8.5);
                            this.doc.setTextColor(C.ink);
                            this.doc.text(pdfSafe(p.cell.bar.label), x + w - padX, top + 3.9, { align: 'right' });
                        }
                    } else if (p.cell.badge) {
                        const tone = TONES[p.cell.badge];
                        const label = pdfSafe(typeof p.cell.text === 'string' ? p.cell.text : '').toUpperCase();
                        this.setFont({ bold: true }, 7);
                        const pw = Math.min(w - padX * 2, this.doc.getTextWidth(label) + 4.4);
                        const px = p.cell.align === 'center' ? x + (w - pw) / 2 : x + padX;
                        this.doc.setFillColor(tone.bg);
                        this.doc.setDrawColor(tone.border);
                        this.doc.setLineWidth(0.25);
                        this.doc.roundedRect(px, top + 0.2, pw, 4.8, 1.4, 1.4, 'FD');
                        this.doc.setTextColor(tone.fg);
                        this.doc.text(label, px + pw / 2, top + 3.55, { align: 'center' });
                    } else if (p.layout) {
                        p.layout.draw(x + padX, top, from[ci], from[ci] + count[ci], w - padX * 2);
                    }
                }
                this.doc.setDrawColor(C.grid);
                this.doc.setLineWidth(0.2);
                this.doc.rect(x, this.y, w, segH, 'S');
            });
            this.y += segH;
        };

        const drawHeader = () => {
            if (!header) return;
            drawSegment(header, header.map(() => 0), header.map((p) => p.lineCount), 0, true);
        };

        // Keep the header together with at least the start of the first row.
        const firstMin = Math.min(rowHeight(prepared[0]), padY * 2 + Math.max(...prepared[0].map((p) => p.lh)) * 2);
        this.ensure(headerH + firstMin);
        drawHeader();

        const usable = this.bottom - this.TOP - headerH;
        prepared.forEach((cells, r) => {
            const full = cells.map((p) => p.lineCount);
            const total = rowHeight(cells);
            if (total <= this.bottom - this.y) {
                drawSegment(cells, cells.map(() => 0), full, r, false);
                return;
            }
            // Small rows move to the next page whole; tall rows (long transcript turns / answers) split by lines.
            if (total <= usable * 0.4) {
                this.newPage();
                drawHeader();
                drawSegment(cells, cells.map(() => 0), full, r, false);
                return;
            }
            const cursor = cells.map(() => 0);
            let guard = 0;
            while (cursor.some((c, i) => c < cells[i].lineCount) && guard++ < 1000) {
                const availH = this.bottom - this.y - padY * 2;
                const remaining = cells.map((p, i) => p.lineCount - cursor[i]);
                const count = cells.map((p, i) => Math.max(0, Math.min(remaining[i], Math.floor((availH + 0.001) / p.lh))));
                // Never strand a single line: every multi-line cell must place 2+ lines, or we start a fresh page.
                const tooTight = cells.some((_, i) => remaining[i] > 1 && count[i] < 2) || count.every((c) => c === 0);
                if (tooTight) {
                    const atTop = this.y <= this.TOP + headerH + 0.5;
                    if (!atTop) { this.newPage(); drawHeader(); continue; }
                    remaining.forEach((rem, i) => { if (rem > 0 && count[i] === 0) count[i] = 1; });
                }
                drawSegment(cells, cursor, count, r, false);
                count.forEach((c, i) => { cursor[i] += c; });
                if (cursor.some((c, i) => c < cells[i].lineCount)) { this.newPage(); drawHeader(); }
            }
        });
        this.y += 4;
    }

    // ── per-page chrome ──────────────────────────────────────────────────────

    decoratePages(title: string, generated: string) {
        const n = this.pageCount;
        const shortTitle = pdfSafe(title) || 'Meeting';
        for (let p = 1; p <= n; p++) {
            this.doc.setPage(p);
            if (p > 1) {
                let t = shortTitle;
                this.setFont({ bold: true }, 8);
                const room = this.CW - 40;
                while (t.length > 4 && this.doc.getTextWidth(t) > room) t = t.slice(0, -2);
                if (t !== shortTitle) t = `${t.trimEnd()}...`;
                this.doc.setTextColor(C.muted);
                this.doc.text(t, this.ML, 11);
                this.setFont({}, 8);
                this.doc.setTextColor(C.faint);
                this.doc.text('GoDojo AI', this.ML + this.CW, 11, { align: 'right' });
                this.doc.setDrawColor(C.line);
                this.doc.setLineWidth(0.25);
                this.doc.line(this.ML, 13.5, this.ML + this.CW, 13.5);
            }
            this.doc.setDrawColor(C.line);
            this.doc.setLineWidth(0.25);
            this.doc.line(this.ML, this.H - 12.5, this.ML + this.CW, this.H - 12.5);
            this.setFont({}, 8);
            this.doc.setTextColor(C.faint);
            this.doc.text(`Generated by GoDojo AI  |  ${pdfSafe(generated)}`, this.ML, this.H - 8);
            this.doc.text(`Page ${p} of ${n}`, this.ML + this.CW, this.H - 8, { align: 'right' });
        }
    }

    // CONTENTS (disabled): the PDF no longer has a contents/index list — restore by un-commenting this
    // method together with the two CONTENTS blocks in buildMeetingPdf (reserve space + draw call).
    // /** Table of contents, drawn after the fact (page numbers are only known once the pages exist). */
    // drawContents(top: number, entries: Array<{ label: string; page: number }>) {
    //     this.doc.setPage(1);
    //     this.setFont({ bold: true }, 9);
    //     this.doc.setTextColor(C.navy);
    //     this.doc.text('CONTENTS', this.ML, top + 3);
    //     let cy = top + 9;
    //     entries.forEach((e) => {
    //         const label = pdfSafe(e.label);
    //         this.setFont({}, 10);
    //         this.doc.setTextColor(C.body);
    //         this.doc.text(label, this.ML + 2, cy);
    //         const startX = this.ML + 2 + this.doc.getTextWidth(label) + 2;
    //         const pageStr = String(e.page);
    //         this.setFont({ bold: true }, 10);
    //         this.doc.setTextColor(C.navy);
    //         this.doc.text(pageStr, this.ML + this.CW - 2, cy, { align: 'right' });
    //         const endX = this.ML + this.CW - 2 - this.doc.getTextWidth(pageStr) - 2;
    //         this.doc.setDrawColor(C.line);
    //         this.doc.setLineWidth(0.3);
    //         this.doc.setLineDashPattern([0.4, 1.2], 0);
    //         this.doc.line(startX, cy - 0.6, endX, cy - 0.6);
    //         this.doc.setLineDashPattern([], 0);
    //         cy += 6;
    //     });
    // }

    // ── markdown (Ask Dojo answers) ──────────────────────────────────────────

    markdown(source: string) {
        const lines = lightClean(source).split('\n');
        const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
        const splitRow = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/;
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            if (!line.trim()) { i++; continue; }

            // fenced code
            if (/^\s*```/.test(line)) {
                const code: string[] = [];
                i++;
                while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
                i++;
                this.codeBlock(code.join('\n'));
                continue;
            }
            // heading
            const h = line.match(/^(#{1,6})\s+(.*)$/);
            if (h) {
                this.ensure(14);
                this.para(h[2], { size: h[1].length <= 2 ? 11.5 : 10.5, bold: true, color: C.navy, after: 1.6, md: true });
                i++;
                continue;
            }
            // table
            if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
                const head = splitRow(line);
                i += 2;
                const body: string[][] = [];
                while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(splitRow(lines[i++]));
                const colCount = Math.max(head.length, ...body.map((row) => row.length));
                const cols: Column[] = Array.from({ length: colCount }, (_, ci) => ({ header: stripInline(head[ci] ?? ''), w: 1 }));
                this.table(
                    cols,
                    body.map((row) => cols.map((_, ci) => ({ text: row[ci] ?? '', md: true }))),
                    { size: 8.5, zebra: true },
                );
                continue;
            }
            // list (with simple nesting by indentation)
            if (LIST_RE.test(line)) {
                while (i < lines.length && LIST_RE.test(lines[i])) {
                    const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/) as RegExpMatchArray;
                    const level = Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
                    const numbered = /\d/.test(m[2]);
                    let text = m[3];
                    i++;
                    while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !LIST_RE.test(lines[i])) text += `\n${lines[i++].trim()}`;
                    const w = this.CW - level * 5 - 5;
                    const L = this.layout(text, w, { size: 10, color: C.body, md: true });
                    if (!L.lineCount) continue;
                    this.flow(L, this.ML + level * 5 + 5, w, (top, _h, first) => {
                        if (!first) return;
                        if (numbered) {
                            this.setFont({ bold: true }, 9.5);
                            this.doc.setTextColor(C.blue);
                            this.doc.text(pdfSafe(m[2]), this.ML + level * 5, top + (L.lineHeight - 10 * MM_PER_PT) / 2 + 10 * MM_PER_PT * 0.8);
                        } else {
                            this.doc.setFillColor(level % 2 ? C.faint : C.blue);
                            this.doc.circle(this.ML + level * 5 + 1.6, top + L.lineHeight / 2, 0.7, 'F');
                        }
                    });
                    this.y += 1.2;
                }
                this.y += 1.6;
                continue;
            }
            // blockquote
            if (/^\s*>/.test(line)) {
                const q: string[] = [];
                while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
                this.quote(q.join('\n'), { tone: 'slate' });
                continue;
            }
            // horizontal rule
            if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { this.rule(4); i++; continue; }

            // paragraph (single newlines are kept, like the Ask Dojo tab does)
            const p: string[] = [];
            while (
                i < lines.length && lines[i].trim() &&
                !/^\s*```/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) &&
                !LIST_RE.test(lines[i]) && !/^\s*>/.test(lines[i]) &&
                !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
            ) p.push(lines[i++]);
            this.para(p.join('\n'), { size: 10, md: true, after: 2.6 });
        }
    }

    private codeBlock(code: string) {
        const pad = 2.5;
        const w = this.CW - pad * 2;
        const L = this.layout(code, w, { size: 8, mono: true, color: C.ink });
        if (!L.lineCount) return;
        this.flow(L, this.ML + pad, w, (top, h, first, last) => {
            this.doc.setFillColor('#f1f5f9');
            this.doc.rect(this.ML, top - (first ? pad : 0), this.CW, h + (first ? pad : 0) + (last ? pad : 0), 'F');
        });
        this.y += pad + 2;
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Report assembly
// ═════════════════════════════════════════════════════════════════════════════

const nonEmpty = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);

const formatDateLong = (raw: string): string => {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return str(raw);
    return d.toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const formatInteractionTime = (ts: number): string => {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase()}`;
};

interface QA {
    q: string;
    a: string;
    time: string;
    sources: string[];
}

const collectQA = (meeting: Meeting, ai: AiInteractionItem[]): QA[] => {
    if (ai.length) {
        return [...ai]
            .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
            .map((it) => {
                const seen = new Set<string>();
                const sources: string[] = [];
                for (const s of it.sources ?? []) {
                    if (!('id' in s) || !s.id || seen.has(s.id)) continue;
                    seen.add(s.id);
                    if (str(s.title)) sources.push(str(s.title));
                }
                return { q: str(it.user_query), a: str(it.ai_response), time: formatInteractionTime(it.timestamp), sources };
            })
            .filter((x) => x.q || x.a);
    }
    return (meeting.usage ?? [])
        .filter((u) => u.question && u.answer)
        .map((u) => ({ q: str(u.question), a: str(u.answer), time: formatInteractionTime(u.timestamp), sources: [] }));
};

export const buildMeetingPdf = (meeting: Meeting, aiInteractions: AiInteractionItem[] = []): jsPDF => {
    const r = new Report();
    const ds = meeting.detailedSummary;
    const title = str(meeting.title) || 'Untitled meeting';

    // ── Pre-compute what each tab will contain (drives the contents list) ──
    const keyPoints = nonEmpty(ds?.keyPoints);
    // OVERVIEW (disabled): the PDF no longer prints an "Overview" section. meeting.summary is only the
    // "See detailed summary" placeholder, so it was showing that text verbatim.
    // const overview = str(meeting.summary) || str(ds?.overview);
    const involvesDemo = !!ds && callInvolves('demo', ds, meeting.meetingTypes);
    const involvesNegotiation = !!ds && callInvolves('negotiation', ds, meeting.meetingTypes);
    const playbook = ds?.nextCallPlaybook;
    const goal = str(playbook?.callGoal);
    const recap = str(playbook?.openingRecap);
    const questions = (playbook?.questionsToAsk ?? [])
        .map((q) => ({ text: coachQuestionText(q).trim(), gap: (typeof q === 'string' ? '' : str(q?.gap)) || '' }))
        .filter((q) => q.text);
    const loops = (ds?.openLoops ?? []).filter((l) => l?.concern?.trim());
    const quant = nonEmpty(playbook?.valueAndROI?.quantitative);
    const qual = nonEmpty(playbook?.valueAndROI?.qualitative);
    const promises = ds ? coachPromises(ds) : [];
    // REPLAY (disabled): "Replay these moments" is hidden from the PDF for now.
    // const keepDoing = (ds?.salesCoachReview?.whatIDidRight ?? []).map(parseCoachHighlight).filter((n) => n !== null);
    const tryNext = (ds?.salesCoachReview?.whatICouldHaveDoneBetter ?? []).map(parseCoachNoteItem).filter((n) => n !== null);
    const legacyActions = ds && ds.salesCoachReview === undefined ? nonEmpty(ds.actionItems) : [];

    const hasGamePlan = !!(goal || recap || questions.length || loops.length || quant.length || qual.length || promises.length);
    const hasCoach = !!(keyPoints.length || involvesDemo || involvesNegotiation || hasGamePlan || tryNext.length || legacyActions.length);

    const visibleTranscript = (meeting.transcript ?? []).filter((e) => !isHiddenSpeaker(e.speaker) && str(e.text));
    const qa = collectQA(meeting, aiInteractions);
    const la = ds?.liveAnalysis;
    const hasAnalysis = !!(la || ds?.bant || ds?.meddicc);

    // ── Page 1: title block ──
    r.y = 14;
    r.doc.setFont('helvetica', 'bold');
    r.doc.setFontSize(8);
    r.doc.setTextColor(C.blue);
    r.doc.text('GODOJO AI  |  MEETING REPORT', r.ML, r.y);
    r.y += 3.2;
    r.para(title, { size: 20, bold: true, color: C.ink, after: 1.5 });
    const dateStr = formatDateLong(meeting.date);
    const durationStr = str(meeting.duration) && str(meeting.duration) !== '\u2014' ? str(meeting.duration) : '';
    r.para([dateStr, durationStr].filter(Boolean).join('  |  '), { size: 10, color: C.muted, after: 2 });
    r.rule(5);

    // At-a-glance facts
    const speakerNames = ds?.speakerNames;
    const companyName = str(meeting.company?.name) || str(ds?.company);
    const facts: Array<[string, string]> = [];
    if (companyName) facts.push(['Company', companyName]);
    if (str(ds?.leadName)) facts.push(['Lead', str(ds?.leadName)]);
    const callTypes = Array.from(new Set([str(ds?.coachCallType), ...nonEmpty(meeting.meetingTypes)].filter(Boolean).map(titleCase)));
    if (callTypes.length) facts.push(['Call type', callTypes.join(', ')]);
    if (str(speakerNames?.user) || str(speakerNames?.client)) {
        facts.push(['Participants', [str(speakerNames?.user), str(speakerNames?.client)].filter(Boolean).join(', ')]);
    }
    if (facts.length) {
        if (facts.length % 2 === 1) facts.push(['', '']);
        const rows: CellInput[][] = [];
        for (let i = 0; i < facts.length; i += 2) {
            const a = facts[i];
            const b = facts[i + 1];
            rows.push([
                { text: a[0], bold: true, color: C.navy, fill: a[0] ? C.blueSoft : C.white },
                a[1],
                { text: b[0], bold: true, color: C.navy, fill: b[0] ? C.blueSoft : C.white },
                b[1],
            ]);
        }
        r.table([{ header: '', w: 20 }, { header: '', w: 30 }, { header: '', w: 20 }, { header: '', w: 30 }], rows, { header: false, size: 9 });
    }

    // CONTENTS (disabled): no contents list is reserved or drawn any more.
    // const tocEntries = [hasCoach, visibleTranscript.length > 0, qa.length > 0, hasAnalysis].filter(Boolean).length;
    // const tocTop = r.y;
    // if (tocEntries > 0) r.y += 9 + tocEntries * 6 + 4;
    r.y += 4; // breathing room before the first tab banner

    let firstSection = true;
    const openSection = (label: string, meta: string) => {
        r.tabBanner(label, meta, firstSection);
        firstSection = false;
    };

    // ═════════ 1. COACH ═════════
    if (hasCoach && ds) {
        openSection('Coach', callTypes.join('  |  '));

        if (keyPoints.length) {
            r.sectionTitle('Call Summary');
            r.bullets(keyPoints, { size: 10.5, gap: 1.8 });
            r.gap(2);
        }

        // OVERVIEW (disabled):
        // if (overview) {
        //     r.sectionTitle('Overview');
        //     r.para(overview, { size: 10, after: 4 });
        // }

        // Follow up on the demo
        if (involvesDemo) {
            const reactions = (ds.demoReview?.reactions ?? []).filter((x) => x?.feature?.trim() && x?.quote?.trim());
            const criteria = (ds.demoReview?.successCriteria ?? []).filter((c) => c?.metric?.trim() && c?.target?.trim());
            if (reactions.length || loops.length || criteria.length) {
                r.sectionTitle('Follow up on the demo');
                if (reactions.length) {
                    r.subTitle('How it landed');
                    r.table(
                        [{ header: 'Feature', w: 30 }, { header: 'What they said', w: 58 }, { header: 'Verdict', w: 16, align: 'center' }],
                        reactions.map((x) => {
                            const who = [str(x.speaker), str(x.timestamp)].filter(Boolean).join(' | ');
                            return [
                                { text: x.feature, bold: true },
                                { text: `"${x.quote.trim()}"${who ? `\n- ${who}` : ''}`, italic: true },
                                { text: x.verdict === 'landed' ? 'Landed' : x.verdict === 'follow_up' ? 'Follow up' : titleCase(String(x.verdict || 'n/a')), badge: statusTone(x.verdict), align: 'center' as const },
                            ];
                        }),
                        { zebra: true },
                    );
                }
                if (loops.length) {
                    r.subTitle('Answer what you owe them');
                    r.table(
                        [{ header: 'They asked', w: 45 }, { header: 'Try saying', w: 55 }],
                        loops.map((l) => [{ text: `"${l.concern.trim()}"` }, { text: str(l.suggestedAnswer) ? `"${str(l.suggestedAnswer)}"` : '-', italic: true, color: C.green }]),
                        { zebra: true },
                    );
                }
                if (criteria.length) {
                    r.subTitle('Agree how the pilot is judged');
                    r.table(
                        [{ header: 'Metric', w: 52 }, { header: 'Target', w: 30 }, { header: 'Owner', w: 18 }],
                        criteria.map((c) => [c.metric.trim(), { text: c.target.trim(), bold: true }, str(c.owner) || '-']),
                        { zebra: true },
                    );
                }
            }
        }

        // Move the deal to signature
        if (involvesNegotiation) {
            const terms = (ds.negotiation?.terms ?? []).filter((t) => t?.term?.trim() && (t.theyAsked?.trim() || t.youOffered?.trim()));
            const trades = (ds.negotiation?.trades ?? []).filter((t) => t?.give?.trim() && t?.get?.trim());
            const limit = str(ds.negotiation?.limit);
            const path = (ds.negotiation?.pathToSignature ?? []).filter((s) => s?.step?.trim());
            if (terms.length || trades.length || limit || path.length) {
                r.sectionTitle('Move the deal to signature');
                if (terms.length) {
                    r.subTitle('Where the terms stand');
                    r.table(
                        [{ header: 'Term', w: 22 }, { header: 'They asked', w: 31 }, { header: 'You offered', w: 31 }, { header: 'Status', w: 16, align: 'center' }],
                        terms.map((t) => [
                            { text: t.term, bold: true },
                            str(t.theyAsked) || '-',
                            { text: str(t.youOffered) || '-', color: C.blue },
                            { text: t.status === 'leaning' ? 'Leaning yes' : t.status === 'must_have' ? 'Must have' : titleCase(String(t.status || 'n/a')), badge: statusTone(t.status), align: 'center' as const },
                        ]),
                        { zebra: true },
                    );
                }
                if (trades.length) {
                    r.subTitle('Trades to offer');
                    r.table(
                        [{ header: 'If you give', w: 50 }, { header: 'Ask for in return', w: 50 }],
                        trades.map((t) => [{ text: t.give, color: C.amber }, { text: t.get, color: C.green }]),
                        { zebra: true },
                    );
                }
                if (limit) r.callout('YOUR LIMIT', limit, 'amber', { bold: true });
                if (path.length) {
                    r.subTitle('Path to signature');
                    r.table(
                        [{ header: 'When', w: 20 }, { header: 'Step', w: 62 }, { header: 'Owner', w: 18 }],
                        path.map((s) => [str(s.date) || '-', s.step.trim(), str(s.owner) || '-']),
                        { zebra: true },
                    );
                }
            }
        }

        // Game plan
        if (hasGamePlan) {
            r.sectionTitle('Your game plan for the next call');
            if (goal) {
                const closes = Array.from(new Set(questions.map((q) => q.gap).filter(Boolean)));
                r.callout('YOUR GOAL FOR THE CALL', goal, 'blue', { size: 11, bold: true, after: closes.length ? 1 : 4 });
                if (closes.length) r.caption(`Closes: ${closes.join(', ')}`, { after: 4 });
            }

            r.subTitle('1. Open with');
            if (recap) r.quote(recap, { tone: 'blue', size: 10 });
            else r.caption('No recap was captured on this call.', { italic: true });

            r.subTitle('2. Ask these');
            if (questions.length) {
                if (questions.some((q) => q.gap)) {
                    r.table(
                        [{ header: 'Gap', w: 24 }, { header: 'Question', w: 76 }],
                        questions.map((q) => [{ text: q.gap || '-', bold: true, color: C.blue }, q.text]),
                        { zebra: true },
                    );
                } else r.bullets(questions.map((q) => q.text), { marker: 'number' });
            } else r.caption('No gap questions were captured on this call.', { italic: true });

            r.subTitle('3. Close the open loops');
            if (loops.length) {
                r.table(
                    [{ header: 'They asked', w: 45 }, { header: 'Try saying', w: 55 }],
                    loops.map((l) => [{ text: `"${l.concern.trim()}"` }, { text: str(l.suggestedAnswer) ? `"${str(l.suggestedAnswer)}"` : '-', italic: true, color: C.green }]),
                    { zebra: true },
                );
            } else r.caption('No open loops - everything they raised was settled on the call.', { italic: true });

            r.subTitle('4. Reinforce the value');
            if (quant.length || qual.length) {
                const rowsN = Math.max(quant.length, qual.length);
                r.table(
                    [{ header: 'In numbers', w: 50 }, { header: 'In their words', w: 50 }],
                    Array.from({ length: rowsN }, (_, i) => [quant[i] ?? '', qual[i] ?? '']),
                    { zebra: true },
                );
            } else r.caption('No agreed numbers or customer quotes were captured.', { italic: true });

            r.subTitle('5. Promises you made');
            if (promises.length) {
                r.table(
                    [{ header: 'Promise', w: 62 }, { header: 'Owner', w: 20 }, { header: 'Due', w: 18 }],
                    promises.map((p) => [p.text, str(p.owner) || '-', str(p.dueDate) || '-']),
                    { zebra: true },
                );
            } else r.caption('No commitments were made on this call.', { italic: true });
        }

        // Coach's notes
        if (tryNext.length) {
            r.sectionTitle("Coach's notes");
            const notes = (label: string, list: NonNullable<(typeof tryNext)[number]>[], fill: string) => {
                if (!list.length) return;
                r.subTitle(label, fill);
                r.table(
                    [{ header: 'Area', w: 20 }, { header: 'Note', w: 46 }, { header: 'Try saying', w: 34 }],
                    list.map((n) => [
                        { text: n.time ? `${n.time} · ${n.label ?? ''}` : (n.label || '-'), bold: true, color: C.navy },
                        n.content || n.quote || '',
                        n.content && n.quote ? { text: `"${n.quote}"`, italic: true, color: C.green } : '',
                    ]),
                    { zebra: true, headerFill: fill },
                );
            };
            // REPLAY (disabled): notes('Replay these moments', keepDoing, '#166534');
            notes('Try next time', tryNext, '#92400e');
        }

        if (legacyActions.length) {
            r.sectionTitle('Action Items');
            r.bullets(legacyActions);
        }
    }

    // ═════════ 2. TRANSCRIPT ═════════
    if (visibleTranscript.length) {
        const speakerLabel = createSpeakerLabeler(meeting.transcript, ds?.speakerNames);
        const relativeTimes = transcriptTimesAreRelative(meeting.transcript);
        const talk = computeTalkTime(meeting.transcript as any);

        openSection('Transcript', `${visibleTranscript.length} messages`);

        // Speaking Balance
        if (talk.speakers.length) {
            r.sectionTitle('Speaking Balance');
            const key = (s: { speaker: string; displayName?: string; speakerIndex?: number | null }) =>
                `${s.speaker === 'user' ? 'user' : 'client'}::${s.displayName ?? '\u2205'}::${s.speakerIndex ?? '\u2205'}`;
            const stats = new Map<string, { turns: number; longest: number }>();
            for (const seg of meeting.transcript ?? []) {
                const raw = (seg.speaker || '').toLowerCase();
                if (isHiddenSpeaker(raw) || !str(seg.text)) continue;
                const words = seg.text.trim().split(/\s+/).filter(Boolean).length;
                const k = key({ speaker: raw, displayName: seg.displayName, speakerIndex: seg.speakerIndex });
                const cur = stats.get(k) ?? { turns: 0, longest: 0 };
                cur.turns += 1;
                cur.longest = Math.max(cur.longest, words);
                stats.set(k, cur);
            }
            let paletteIdx = 0;
            const speakers = talk.speakers.map((s) => {
                const label = speakerLabel(s.speaker, s.displayName, s.speakerIndex) || 'Speaker';
                const color = s.speaker === 'user' ? C.blue : SPEAKER_PALETTE[paletteIdx++ % SPEAKER_PALETTE.length];
                const st = stats.get(key(s)) ?? { turns: 0, longest: 0 };
                return { ...s, label, color, ...st, share: talk.totalWords ? (s.words / talk.totalWords) * 100 : 0 };
            });
            const yourShare = speakers.filter((s) => s.speaker === 'user').reduce((a, s) => a + s.share, 0);
            const totalTurns = speakers.reduce((a, s) => a + s.turns, 0);

            r.statTiles([
                { label: 'Total words', value: talk.totalWords.toLocaleString() },
                { label: 'Speakers', value: String(speakers.length) },
                { label: 'Turns', value: totalTurns.toLocaleString() },
                { label: 'Talk ratio', value: `${Math.round(yourShare)}:${Math.round(100 - yourShare)}`, sub: 'you : them', color: C.green },
            ]);
            r.stackedBar(speakers.map((s) => ({ label: s.label, value: s.words, color: s.color })));
            r.table(
                [
                    { header: 'Speaker', w: 31 },
                    { header: 'Words', w: 12, align: 'right' },
                    { header: 'Share of conversation', w: 31 },
                    { header: 'Turns', w: 10, align: 'right' },
                    { header: 'Avg words / turn', w: 14, align: 'right' },
                    { header: 'Longest turn', w: 12, align: 'right' },
                ],
                speakers.map((s) => [
                    { text: s.label, bold: true, color: s.color },
                    s.words.toLocaleString(),
                    { bar: { percent: s.share, color: s.color, label: `${s.percent}%` } },
                    String(s.turns),
                    s.turns ? String(Math.round(s.words / s.turns)) : '-',
                    s.longest ? `${s.longest.toLocaleString()} w` : '-',
                ]),
                { zebra: true },
            );
            r.caption('Speaking balance is measured in words spoken and shows participation and engagement during the meeting.', { italic: true, after: 5 });
        }

        // Full transcript
        r.sectionTitle('Full Transcript');
        const colorByLabel = new Map<string, string>();
        let tIdx = 0;
        const colorFor = (label: string, speaker: string) => {
            if (speaker === 'user') return C.blue;
            if (!colorByLabel.has(label)) colorByLabel.set(label, SPEAKER_PALETTE[tIdx++ % SPEAKER_PALETTE.length]);
            return colorByLabel.get(label) as string;
        };
        r.table(
            [{ header: 'Time', w: 15 }, { header: 'Speaker', w: 21 }, { header: 'Message', w: 64 }],
            visibleTranscript.map((e) => {
                const label = speakerLabel(e.speaker, e.displayName, e.speakerIndex);
                return [
                    { text: formatTranscriptTime(e.timestamp, relativeTimes), color: C.muted, size: 8 },
                    { text: label, bold: true, color: colorFor(label, (e.speaker || '').toLowerCase()) },
                    { text: e.text.trim(), size: 9 },
                ];
            }),
            { zebra: true, size: 9 },
        );
    }

    // ═════════ 3. ASK DOJO ═════════
    if (qa.length) {
        openSection('Ask Dojo', `${qa.length} ${qa.length === 1 ? 'question' : 'questions'}`);
        qa.forEach((item, idx) => {
            r.ensure(34);
            if (item.q) {
                r.callout(`QUESTION ${idx + 1}${item.time ? `  |  ${item.time}` : ''}`, item.q, 'blue', { size: 10.5, bold: true, after: 2.5 });
            }
            if (item.a) r.markdown(item.a);
            if (item.sources.length) r.caption(`Sources: ${item.sources.join('; ')}`, { italic: true, after: 1 });
            if (idx < qa.length - 1) { r.gap(1.5); r.rule(5); }
        });
    }

    // ═════════ 4. CALL ANALYSIS ═════════
    if (hasAnalysis) {
        openSection('Call Analysis', la?.source === 'v2_end' ? 'End-of-call analysis' : '');

        if (la?.truncated) {
            r.callout(
                'PARTIAL ANALYSIS',
                `Only the first ${la.truncated.analyzedChars.toLocaleString()} of ${la.truncated.totalChars.toLocaleString()} characters of the transcript were analysed - anything later in the call is not reflected here.`,
                'amber',
                { size: 9 },
            );
        }

        type FieldRow = { label: string; status: string; detail: string; evidence: string[]; ask: string };
        const MEDDIC_RAW: Record<string, string> = {
            metrics: 'metrics', economicBuyer: 'economic_buyer', decisionCriteria: 'decision_criteria',
            decisionProcess: 'decision_process', identifyPain: 'identify_pain', champion: 'champion', competition: 'competition',
        };
        const bantRows: FieldRow[] = [];
        const meddiccRows: FieldRow[] = [];

        const nb = la ? normalizeBant(la.bant) : null;
        if (nb) {
            BANT_ORDER.forEach((k) => {
                const raw = (la?.bant as any)?.[k];
                bantRows.push({ label: humanizeKey(k), status: (nb as any)[k].status, detail: (nb as any)[k].detail, evidence: fieldEvidenceList(raw), ask: str(raw?.suggested_question) });
            });
        } else if (ds?.bant) {
            BANT_ORDER.forEach((k) => {
                const f = (ds.bant as any)[k] as BantMeddicField | undefined;
                if (f) bantRows.push({ label: humanizeKey(k), status: f.status, detail: f.detail, evidence: [], ask: '' });
            });
        }
        const nm = la ? normalizeMeddicc(la.meddic) : null;
        if (nm) {
            MEDDICC_ORDER.forEach((k) => {
                const raw = (la?.meddic as any)?.[MEDDIC_RAW[k]];
                meddiccRows.push({ label: humanizeKey(k), status: (nm as any)[k].status, detail: (nm as any)[k].detail, evidence: fieldEvidenceList(raw), ask: str(raw?.suggested_question) });
            });
        } else if (ds?.meddicc) {
            MEDDICC_ORDER.forEach((k) => {
                const f = (ds.meddicc as any)[k] as BantMeddicField | undefined;
                if (f) meddiccRows.push({ label: humanizeKey(k), status: f.status, detail: f.detail, evidence: [], ask: '' });
            });
        }

        const frameworkTable = (heading: string, rows: FieldRow[]) => {
            if (!rows.length) return;
            const clear = rows.filter((x) => normKey(x.status) === 'clear').length;
            r.sectionTitle(`${heading}  (${clear}/${rows.length} confirmed)`);
            const withEvidence = rows.some((x) => x.evidence.length);
            const cols: Column[] = withEvidence
                ? [{ header: 'Criterion', w: 17 }, { header: 'Status', w: 13, align: 'center' }, { header: 'Assessment', w: 35 }, { header: 'Evidence from the call', w: 35 }]
                : [{ header: 'Criterion', w: 22 }, { header: 'Status', w: 15, align: 'center' }, { header: 'Assessment', w: 63 }];
            r.table(
                cols,
                rows.map((x) => {
                    const row: CellInput[] = [
                        { text: x.label, bold: true, color: C.navy },
                        { text: x.status || 'Missing', badge: statusTone(x.status || 'Missing'), align: 'center' as const },
                        x.detail || '-',
                    ];
                    if (withEvidence) {
                        row.push({ text: x.evidence.length ? x.evidence.map((e) => `"${e}"`).join('\n') : '-', italic: true, color: C.muted, size: 8 });
                    }
                    return row;
                }),
                { zebra: true },
            );
        };
        frameworkTable('MEDDICC', meddiccRows);
        frameworkTable('BANT', bantRows);

        // Gaps to close
        const gapRows = [
            ...meddiccRows.map((x) => ({ ...x, fw: 'MEDDICC' })),
            ...bantRows.map((x) => ({ ...x, fw: 'BANT' })),
        ].filter((x) => normKey(x.status) !== 'clear' && x.ask);
        // GAPS HEADER (disabled): the "Gaps to close" title and the "GAPS TO ADDRESS ..." callout are no
        // longer printed in the PDF. Only the per-criterion "Question to ask next" table remains.
        // const gapNames = nonEmpty(ds?.meddicc?.gaps);
        if (gapRows.length) {
            // r.sectionTitle('Gaps to close', 'red');
            // if (gapNames.length) r.callout('GAPS TO ADDRESS', gapNames.map(humanizeKey).join('  |  '), 'red', { size: 9.5, bold: true });
            if (gapRows.length) {
                r.table(
                    [{ header: 'Criterion', w: 22 }, { header: 'Status', w: 14, align: 'center' }, { header: 'Question to ask next', w: 64 }],
                    gapRows.map((x) => [
                        { text: `${x.fw} - ${x.label}`, bold: true, color: C.navy },
                        { text: x.status || 'Missing', badge: statusTone(x.status || 'Missing'), align: 'center' as const },
                        { text: x.ask, italic: true, color: C.green },
                    ]),
                    { zebra: true },
                );
            }
        }

        if (la) {
            // Objections
            const { objections, followUps } = splitRepFollowUps(la.objections ?? []);
            const { active, resolved } = partitionObjections(objections);
            const ordered = [...active, ...resolved];
            if (ordered.length || la.objectionDetectionOff === 'internal') {
                r.sectionTitle(`Objections  (${ordered.length})`);
                if (!ordered.length) {
                    r.caption('Objection detection is off for internal meetings.', { italic: true });
                } else {
                    r.table(
                        [{ header: 'Objection raised', w: 33 }, { header: 'Topic', w: 15 }, { header: 'Status', w: 13, align: 'center' }, { header: 'Suggested answer / how it was handled', w: 39 }],
                        ordered.map((o) => {
                            const status = o.resolved || o.handled === 'resolved' ? 'Resolved' : o.handled === 'partially' ? 'Partial' : o.handled === 'unresolved' ? 'Unresolved' : 'Open';
                            const answer = [str(o.rep_response) && `You said: ${str(o.rep_response)}`, str(o.suggested_answer) && `Try: ${str(o.suggested_answer)}`].filter(Boolean).join('\n');
                            return [
                                { text: `"${str(o.quote)}"`, italic: true },
                                str(o.category_label) || str(o.topic) || '-',
                                { text: status, badge: statusTone(status), align: 'center' as const },
                                { text: answer || '-', color: answer ? C.green : C.muted },
                            ];
                        }),
                        { zebra: true },
                    );
                }
            }
            if (followUps.length) {
                r.sectionTitle(`Your follow-ups  (${followUps.length})`);
                r.table(
                    [{ header: 'What you promised to come back on', w: 80 }, { header: 'Status', w: 20, align: 'center' }],
                    followUps.map((o) => [
                        { text: `"${str(o.quote)}"`, italic: true },
                        { text: o.status === 'deferred' ? 'Deferred' : 'Open', badge: statusTone(o.status), align: 'center' as const },
                    ]),
                    { zebra: true },
                );
            }

            // Signals
            const signals = (la.signals ?? []).filter((s) => str(s?.quote));
            if (signals.length) {
                r.sectionTitle(`Buying signals  (${signals.length})`);
                r.table(
                    [{ header: 'What was said', w: 36 }, { header: 'Type', w: 16 }, { header: 'Read', w: 12, align: 'center' }, { header: 'Intensity', w: 11, align: 'center' }, { header: 'Ask now', w: 25 }],
                    signals.map((s) => [
                        { text: `"${str(s.quote)}"`, italic: true },
                        (s.signal_type ?? []).map((t) => titleCase(t)).join(', ') || '-',
                        { text: titleCase(String(s.category || 'neutral')), badge: statusTone(s.category), align: 'center' as const },
                        { text: titleCase(String(s.intensity || 'low')), align: 'center' as const },
                        { text: str(s.ask_now) || '-', color: C.blue },
                    ]),
                    { zebra: true },
                );
            }

            // Deal optimizer
            const alerts = (la.dealOptimizer ?? []).filter((a) => str(a?.headline) || str(a?.quote));
            if (alerts.length) {
                r.sectionTitle(`Deal optimizer  (${alerts.length})`);
                r.table(
                    [{ header: 'Trigger', w: 15 }, { header: 'What is happening', w: 32 }, { header: 'Recommended moves', w: 38 }, { header: 'Priority', w: 15, align: 'center' }],
                    alerts.map((a) => {
                        const moves = nonEmpty(a.moves).map((m, i) => `${i + 1}. ${m}`).join('\n');
                        const anchor = str(a.anchor) ? `\nAnchor: ${str(a.anchor)}` : '';
                        return [
                            { text: titleCase(String(a.trigger || '')), bold: true, color: C.navy },
                            `${str(a.headline)}${str(a.quote) ? `\n"${str(a.quote)}"` : ''}`,
                            `${moves}${anchor}`,
                            { text: titleCase(String(a.intensity || 'low')), badge: intensityTone(a.intensity), align: 'center' as const },
                        ];
                    }),
                    { zebra: true },
                );
            }
        }
    }

    // CONTENTS (disabled):
    // if (tocEntries > 0) r.drawContents(tocTop, r.sections);

    // ── Chrome + metadata ──
    r.decoratePages(title, new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
    r.doc.setProperties({ title, subject: 'Meeting report', author: 'GoDojo AI', creator: 'GoDojo AI' });
    return r.doc;
};

// ═════════════════════════════════════════════════════════════════════════════
// Public entry point
// ═════════════════════════════════════════════════════════════════════════════

// Client-only ids — there is no backend row to fetch for these.
const isFetchable = (id?: string): id is string =>
    !!id && id !== 'live-meeting-current' && !id.startsWith('optimistic-');

/** List rows / local mirrors can lack the transcript or summary; pull the full record when so. */
async function withFullDetail(meeting: Meeting): Promise<Meeting> {
    const complete = !!meeting.transcript?.length && !!meeting.detailedSummary;
    if (complete || !isFetchable(meeting.id)) return meeting;
    try {
        const full = (await meetingsApi.get(meeting.id)) as unknown as Partial<Meeting>;
        const merged: Record<string, unknown> = { ...meeting };
        for (const [k, v] of Object.entries(full ?? {})) if (v !== undefined && v !== null) merged[k] = v;
        return merged as unknown as Meeting;
    } catch {
        return meeting;
    }
}

/** The Ask Dojo history lives behind its own endpoint — never inside the meeting payload. */
async function fetchAskDojo(meeting: Meeting, fallback?: AiInteractionItem[]): Promise<AiInteractionItem[]> {
    if (isFetchable(meeting.id)) {
        try {
            const res = await meetingsApi.getAiInteractions(meeting.id, 500);
            if (res?.items?.length) return res.items;
        } catch {
            /* fall through to what the caller already holds */
        }
    }
    return fallback ?? [];
}

export const generateMeetingPDF = async (meeting: Meeting, options: PdfExportOptions = {}): Promise<void> => {
    // Let the caller's "exporting…" state paint before the (synchronous) layout work starts.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const full = await withFullDetail(meeting);
    const ai = await fetchAskDojo(full, options.aiInteractions);
    const doc = buildMeetingPdf(full, ai);
    const safeTitle = (str(full.title) || 'meeting').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'meeting';
    doc.save(`${safeTitle}.pdf`);
};