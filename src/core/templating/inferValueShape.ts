import type { FieldType } from "../llm-extractor/types";
import type { FieldTemplate } from "./types";

export function inferValueShape(input: {
    fieldType: FieldType;
    rawValue: string | null;
    normalizedValue: unknown;
}): FieldTemplate["validation"]["valueShape"] {
    const { fieldType, rawValue, normalizedValue } = input;

    if (rawValue == null || rawValue.trim() === "") return "empty";

    if (fieldType === "number") {
        if (/[€$£]|eur|usd|gbp|chf/i.test(rawValue)) return "currency";
        return "number";
    }

    if (fieldType === "boolean") return "boolean";
    if (fieldType === "date") return "date";
    if (fieldType === "url") return "url";

    const value = String(normalizedValue ?? rawValue);

    if (value.length > 300) return "longText";

    return "text";
}