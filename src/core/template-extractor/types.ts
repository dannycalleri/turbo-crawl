import type { FieldType } from "../llm-extractor/types";
import type { SelectorCandidate } from "../templating/types";

export type CandidateExtraction = {
    selector: SelectorCandidate;
    rawValue: string | null;
    normalizedValue: unknown;
    valid: boolean;
    confidence: number;
    warnings: string[];
};

export type FieldExtractionResult = {
    fieldName: string;
    type: FieldType;

    rawValue: string | null;
    normalizedValue: unknown;

    selectorUsed: SelectorCandidate | null;

    confidence: number;
    warnings: string[];

    candidatesTried: CandidateExtraction[];
};

export type TemplateExtractionResult = {
    payload: Record<string, unknown>;

    fieldResults: Record<string, FieldExtractionResult>;

    confidence: number;

    templateId: string;
    usedTemplate: true;
    llmUsed: false;

    warnings: string[];
};