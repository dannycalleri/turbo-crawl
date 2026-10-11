import type { PagePacket } from "../types";
import type { FieldType } from "../llm-extractor/types";
import type { LLMExtractionResult } from "../llm-extractor/types";
import type { ExtractionTemplate, FieldTemplate } from "./types";
import { findSourceNode, generateSelectorCandidates } from "./generateSelectorCandidates";
import { inferValueShape } from "./inferValueShape";
import { inferUrlPattern } from "./inferUrlPattern";
import { normalizeDomain } from "../domain-store";
import { createTemplateId } from "./templateId";

export function generateExtractionTemplate(input: {
    schema: Record<string, FieldType>;
    pagePacket: PagePacket;
    extraction: LLMExtractionResult;
}): ExtractionTemplate {
    const finalUrl = input.pagePacket.finalUrl || input.pagePacket.url;
    const domain = normalizeDomain(finalUrl);

    const fields: Record<string, FieldTemplate> = {};

    for (const [fieldName, fieldType] of Object.entries(input.schema)) {
        const normalizedValue = input.extraction.payload[fieldName] ?? null;
        const evidence = input.extraction.evidence[fieldName];

        const rawValue =
            evidence?.quotedText ??
            (normalizedValue == null ? null : String(normalizedValue));

        const sourceNode = findSourceNode(
            input.pagePacket,
            evidence?.sourceNodeId ?? null
        );

        const selectors = generateSelectorCandidates({
            pagePacket: input.pagePacket,
            sourceNode,
            fieldName,
            fieldType,
            rawValue,
        });

        fields[fieldName] = {
            fieldName,
            type: fieldType,

            sourceNodeId: evidence?.sourceNodeId ?? null,

            rawValue,
            normalizedValue,

            selectors,

            validation: {
                expectedType: fieldType,
                valueShape: inferValueShape({
                    fieldType,
                    rawValue,
                    normalizedValue,
                }),
            },
        };
    }

    return {
        id: createTemplateId(domain, inferUrlPattern(finalUrl), input.schema),
        domain,
        urlPattern: inferUrlPattern(finalUrl),
        schema: input.schema,

        createdFromUrl: finalUrl,
        createdAt: new Date().toISOString(),

        fields,
    };
}
