// Encrypts a proof-of-possession of VITE_DANGEROUS_KEY for the backend's
// key-gated "dangerous" endpoints (currently just POST
// /api/v1/auth/dangerous/delete-user). The raw key is never sent over the
// wire — we AES-256-GCM encrypt a small freshness-stamped payload with a
// key derived from the shared secret. The backend derives the same AES key
// from its OWN DANGEROUS_KEY env var; the GCM auth tag only verifies if
// both sides used the same key, so a successful decrypt on the backend
// *is* the proof of possession — see app/core/dangerous_key.py for the
// matching server-side half of this.
//
// IMPORTANT: this is a shared secret bundled into every install of this
// app, not per-user auth. Anyone who extracts VITE_DANGEROUS_KEY from the
// app bundle can call the dangerous endpoints for ANY uid. Only ever wire
// this up to dev-only UI (see the `import.meta.env.DEV` gate in
// GeneralTab.tsx) and never set DANGEROUS_KEY in a production backend .env.

export interface EncryptedKeyPayload {
    iv: string;   // base64
    data: string; // base64 (ciphertext || 16-byte GCM tag — WebCrypto's AES-GCM output shape)
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
}

function toBase64(buf: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/**
 * Builds a fresh encrypted proof-of-possession of VITE_DANGEROUS_KEY.
 * Call this immediately before each dangerous-endpoint request — the
 * embedded timestamp is checked against a 60s window server-side, so a
 * payload built earlier and cached/reused will be rejected.
 */
export async function encryptDangerousKey(): Promise<EncryptedKeyPayload> {
    const secret = import.meta.env.VITE_DANGEROUS_KEY as string | undefined;
    if (!secret) {
        throw new Error("VITE_DANGEROUS_KEY is not set in this build's .env — cannot call dangerous endpoints.");
    }
    const key = await deriveAesKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify({ ts: Date.now() }));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return { iv: toBase64(iv.buffer), data: toBase64(ciphertext) };
}