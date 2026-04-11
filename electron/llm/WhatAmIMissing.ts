import { LLMHelper } from "../LLMHelper";
import { WHAT_AM_I_MISSING_PROMPT } from "./prompts";

export class WhatAmIMissingLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    // Non-streaming fallback
    async generate(transcript: string): Promise<string> {
        const stream = this.generateStream(transcript);
        let full = "";
        for await (const chunk of stream) full += chunk;
        return full;
    }

    async *generateStream(
        transcript: string
    ): AsyncGenerator<string> {
        try {
            const fullMessage = `CONVERSATION TRANSCRIPT:\n${transcript}`;

            yield* this.llmHelper.streamChat(
                fullMessage,
                undefined,        // no images needed
                undefined,        // no extra context
                WHAT_AM_I_MISSING_PROMPT  // your prompt as system prompt
            );

        } catch (error) {
            console.error("[WhatAmIMissingLLM] Stream failed:", error);
            yield "Could not analyze gaps right now. Please try again.";
        }
    }
}