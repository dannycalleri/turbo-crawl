import type { Page } from "playwright";
import {
    extractNumberTokens,
    normalizeValue,
} from "../llm-extractor/validation/normalizeValue";
import type { FieldTemplate } from "../templating/types";
import type { PagePacket } from "../types";
import type {
    CandidateExtraction,
    FieldExtractionResult,
} from "./types";
import { readSelectorValue } from "./selectorValueReader";

export async function extractFieldWithTemplate(input: {
    page: Page;
    pagePacket: PagePacket;
    field: FieldTemplate;
}): Promise<FieldExtractionResult> {
    const candidatesTried: CandidateExtraction[] = [];
    const warnings: string[] = [];
    const baseUrl = input.pagePacket.finalUrl || input.pagePacket.url;

    for (const selector of input.field.selectors) {
        const readResult = await readSelectorValue({
            page: input.page,
            pagePacket: input.pagePacket,
            selector,
        });

        const valueForNormalization = selectLearnedNumberValue({
            field: input.field,
            rawValue: readResult.rawValue,
            baseUrl,
        });

        const normalizedValue = normalizeValue({
            value: valueForNormalization,
            type: input.field.type,
            baseUrl,
        });
        const valid = normalizedValue !== null;
        const candidateWarnings = valid
            ? readResult.warnings
            : [
                ...readResult.warnings,
                `Selector did not produce a valid ${input.field.type} value.`,
            ];

        const candidate: CandidateExtraction = {
            selector,
            rawValue: readResult.rawValue,
            normalizedValue,
            valid,
            confidence: selector.score,
            warnings: candidateWarnings,
        };

        candidatesTried.push(candidate);

        if (valid) {
            return {
                fieldName: input.field.fieldName,
                type: input.field.type,
                rawValue: candidate.rawValue,
                normalizedValue: candidate.normalizedValue,
                selectorUsed: selector,
                confidence: candidate.confidence,
                warnings: candidate.warnings,
                candidatesTried,
            };
        }

        warnings.push(...candidateWarnings);
    }

    const uniqueWarnings = dedupeWarnings(warnings);

    return {
        fieldName: input.field.fieldName,
        type: input.field.type,
        rawValue: null,
        normalizedValue: null,
        selectorUsed: null,
        confidence: 0,
        warnings:
            uniqueWarnings.length > 0
                ? uniqueWarnings
                : [`No selectors available for field: ${input.field.fieldName}`],
        candidatesTried,
    };
}

function selectLearnedNumberValue(input: {
    field: FieldTemplate;
    rawValue: string | null;
    baseUrl: string;
}): string | null {
    if (
        input.field.type !== "number" ||
        input.rawValue === null ||
        input.field.rawValue === null ||
        input.field.normalizedValue === null
    ) {
        return input.rawValue;
    }

    const learnedIndex = findLearnedNumberIndex({
        rawValue: input.field.rawValue,
        normalizedValue: input.field.normalizedValue,
        baseUrl: input.baseUrl,
    });

    if (learnedIndex === null) {
        return input.rawValue;
    }

    return extractNumberTokens(input.rawValue)[learnedIndex] ?? input.rawValue;
}

function findLearnedNumberIndex(input: {
    rawValue: string;
    normalizedValue: unknown;
    baseUrl: string;
}): number | null {
    const learnedValue = normalizeValue({
        value: input.normalizedValue,
        type: "number",
        baseUrl: input.baseUrl,
    });

    if (typeof learnedValue !== "number") {
        return null;
    }

    const matchingIndexes = extractNumberTokens(input.rawValue)
        .map((token, index) => {
            const tokenValue = normalizeValue({
                value: token,
                type: "number",
                baseUrl: input.baseUrl,
            });

            return tokenValue === learnedValue ? index : null;
        })
        .filter(index => index !== null);

    if (matchingIndexes.length !== 1) {
        return null;
    }

    return matchingIndexes[0] ?? null;
}

function dedupeWarnings(warnings: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const warning of warnings) {
        if (seen.has(warning)) continue;

        seen.add(warning);
        result.push(warning);
    }

    return result;
}
