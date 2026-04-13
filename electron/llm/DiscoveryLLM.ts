import { LLMHelper } from "../LLMHelper";
import { DISCOVERY_PROMPT } from "./prompts";

export class DiscoveryLLM {
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
                DISCOVERY_PROMPT
            );

        } catch (error) {
            console.error("[DiscoveryLLM] Stream failed:", error);
            yield "Could not analyze conversation right now. Please try again.";
        }
    }
}