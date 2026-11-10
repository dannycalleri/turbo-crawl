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
        return `${JSON.stringify(urlPattern)} is not a valid pattern: start with "/", and write placeholders as ":" plus a lowercase name`;
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
