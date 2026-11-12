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

    const [, basename = "", extension = ""] = /^(.*?)(\.(?:html?|php|aspx?))?$/i.exec(decodeSegment(part))!;
    const shape = inferBasenamePattern(basename);

    return shape === null ? part.replace(/:/g, "%3A") : shape + extension;
}

function inferBasenamePattern(basename: string): string | null {
    if (/^\d+$/.test(basename)) return ":id";

    if (/^[0-9a-f]{8,}$/i.test(basename)) return ":hash";

    const affix = /^([\p{L}\p{N}]+(?:[-_]+[\p{L}\p{N}]+)*)--(\p{L}+)\d+$/u.exec(basename);
    if (affix) return `:slug--${affix[2]}:id`;

    if (looksLikeSlug(basename)) return ":slug";

    return null;
}

export function decodeSegment(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}

function looksLikeSlug(part: string): boolean {
    const tokens = part.split(/[-_]+/).filter(Boolean);
    if (tokens.length < 2 || !tokens.every(token => /^[\p{L}\p{N}]+$/u.test(token))) return false;
    return part.includes("-") || /\d/.test(part);
}
