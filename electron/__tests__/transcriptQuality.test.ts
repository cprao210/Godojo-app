import { describe, expect, it } from 'vitest';
import { assessFinal, guessLanguage, LanguageTracker } from '../services/transcriptQuality';
import { buildTranslateMessage } from '../services/TranscriptTranslator';
import { RECOGNITION_LANGUAGES } from '../config/languages';

// Lines replayed from a real Hinglish demo call recognized with Deepgram `multi`.
const HALLUCINATED = ['Déjame ver.', 'Saketendaić?', 'Tú firmaste nada más este', 'Contigo de'];
const REAL = [
    'Hello, sir. I\'m here.',
    'We have an idea around 300, what we have at present time.',
    'नहीं अब shortage का जैसे क्या है कि actually guard हैं',
    'बिना data के भी चलेगा कि without उसमें जो है',
    'Yes, yes, everyone has their own route, they all have it.',
    'Okay.',
];

describe('guessLanguage', () => {
    it('reads scripts first', () => {
        expect(guessLanguage('बारह बजे से पहले हमको कोई ज़रूरत भी नहीं है')).toBe('hi');
        expect(guessLanguage('siteएं हैं अपना जो है उनको दिया गया है')).toBe('hi');
        expect(guessLanguage('Привет')).toBe('ru');
    });

    it('treats Hinglish in Latin letters as English', () => {
        expect(guessLanguage('rate kam karo thoda sir')).toBe('en');
    });

    it('names foreign Latin-script lines', () => {
        expect(guessLanguage('Tú firmaste nada más este')).toBe('es');
        expect(guessLanguage('Saketendaić?')).toBe('xx');
    });
});

describe('assessFinal', () => {
    it('flags every hallucinated line when the call is pinned to Hindi + English', () => {
        for (const line of HALLUCINATED) {
            const v = assessFinal(line, { callLanguages: ['hi', 'en'] });
            expect(v.suspect, line).toBe(true);
            expect(v.reason).toBe('foreign_language');
        }
        for (const line of REAL) {
            expect(assessFinal(line, { callLanguages: ['hi', 'en'] }).suspect, line).toBe(false);
        }
    });

    it('in multilingual mode flags short foreign Latin lines from the start', () => {
        const tracker = new LanguageTracker();
        expect(assessFinal('Déjame ver.', { tracker }).suspect).toBe(true);
        expect(assessFinal('Saketendaić?', { tracker }).suspect).toBe(true);
        expect(assessFinal('Hello, sir. I\'m here.', { tracker }).suspect).toBe(false);
        // Devanagari at the start of an Indian call is NOT suspect.
        expect(assessFinal('नहीं अब shortage का जैसे', { tracker }).suspect).toBe(false);
    });

    it('stops flagging a language that becomes common on the call', () => {
        const tracker = new LanguageTracker(4, 0.1);
        for (let i = 0; i < 6; i++) assessFinal('muy bueno, gracias señor', { tracker });
        expect(assessFinal('gracias', { tracker }).suspect).toBe(false);
    });

    it('uses confidence only when the provider reports a real one', () => {
        expect(assessFinal('we have 1500 guards', { confidence: 0.2, confidenceIsReal: true }).reason).toBe('low_confidence');
        expect(assessFinal('we have 1500 guards', { confidence: 0.2, confidenceIsReal: false }).suspect).toBe(false);
    });
});


describe('translation context', () => {
    it('sends the bare line without context (unchanged behaviour)', () => {
        expect(buildTranslateMessage('नमस्ते')).toBe('नमस्ते');
    });

    it('wraps the line with at most three previous lines', () => {
        const msg = buildTranslateMessage('ग्यारह बजे', ['a', 'b', 'c', 'd']);
        expect(msg).toContain('Line to translate:\nग्यारह बजे');
        expect(msg).toContain('- b\n- c\n- d');
        expect(msg).not.toContain('- a');
    });
});

describe('Hindi + English recognition language', () => {
    it('pins the call languages and multi-language hints', () => {
        const opt = RECOGNITION_LANGUAGES['hindi-english'];
        expect(opt.callLanguages).toEqual(['hi', 'en']);
        expect(opt.hints).toEqual(['hi', 'en']);
        expect(opt.deepgram).toBe('multi');
        expect(opt.alternates).toEqual(['en-IN']);
    });
});
