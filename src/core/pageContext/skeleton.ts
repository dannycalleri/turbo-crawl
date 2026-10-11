import type { Page } from "playwright";

export type SkeletonNode = {
    tag: string;
    attrs: string;
    text: string;
    children: SkeletonNode[];
};

export type PageSkeleton = {
    text: string;
    bytes: number;
    truncated: boolean;
};

export const DEFAULT_SKELETON_BYTES = 120_000;
const MAX_REPEATED_SIBLINGS = 3;

export function resolveSkeletonBudget(env: NodeJS.ProcessEnv = process.env): number {
    const value = Number(env.TURBO_CRAWL_SKELETON_BYTES);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SKELETON_BYTES;
}

export async function capturePageSkeleton(
    page: Page,
    maxBytes: number = resolveSkeletonBudget(),
): Promise<PageSkeleton> {
    const root = await page.evaluate(collectSkeletonTree);
    return renderSkeleton(root, maxBytes);
}

// Runs in the browser. Must stay self-contained: Playwright serializes it.
export function collectSkeletonTree(): SkeletonNode | null {
    const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "TEMPLATE", "IFRAME", "LINK", "META", "HEAD", "PATH"]);
    const KEEP_ATTRS = ["itemprop", "itemtype", "aria-label", "role", "name", "type", "href", "src", "content", "datetime", "alt", "title"];

    const isStableClass = (token: string): boolean => {
        if (!token || token.length > 40) return false;
        const lower = token.toLowerCase();
        if (/^[a-f0-9]{6,}$/.test(lower)) return false;
        if (/css-[a-z0-9]{4,}/.test(lower)) return false;
        if (/^_[a-z0-9]+$/.test(lower)) return false;
        if (/\d{4,}/.test(lower)) return false;
        if (/^(sc|jsx|emotion)-/.test(lower)) return false;
        return true;
    };

    const shorten = (value: string, max: number): string => {
        const clean = value.replace(/\s+/g, " ").trim();
        return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
    };

    const isHidden = (element: Element): boolean => {
        if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
        const style = window.getComputedStyle(element);
        return style.display === "none" || style.visibility === "hidden";
    };

    const describe = (element: Element): string => {
        const parts: string[] = [];
        if (element.id && isStableClass(element.id)) parts.push(`#${element.id}`);
        const classes = Array.from(element.classList).filter(isStableClass).slice(0, 4);
        if (classes.length) parts.push(`.${classes.join(".")}`);
        const attrs: string[] = [];
        for (const attr of Array.from(element.attributes)) {
            const name = attr.name;
            if (!(KEEP_ATTRS.includes(name) || name.startsWith("data-"))) continue;
            if (name.startsWith("data-") && attr.value.length > 60) continue;
            attrs.push(`${name}="${shorten(attr.value, 80)}"`);
        }
        if (attrs.length) parts.push(`[${attrs.slice(0, 6).join(" ")}]`);
        return parts.join("");
    };

    const ownText = (element: Element): string => {
        let text = "";
        for (const child of Array.from(element.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) text += ` ${child.textContent ?? ""}`;
        }
        return shorten(text, 80);
    };

    const walk = (element: Element): SkeletonNode | null => {
        if (SKIP.has(element.tagName.toUpperCase()) || isHidden(element)) return null;
        const children: SkeletonNode[] = [];
        for (const child of Array.from(element.children)) {
            const node = walk(child);
            if (node) children.push(node);
        }
        const text = ownText(element);
        const attrs = describe(element);
        return { tag: element.tagName.toLowerCase(), attrs, text, children };
    };

    return document.body ? walk(document.body) : null;
}

export function renderSkeleton(root: SkeletonNode | null, maxBytes: number): PageSkeleton {
    if (!root) {
        return { text: "", bytes: 0, truncated: false };
    }

    const collapsed = collapseTree(root);
    const fullDepth = treeDepth(collapsed);
    let depthLimit = fullDepth;
    let text = renderLines(collapsed, depthLimit).join("\n");

    while (byteLength(text) > maxBytes && depthLimit > 1) {
        depthLimit -= 1;
        text = renderLines(collapsed, depthLimit).join("\n");
    }

    let truncated = depthLimit < fullDepth;

    if (byteLength(text) > maxBytes) {
        const marker = "\n… (skeleton truncated to fit the size budget)";
        text = maxBytes > byteLength(marker)
            ? sliceToBytes(text, maxBytes - byteLength(marker)) + marker
            : sliceToBytes(text, maxBytes);
        truncated = true;
    } else if (truncated) {
        const marker = `\n… (elements deeper than ${depthLimit} levels omitted to fit the size budget)`;
        if (byteLength(text) + byteLength(marker) <= maxBytes) {
            text += marker;
        }
    }

    return { text, bytes: byteLength(text), truncated };
}

function collapseTree(node: SkeletonNode): SkeletonNode {
    // Unwrap anonymous single-child wrappers to keep the outline shallow.
    let current = node;
    while (
        current.children.length === 1 &&
        !current.attrs &&
        !current.text &&
        (current.tag === "div" || current.tag === "span")
    ) {
        current = current.children[0]!;
    }

    const children: SkeletonNode[] = [];
    let runSignature: string | null = null;
    let runLength = 0;

    for (const child of current.children) {
        const collapsedChild = collapseTree(child);
        const signature = `${collapsedChild.tag}${collapsedChild.attrs.replace(/\[.*\]$/, "")}`;

        if (signature === runSignature) {
            runLength += 1;
        } else {
            flushRun(children, runLength);
            runSignature = signature;
            runLength = 1;
        }

        if (runLength <= MAX_REPEATED_SIBLINGS) {
            children.push(collapsedChild);
        }
    }

    flushRun(children, runLength);

    if (!current.text && !current.attrs && children.length === 0) {
        return { ...current, children: [] };
    }

    return { ...current, children };
}

function flushRun(children: SkeletonNode[], runLength: number): void {
    if (runLength > MAX_REPEATED_SIBLINGS) {
        children.push({ tag: "…", attrs: "", text: `+${runLength - MAX_REPEATED_SIBLINGS} more`, children: [] });
    }
}

function renderLines(node: SkeletonNode, depthLimit: number, depth = 0, lines: string[] = []): string[] {
    if (depth >= depthLimit) return lines;

    const isEmptyLeaf = !node.text && !node.attrs && node.children.length === 0;
    if (!isEmptyLeaf) {
        const label = node.tag === "…" ? node.text : `${node.tag}${node.attrs}${node.text ? ` "${node.text}"` : ""}`;
        lines.push(`${"  ".repeat(depth)}${label}`);
    }

    for (const child of node.children) {
        renderLines(child, depthLimit, depth + 1, lines);
    }

    return lines;
}

function treeDepth(node: SkeletonNode): number {
    return 1 + node.children.reduce((max, child) => Math.max(max, treeDepth(child)), 0);
}

function byteLength(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

function sliceToBytes(text: string, maxBytes: number): string {
    const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes);
    return buffer.toString("utf8").replace(/�$/, "");
}
