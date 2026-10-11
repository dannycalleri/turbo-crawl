import type { PagePacket } from "../types";
import type { SelectorCandidate } from "./types";
import type { FieldType } from "../llm-extractor/types";

import { dedupeAndSortCandidates } from "./dedupeAndSortCandidates";

export function generateMetadataCandidates(input: {
    pagePacket: PagePacket;
    fieldName: string;
    fieldType: FieldType;
    rawValue: string | null;
}): SelectorCandidate[] {
    const { pagePacket, rawValue } = input;

    if (!rawValue) return [];

    const candidates: SelectorCandidate[] = [];

    if (pagePacket.metadata.canonicalUrl === rawValue) {
        candidates.push({
            kind: "meta",
            selector: "link[rel='canonical']@href",
            attribute: "href",
            score: 95,
            reusable: true,
        });
    }

    if (pagePacket.metadata.description === rawValue) {
        candidates.push({
            kind: "meta",
            selector: "meta[name='description']@content",
            attribute: "content",
            score: 85,
            reusable: true,
        });
    }

    for (const [property, value] of Object.entries(pagePacket.metadata.openGraph)) {
        if (value === rawValue) {
            candidates.push({
                kind: "meta",
                selector: `meta[property='${property}']@content`,
                attribute: "content",
                score: 88,
                reusable: true,
            });
        }
    }

    for (const [name, value] of Object.entries(pagePacket.metadata.twitter)) {
        if (value === rawValue) {
            candidates.push({
                kind: "meta",
                selector: `meta[name='${name}']@content`,
                attribute: "content",
                score: 82,
                reusable: true,
            });
        }
    }

    // If the field is a URL and the value is the current page URL.
    if (
        input.fieldType === "url" &&
        normalizeUrl(rawValue) === normalizeUrl(pagePacket.finalUrl || pagePacket.url)
    ) {
        candidates.push({
            kind: "meta",
            selector: "@currentUrl",
            attribute: "content",
            score: 80,
            reusable: true,
        });
    }

    return dedupeAndSortCandidates(candidates);
}

function normalizeUrl(value: string): string {
    try {
        const url = new URL(value);
        url.hash = "";
        return url.toString();
    } catch {
        return value;
    }
}