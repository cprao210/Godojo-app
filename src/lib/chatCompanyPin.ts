// src/lib/chatCompanyPin.ts
//
// Pure helpers for pinning a customer company to a global chat session (the chip above the input
// and "@" mentions in it). React-free so they are unit tested under the node vitest setup.

import type { ChatCompanyPin, ChatHistoryTurn } from "@/types";

/** Longest "@…" text treated as a company search (company names are short). */
export const MENTION_MAX_CHARS = 40;

export interface Mention {
    /** Index of the "@" in the input. */
    start: number;
    /** What the user typed after the "@" (may be empty right after typing "@"). */
    query: string;
}

/**
 * The "@company" the user is typing at the END of the input, or null.
 * "@" must start the input or follow whitespace (so emails like a@b.com never trigger), and the
 * text after it runs to the end without a newline or another "@".
 */
export function findMention(text: string): Mention | null {
    if (!text) return null;
    const at = text.lastIndexOf("@");
    if (at < 0) return null;
    if (at > 0 && !/\s/.test(text[at - 1])) return null;
    const query = text.slice(at + 1);
    if (query.length > MENTION_MAX_CHARS || /[\n@]/.test(query)) return null;
    // "@ " (a space straight after the @) is not a mention.
    if (/^\s/.test(query)) return null;
    return { start: at, query: query.trimEnd() };
}

/** The input with the "@company" mention removed once a company is picked. */
export function removeMention(text: string, mention: Mention): string {
    const before = text.slice(0, mention.start);
    return before.trim() ? before.replace(/\s*$/, " ") : "";
}

/**
 * The pin to restore when a session is reopened: the LATEST assistant turn's pin. A later turn
 * without one means the user removed it, so it stays removed.
 */
export function pinFromHistory(turns: ChatHistoryTurn[]): ChatCompanyPin | null {
    for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (t.role !== "assistant") continue;
        const pin = t.company_pin;
        return pin && typeof pin.id === "string" && pin.id ? { id: pin.id, name: pin.name || "" } : null;
    }
    return null;
}
