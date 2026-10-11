import type { FieldType } from "../types";

export function normalizeValue(input: {
    value: unknown;
    type: FieldType;
    baseUrl?: string;
}): unknown {
    const { value, type, baseUrl } = input;

    if (value === null || value === undefined) return null;

    switch (type) {
        case "string":
            return normalizeString(value);

        case "text":
            return normalizeText(value);

        case "number":
            return normalizeNumber(value);

        case "boolean":
            return normalizeBoolean(value);

        case "date":
            return normalizeDate(value);

        case "url":
            return normalizeUrl(value, baseUrl);
    }
}

function normalizeString(value: unknown): string | null {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text || null;
}

function normalizeText(value: unknown): string | null {
    const text = String(value)
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    return text || null;
}

function normalizeNumber(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }

    const tokens = extractNumberTokens(value);

    if (tokens.length !== 1) return null;

    const raw = tokens[0];

    if (!raw) return null;

    const hasComma = raw.includes(",");
    const hasDot = raw.includes(".");

    let normalized = raw;

    if (hasComma && hasDot) {
        const lastComma = raw.lastIndexOf(",");
        const lastDot = raw.lastIndexOf(".");

        if (lastComma > lastDot) {
            normalized = raw.replace(/\./g, "").replace(",", ".");
        } else {
            normalized = raw.replace(/,/g, "");
        }
    } else if (hasComma && !hasDot) {
        normalized = raw.replace(",", ".");
    }

    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : null;
}

export function extractNumberTokens(value: unknown): string[] {
    return String(value).match(/-?\d+(?:[.,]\d+)*/g) ?? [];
}

function normalizeBoolean(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;

    const text = String(value).toLowerCase();

    const trueTerms = [
        "true",
        "yes",
        "available",
        "in stock",
        "disponibile",
        "add to cart",
        "buy now",
    ];

    const falseTerms = [
        "false",
        "no",
        "unavailable",
        "out of stock",
        "sold out",
        "non disponibile",
        "esaurito",
    ];

    if (trueTerms.some(term => text.includes(term))) return true;
    if (falseTerms.some(term => text.includes(term))) return false;

    return null;
}

function normalizeDate(value: unknown): string | null {
    const text = String(value).trim();

    if (!text) return null;

    /**
     * MVP behavior:
     * - keep ISO dates as-is
     * - otherwise preserve raw string for user review
     *
     * Eventually add date-fns/luxon parsing with locale hints.
     */
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return text;
    }

    return text;
}

function normalizeUrl(value: unknown, baseUrl?: string): string | null {
    const text = String(value).trim();

    if (!text) return null;

    try {
        return new URL(text, baseUrl).toString();
    } catch {
        return null;
    }
}
