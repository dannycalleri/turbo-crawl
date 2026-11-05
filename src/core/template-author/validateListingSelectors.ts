import type { Page } from "playwright";
import { cleanLinks, groupLinks, readDomLinks, type LinkItem } from "../extraction/links";
import type { ListingTemplate } from "../templating/types";

export const MIN_ITEM_LINKS = 2;
export const MIN_ITEM_PATTERN_SHARE = 0.8;

export const LINK_ROLES = ["itemLinks", "nextPage", "pageLinks"] as const;
export type LinkRole = typeof LINK_ROLES[number];

export type ItemLinksFit =
    | { fits: true; itemUrls: string[]; itemUrlPattern: string }
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

export function itemLinksFit(urls: string[], pageUrl: string): ItemLinksFit {
    const itemUrls = sameHostLinks(urls, pageUrl);
    if (itemUrls.length < MIN_ITEM_LINKS) {
        return { fits: false, reason: `read ${itemUrls.length} link(s) on this host; a listing needs at least ${MIN_ITEM_LINKS}` };
    }

    const [largest] = groupLinks(itemUrls, pageUrl);
    if (largest!.count / itemUrls.length < MIN_ITEM_PATTERN_SHARE) {
        return {
            fits: false,
            reason: `the links do not share one URL pattern (${largest!.urlPattern} covers ${largest!.count} of ${itemUrls.length}); select only the item links`,
        };
    }

    return { fits: true, itemUrls, itemUrlPattern: largest!.urlPattern };
}

export async function validateLinkSelectors(
    page: Page,
    role: LinkRole,
    selectors: string[],
): Promise<LinkSelectorValidation[]> {
    const pageUrl = page.url();
    const results: LinkSelectorValidation[] = [];

    for (const selector of selectors) {
        let links: LinkItem[];
        try {
            links = await readDomLinks(page, selector);
        } catch (error) {
            const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
            results.push({ selector, passed: false, links: [], reason: `selector could not be evaluated: ${message}` });
            continue;
        }
        const urls = links.map(link => link.url);

        if (role === "itemLinks") {
            const fit = itemLinksFit(urls, pageUrl);
            results.push(fit.fits
                ? { selector, passed: true, links: links.filter(link => fit.itemUrls.includes(link.url)), reason: "ok" }
                : { selector, passed: false, links, reason: fit.reason });
            continue;
        }

        const pageUrls = sameHostLinks(urls, pageUrl);
        results.push(pageUrls.length > 0
            ? { selector, passed: true, links: links.filter(link => pageUrls.includes(link.url)), reason: "ok" }
            : { selector, passed: false, links, reason: "no link to another page on this host" });
    }

    return results;
}

export async function readListingLinks(page: Page, template: ListingTemplate): Promise<ListingLinks | null> {
    const items = (await validateLinkSelectors(page, "itemLinks", template.itemLinks)).find(result => result.passed);
    if (!items) return null;

    const next = (await validateLinkSelectors(page, "nextPage", template.nextPage)).find(result => result.passed);
    const pages = (await validateLinkSelectors(page, "pageLinks", template.pageLinks)).find(result => result.passed);

    return {
        items: items.links,
        paginationUrls: [...new Set([...(next ? next.links.slice(0, 1) : []), ...(pages?.links ?? [])].map(link => link.url))],
    };
}

function sameHostLinks(urls: string[], pageUrl: string): string[] {
    const [page] = cleanLinks([pageUrl], pageUrl);
    const host = new URL(pageUrl).host;
    return urls.filter(url => url !== page && new URL(url).host === host);
}
