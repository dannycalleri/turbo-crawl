type CompiledPattern = {
    segments: RegExp[];
    query: Array<{ key: string; value: RegExp }>;
};

const PLACEHOLDER = /:([a-z][a-z0-9_]*)/g;

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

    const pairs = queryText ? queryText.split("&") : [];
    if (pairs.some(pair => pair.indexOf("=") <= 0)) return null;
    const query = [...new URLSearchParams(queryText ?? "")].map(([key, value]) => ({ key, value: compilePart(value) }));

    return { segments: path!.split("/").filter(Boolean).map(segment => compilePart(decode(segment))), query };
}

function compilePart(text: string): RegExp {
    let source = "";
    let last = 0;
    for (const match of text.matchAll(PLACEHOLDER)) {
        source += escapeRegExp(text.slice(last, match.index)) + (match[1] === "id" ? "\\d+" : "[^/]+?");
        last = match.index + match[0].length;
    }
    return new RegExp(`^${source}${escapeRegExp(text.slice(last))}$`);
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
