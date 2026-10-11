import type { FieldEvidence } from "../types";
import type { PagePacket } from "../../types";
import type { CompactPagePacket } from "../../compactPagePacket";

export function buildNodeIdSet(pagePacket: PagePacket | CompactPagePacket): Set<string> {
    const ids = new Set<string>();

    for (const block of pagePacket.visibleBlocks) ids.add(block.nodeId);
    for (const block of pagePacket.jsonLd) ids.add(block.nodeId);
    for (const link of pagePacket.links) ids.add(link.nodeId);
    for (const image of pagePacket.images) ids.add(image.nodeId);
    for (const table of pagePacket.tables) ids.add(table.nodeId);

    return ids;
}

export function verifyFieldEvidence(input: {
    evidence: FieldEvidence | null;
    validNodeIds: Set<string>;
}) {
    const warnings: string[] = [];

    if (!input.evidence) {
        warnings.push("Missing evidence.");
        return {
            sourceNodeExists: false,
            warnings,
        };
    }

    const sourceNodeId = input.evidence.sourceNodeId;

    if (sourceNodeId === null) {
        return {
            sourceNodeExists: true,
            warnings,
        };
    }

    const sourceNodeExists = input.validNodeIds.has(sourceNodeId);

    if (!sourceNodeExists) {
        warnings.push(`Evidence sourceNodeId does not exist: ${sourceNodeId}`);
    }

    if (
        typeof input.evidence.confidence !== "number" ||
        input.evidence.confidence < 0 ||
        input.evidence.confidence > 1
    ) {
        warnings.push("Evidence confidence is outside 0..1.");
    }

    return {
        sourceNodeExists,
        warnings,
    };
}
