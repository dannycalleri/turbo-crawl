import type { PagePacket } from "../types";
import type { FieldType } from "../llm-extractor/types";
import type { SelectorCandidate } from "./types";

export function generateJsonLdCandidates(input: {
    jsonLdNode: PagePacket["jsonLd"][number];
    rawValue: string | null;
    fieldName: string;
    fieldType: FieldType;
}): SelectorCandidate[] {
    const { jsonLdNode, rawValue, fieldName } = input;

    if (!rawValue) {
        return [];
    }

    const paths = findJsonPathsByValue(jsonLdNode.data, rawValue);

    return paths.map(path => ({
        kind: "jsonld" as const,
        selector: `${jsonLdNode.nodeId}:${path}`,
        attribute: "json" as const,
        score: scoreJsonLdPath(path, fieldName),
        reusable: true,
    }));
}

function findJsonPathsByValue(data: unknown, rawValue: string): string[] {
    const paths: string[] = [];
    const expected = normalizeComparable(rawValue);

    walk(data, "$");

    return paths;

    function walk(value: unknown, path: string) {
        if (value == null) return;

        if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
        ) {
            const actual = normalizeComparable(String(value));

            if (actual === expected) {
                paths.push(path);
            }

            return;
        }

        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                walk(item, `${path}[${index}]`);
            });

            return;
        }

        if (typeof value === "object") {
            for (const [key, child] of Object.entries(value)) {
                walk(child, `${path}.${key}`);
            }
        }
    }
}

function scoreJsonLdPath(path: string, fieldName: string): number {
    const lowerPath = path.toLowerCase();
    const lowerField = fieldName.toLowerCase();

    let score = 90;

    if (lowerField.includes("price") && lowerPath.includes("price")) score += 5;
    if (lowerField.includes("name") && lowerPath.includes("name")) score += 5;
    if (lowerField.includes("description") && lowerPath.includes("description")) score += 5;
    if (lowerField.includes("brand") && lowerPath.includes("brand")) score += 5;

    return Math.min(score, 98);
}

function normalizeComparable(value: string): string {
    return value
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}