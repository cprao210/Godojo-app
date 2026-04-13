// ==========================================
// OBJECTION HANDLER LLM
// ==========================================
/**
 * Dedicated LLM class for the Objection Handler mode.
 * Detects prospect pushback from live transcript and returns
 * counter-arguments and reframes the sales rep can use immediately.
 */

import { LLMHelper } from "../LLMHelper";
import { OBJECTION_HANDLER_PROMPT } from "./prompts";

export class ObjectionHandlerLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    async generate(transcript: string): Promise<string> {
        const stream = this.generateStream(transcript);
        let full = "";
        for await (const chunk of stream) full += chunk;
        return full;
    }

    async *generateStream(transcript: string): AsyncGenerator<string> {
        try {
            const fullMessage = `LIVE SALES CONVERSATION:\n${transcript}`;

            yield* this.llmHelper.streamChat(
                fullMessage,
                undefined,
                undefined,
                OBJECTION_HANDLER_PROMPT
            );

        } catch (error) {
            console.error("[ObjectionHandlerLLM] Stream failed:", error);
            yield "Could not analyze objection right now. Please try again.";
        }
    }
}