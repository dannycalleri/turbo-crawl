import type { Page } from "playwright";
import { inferUrlPattern } from "../templating/inferUrlPattern";

export type LinkBlock = {
    nodeId: string;
    text: string;
    href: string;
    cssPath: string;
    score: number;
};

export async function extractLinks(page: Page): Promise<LinkBlock[]> {
    const links = await page.evaluate(() => {
        const helpers = window.__turboCrawl;
        if (!helpers) {
            throw new Error("Turbo Crawl page helpers are not installed.");
        }

        const anchors = Array.from(document.querySelectorAll("a[href]"));
        const result: LinkBlock[] = [];

        let counter = 1;

        for (const anchor of anchors) {
            if (!(anchor instanceof HTMLAnchorElement)) continue;

            const text = helpers.normalizeWhitespace(anchor.innerText || anchor.textContent || "");
            const href = anchor.href;

            if (!href) continue;
            if (!text && !looksUsefulHref(href)) continue;

            result.push({
                nodeId: `link_${String(counter).padStart(3, "0")}`,
                text,
                href,
                cssPath: helpers.getCssPath(anchor),
                score: scoreLink(anchor, text, href),
            });

            counter += 1;
        }

        function looksUsefulHref(href: string): boolean {
            return /product|watch|item|listing|article|collection|brand/i.test(href);
        }
        
        function scoreLink(anchor: HTMLAnchorElement, text: string, href: string): number {
            let score = 0;
        
            if (text.length > 0 && text.length <= 120) score += 0.25;
            if (/canonical|product|item|listing|brand|watch/i.test(href)) score += 0.25;
            if (anchor.closest("main, article, [role='main']")) score += 0.25;
            if (anchor.closest("header, footer, nav")) score -= 0.25;
        
            return Math.max(0, Math.min(1, score));
        }
        
        return result;
    });

    return links
        .sort((a, b) => b.score - a.score)
        .slice(0, 100);
}

export type LinkGroup = {
    urlPattern: string;
    count: number;
    samples: string[];
};

export type LinkItem = {
    url: string;
    text: string;
    cssPath: string;
};

export async function readDomLinks(page: Page, selector: string): Promise<LinkItem[]> {
    const anchors = await page.locator(selector).evaluateAll(elements => elements.flatMap(element => {
        const href = element.getAttribute("href");
        if (href === null) return [];
        return [{
            href,
            text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
            cssPath: window.__turboCrawl?.getCssPath(element) ?? "",
        }];
    }));

    const links = new Map<string, LinkItem>();
    for (const anchor of anchors) {
        const [url] = cleanLinks([anchor.href], page.url());
        if (url && !links.has(url)) links.set(url, { url, text: anchor.text, cssPath: anchor.cssPath });
    }
    return [...links.values()];
}

export async function summarizeLinkGroups(page: Page): Promise<LinkGroup[]> {
    const hrefs = await page.locator("a[href]").evaluateAll(elements =>
        elements.map(element => element.getAttribute("href") ?? ""));
    return groupLinks(cleanLinks(hrefs, page.url()), page.url());
}

export function cleanLinks(hrefs: string[], baseUrl: string): string[] {
    const seen = new Set<string>();
    for (const href of hrefs) {
        let url: URL;
        try {
            url = new URL(href.trim(), baseUrl);
        } catch {
            continue;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        url.hash = "";
        seen.add(url.toString());
    }
    return [...seen];
}

export function groupLinks(urls: string[], pageUrl: string): LinkGroup[] {
    const host = new URL(pageUrl).host;
    const groups = new Map<string, string[]>();
    for (const url of urls) {
        if (new URL(url).host !== host) continue;
        const pattern = inferUrlPattern(url);
        const members = groups.get(pattern);
        if (members) members.push(url);
        else groups.set(pattern, [url]);
    }
    return [...groups.entries()]
        .map(([urlPattern, members]) => ({ urlPattern, count: members.length, samples: members.slice(0, 3) }))
        .sort((left, right) => right.count - left.count || left.urlPattern.localeCompare(right.urlPattern));
}
