import type { Page } from "playwright";
import { readDomLinks, sameHostLinks, type LinkItem } from "../extraction/links";
import { urlMatchesPattern } from "../templating/urlPatterns";
import type { ListingTemplate } from "../templating/types";

export const MIN_ITEM_LINKS = 2;

export const LINK_ROLES = ["itemLinks", "nextPage", "pageLinks"] as const;
export type LinkRole = typeof LINK_ROLES[number];

type ItemLinksFit =
    | { fits: true; itemUrls: string[] }
    | { fits: false; reason: string };

export type LinkSelectorValidation = {
    selector: string;
    passed: boolean;
    links: LinkItem[];
    reason: string;
};

export type ListingLinks = {
    items: LinkItem[];
    paginationUrls: string[];
};

export function itemLinksFit(urls: string[], pageUrl: string, itemUrlPatterns: string[]): ItemLinksFit {
    const sameHost = sameHostLinks(urls, pageUrl);
    const itemUrls = sameHost.filter(url => urlMatchesPattern(url, itemUrlPatterns));
    if (itemUrls.length < MIN_ITEM_LINKS) {
        return {
            fits: false,
            reason: `${itemUrls.length} of ${sameHost.length} link(s) on this host match ${itemUrlPatterns.join(" or ") || "no item pattern"}; a listing needs at least ${MIN_ITEM_LINKS}`,
        };
    }
    return { fits: true, itemUrls };
}

export async function validateLinkSelectors(
    page: Page,
    role: LinkRole,
    selectors: string[],
    itemUrlPatterns: string[] = [],
): Promise<LinkSelectorValidation[]> {
    const results: LinkSelectorValidation[] = [];
    for (const selector of selectors) results.push(await validateLinkSelector(page, role, selector, itemUrlPatterns));
    return results;
}

export async function readListingLinks(page: Page, template: ListingTemplate): Promise<ListingLinks | null> {
    const items = await firstPassing(page, "itemLinks", template.itemLinks, template.itemUrlPatterns);
    if (!items) return null;

    const next = await firstPassing(page, "nextPage", template.nextPage);
    const pages = await firstPassing(page, "pageLinks", template.pageLinks);

    return {
        items: items.links,
        paginationUrls: [...new Set([...(next ? next.links.slice(0, 1) : []), ...(pages?.links ?? [])].map(link => link.url))],
    };
}

async function firstPassing(page: Page, role: LinkRole, selectors: string[], itemUrlPatterns: string[] = []): Promise<LinkSelectorValidation | null> {
    for (const selector of selectors) {
        const result = await validateLinkSelector(page, role, selector, itemUrlPatterns);
        if (result.passed && result.links.length > 0) return result;
    }
    return null;
}

async function validateLinkSelector(page: Page, role: LinkRole, selector: string, itemUrlPatterns: string[]): Promise<LinkSelectorValidation> {
    let links: LinkItem[];
    try {
        links = await readDomLinks(page, selector);
    } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        return { selector, passed: false, links: [], reason: `selector could not be evaluated: ${message}` };
    }

    const pageUrl = page.url();
    const urls = links.map(link => link.url);
    if (role === "itemLinks") {
        const fit = itemLinksFit(urls, pageUrl, itemUrlPatterns);
        return fit.fits
            ? { selector, passed: true, links: keepLinks(links, fit.itemUrls), reason: "ok" }
            : { selector, passed: false, links, reason: fit.reason };
    }

    if (links.length === 0) {
        const matched = await page.locator(selector).count();
        // The last page of a list, or a one-page list, has no next or numbered page links.
        return matched === 0
            ? { selector, passed: true, links: [], reason: "matches nothing on this page" }
            : { selector, passed: false, links: [], reason: `matches ${matched} element(s), but none is a link with an href` };
    }

    const pageUrls = sameHostLinks(urls, pageUrl);
    return pageUrls.length > 0
        ? { selector, passed: true, links: keepLinks(links, pageUrls), reason: "ok" }
        : { selector, passed: false, links, reason: "no link to another page on this host" };
}

function keepLinks(links: LinkItem[], urls: string[]): LinkItem[] {
    const kept = new Set(urls);
    return links.filter(link => kept.has(link.url));
}

