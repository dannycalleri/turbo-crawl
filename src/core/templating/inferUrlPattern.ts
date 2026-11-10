export function inferUrlPattern(rawUrl: string): string {
    const url = new URL(rawUrl);

    const parts = url.pathname
        .split("/")
        .filter(Boolean)
        .map(inferPathPartPattern);

    return "/" + parts.join("/");
}

function inferPathPartPattern(part: string): string {
    if (part.startsWith(":")) return part;

    const basename = stripKnownFileExtension(decodeSegment(part));

    if (/^\d+$/.test(basename)) return ":id";

    if (/^[0-9a-f]{8,}$/i.test(basename)) return ":hash";

    if (looksLikeSlug(basename)) return ":slug";

    return part.replace(/:/g, "%3A");
}

export function decodeSegment(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}

function stripKnownFileExtension(part: string): string {
    return part.replace(/\.(?:html?|php|aspx?)$/i, "");
}

function looksLikeSlug(part: string): boolean {
    const tokens = part.split(/[-_]+/).filter(Boolean);
    if (tokens.length < 2 || !tokens.every(token => /^[\p{L}\p{N}]+$/u.test(token))) return false;
    return part.includes("-") || /\d/.test(part);
}
