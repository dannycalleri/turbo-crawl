import { isValidPattern, urlMatchesPattern } from "../templating/urlPatterns";

export type PatternAnswer = {
    urlPattern: string;
    sameTypeLinks: string[];
    otherTypeLinks: string[];
};

export function checkUrlPattern(answer: PatternAnswer | null, pageUrl: string, promptLinks: string[]): string | null {
    if (!answer) return "no urlPattern was given";
    const { urlPattern, sameTypeLinks, otherTypeLinks } = answer;

    if (!isValidPattern(urlPattern)) {
        return invalid(urlPattern);
    }
    if (!urlMatchesPattern(pageUrl, urlPattern)) return `the page URL ${pageUrl} does not match ${urlPattern}`;

    const known = new Set(promptLinks);
    const invented = [...sameTypeLinks, ...otherTypeLinks].filter(link => !known.has(link));
    if (invented.length > 0) return `${invented.join(", ")} is not in the list of links on this page`;

    const missed = sameTypeLinks.filter(link => !urlMatchesPattern(link, urlPattern));
    if (missed.length > 0) return `${urlPattern} does not match ${missed.join(", ")}, which you listed as the same page type`;

    const caught = otherTypeLinks.filter(link => urlMatchesPattern(link, urlPattern));
    if (caught.length > 0) return `${urlPattern} matches ${caught.join(", ")}, which you listed as another page type`;

    return null;
}

export function checkItemUrlPattern(pattern: string, pageUrl: string): string | null {
    if (!pattern) return "no itemUrlPattern was given";
    if (!isValidPattern(pattern)) return invalid(pattern);
    if (urlMatchesPattern(pageUrl, pattern)) return `the listing page ${pageUrl} matches ${pattern}, so it cannot be the pattern of the item pages`;
    return null;
}

export function checkPageUrlPattern(pattern: string, pageUrl: string, paginationUrls: string[], itemUrls: string[]): string | null {
    if (!pattern) return "no pageUrlPattern was given";
    if (!isValidPattern(pattern)) return invalid(pattern);
    if (!urlMatchesPattern(pageUrl, pattern)) return `the page URL ${pageUrl} does not match ${pattern}`;

    const missed = paginationUrls.filter(url => !urlMatchesPattern(url, pattern));
    if (missed.length > 0) return `${pattern} does not match the pagination link(s) ${missed.join(", ")}`;

    const caught = itemUrls.filter(url => urlMatchesPattern(url, pattern));
    if (caught.length > 0) return `${pattern} matches the item link(s) ${caught.slice(0, 3).join(", ")}`;

    return null;
}

function invalid(pattern: string): string {
    return `${JSON.stringify(pattern)} is not a valid pattern: start with "/", and write placeholders as ":" plus a lowercase name`;
}
