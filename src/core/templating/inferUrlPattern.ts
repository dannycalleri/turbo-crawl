export function inferUrlPattern(rawUrl: string): string {
    const url = new URL(rawUrl);

    const parts = url.pathname
        .split("/")
        .filter(Boolean)
        .map(inferPathPartPattern);

    return "/" + parts.join("/");
}

function inferPathPartPattern(part: string): string {
    const basename = stripKnownFileExtension(part);

    // This regexp matches a string that consists entirely of one or more digits (0-9).
    if (/^\d+$/.test(basename)) return ":id";

    // This regexp matches strings of 8 or more hexadecimal characters (0-9, a-f, case-insensitive).
    // Used to identify hash-like URL path segments, e.g., 9fa58eea or A1B2C3D4E5.
    if (/^[0-9a-f]{8,}$/i.test(basename)) return ":hash";

    if (looksLikeSlug(basename)) return ":slug";

    return part;
}

function stripKnownFileExtension(part: string): string {
    return part.replace(/\.(?:html?|php|aspx?)$/i, "");
}

// Hyphenated words ("black-bay-58"), or words joined by "-"/"_" that carry an id
// ("a-light-in-the-attic_1000", "sapiens_996"). Plain "my_account" stays literal.
function looksLikeSlug(part: string): boolean {
    if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(part)) return true;
    return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(part) && /\d/.test(part);
}
