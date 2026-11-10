import type { Page } from "playwright";
import {
    extractNumberTokens,
    normalizeValue,
} from "../llm-extractor/validation/normalizeValue";
import type { FieldTemplate, SelectorCandidate } from "../templating/types";
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

    const tryCandidate = async (selector: SelectorCandidate): Promise<CandidateExtraction> => {
        const readResult = await readSelectorValue({
            page: input.page,
            pagePacket: input.pagePacket,
            selector,
            fieldType: input.field.type,
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
        return {
            selector,
            rawValue: readResult.rawValue,
            normalizedValue,
            valid,
            confidence: selector.score,
            warnings: valid
                ? readResult.warnings
                : [...readResult.warnings, `Selector did not produce a valid ${input.field.type} value.`],
        };
    };

    const laterCssReads = async (later: SelectorCandidate[]): Promise<boolean> => {
        for (const selector of later) {
            if (selector.kind === "css" && (await tryCandidate(selector)).valid) return true;
        }
        return false;
    };

    for (const [index, selector] of input.field.selectors.entries()) {
        const candidate = await tryCandidate(selector);
        candidatesTried.push(candidate);

        if (candidate.valid) {
            const bodyMatched = selector.kind === "css" || await laterCssReads(input.field.selectors.slice(index + 1));
            return {
                fieldName: input.field.fieldName,
                type: input.field.type,
                rawValue: candidate.rawValue,
                normalizedValue: candidate.normalizedValue,
                selectorUsed: selector,
                bodyMatched,
                confidence: candidate.confidence,
                warnings: candidate.warnings,
                candidatesTried,
            };
        }

        warnings.push(...candidate.warnings);
    }

    const uniqueWarnings = dedupeWarnings(warnings);

    return {
        fieldName: input.field.fieldName,
        type: input.field.type,
        rawValue: null,
        normalizedValue: null,
        selectorUsed: null,
        bodyMatched: false,
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
