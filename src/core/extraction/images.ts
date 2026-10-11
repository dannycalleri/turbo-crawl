import type { Page } from "playwright";

export type ImageBlock = {
    nodeId: string;
    src: string;
    alt: string | null;
    width: number | null;
    height: number | null;
    cssPath: string;
    score: number;
};


export async function extractImages(page: Page): Promise<ImageBlock[]> {
    const images = await page.evaluate(() => {
        const helpers = window.__turboCrawl;
        if (!helpers) {
            throw new Error("Turbo Crawl page helpers are not installed.");
        }

        const nodes = Array.from(document.querySelectorAll('img'));
        const result: ImageBlock[] = [];

        let counter = 1;

        for (const image of nodes) {
            if (!(image instanceof HTMLImageElement)) continue;

            const src = image.currentSrc || image.src;
            if (!src) continue;

            const rect = image.getBoundingClientRect();

            const width = image.naturalWidth || Math.round(rect.width) || null;
            const height = image.naturalHeight || Math.round(rect.height) || null;
            const alt = image.alt?.trim() || null;

            result.push({
                nodeId: `img_${String(counter).padStart(3, "0")}`,
                src,
                alt,
                width,
                height,
                cssPath: helpers.getCssPath(image),
                score: scoreImage(image, alt, width, height),
            });

            counter += 1;
        }

        function scoreImage(
            img: HTMLImageElement,
            alt: string | null,
            width: number | null,
            height: number | null
        ): number {
            let score = 0;
        
            if (alt) score += 0.25;
            if (width && height && width >= 300 && height >= 300) score += 0.25;
            if (img.closest("main, article, [role='main']")) score += 0.25;
        
            const attrText = [
                img.className,
                img.id,
                img.getAttribute("data-testid"),
                img.getAttribute("itemprop"),
            ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
        
            if (/product|main|hero|image|gallery|watch/.test(attrText)) score += 0.25;
            if (img.closest("header, footer, nav")) score -= 0.25;
        
            return Math.max(0, Math.min(1, score));
        }
        
        return result;
    });

    return images
        .sort((a, b) => b.score - a.score)
        .slice(0, 50);
}
