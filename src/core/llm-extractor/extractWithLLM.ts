import type {
    LLMExtractionResult,
    UserSchema,
} from "./types";
import type { PagePacket } from "../types";
import type { CompactPagePacket } from "../compactPagePacket";
import type { LLMProvider } from "./providers/LLMProvider";
import { compileLLMResponseJsonSchema } from "./llmResponseSchemaCompiler";
import { buildExtractionPrompt } from "./promptBuilder";
import { measureStructuredRequestFootprint } from "./requestDiagnostics";
import { validateExtraction } from "./validation/validateExtraction";

const DEFAULT_LLM_EXTRACTION_TIMEOUT_MS = 600_000;
const MIN_LLM_COMPLETION_TOKENS = 1024;
const MAX_LLM_COMPLETION_TOKENS = 4096;
const TOKENS_PER_SCHEMA_FIELD = 256;

export async function extractWithLLM(input: {
    userSchema: UserSchema;
    pagePacket: PagePacket | CompactPagePacket;
    provider: LLMProvider;
    model: string;
}): Promise<LLMExtractionResult> {
    const responseJsonSchema = compileLLMResponseJsonSchema(input.userSchema);

    const messages = buildExtractionPrompt({
        userSchema: input.userSchema,
        pagePacket: input.pagePacket,
    });
    const footprint = measureStructuredRequestFootprint({
        model: input.model,
        messages,
        jsonSchema: responseJsonSchema,
        temperature: 0,
        maxTokens: estimateExtractionMaxTokens(input.userSchema),
        pagePacket: input.pagePacket,
        userSchema: input.userSchema,
        retainedCounts: "compaction" in input.pagePacket ? input.pagePacket.compaction.retainedCounts : undefined,
        omittedCounts: "compaction" in input.pagePacket ? input.pagePacket.compaction.omittedCounts : undefined,
    });

    const llmResponse = await input.provider.completeStructured({
        model: input.model,
        messages,
        jsonSchema: responseJsonSchema,
        temperature: 0,
        maxTokens: estimateExtractionMaxTokens(input.userSchema),
        timeoutMs: getLlmExtractionTimeoutMs(),
        footprint,
    });

    const validated = validateExtraction({
        rawExtraction: llmResponse.parsed,
        userSchema: input.userSchema,
        pagePacket: input.pagePacket,
    });

    if (!validated.success) {
        throw new Error(
            `LLM extraction failed validation: ${validated.error.message}`
        );
    }

    return {
        payload: validated.payload,
        evidence: validated.evidence,
        fieldReports: validated.fieldReports,

        provider: input.provider.name,
        model: input.model,
        llmUsed: true,

        rawResponse: llmResponse.raw,
        createdAt: new Date().toISOString(),
    };
}

function getLlmExtractionTimeoutMs(): number {
    const configured = Number(process.env.TURBO_CRAWL_LLM_TIMEOUT_MS);

    if (Number.isFinite(configured) && configured > 0) {
        return configured;
    }

    return DEFAULT_LLM_EXTRACTION_TIMEOUT_MS;
}

function estimateExtractionMaxTokens(userSchema: UserSchema): number {
    const fieldCount = Object.keys(userSchema).length;
    return Math.min(
        MAX_LLM_COMPLETION_TOKENS,
        Math.max(MIN_LLM_COMPLETION_TOKENS, 512 + fieldCount * TOKENS_PER_SCHEMA_FIELD),
    );
}
