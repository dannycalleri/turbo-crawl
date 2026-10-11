import type { Page } from "playwright";

export type TableBlock = {
    nodeId: string;
    cssPath: string;
    headers: string[];
    rows: string[][];
    score: number;
};


export async function extractTables(page: Page): Promise<TableBlock[]> {
    const tables = await page.evaluate(() => {
        const helpers = window.__turboCrawl;
        if (!helpers) {
            throw new Error("Turbo Crawl page helpers are not installed.");
        }

        const nodes = Array.from(document.querySelectorAll("table"));
        const result: TableBlock[] = [];

        let counter = 1;

        for (const table of nodes) {
            if (!(table instanceof HTMLTableElement)) continue;

            const headers = Array.from(table.querySelectorAll("thead th"))
                .map(th => helpers.normalizeWhitespace(th.textContent || ""))
                .filter(Boolean);

            const rows = Array.from(table.querySelectorAll("tr"))
                .map(row =>
                    Array.from(row.querySelectorAll("th, td"))
                        .map(cell => helpers.normalizeWhitespace(cell.textContent || ""))
                        .filter(Boolean)
                )
                .filter(row => row.length > 0)
                .slice(0, 50);

            if (rows.length === 0) continue;

            result.push({
                nodeId: `table_${String(counter).padStart(3, "0")}`,
                cssPath: helpers.getCssPath(table),
                headers,
                rows,
                score: scoreTable(table, rows),
            });

            counter += 1;
        }

        function scoreTable(table: HTMLTableElement, rows: string[][]): number {
            let score = 0;
        
            if (rows.length >= 2) score += 0.25;
            if (table.closest("main, article, [role='main']")) score += 0.25;
        
            const text = table.textContent?.toLowerCase() || "";
        
            if (/spec|reference|diameter|movement|case|price|brand|model/.test(text)) {
                score += 0.35;
            }
        
            if (table.closest("header, footer, nav")) score -= 0.25;
        
            return Math.max(0, Math.min(1, score));
        }
        
        return result;
    });

    return tables
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
}
