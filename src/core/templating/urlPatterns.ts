import { decodeSegment, inferUrlPattern } from "./inferUrlPattern";

type CompiledPattern = {
    segments: RegExp[];
    query: Array<{ key: string; value: RegExp }>;
};

const PLACEHOLDER_NAME = "[a-z][a-z0-9]*(?:_[a-z0-9]+)*";
const PLACEHOLDER = new RegExp(`:(${PLACEHOLDER_NAME})`, "g");
const HAS_PLACEHOLDER = new RegExp(`:${PLACEHOLDER_NAME}`);
const WHOLE_PLACEHOLDER = new RegExp(`^:${PLACEHOLDER_NAME}$`);

const compiled = new Map<string, CompiledPattern | null>();

export function isValidPattern(pattern: string): boolean {
    return compilePattern(pattern) !== null;
}

export function urlMatchesPattern(url: string, pattern: string): boolean {
    return matchingPattern(url, [pattern]) !== undefined;
}

export function templateCoversUrl(template: { urlPatterns: string[] }, url: string): boolean {
    return matchingPattern(url, template.urlPatterns) !== undefined;
}

export function matchingPattern(rawUrl: string, patterns: string[]): string | undefined {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return undefined;
    }
    const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);

    return patterns.find(pattern => {
        const parts = compilePattern(pattern);
        return parts !== null &&
            segments.length === parts.segments.length &&
            parts.segments.every((segment, index) => segment.test(segments[index]!)) &&
            parts.query.every(({ key, value }) => url.searchParams.getAll(key).some(candidate => value.test(candidate)));
    });
}

function compilePattern(pattern: string): CompiledPattern | null {
    if (!compiled.has(pattern)) compiled.set(pattern, parsePattern(pattern));
    return compiled.get(pattern)!;
}

function parsePattern(pattern: string): CompiledPattern | null {
    if (!pattern.startsWith("/") || pattern.includes("#")) return null;

    const [path, queryText, ...rest] = pattern.split("?");
    if (rest.length > 0) return null;

    const query: CompiledPattern["query"] = [];
    for (const pair of queryText ? queryText.split("&") : []) {
        const separator = pair.indexOf("=");
        if (separator <= 0) return null;
        query.push({ key: decodeQueryText(pair.slice(0, separator)), value: compilePart(pair.slice(separator + 1), decodeQueryText) });
    }

    return { segments: path!.split("/").filter(Boolean).map(segment => compilePart(segment, decodeSegment)), query };
}

// Placeholders are found before decoding, so an encoded colon (%3A) stays literal text.
function compilePart(raw: string, decodeText: (text: string) => string): RegExp {
    let source = "";
    let last = 0;
    for (const match of raw.matchAll(PLACEHOLDER)) {
        source += escapeRegExp(decodeText(raw.slice(last, match.index))) + (match[1] === "id" ? "\\d+" : "[^/]+?");
        last = match.index + match[0].length;
    }
    return new RegExp(`^${source}${escapeRegExp(decodeText(raw.slice(last)))}$`);
}

function decodeQueryText(text: string): string {
    return decodeSegment(text.replace(/\+/g, " "));
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const MAX_URL_PATTERNS = 20;

export function mergePatterns(patterns: string[]): string[] {
    let merged = [...new Set(patterns)];
    for (let found = findMerge(merged); found; found = findMerge(merged)) {
        merged[found.left] = found.combined;
        merged.splice(found.right, 1);
        merged = [...new Set(merged)];
    }
    return merged;
}

function findMerge(patterns: string[]): { left: number; right: number; combined: string } | null {
    for (let left = 0; left < patterns.length; left += 1) {
        for (let right = left + 1; right < patterns.length; right += 1) {
            const combined = mergePair(patterns[left]!, patterns[right]!);
            if (combined !== null) return { left, right, combined };
        }
    }
    return null;
}

export function normalizePatterns(patterns: string[]): string[] {
    return capPatterns(mergePatterns(patterns.map(normalizePattern)));
}

// Only a pattern with no placeholder is a raw per-page path from an old file. A pattern
// with placeholders was already generalized, by the agent or the heuristic, and stays as it is.
function normalizePattern(pattern: string): string {
    const [path, query] = pattern.split("?");
    if (!path!.startsWith("/") || HAS_PLACEHOLDER.test(pattern)) return pattern;
    const inferred = inferUrlPattern(`https://pattern.invalid${path}`);
    return query === undefined ? inferred : `${inferred}?${query}`;
}

export function capPatterns(patterns: string[]): string[] {
    return patterns.length <= MAX_URL_PATTERNS
        ? patterns
        : [patterns[0]!, ...patterns.slice(patterns.length - (MAX_URL_PATTERNS - 1))];
}

function mergePair(left: string, right: string): string | null {
    const [leftPath, leftQuery = ""] = left.split("?");
    const [rightPath, rightQuery = ""] = right.split("?");
    if (leftQuery !== rightQuery) return null;

    const leftSegments = leftPath!.split("/").filter(Boolean);
    const rightSegments = rightPath!.split("/").filter(Boolean);
    if (leftSegments.length !== rightSegments.length) return null;

    const differing = leftSegments.flatMap((segment, index) => segment === rightSegments[index] ? [] : [index]);
    if (differing.length !== 1) return null;

    const index = differing[0]!;
    const pair = [leftSegments[index]!, rightSegments[index]!];
    if (!pair.every(isWholeSegment)) return null;

    const segments = [...leftSegments];
    segments[index] = pair.every(segment => segment === ":id" || /^\d+$/.test(segment)) ? ":id" : ":slug";
    return "/" + segments.join("/") + (leftQuery ? `?${leftQuery}` : "");
}

function isWholeSegment(segment: string): boolean {
    return WHOLE_PLACEHOLDER.test(segment) || !HAS_PLACEHOLDER.test(segment);
}
