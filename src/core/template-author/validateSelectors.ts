import type { Page } from "playwright";
import { MIN_PAIRS, type FieldType } from "../llm-extractor/types";
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
    /** For a pairs field: the label of one row that the selector must read. */
    expectedSample?: string | null;
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
            const failure = result.selectorUsed === null
                ? describeFailure(attempt?.rawValue ?? null, input.type, attempt?.warnings ?? [], attempt?.pairCount)
                : input.type === "pairs"
                    ? missingLabel(result.normalizedValue as Record<string, string>, input.expectedSample ?? null)
                    : null;

            results.push({
                selector,
                passed: failure === null,
                rawValue: attempt?.rawValue ?? null,
                normalizedValue: result.normalizedValue,
                reason: failure ?? "ok",
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

function missingLabel(pairs: Record<string, string>, expectedLabel: string | null): string | null {
    const count = Object.keys(pairs).length;
    if (!expectedLabel?.trim()) {
        return `read ${count} pairs, but expectedSample is empty. Give the label of one row on this page`;
    }
    const comparable = (label: string) => label.replace(/\s+/g, " ").trim().replace(/\s*:$/, "").toLowerCase();
    return Object.keys(pairs).some(label => comparable(label) === comparable(expectedLabel))
        ? null
        : `read ${count} pairs, but no row has the label ${JSON.stringify(expectedLabel)}. Point at the element that holds that row and the rows around it`;
}

function describeFailure(rawValue: string | null, type: FieldType, warnings: string[], pairCount: number | undefined): string {
    if (pairCount !== undefined) {
        const noMatch = warnings.find(warning => warning.startsWith("Selector matched no elements"));
        return `read ${pairCount} pairs; a pairs field needs ${MIN_PAIRS} or more${noMatch ? ` (${noMatch})` : ""}. Point at the element that holds all the rows, not one row`;
    }
    if (rawValue === null) {
        const readerWarning = warnings.find(warning => !warning.startsWith("Selector did not produce"));
        return readerWarning ? `no value: ${readerWarning}` : "no value found";
    }
    return `value is not a valid ${type}`;
}
