import type { PagePacket } from "../types";
import type { SelectorCandidate } from "./types";
import type { FieldType } from "../llm-extractor/types";
import { generateJsonLdCandidates } from "./generateJsonLdCandidates";
import { generateMetadataCandidates } from "./generateMetadataCandidates";
import { generateDomCandidates } from "./generateDomCandiddates";
import { generateTableCandidates } from "./generateTableCandidates";

type SourceNode =
    | {
        kind: "dom";
        node: PagePacket["visibleBlocks"][number];
    }
    | {
        kind: "jsonld";
        node: PagePacket["jsonLd"][number];
    }
    | {
        kind: "table";
        node: PagePacket["tables"][number];
    }
    | {
        kind: "metadata";
        node: null;
    }
    | null;

export function findSourceNode(
    pagePacket: PagePacket,
    sourceNodeId: string | null
): SourceNode {
    if (!sourceNodeId) {
        return null;
    }

    const domNode = pagePacket.visibleBlocks.find(
        node => node.nodeId === sourceNodeId
    );

    if (domNode) {
        return {
            kind: "dom",
            node: domNode,
        };
    }

    const jsonLdNode = pagePacket.jsonLd.find(
        node => node.nodeId === sourceNodeId
    );

    if (jsonLdNode) {
        return {
            kind: "jsonld",
            node: jsonLdNode,
        };
    }

    const tableNode = pagePacket.tables.find(
        node => node.nodeId === sourceNodeId
    );

    if (tableNode) {
        return {
            kind: "table",
            node: tableNode,
        };
    }

    return null;
}

export function generateSelectorCandidates(input: {
    pagePacket: PagePacket;
    sourceNode: SourceNode;
    fieldName: string;
    fieldType: FieldType;
    rawValue: string | null;
}): SelectorCandidate[] {
    const { sourceNode } = input;

    if (!sourceNode) {
        return generateMetadataCandidates(input);
    }

    if (sourceNode.kind === "jsonld") {
        return generateJsonLdCandidates({
            jsonLdNode: sourceNode.node,
            rawValue: input.rawValue,
            fieldName: input.fieldName,
            fieldType: input.fieldType,
        });
    }

    if (sourceNode.kind === "dom") {
        return generateDomCandidates({
            domNode: sourceNode.node,
            fieldName: input.fieldName,
            fieldType: input.fieldType,
        });
    }

    if (sourceNode.kind === "table") {
        return generateTableCandidates({
            tableNode: sourceNode.node,
            rawValue: input.rawValue,
            fieldType: input.fieldType,
        });
    }

    return [];
}
