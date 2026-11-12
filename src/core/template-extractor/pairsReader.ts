import type { Page } from "playwright";
import type { SelectorCandidate } from "../templating/types";

export const MIN_PAIRS = 3;

export type PairsReadResult = {
    pairs: Record<string, string> | null;
    count: number;
    warnings: string[];
};

export async function readPairsSelector(page: Page, selector: SelectorCandidate): Promise<PairsReadResult> {
    if (selector.kind !== "css" && selector.kind !== "xpath") {
        return { pairs: null, count: 0, warnings: [`A pairs field needs a css or xpath selector, not ${selector.kind}.`] };
    }

    const locator = page.locator(selector.kind === "xpath" ? `xpath=${selector.selector}` : selector.selector);
    const matched = await locator.count();
    if (matched === 0) {
        return { pairs: null, count: 0, warnings: [`Selector matched no elements: ${selector.selector}`] };
    }

    const rows = await locator.first().evaluate(readRows);
    const pairs: Record<string, string> = {};
    const warnings: string[] = matched > 1 ? [`Selector matched ${matched} elements; using the first match.`] : [];
    for (const [label, value] of rows) {
        if (label in pairs) warnings.push(`Label "${label}" appears more than once; kept the first value.`);
        else pairs[label] = value;
    }
    return { pairs, count: Object.keys(pairs).length, warnings };
}

export function pairsValue(read: PairsReadResult): { value: Record<string, string> | null; warnings: string[] } {
    if (read.pairs === null) return { value: null, warnings: read.warnings };
    if (read.count < MIN_PAIRS) {
        return { value: null, warnings: [...read.warnings, `Selector read ${read.count} pairs; a pairs field needs ${MIN_PAIRS} or more.`] };
    }
    return { value: read.pairs, warnings: read.warnings };
}

// Runs in the page, so it must not reference anything outside its own body.
function readRows(container: Element): Array<[string, string]> {
    const clean = (element: Element) =>
        ((element instanceof HTMLElement ? element.innerText : element.textContent) ?? "").replace(/\s+/g, " ").trim();
    const asLabel = (text: string) => text.replace(/\s*:$/, "");
    const STRUCTURE = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "DL", "DT", "DD"]);

    const textChildren = (element: Element) => Array.from(element.children).filter(child => clean(child) !== "");
    const pairMemo = new Map<Element, boolean>();
    const rowsMemo = new Map<Element, boolean>();
    const holdsRows = (element: Element): boolean => {
        if (!rowsMemo.has(element)) {
            rowsMemo.set(element, element.matches("tr, dt") || element.querySelector("tr, dt") !== null ||
                isSiblingPair(element) || Array.from(element.children).some(holdsRows));
        }
        return rowsMemo.get(element)!;
    };
    const isSiblingPair = (element: Element): boolean => {
        if (!pairMemo.has(element)) {
            const children = Array.from(element.children);
            pairMemo.set(element, !STRUCTURE.has(element.tagName) && children.length === 2 &&
                children.every(child => clean(child) !== "" && !holdsRows(child)));
        }
        return pairMemo.get(element)!;
    };

    const rows: Array<[string, string]> = [];
    const read = new Set<Element>();
    const insideRead = (element: Element) => {
        for (let node = element.parentElement; node && node !== container; node = node.parentElement) {
            if (read.has(node)) return true;
        }
        return false;
    };

    for (const element of Array.from(container.querySelectorAll("*"))) {
        if (read.has(element) || insideRead(element)) continue;

        if (element.tagName === "TR") {
            const cells = textChildren(element).filter(cell => cell.tagName === "TD" || cell.tagName === "TH");
            if (cells.length >= 2) {
                rows.push([asLabel(clean(cells[0]!)), clean(cells[1]!)]);
                read.add(element);
            }
        } else if (element.tagName === "DT") {
            let next = element.nextElementSibling;
            while (next && next.tagName !== "DD" && next.tagName !== "DT") next = next.nextElementSibling;
            if (next?.tagName === "DD" && clean(element) !== "" && clean(next) !== "") {
                rows.push([asLabel(clean(element)), clean(next)]);
                read.add(element);
                read.add(next);
            }
        } else if (isSiblingPair(element)) {
            const [label, value] = Array.from(element.children);
            rows.push([asLabel(clean(label!)), clean(value!)]);
            read.add(element);
        }
    }
    return rows;
}
