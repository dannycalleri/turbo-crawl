export type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

export type StructuredLLMRequest = {
    model: string;
    messages: ChatMessage[];
    jsonSchema: unknown;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    footprint?: import("../requestDiagnostics").RequestFootprintDiagnostics;
};

export type StructuredLLMResponse = {
    parsed: unknown;
    raw: unknown;
};

export interface LLMProvider {
    name: ProviderName;

    completeStructured(
        request: StructuredLLMRequest
    ): Promise<StructuredLLMResponse>;
}

export const PROVIDER_NAMES = ["claude", "codex", "lmstudio"] as const;

export type ProviderName = typeof PROVIDER_NAMES[number];
