import type { Page } from "playwright";
import type { ExtractionTemplate } from "../templating/types";
import type { PagePacket } from "../types";
import type {
    FieldExtractionResult,
    TemplateExtractionResult,
} from "./types";
import { extractFieldWithTemplate } from "./extractFieldWithTemplate";

export async function extractWithTemplate(input: {
    page: Page;
    pagePacket: PagePacket;
    template: ExtractionTemplate;
}): Promise<TemplateExtractionResult> {
    const fieldResults: Record<string, FieldExtractionResult> = {};
    const payload: Record<string, unknown> = {};
    const warnings: string[] = [];
    const fields = Object.values(input.template.fields);

    for (const field of fields) {
        const fieldResult = await extractFieldWithTemplate({
            page: input.page,
            pagePacket: input.pagePacket,
            field,
        });

        fieldResults[field.fieldName] = fieldResult;
        payload[field.fieldName] = fieldResult.normalizedValue;

        for (const warning of fieldResult.warnings) {
            warnings.push(`${field.fieldName}: ${warning}`);
        }
    }

    if (fields.length === 0) {
        warnings.push(`Template has no fields: ${input.template.id}`);
    }

    return {
        payload,
        fieldResults,
        confidence: calculateConfidence(Object.values(fieldResults)),
        templateId: input.template.id,
        usedTemplate: true,
        llmUsed: false,
        warnings,
    };
}

function calculateConfidence(fieldResults: FieldExtractionResult[]): number {
    if (fieldResults.length === 0) return 0;

    const total = fieldResults.reduce(
        (sum, fieldResult) => sum + fieldResult.confidence,
        0
    );

    return total / fieldResults.length;
}
