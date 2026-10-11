import type { Page } from "playwright";
// Values used inside page.evaluate callbacks are written inline: those callbacks run in
// the browser, where module-level constants do not exist once the CLI is bundled.

export type BoundingBox = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type DomBlock = {
    nodeId: string;
    tag: string;
    text: string;
    normalizedText: string;
    cssPath: string;
    xpath: string | null;

    attributes: Record<string, string>;

    role: string | null;
    ariaLabel: string | null;

    href: string | null;
    src: string | null;

    boundingBox: BoundingBox | null;

    isVisible: boolean;
    isInMainContent: boolean;
    isLikelyNoise: boolean;

    score: number;
};

export type ExtractDomBlocksOptions = {
    maxBlocks: number;
    maxTextLength?: number;
};


export async function extractDomBlocks(
    page: Page,
    options: ExtractDomBlocksOptions
): Promise<DomBlock[]> {
    const maxBlocks = options.maxBlocks;
    const maxTextLength = options.maxTextLength ?? 800;

    const blocks = await page.evaluate(
        ({ maxTextLength }) => {
            const helpers = window.__turboCrawl;
            if (!helpers) {
                throw new Error("Turbo Crawl page helpers are not installed.");
            }
            const helperRuntime = helpers;

            const CANDIDATE_SELECTOR = [
                "h1",
                "h2",
                "h3",
                "h4",
                "p",
                "span",
                "strong",
                "em",
                "li",
                "dt",
                "dd",
                "td",
                "th",
                "a",
                "button",
                "label",
                "[itemprop]",
                "[data-testid]",
                "[data-test]",
                "[data-cy]",
                "[aria-label]",
            ].join(",");

            const NOISE_SELECTOR = [
                "script",
                "style",
                "noscript",
                "svg",
                "header",
                "footer",
                "nav",
                "[hidden]",
                "[aria-hidden='true']",
                "[role='navigation']",
                "[role='banner']",
                "[role='contentinfo']",
            ].join(",");

            const nodes = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR));

            const blocks: DomBlock[] = [];
            let counter = 1;

            for (const el of nodes) {
                if (!(el instanceof HTMLElement)) continue;

                if (el.closest(NOISE_SELECTOR)) continue;

                const normalizedText = getUsefulText(el, maxTextLength);

                if (!normalizedText) continue;
                if (normalizedText.length < 2) continue;

                const rect = el.getBoundingClientRect();
                const isVisible = isElementVisible(el, rect);

                if (!isVisible) continue;

                const attributes = getUsefulAttributes(el);
                const isInMainContent = Boolean(el.closest("main, article, [role='main']"));
                const isLikelyNoise = looksLikeNoise(el, normalizedText);

                const score = scoreElement({
                    el,
                    text: normalizedText,
                    attributes,
                    isInMainContent,
                    isLikelyNoise,
                });

                blocks.push({
                    nodeId: `dom_${String(counter).padStart(3, "0")}`,
                    tag: el.tagName.toLowerCase(),
                    text: normalizedText,
                    normalizedText,
                    cssPath: helperRuntime.getCssPath(el),
                    xpath: getXPath(el),
                    attributes,
                    role: el.getAttribute("role"),
                    ariaLabel: el.getAttribute("aria-label"),
                    href: el instanceof HTMLAnchorElement ? el.href : null,
                    src:
                        el instanceof HTMLImageElement
                            ? el.currentSrc || el.src
                            : null,
                    boundingBox: {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                    },
                    isVisible,
                    isInMainContent,
                    isLikelyNoise,
                    score,
                });

                counter += 1;
            }

            function getUsefulText(el: HTMLElement, maxLength: number): string {
                const tag = el.tagName.toLowerCase();
            
                if (tag === "img") {
                    return el.getAttribute("alt") || "";
                }
            
                const text = el.innerText || el.textContent || "";
                const normalized = helperRuntime.normalizeWhitespace(text);
            
                if (normalized.length <= maxLength) return normalized;
            
                return normalized.slice(0, maxLength) + "…";
            }
            
            function isElementVisible(el: HTMLElement, rect: DOMRect): boolean {
                const style = window.getComputedStyle(el);
            
                if (style.display === "none") return false;
                if (style.visibility === "hidden") return false;
                if (Number(style.opacity) === 0) return false;
            
                if (rect.width <= 0 || rect.height <= 0) return false;
            
                return true;
            }
            
            function getUsefulAttributes(el: HTMLElement): Record<string, string> {
                const allowed = [
                    "id",
                    "class",
                    "name",
                    "title",
                    "alt",
                    "itemprop",
                    "property",
                    "content",
                    "data-testid",
                    "data-test",
                    "data-cy",
                    "aria-label",
                    "role",
                ];
            
                const result: Record<string, string> = {};
            
                for (const attr of allowed) {
                    const value = el.getAttribute(attr);
                    if (!value) continue;
            
                    const clean = helperRuntime.normalizeWhitespace(value);
                    if (!clean) continue;
            
                    result[attr] = clean.slice(0, 300);
                }
            
                return result;
            }
            
            function looksLikeNoise(el: HTMLElement, text: string): boolean {
                const lowercaseText = text.toLowerCase();
            
                const noiseTerms = [
                    "cookie",
                    "privacy policy",
                    "terms of service",
                    "newsletter",
                    "subscribe",
                    "sign up",
                    "login",
                    "log in",
                    "menu",
                    "copyright",
                ];
            
                if (noiseTerms.some(term => lowercaseText.includes(term))) return true;
            
                const closestNoise = el.closest(
                    "[class*='cookie'], [id*='cookie'], [class*='newsletter'], [id*='newsletter'], [class*='modal'], [id*='modal']"
                );
            
                return Boolean(closestNoise);
            }
            
            function scoreElement(input: {
                el: HTMLElement;
                text: string;
                attributes: Record<string, string>;
                isInMainContent: boolean;
                isLikelyNoise: boolean;
            }): number {
                let score = 0;
            
                const tag = input.el.tagName.toLowerCase();
                const textLength = input.text.length;
                const attrText = Object.values(input.attributes).join(" ").toLowerCase();
            
                if (["h1", "h2", "h3"].includes(tag)) score += 0.25;
                if (["p", "li", "dt", "dd", "td", "th"].includes(tag)) score += 0.15;
                if (input.isInMainContent) score += 0.2;
            
                if (input.attributes["itemprop"]) score += 0.25;
                if (input.attributes["data-testid"]) score += 0.25;
                if (input.attributes["data-test"]) score += 0.2;
                if (input.attributes["data-cy"]) score += 0.2;
            
                if (
                    /title|name|price|amount|description|availability|sku|brand|reference|product|model/.test(
                        attrText
                    )
                ) {
                    score += 0.2;
                }
            
                if (textLength >= 2 && textLength <= 120) score += 0.1;
                if (textLength > 120 && textLength <= 800) score += 0.05;
            
                if (input.isLikelyNoise) score -= 0.4;
            
                return Math.max(0, Math.min(1, score));
            }
            
            function getXPath(el: Element): string | null {
                const parts: string[] = [];
                let current: Element | null = el;
            
                while (current && current.nodeType === Node.ELEMENT_NODE) {
                    let index = 1;
                    let sibling = current.previousElementSibling;
            
                    while (sibling) {
                        if (sibling.tagName === current.tagName) index += 1;
                        sibling = sibling.previousElementSibling;
                    }
            
                    parts.unshift(
                        `${current.tagName.toLowerCase()}[${index}]`
                    );
            
                    current = current.parentElement;
                }
            
                return "/" + parts.join("/");
            }
            
            return blocks;
        },
        { maxTextLength }
    );

    return blocks
        .filter(block => !block.isLikelyNoise)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxBlocks);
}
