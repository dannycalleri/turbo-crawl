import type { SelectorCandidate } from "./types";

export function dedupeAndSortCandidates(
    candidates: SelectorCandidate[]
): SelectorCandidate[] {
    const seen = new Set<string>();
    const deduped: SelectorCandidate[] = [];

    for (const candidate of candidates) {
        const key = `${candidate.kind}:${candidate.selector}:${candidate.attribute}`;

        if (seen.has(key)) continue;

        seen.add(key);
        deduped.push(candidate);
    }

    return deduped.sort((a, b) => {
        // Prefer reusable selectors even if the score is slightly lower.
        if (a.reusable && !b.reusable) return -1;
        if (!a.reusable && b.reusable) return 1;

        return b.score - a.score;
    });
}