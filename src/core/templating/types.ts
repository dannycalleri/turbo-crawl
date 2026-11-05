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
    attribute: "textContent" | "href" | "src" | "content" | "json" | `attr:${string}`;
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
    /** The URL patterns where the template fitted, the authoring page's first. */
    urlPatterns: string[];
    schema: Record<string, FieldType>;

    createdFromUrl: string;
    createdAt: string;

    fields: Record<string, FieldTemplate>;
};

export type ListingTemplate = {
    id: string;
    kind: "listing";
    domain: string;
    urlPatterns: string[];
    itemLinks: string[];
    nextPage: string[];
    pageLinks: string[];
    itemUrlPattern: string;
    createdFromUrl: string;
    createdAt: string;
};
