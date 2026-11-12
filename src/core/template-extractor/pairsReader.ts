import type { Page } from "playwright";
import { MIN_PAIRS } from "../llm-extractor/types";
import type { SelectorCandidate } from "../templating/types";

export type PairsReadResult = {
    pairs: Record<string, string> | null;
    warnings: string[];
};

export async function readPairsSelector(page: Page, selector: SelectorCandidate): Promise<PairsReadResult> {
    if (selector.kind !== "css" && selector.kind !== "xpath") {
        return { pairs: null, warnings: [`A pairs field needs a css or xpath selector, not ${selector.kind}.`] };
    }

    const locator = page.locator(selector.kind === "xpath" ? `xpath=${selector.selector}` : selector.selector);
    const matched = await locator.count();
    if (matched === 0) {
        return { pairs: null, warnings: [`Selector matched no elements: ${selector.selector}`] };
    }

    const rows = await locator.first().evaluate(readRows);
    const pairs: Record<string, string> = {};
    const warnings: string[] = matched > 1 ? [`Selector matched ${matched} elements; using the first match.`] : [];
    for (const [label, value] of rows) {
        if (label in pairs) warnings.push(`Label "${label}" appears more than once; kept the first value.`);
        else pairs[label] = value;
    }
    return { pairs, warnings };
}

export function pairsValue(read: PairsReadResult): { value: Record<string, string> | null; warnings: string[] } {
    if (read.pairs === null) return { value: null, warnings: read.warnings };
    const count = Object.keys(read.pairs).length;
    if (count < MIN_PAIRS) {
        return { value: null, warnings: [...read.warnings, `Selector read ${count} pairs; a pairs field needs ${MIN_PAIRS} or more.`] };
    }
    return { value: read.pairs, warnings: read.warnings };
}

// Runs in the page, so it must not reference anything outside its own body.
function readRows(container: Element): Array<[string, string]> {
    const textMemo = new Map<Element, string>();
    const clean = (element: Element): string => {
        if (!textMemo.has(element)) {
            const text = (element instanceof HTMLElement ? element.innerText : element.textContent) ?? "";
            textMemo.set(element, text.replace(/\s+/g, " ").trim());
        }
        return textMemo.get(element)!;
    };
    const asLabel = (text: string) => text.replace(/\s*:$/, "");
    const STRUCTURE = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "DL", "DT", "DD"]);

    const textChildren = (element: Element) => Array.from(element.children).filter(child => clean(child) !== "");
    const pairMemo = new Map<Element, boolean>();
    const groupMemo = new Map<Element, boolean>();
    // Inline parts are one value, such as <b>40</b> <small>mm</small>. A pair of any other element is a row,
    // so an element beside it is a group title, not a label. Tags, not computed style: a snapshot loads
    // no stylesheet, and a live page and its snapshot must give the same pairs.
    const INLINE = new Set(["SPAN", "B", "STRONG", "I", "EM", "SMALL", "A", "SUP", "SUB", "ABBR", "CODE", "LABEL", "FONT", "MARK", "U", "S"]);
    const holdsGroup = (element: Element): boolean => {
        if (!groupMemo.has(element)) groupMemo.set(element, findGroup(element));
        return groupMemo.get(element)!;
    };
    const findGroup = (element: Element): boolean => {
        if (element.matches("tr, dt") || element.querySelector("tr, dt") !== null) return true;
        let pairs = 0;
        for (const candidate of [element, ...Array.from(element.querySelectorAll("*"))]) {
            if (!isSiblingPair(candidate)) continue;
            pairs += 1;
            if (pairs >= 2 || !INLINE.has(candidate.tagName)) return true;
        }
        return false;
    };
    const isSiblingPair = (element: Element): boolean => {
        if (!pairMemo.has(element)) {
            const children = Array.from(element.children);
            pairMemo.set(element, !STRUCTURE.has(element.tagName) && children.length === 2 &&
                children.every(child => clean(child) !== "" && !holdsGroup(child)));
        }
        return pairMemo.get(element)!;
    };

    const rows: Array<[string, string]> = [];
    const read = new Set<Element>();
    // querySelectorAll is in document order, so the descendants of a read element follow it directly.
    let lastRead: Element | null = null;

    for (const element of Array.from(container.querySelectorAll("*"))) {
        if (read.has(element)) {
            lastRead = element;
            continue;
        }
        if (lastRead?.contains(element)) continue;

        if (element.tagName === "TR") {
            const cells = textChildren(element).filter(cell => cell.tagName === "TD" || cell.tagName === "TH");
            if (cells.length >= 2) {
                rows.push([asLabel(clean(cells[0]!)), clean(cells[1]!)]);
                read.add(element);
                lastRead = element;
            }
        } else if (element.tagName === "DT") {
            let next = element.nextElementSibling;
            while (next && next.tagName !== "DD" && next.tagName !== "DT") next = next.nextElementSibling;
            if (next?.tagName === "DD" && clean(element) !== "" && clean(next) !== "") {
                rows.push([asLabel(clean(element)), clean(next)]);
                read.add(element);
                read.add(next);
                lastRead = element;
            }
        } else if (isSiblingPair(element)) {
            const [label, value] = Array.from(element.children);
            rows.push([asLabel(clean(label!)), clean(value!)]);
            read.add(element);
            lastRead = element;
        }
    }
    return rows;
}
