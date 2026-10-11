import type {
    LLMProvider,
    StructuredLLMRequest,
    StructuredLLMResponse,
} from "./LLMProvider";

export class LMStudioProvider implements LLMProvider {
    name = "lmstudio" as const;

    constructor(
        private readonly baseUrl = "http://localhost:1234",
        private readonly defaultTimeoutMs = 600_000,
    ) { }

    async completeStructured(
        request: StructuredLLMRequest
    ): Promise<StructuredLLMResponse> {
        const controller = new AbortController();
        const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
        const timeout = setTimeout(() => {
            controller.abort(
                new Error(`LM Studio request timed out after ${timeoutMs}ms`)
            );
        }, timeoutMs);

        let response: Response;
        let rawText: string;

        try {
            response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                },
                signal: controller.signal,
                body: JSON.stringify({
                    model: request.model,
                    messages: request.messages,
                    temperature: request.temperature ?? 0,
                    max_tokens: request.maxTokens,
                    response_format: {
                        type: "json_schema",
                        json_schema: {
                            name: "webpage_extraction_result",
                            strict: true,
                            schema: request.jsonSchema,
                        },
                    },
                }),
            });

            rawText = await response.text();
        } catch (error) {
            if (isAbortError(error) || controller.signal.aborted) {
                throw createTimeoutError(timeoutMs);
            }

            throw error;
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) {
            if (isContextLengthError(rawText)) {
                throw new Error(formatContextLengthError(
                    response.status,
                    rawText,
                    request.footprint,
                    isProviderContextAccountingError(rawText),
                ));
            }

            throw new Error(
                `LM Studio request failed: ${response.status} ${rawText}`
            );
        }

        let raw: any;

        try {
            raw = JSON.parse(rawText);
        } catch {
            throw new Error(
                `LM Studio returned non-JSON HTTP response: ${rawText.slice(0, 500)}`
            );
        }

        const message = raw?.choices?.[0]?.message;
        const content = readMessageText(message?.content);
        const reasoningContent = readMessageText(message?.reasoning_content);

        if (content === null) {
            throw new Error("LM Studio response did not include choices[0].message.content");
        }

        const finalText = content.trim() || reasoningContent?.trim() || "";

        if (!finalText) {
            const finishReason = raw?.choices?.[0]?.finish_reason ?? "unknown";
            const promptTokens = raw?.usage?.prompt_tokens ?? "unknown";
            const completionTokens = raw?.usage?.completion_tokens ?? "unknown";

            throw new Error(
                `LM Studio returned empty structured output content (finish_reason=${finishReason}, prompt_tokens=${promptTokens}, completion_tokens=${completionTokens}). ` +
                `This often happens with reasoning models or LM Studio reasoning/content separation.`
            );
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(finalText);
        } catch {
            if (raw?.choices?.[0]?.finish_reason === "length") {
                const promptTokens = raw?.usage?.prompt_tokens ?? "unknown";
                const completionTokens = raw?.usage?.completion_tokens ?? "unknown";
                throw new Error(
                    `LM Studio stopped generation because the completion token limit was reached ` +
                    `(prompt_tokens=${promptTokens}, completion_tokens=${completionTokens}). ` +
                    `The partial response was not valid JSON.`
                );
            }

            throw new Error(
                `LM Studio returned non-JSON content: ${finalText.slice(0, 500)}`
            );
        }

        return {
            parsed,
            raw,
        };
    }
}

function readMessageText(value: unknown): string | null {
    if (typeof value === "string") {
        return value;
    }

    if (Array.isArray(value)) {
        const text = value
            .map(item => {
                if (typeof item === "string") return item;
                if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
                    return item.text;
                }
                return "";
            })
            .join("");

        return text;
    }

    return null;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function createTimeoutError(timeoutMs: number): Error {
    return new Error(`LM Studio request timed out after ${timeoutMs}ms`);
}

function isContextLengthError(rawText: string): boolean {
    const normalized = rawText.toLowerCase();
    return (
        normalized.includes("context length") ||
        normalized.includes("context_length") ||
        normalized.includes("maximum context") ||
        normalized.includes("max context") ||
        normalized.includes("bigger context") ||
        normalized.includes("too many tokens") ||
        normalized.includes("exceeds context") ||
        normalized.includes("request too large") ||
        normalized.includes("tokens to keep from the initial prompt") ||
        normalized.includes("initial prompt is greater than the context")
    );
}

function isProviderContextAccountingError(rawText: string): boolean {
    const normalized = rawText.toLowerCase();
    return (
        normalized.includes("tokens to keep from the initial prompt") ||
        normalized.includes("initial prompt is greater than the context") ||
        normalized.includes("initial prompt")
    );
}

function formatContextLengthError(
    status: number,
    rawText: string,
    footprint: import("../requestDiagnostics").RequestFootprintDiagnostics | undefined,
    isProviderAccountingError: boolean,
): string {
    const excerpt = formatProviderExcerpt(rawText);
    const diagnostics = footprint
        ? ` Request footprint: totalRequestBytes=${footprint.totalRequestBytes}, ` +
        `userPromptBytes=${footprint.userPromptBytes}, responseSchemaBytes=${footprint.responseSchemaBytes}, ` +
        `compactPacketBytes=${footprint.compactPacketBytes}. Dominant components: ` +
        footprint.dominantComponents
            .slice(0, 4)
            .map(component => `${component.name}=${component.bytes}`)
            .join(", ") +
        "."
        : "";
    const contextAccountingNote = isProviderAccountingError
        ? " LM Studio reported a provider context accounting limit even though app-side byte diagnostics may be small."
        : "";

    return (
        `LLM extraction request is too large for the configured model context ` +
        `(LM Studio ${status}). Reduce the compact packet/request size or raise the model context budget.` +
        contextAccountingNote +
        diagnostics +
        ` Provider response: ${excerpt}`
    );
}

function formatProviderExcerpt(rawText: string): string {
    return rawText.replace(/\s+/g, " ").trim().slice(0, 500);
}
