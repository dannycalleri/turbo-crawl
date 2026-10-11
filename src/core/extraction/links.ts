import type { Page } from "playwright";

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
