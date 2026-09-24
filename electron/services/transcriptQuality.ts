/**
 * transcriptQuality — per-final language guess + "suspect line" flag (live-analysis v2 §2.1 T5).
 *
 * Multilingual STT (Deepgram `multi` switches across ten languages) regularly emits short
 * hallucinated lines in a language nobody on the call speaks — "Déjame ver", "Tú firmaste nada
 * más este", "Saketendaić?" on a Hindi/English call. Those lines must never become BANT/MEDDIC
 * evidence. This module decides, cheaply and offline, whether a final looks like one:
 *
 *  - `lang`: a script-first guess (Devanagari → hi, Cyrillic → ru, …; Latin text is scored against
 *    small stop-word/diacritic tables for es/pt/fr/de/it/tr and defaults to en — Hinglish typed in
 *    Latin letters reads as en, which is what we want).
 *  - `suspect`: the guessed language is outside the call's expected languages
 *    (`callLanguages`, from the recognition-language setting) — or, when the setting doesn't pin
 *    them (e.g. 'multilingual'), the line is short and in a language that is RARE on this call so
 *    far (LanguageTracker). Low ASR confidence also flags, but only for providers that report a
 *    real confidence (the others hard-code 1.0).
 *
 * Pure and synchronous: it runs on the ORIGINAL recognized text before translation.
 */

export type SuspectReason = 'foreign_language' | 'rare_language' | 'low_confidence' | null;

export interface QualityVerdict {
    lang: string;
    suspect: boolean;
    reason: SuspectReason;
}

const SCRIPTS: Array<[RegExp, string]> = [
    [/[ऀ-ॿ]/g, 'hi'],
    [/[Ѐ-ӿ]/g, 'ru'],
    [/[؀-ۿ]/g, 'ar'],
    [/[ঀ-৿]/g, 'bn'],
    [/[਀-੿]/g, 'pa'],
    [/[઀-૿]/g, 'gu'],
    [/[஀-௿]/g, 'ta'],
    [/[ఀ-౿]/g, 'te'],
    [/[ಀ-೿]/g, 'kn'],
    [/[ഀ-ൿ]/g, 'ml'],
    [/[぀-ヿ]/g, 'ja'],
    [/[가-힯]/g, 'ko'],
    [/[一-鿿]/g, 'zh'],
];

// Words that are strong evidence of a Latin-script language other than English/Hinglish.
// Deliberately excludes anything that is also common Hinglish or English ("de", "yo", "la", "me").
const LATIN_WORDS: Record<string, Set<string>> = {
    es: new Set(['déjame', 'contigo', 'conmigo', 'firmaste', 'nada', 'más', 'tú', 'gracias', 'hola', 'señor', 'también', 'porque', 'pero', 'esto', 'este', 'esta', 'estoy', 'usted', 'ustedes', 'vamos', 'bueno', 'entonces', 'dónde', 'qué', 'cómo', 'nosotros', 'ahora', 'muy', 'sí']),
    pt: new Set(['obrigado', 'obrigada', 'você', 'não', 'então', 'também', 'agora', 'isso', 'muito', 'tudo', 'bem', 'estou']),
    fr: new Set(['bonjour', 'merci', 'oui', 'avec', 'pourquoi', 'alors', 'très', 'nous', 'vous', 'c\'est', 'être', 'déjà', 'voilà', 'ça']),
    de: new Set(['danke', 'bitte', 'nicht', 'ich', 'und', 'aber', 'wir', 'sind', 'genau', 'also', 'jetzt', 'schön', 'für']),
    it: new Set(['grazie', 'prego', 'perché', 'allora', 'anche', 'molto', 'sono', 'questo', 'quello', 'ciao']),
    tr: new Set(['teşekkür', 'evet', 'hayır', 'şimdi', 'değil', 'için', 'çok', 'güzel']),
};
// Latin letters with diacritics that English/Hinglish ASR output essentially never contains.
const FOREIGN_DIACRITIC = /[À-ÖØ-öø-ÿĀ-žḀ-ỿ]/;
const WORD = /[\p{L}\p{M}']+/gu;

/** Script/stop-word language guess for one line. */
export function guessLanguage(text: string): string {
    const t = text || '';
    let best = '';
    let bestCount = 0;
    for (const [rx, code] of SCRIPTS) {
        const n = (t.match(rx) || []).length;
        if (n > bestCount) {
            best = code;
            bestCount = n;
        }
    }
    const latin = (t.match(/[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]/g) || []).length;
    if (bestCount > 0 && bestCount >= latin * 0.3) return best;

    const words = (t.toLowerCase().match(WORD) || []);
    let latinBest = '';
    let latinScore = 0;
    for (const [code, vocab] of Object.entries(LATIN_WORDS)) {
        const score = words.filter(w => vocab.has(w)).length;
        if (score > latinScore) {
            latinBest = code;
            latinScore = score;
        }
    }
    if (latinScore > 0) return latinBest;
    if (FOREIGN_DIACRITIC.test(t)) return 'xx'; // some non-English Latin language we can't name
    return bestCount > 0 ? best : 'en';
}

/**
 * Tracks which languages this call is actually in, for settings that don't pin them
 * ('multilingual'). A language is RARE once enough finals have been seen and it accounts for
 * less than `rareShare` of them.
 */
export class LanguageTracker {
    private counts = new Map<string, number>();
    private total = 0;

    constructor(private readonly minFinals = 8, private readonly rareShare = 0.1) { }

    observe(lang: string): void {
        if (!lang) return;
        this.counts.set(lang, (this.counts.get(lang) || 0) + 1);
        this.total += 1;
    }

    /** Enough finals seen to judge rarity. */
    get settled(): boolean {
        return this.total >= this.minFinals;
    }

    isRare(lang: string): boolean {
        if (!this.settled) return false;
        return (this.counts.get(lang) || 0) / this.total < this.rareShare;
    }

    reset(): void {
        this.counts.clear();
        this.total = 0;
    }
}

export interface AssessOptions {
    /** Expected languages (ISO-639-1) from the recognition-language setting, if pinned. */
    callLanguages?: string[];
    tracker?: LanguageTracker;
    confidence?: number;
    /** True only for providers that report a real per-segment confidence (Deepgram, Google). */
    confidenceIsReal?: boolean;
    lowConfidence?: number;
}

const SHORT_LINE_TOKENS = 6;
const LATIN_FOREIGN = new Set([...Object.keys(LATIN_WORDS), 'xx']);

export function assessFinal(text: string, opts: AssessOptions = {}): QualityVerdict {
    const lang = guessLanguage(text);
    const tokens = (text.match(WORD) || []).length;
    const expected = (opts.callLanguages || []).map(l => l.toLowerCase());
    let reason: SuspectReason = null;

    if (expected.length > 0) {
        if (!expected.includes(lang)) reason = 'foreign_language';
    } else if (opts.tracker && lang !== 'en' && tokens <= SHORT_LINE_TOKENS) {
        // Adaptive: only SHORT lines in a language that's rare on THIS call. A genuine switch to a
        // second language produces many lines and stops being rare quickly. Short non-English
        // Latin-script lines (the classic `multi` hallucination) are flagged from the very start;
        // other scripts (Devanagari on an Indian call) only once the call's mix is known.
        const latinForeign = LATIN_FOREIGN.has(lang);
        if ((latinForeign && !opts.tracker.settled) || opts.tracker.isRare(lang)) reason = 'rare_language';
    }
    if (opts.tracker) opts.tracker.observe(lang);

    if (
        !reason
        && opts.confidenceIsReal
        && typeof opts.confidence === 'number'
        && opts.confidence < (opts.lowConfidence ?? 0.5)
    ) {
        reason = 'low_confidence';
    }
    return { lang, suspect: reason !== null, reason };
}
