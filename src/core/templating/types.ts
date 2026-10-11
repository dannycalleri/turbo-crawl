import type { FieldType } from "../llm-extractor/types";

export type SelectorKind =
    | "jsonld"
    | "meta"
    | "css"
    | "xpath"
    | "table";

export type SelectorCandidate = {
    kind: SelectorKind;
    selector: string;
    attribute: "textContent" | "href" | "src" | "content" | "json";
    score: number;
    reusable: boolean;
};

export type FieldTemplate = {
    fieldName: string;
    type: FieldType;

    sourceNodeId: string | null;

    rawValue: string | null;
    normalizedValue: unknown;

    selectors: SelectorCandidate[];

    validation: {
        expectedType: FieldType;
        valueShape: "empty" | "text" | "longText" | "number" | "currency" | "boolean" | "date" | "url";
    };
};

export type ExtractionTemplate = {
    id: string;
    domain: string;
    urlPattern: string;
    schema: Record<string, FieldType>;

    createdFromUrl: string;
    createdAt: string;

    fields: Record<string, FieldTemplate>;
};
