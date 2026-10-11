import type { Page } from "playwright";
import type { FieldType } from "../llm-extractor/types";
import type { FieldTemplate, SelectorCandidate } from "../templating/types";
import { inferValueShape } from "../templating/inferValueShape";
import { extractFieldWithTemplate } from "../template-extractor/extractFieldWithTemplate";
import type { PagePacket } from "../types";
import type { AuthoredSelector } from "./authorPrompt";

export type SelectorValidation = {
    selector: AuthoredSelector;
    passed: boolean;
    rawValue: string | null;
    normalizedValue: unknown;
    reason: string;
};

export function toSelectorCandidate(selector: AuthoredSelector, score = 90): SelectorCandidate {
    return {
        kind: selector.kind,
        selector: selector.selector,
        attribute: selector.attribute,
        score,
        reusable: true,
    };
}

export function createFieldTemplate(input: {
    fieldName: string;
    type: FieldType;
    selectors: SelectorCandidate[];
    rawValue: string | null;
    normalizedValue: unknown;
}): FieldTemplate {
    return {
        fieldName: input.fieldName,
        type: input.type,
        sourceNodeId: null,
        rawValue: input.rawValue,
        normalizedValue: input.normalizedValue,
        selectors: input.selectors,
        validation: {
            expectedType: input.type,
            valueShape: inferValueShape({
                fieldType: input.type,
                rawValue: input.rawValue,
                normalizedValue: input.normalizedValue,
            }),
        },
    };
}

// Runs each selector on its own through the same reader template extraction uses,
// so a selector that passes here behaves identically when the template is reused.
export async function validateSelectors(input: {
    page: Page;
    pagePacket: PagePacket;
    fieldName: string;
    type: FieldType;
    selectors: AuthoredSelector[];
}): Promise<SelectorValidation[]> {
    const results: SelectorValidation[] = [];

    for (const selector of input.selectors) {
        try {
            const result = await extractFieldWithTemplate({
                page: input.page,
                pagePacket: input.pagePacket,
                field: createFieldTemplate({
                    fieldName: input.fieldName,
                    type: input.type,
                    selectors: [toSelectorCandidate(selector)],
                    rawValue: null,
                    normalizedValue: null,
                }),
            });
            const attempt = result.candidatesTried[0];
            const passed = result.selectorUsed !== null;

            results.push({
                selector,
                passed,
                rawValue: attempt?.rawValue ?? null,
                normalizedValue: result.normalizedValue,
                reason: passed
                    ? "ok"
                    : describeFailure(attempt?.rawValue ?? null, input.type, attempt?.warnings ?? []),
            });
        } catch (error) {
            results.push({
                selector,
                passed: false,
                rawValue: null,
                normalizedValue: null,
                reason: `selector could not be evaluated: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
            });
        }
    }

    return results;
}

function describeFailure(rawValue: string | null, type: FieldType, warnings: string[]): string {
    if (rawValue === null) {
        const readerWarning = warnings.find(warning => !warning.startsWith("Selector did not produce"));
        return readerWarning ? `no value: ${readerWarning}` : "no value found";
    }
    return `value is not a valid ${type}`;
}
