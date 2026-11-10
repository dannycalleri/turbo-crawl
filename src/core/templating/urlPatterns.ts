type CompiledPattern = {
    segments: RegExp[];
    query: Array<{ key: string; value: RegExp }>;
};

const PLACEHOLDER = /:([a-z][a-z0-9]*(?:_[a-z0-9]+)*)/g;

export function isValidPattern(pattern: string): boolean {
    return compilePattern(pattern) !== null;
}

export function urlMatchesPattern(rawUrl: string, pattern: string): boolean {
    const compiled = compilePattern(pattern);
    if (!compiled) return false;

    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return false;
    }

    const segments = url.pathname.split("/").filter(Boolean).map(decode);
    if (segments.length !== compiled.segments.length) return false;
    if (!compiled.segments.every((segment, index) => segment.test(segments[index]!))) return false;

    return compiled.query.every(({ key, value }) => url.searchParams.getAll(key).some(candidate => value.test(candidate)));
}

export function templateCoversUrl(template: { urlPatterns: string[] }, url: string): boolean {
    return template.urlPatterns.some(pattern => urlMatchesPattern(url, pattern));
}

function compilePattern(pattern: string): CompiledPattern | null {
    if (!pattern.startsWith("/") || pattern.includes("#")) return null;

    const [path, queryText, ...rest] = pattern.split("?");
    if (rest.length > 0) return null;

    const query: CompiledPattern["query"] = [];
    for (const pair of queryText ? queryText.split("&") : []) {
        const separator = pair.indexOf("=");
        if (separator <= 0) return null;
        query.push({ key: decodeQueryText(pair.slice(0, separator)), value: compilePart(pair.slice(separator + 1), decodeQueryText) });
    }

    return { segments: path!.split("/").filter(Boolean).map(segment => compilePart(segment, decode)), query };
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
    return decode(text.replace(/\+/g, " "));
}

function decode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const MAX_URL_PATTERNS = 20;

export function mergePatterns(patterns: string[]): string[] {
    const merged = [...new Set(patterns)];
    for (let left = 0; left < merged.length; left += 1) {
        for (let right = left + 1; right < merged.length; right += 1) {
            const combined = mergePair(merged[left]!, merged[right]!);
            if (combined === null) continue;
            merged[left] = combined;
            merged.splice(right, 1);
            return mergePatterns(merged);
        }
    }
    return merged;
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
    return /^:[a-z][a-z0-9_]*$/.test(segment) || !new RegExp(PLACEHOLDER.source).test(segment);
}
