import { isValidPattern, urlMatchesPattern } from "../templating/urlPatterns";

export type PatternAnswer = {
    urlPattern: string;
    sameTypeLinks: string[];
    otherTypeLinks: string[];
};

export function checkUrlPattern(answer: PatternAnswer | null, pageUrl: string, promptLinks: string[]): string | null {
    if (!answer) return "no urlPattern was given";
    const { urlPattern, sameTypeLinks, otherTypeLinks } = answer;
    const failure = precheck(urlPattern, "urlPattern") ?? pageMustMatch(pageUrl, urlPattern);
    if (failure !== null) return failure;

    const known = new Set(promptLinks);
    const invented = [...sameTypeLinks, ...otherTypeLinks].filter(link => !known.has(link));
    if (invented.length > 0) return `${invented.join(", ")} is not in the list of links on this page`;

    const missed = missing(sameTypeLinks, urlPattern);
    if (missed.length > 0) return `${urlPattern} does not match ${missed.join(", ")}, which you listed as the same page type`;

    const caught = matching(otherTypeLinks, urlPattern);
    if (caught.length > 0) return `${urlPattern} matches ${caught.join(", ")}, which you listed as another page type`;

    return null;
}

export function checkItemUrlPattern(pattern: string, pageUrl: string, paginationUrls: string[] = []): string | null {
    const failure = precheck(pattern, "itemUrlPattern");
    if (failure !== null) return failure;
    if (urlMatchesPattern(pageUrl, pattern)) return `the listing page ${pageUrl} matches ${pattern}, so it cannot be the pattern of the item pages`;
    const caught = matching(paginationUrls, pattern);
    if (caught.length > 0) return `${pattern} matches the pagination link(s) ${caught.slice(0, 3).join(", ")}, so it cannot be the pattern of the item pages`;
    return null;
}

export function checkPageUrlPattern(pattern: string, pageUrl: string, paginationUrls: string[], itemUrls: string[]): string | null {
    const failure = precheck(pattern, "pageUrlPattern") ?? pageMustMatch(pageUrl, pattern);
    if (failure !== null) return failure;

    const missed = missing(paginationUrls, pattern);
    if (missed.length > 0) return `${pattern} does not match the pagination link(s) ${missed.join(", ")}`;

    const caught = matching(itemUrls, pattern);
    if (caught.length > 0) return `${pattern} matches the item link(s) ${caught.slice(0, 3).join(", ")}`;

    return null;
}

function precheck(pattern: string, name: string): string | null {
    if (!pattern) return `no ${name} was given`;
    if (!isValidPattern(pattern)) return `${JSON.stringify(pattern)} is not a valid pattern: start with "/", and write placeholders as ":" plus a lowercase name`;
    return null;
}

function pageMustMatch(pageUrl: string, pattern: string): string | null {
    return urlMatchesPattern(pageUrl, pattern) ? null : `the page URL ${pageUrl} does not match ${pattern}`;
}

const matching = (urls: string[], pattern: string) => urls.filter(url => urlMatchesPattern(url, pattern));
const missing = (urls: string[], pattern: string) => urls.filter(url => !urlMatchesPattern(url, pattern));
