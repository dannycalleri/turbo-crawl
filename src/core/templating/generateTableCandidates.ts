import type { FieldType } from "../llm-extractor/types";
import type { PagePacket } from "../types";
import type { SelectorCandidate } from "./types";

export function generateTableCandidates(input: {
    tableNode: PagePacket["tables"][number];
    rawValue: string | null;
    fieldType: FieldType;
}): SelectorCandidate[] {
    const rawValue = normalizeComparable(input.rawValue);

    if (!rawValue) {
        return [];
    }

    const candidates: SelectorCandidate[] = [];
    const seen = new Set<string>();

    for (const [rowIndex, row] of input.tableNode.rows.entries()) {
        for (const [cellIndex, cell] of row.entries()) {
            if (!cellMatches(cell, rawValue, input.fieldType)) {
                continue;
            }

            for (const label of getCandidateLabels(row, cellIndex)) {
                addCandidate(candidates, seen, {
                    kind: "table",
                    selector: `${input.tableNode.nodeId}:label=${encodeURIComponent(label)}`,
                    attribute: "textContent",
                    score: 88,
                    reusable: true,
                });

                addCandidate(candidates, seen, {
                    kind: "table",
                    selector: `label=${encodeURIComponent(label)}`,
                    attribute: "textContent",
                    score: 82,
                    reusable: true,
                });
            }

            addCandidate(candidates, seen, {
                kind: "table",
                selector: `${input.tableNode.nodeId}:cell=${rowIndex},${cellIndex}`,
                attribute: "textContent",
                score: 45,
                reusable: false,
            });
        }
    }

    return candidates;
}

function getCandidateLabels(row: string[], valueCellIndex: number): string[] {
    const labels = row
        .slice(0, valueCellIndex)
        .map(label => label.trim())
        .filter(Boolean)
        .reverse();

    return [...new Set(labels)];
}

function addCandidate(
    candidates: SelectorCandidate[],
    seen: Set<string>,
    candidate: SelectorCandidate
): void {
    const key = `${candidate.kind}:${candidate.selector}:${candidate.attribute}`;

    if (seen.has(key)) {
        return;
    }

    seen.add(key);
    candidates.push(candidate);
}

function cellMatches(cell: string, normalizedRawValue: string, fieldType: FieldType): boolean {
    const normalizedCell = normalizeComparable(cell);

    if (!normalizedCell) {
        return false;
    }

    if (normalizedCell === normalizedRawValue) {
        return true;
    }

    if (fieldType !== "number") {
        return false;
    }

    return normalizeNumberText(normalizedCell) === normalizeNumberText(normalizedRawValue);
}

function normalizeComparable(value: string | null | undefined): string | null {
    if (value == null) {
        return null;
    }

    const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();

    return normalized || null;
}

function normalizeNumberText(value: string): string {
    return value.replace(/[^\d,.-]/g, "");
}
