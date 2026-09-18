// Covers the three-tier API-key resolution chain in CredentialsManager:
//   the user's own saved key  ->  the backend fallback key  ->  the bundled .env key
//
// These are the invariants the fallback-key work is built on, and the ones that
// silently regressed before: a default overwriting a user key, an unreadable
// store getting clobbered with an empty one, and an account switch leaking keys.
// Electron is mocked; safeStorage encryption is deliberately reported as
// UNavailable so the plaintext path is exercised without a Keychain/DPAPI.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Module from 'module';

// Mutable state the mocked electron surface reads. vi.hoisted lifts it above the
// imports, so it exists both when the vi.mock factory closes over it and when
// CredentialsManager's module body calls app.getPath() at import time.
const state = vi.hoisted(() => ({
    userDataDir: '',
    encryptionAvailable: false,
    /** Simulates the macOS Keychain-ACL failure: encryption "works", decryption doesn't. */
    decryptThrows: false,
}));

vi.mock('electron', () => ({
    app: {
        getPath: (_name: string) => state.userDataDir,
        getVersion: () => '0.0.0-test',
        get isPackaged() { return false; },
    },
    safeStorage: {
        isEncryptionAvailable: () => state.encryptionAvailable,
        encryptString: (s: string) => Buffer.from(s, 'utf8'),
        decryptString: (b: Buffer) => {
            if (state.decryptThrows) throw new Error('Decryption failed');
            return b.toString('utf8');
        },
    },
}));

// CredentialsManager reaches for PostHog with a bare `require` so the circular
// import (PostHogMainService -> AuthManager -> CredentialsManager) resolves
// lazily. Vitest's transform turns that into a real CJS require, which cannot
// resolve an extensionless .ts sibling — so intercept the CJS loader itself and
// capture the events. vi.mock cannot help here: a real require bypasses it.
const captured: Array<{ event: string; props: Record<string, any> }> = [];
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request.endsWith('PostHogMainService')) {
        return { posthogMain: { capture: (event: string, props: Record<string, any> = {}) => { captured.push({ event, props }); } } };
    }
    return originalLoad.call(this, request, parent, isMain);
};

// Imported statically: vi.mock is hoisted above all imports, and the six
// `require('./PostHogMainService')` sites are inside methods, so the loader
// patch above is in place well before any of them runs.
import { CredentialsManager } from '../services/CredentialsManager';
/** The constructor is private, so derive the instance type from the factory. */
type CM = ReturnType<typeof CredentialsManager.getInstance>;

/** A fresh singleton over a fresh temp userData dir, with all env keys cleared. */
function freshManager(): CM {
    state.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-test-'));
    // The singleton caches the instance; drop it so each test gets a clean load.
    (CredentialsManager as any).instance = undefined;
    const cm = CredentialsManager.getInstance();
    cm.init();
    return cm;
}

const ENV_KEYS = [
    'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_API_KEY',
    'DEEPGRAM_API_KEY', 'TAVILY_API_KEY', 'AZURE_SPEECH_KEY', 'API_ENCRYPTION_KEY',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    captured.length = 0;
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    if (state.userDataDir && fs.existsSync(state.userDataDir)) {
        fs.rmSync(state.userDataDir, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
});

/**
 * Seeds the backend fallback tier by driving the real fetch+decrypt path, so
 * the test also proves the AES-256-GCM envelope the Python backend produces is
 * read correctly (rather than poking at private fields).
 */
async function seedBackendFallback(cm: CM, keys: Record<string, string>): Promise<void> {
    const passphrase = 'test-passphrase';
    process.env.API_ENCRYPTION_KEY = passphrase;
    const keyHash = crypto.createHash('sha256').update(passphrase).digest();

    const payload = Object.entries(keys).map(([provider, value]) => {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', keyHash, iv);
        const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        // The backend appends the 16-byte auth tag, matching WebCrypto's output.
        const data = Buffer.concat([body, cipher.getAuthTag()]);
        return { provider, encrypted_key: JSON.stringify({ iv: iv.toString('base64'), data: data.toString('base64') }) };
    });

    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ keys: payload }),
    })));

    await cm.fetchFallbackKeys('fake-id-token');
}

describe('key resolution order', () => {
    it('reports no key and no source when every tier is empty', () => {
        const cm = freshManager();
        expect(cm.getGeminiApiKey()).toBeUndefined();
        expect(cm.getKeySource('gemini')).toBe('none');
        expect(cm.hasUserKey('gemini')).toBe(false);
    });

    it('falls back to the bundled .env key when the user has none', () => {
        process.env.GEMINI_API_KEY = 'env-gemini';
        const cm = freshManager();
        expect(cm.getGeminiApiKey()).toBe('env-gemini');
        expect(cm.getKeySource('gemini')).toBe('env_bundled');
        expect(cm.hasUserKey('gemini')).toBe(false);
    });

    it('prefers the backend fallback over the bundled .env key', async () => {
        process.env.GEMINI_API_KEY = 'env-gemini';
        const cm = freshManager();
        await seedBackendFallback(cm, { gemini: 'backend-gemini' });
        expect(cm.getGeminiApiKey()).toBe('backend-gemini');
        expect(cm.getKeySource('gemini')).toBe('backend_fallback');
    });

    it("prefers the user's own key over both defaults", async () => {
        process.env.GEMINI_API_KEY = 'env-gemini';
        const cm = freshManager();
        await seedBackendFallback(cm, { gemini: 'backend-gemini' });
        cm.setGeminiApiKey('user-gemini');
        expect(cm.getGeminiApiKey()).toBe('user-gemini');
        expect(cm.getKeySource('gemini')).toBe('user');
        expect(cm.hasUserKey('gemini')).toBe(true);
    });

    it('never lets a default overwrite the stored user key', async () => {
        const cm = freshManager();
        cm.setGeminiApiKey('user-gemini');
        await seedBackendFallback(cm, { gemini: 'backend-gemini' });
        expect(cm.getGeminiApiKey()).toBe('user-gemini');
        expect(cm.getAllCredentials().geminiApiKey).toBe('user-gemini');
    });

    it('reveals the default again once the user removes their key', async () => {
        const cm = freshManager();
        await seedBackendFallback(cm, { gemini: 'backend-gemini' });
        cm.setGeminiApiKey('user-gemini');
        expect(cm.getKeySource('gemini')).toBe('user');
        cm.setGeminiApiKey('');
        expect(cm.getGeminiApiKey()).toBe('backend-gemini');
        expect(cm.getKeySource('gemini')).toBe('backend_fallback');
    });

    it('applies the same chain to deepgram, tavily and groq', async () => {
        process.env.DEEPGRAM_API_KEY = 'env-deepgram';
        process.env.TAVILY_API_KEY = 'env-tavily';
        const cm = freshManager();
        expect(cm.getKeySource('deepgram')).toBe('env_bundled');
        expect(cm.getKeySource('tavily')).toBe('env_bundled');
        expect(cm.getKeySource('groq')).toBe('none');

        await seedBackendFallback(cm, { deepgram: 'backend-dg', tavily: 'backend-tv', groq: 'backend-groq' });
        expect(cm.getDeepgramApiKey()).toBe('backend-dg');
        expect(cm.getTavilyApiKey()).toBe('backend-tv');
        expect(cm.getGroqApiKey()).toBe('backend-groq');

        cm.setDeepgramApiKey('user-dg');
        cm.setTavilyApiKey('user-tv');
        cm.setGroqApiKey('user-groq');
        expect(cm.getKeySources()).toMatchObject({ deepgram: 'user', tavily: 'user', groq: 'user' });
    });

    it('keeps the STT groq/openai slots separate from the LLM ones', () => {
        const cm = freshManager();
        cm.setGroqApiKey('llm-groq');
        cm.setGroqSttApiKey('stt-groq');
        expect(cm.getGroqApiKey()).toBe('llm-groq');
        expect(cm.getGroqSttApiKey()).toBe('stt-groq');
    });
});

describe('key normalization', () => {
    it('trims surrounding whitespace and newlines on save', () => {
        const cm = freshManager();
        cm.setGeminiApiKey('  user-gemini\n');
        expect(cm.getGeminiApiKey()).toBe('user-gemini');
        expect(cm.getAllCredentials().geminiApiKey).toBe('user-gemini');
    });

    it('treats a whitespace-only key as removal, not as a stored key', () => {
        const cm = freshManager();
        cm.setGeminiApiKey('   ');
        expect(cm.hasUserKey('gemini')).toBe(false);
        expect(cm.getKeySource('gemini')).toBe('none');
    });

    it('ignores a whitespace-only bundled .env value', () => {
        process.env.GEMINI_API_KEY = '   ';
        const cm = freshManager();
        expect(cm.getKeySource('gemini')).toBe('none');
    });
});

describe('store health guards', () => {
    it('reports a healthy store after a normal load', () => {
        const cm = freshManager();
        expect(cm.getStoreHealth().loadState).toBe('ok');
    });

    it('refuses to overwrite a store it could not decrypt', () => {
        const cm = freshManager();
        cm.setGeminiApiKey('user-gemini');

        // Simulate the macOS failure: the file is encrypted but this launch
        // cannot decrypt it (Keychain ACL invalidated by a new code signature).
        const encPath = path.join(state.userDataDir, 'credentials-anon.enc');
        fs.writeFileSync(encPath, Buffer.from('not-really-encrypted'));
        const before = fs.readFileSync(encPath);

        state.encryptionAvailable = true;
        state.decryptThrows = true;
        try {
            (CredentialsManager as any).instance = undefined;
            const reopened = CredentialsManager.getInstance();
            reopened.init();

            expect(reopened.getStoreHealth().loadState).toBe('failed');
            // An empty in-memory map must not be flushed over the real file.
            // sttProvider is a setting, not a key, so the map stays "effectively
            // empty" and the guard should refuse the write.
            reopened.setSttProvider('deepgram');
            expect(fs.readFileSync(encPath).equals(before)).toBe(true);
            expect(captured.some(c => c.event === 'credentials_store_write_blocked')).toBe(true);
        } finally {
            state.encryptionAvailable = false;
            state.decryptThrows = false;
        }
        expect(cm).toBeDefined();
    });

    it('backs the unreadable file up rather than deleting it when the user re-enters a key', () => {
        freshManager();
        const encPath = path.join(state.userDataDir, 'credentials-anon.enc');
        fs.writeFileSync(encPath, Buffer.from('not-really-encrypted'));

        state.encryptionAvailable = true;
        state.decryptThrows = true;
        try {
            (CredentialsManager as any).instance = undefined;
            const reopened = CredentialsManager.getInstance();
            reopened.init();
            expect(reopened.getStoreHealth().loadState).toBe('failed');

            // A real user key is authoritative, so the write goes through — and
            // the unreadable original is preserved under a .unreadable-<ts> name.
            state.decryptThrows = false;
            reopened.setGeminiApiKey('recovered-key');
            expect(reopened.getGeminiApiKey()).toBe('recovered-key');
            const backups = fs.readdirSync(state.userDataDir).filter(f => f.includes('.unreadable-'));
            expect(backups.length).toBe(1);
        } finally {
            state.encryptionAvailable = false;
            state.decryptThrows = false;
        }
    });
});

describe('account isolation', () => {
    it('does not carry one account\'s key into another', () => {
        const cm = freshManager();
        cm.switchUser('userA');
        cm.setGeminiApiKey('key-A');

        cm.switchUser('userB');
        expect(cm.hasUserKey('gemini')).toBe(false);
        expect(cm.getGeminiApiKey()).toBeUndefined();
        cm.setGeminiApiKey('key-B');

        cm.switchUser('userA');
        expect(cm.getGeminiApiKey()).toBe('key-A');
        cm.switchUser('userB');
        expect(cm.getGeminiApiKey()).toBe('key-B');
    });

    it('drops the backend fallback tier on switch, since it is fetched per user', async () => {
        const cm = freshManager();
        cm.switchUser('userA');
        await seedBackendFallback(cm, { gemini: 'backend-for-A' });
        expect(cm.getKeySource('gemini')).toBe('backend_fallback');

        cm.switchUser('userB');
        expect(cm.getGeminiApiKey()).toBeUndefined();
        expect(cm.getKeySource('gemini')).toBe('none');
    });

    it('reports — but never migrates — keys left in the anonymous store', () => {
        const cm = freshManager();
        cm.setGeminiApiKey('typed-before-sign-in');
        cm.switchUser('userA');
        expect(cm.hasUserKey('gemini')).toBe(false);
        const orphaned = captured.find(c => c.event === 'credentials_anon_keys_orphaned');
        expect(orphaned?.props.providers).toContain('gemini');
    });
});

describe('source telemetry', () => {
    it('emits api_key_resolved once per provider+source and again when the tier flips', () => {
        process.env.GEMINI_API_KEY = 'env-gemini';
        const cm = freshManager();
        cm.getGeminiApiKey();
        cm.getGeminiApiKey();
        cm.getGeminiApiKey();
        const resolved = captured.filter(c => c.event === 'api_key_resolved' && c.props.provider === 'gemini');
        expect(resolved.length).toBe(1);
        expect(resolved[0].props.source).toBe('env_bundled');

        cm.setGeminiApiKey('user-gemini');
        cm.getGeminiApiKey();
        const flip = captured.find(c => c.event === 'api_key_source_changed' && c.props.provider === 'gemini');
        expect(flip?.props).toMatchObject({ fromSource: 'env_bundled', toSource: 'user', reason: 'user_save' });
    });

    it('records the add/replace/remove action and whether a default took over', () => {
        process.env.GEMINI_API_KEY = 'env-gemini';
        const cm = freshManager();

        cm.setGeminiApiKey('first');
        cm.setGeminiApiKey('second');
        cm.setGeminiApiKey('');

        const saves = captured.filter(c => c.event === 'api_key_saved' && c.props.provider === 'gemini');
        expect(saves.map(s => s.props.action)).toEqual(['added', 'replaced', 'removed']);
        expect(saves[0].props).toMatchObject({ sourceBefore: 'env_bundled', sourceAfter: 'user', keyLength: 5 });
        expect(saves[2].props).toMatchObject({ sourceAfter: 'env_bundled', fellBackToDefault: true });
    });

    it('never puts a key value or prefix in a telemetry property', () => {
        const cm = freshManager();
        cm.setGeminiApiKey('super-secret-key-value');
        cm.getGeminiApiKey();
        const serialized = JSON.stringify(captured);
        expect(serialized).not.toContain('super-secret');
        expect(serialized).not.toContain('super');
    });

    it('reports the tier of every provider in one snapshot', async () => {
        process.env.TAVILY_API_KEY = 'env-tavily';
        const cm = freshManager();
        await seedBackendFallback(cm, { deepgram: 'backend-dg' });
        cm.setGeminiApiKey('user-gemini');
        captured.length = 0;

        cm.trackKeySourceSnapshot('unit-test');
        const snapshot = captured.find(c => c.event === 'api_keys_snapshot');
        expect(snapshot?.props).toMatchObject({
            trigger: 'unit-test',
            geminiSource: 'user',
            deepgramSource: 'backend_fallback',
            tavilySource: 'env_bundled',
            groqSource: 'none',
        });
    });
});
