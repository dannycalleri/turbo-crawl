import type {
    FieldReport,
    RawLLMExtraction,
    UserSchema,
} from "../types";
import type { PagePacket } from "../../types";
import type { CompactPagePacket } from "../../compactPagePacket";
import { compileLLMResponseZodSchema } from "../schemaCompiler";
import { normalizeValue } from "./normalizeValue";
import { buildNodeIdSet, verifyFieldEvidence } from "./fieldEvidenceVerifier";

export function validateExtraction(input: {
    rawExtraction: unknown;
    userSchema: UserSchema;
    pagePacket: PagePacket | CompactPagePacket;
}) {
    const { rawExtraction, userSchema, pagePacket } = input;

    const responseSchema = compileLLMResponseZodSchema(userSchema);

    const parsed = responseSchema.safeParse(rawExtraction);

    if (!parsed.success) {
        return {
            success: false as const,
            error: parsed.error,
        };
    }

    const extraction = parsed.data as RawLLMExtraction;
    const validNodeIds = buildNodeIdSet(pagePacket);

    const normalizedPayload: Record<string, unknown> = {};
    const fieldReports: Record<string, FieldReport> = {};

    for (const [fieldName, fieldType] of Object.entries(userSchema)) {
        const rawValue = extraction.payload[fieldName];
        const evidence = extraction.evidence[fieldName] ?? null;

        const normalizedValue = normalizeValue({
            value: rawValue,
            type: fieldType,
            baseUrl: pagePacket.finalUrl || pagePacket.url,
        });

        const evidenceCheck = verifyFieldEvidence({
            evidence,
            validNodeIds,
        });

        const warnings = [...evidenceCheck.warnings];

        if (rawValue !== null && normalizedValue === null) {
            warnings.push("Value could not be normalized.");
        }

        const isValid =
            rawValue === null ||
            normalizedValue !== null;

        normalizedPayload[fieldName] = normalizedValue;

        fieldReports[fieldName] = {
            fieldName,
            type: fieldType,
            rawValue,
            normalizedValue,
            evidence,
            sourceNodeExists: evidenceCheck.sourceNodeExists,
            isValid,
            warnings,
        };
    }

    return {
        success: true as const,
        payload: normalizedPayload,
        evidence: extraction.evidence,
        fieldReports,
    };
}
