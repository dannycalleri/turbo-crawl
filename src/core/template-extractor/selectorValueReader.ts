import type { Page } from "playwright";
import type { PagePacket } from "../types";
import type { SelectorCandidate } from "../templating/types";

export type SelectorValueReadResult = {
    rawValue: string | null;
    warnings: string[];
};

export async function readSelectorValue(input: {
    page: Page;
    pagePacket: PagePacket;
    selector: SelectorCandidate;
}): Promise<SelectorValueReadResult> {
    switch (input.selector.kind) {
        case "jsonld":
            return readJsonLdSelector(input.pagePacket, input.selector);

        case "meta":
            return readMetaSelector(input.pagePacket, input.selector);

        case "css":
        case "xpath":
            return readDomSelector(input.page, input.selector);

        case "table":
            return readTableSelector(input.pagePacket, input.selector);
    }
}

export function readJsonLdSelector(
    pagePacket: PagePacket,
    selector: SelectorCandidate
): SelectorValueReadResult {
    const parsed = parseJsonLdSelector(selector.selector);

    if (!parsed) {
        return {
            rawValue: null,
            warnings: [`Invalid JSON-LD selector: ${selector.selector}`],
        };
    }

    const block = pagePacket.jsonLd.find(node => node.nodeId === parsed.nodeId);

    if (!block) {
        return {
            rawValue: null,
            warnings: [`JSON-LD node not found: ${parsed.nodeId}`],
        };
    }

    const value = readJsonPath(block.data, parsed.path);

    if (value === undefined || value === null) {
        return {
            rawValue: null,
            warnings: [`JSON-LD path not found: ${selector.selector}`],
        };
    }

    return {
        rawValue: stringifyRawValue(value),
        warnings: [],
    };
}

export function readMetaSelector(
    pagePacket: PagePacket,
    selector: SelectorCandidate
): SelectorValueReadResult {
    if (selector.selector === "@currentUrl") {
        return {
            rawValue: normalizeRawValue(pagePacket.finalUrl || pagePacket.url),
            warnings: [],
        };
    }

    const parsed = parseMetaSelector(selector.selector);

    if (!parsed) {
        return {
            rawValue: null,
            warnings: [`Invalid metadata selector: ${selector.selector}`],
        };
    }

    const { cssSelector, attribute } = parsed;

    if (attribute !== "content" && attribute !== "href") {
        return {
            rawValue: null,
            warnings: [`Unsupported metadata attribute: ${attribute}`],
        };
    }

    if (cssSelector === "link[rel='canonical']" && attribute === "href") {
        return {
            rawValue: normalizeRawValue(pagePacket.metadata.canonicalUrl),
            warnings: [],
        };
    }

    const metaName = readQuotedSelectorValue(cssSelector, "name");
    if (metaName && attribute === "content") {
        return {
            rawValue: normalizeRawValue(readMetaName(pagePacket, metaName)),
            warnings: [],
        };
    }

    const metaProperty = readQuotedSelectorValue(cssSelector, "property");
    if (metaProperty && attribute === "content") {
        return {
            rawValue: normalizeRawValue(
                pagePacket.metadata.openGraph[metaProperty] ??
                pagePacket.metadata.other[metaProperty] ??
                null
            ),
            warnings: [],
        };
    }

    return {
        rawValue: null,
        warnings: [`Unsupported metadata selector: ${selector.selector}`],
    };
}

export function readTableSelector(
    pagePacket: PagePacket,
    selector: SelectorCandidate
): SelectorValueReadResult {
    const parsed = parseTableSelector(selector.selector);

    if (!parsed) {
        return {
            rawValue: null,
            warnings: [`Invalid table selector: ${selector.selector}`],
        };
    }

    if (parsed.mode === "cell") {
        const table = pagePacket.tables.find(node => node.nodeId === parsed.nodeId);

        if (!table) {
            return {
                rawValue: null,
                warnings: [`Table node not found: ${parsed.nodeId}`],
            };
        }

        return {
            rawValue: normalizeRawValue(table.rows[parsed.rowIndex]?.[parsed.cellIndex]),
            warnings: [],
        };
    }

    const tables = parsed.nodeId
        ? pagePacket.tables.filter(node => node.nodeId === parsed.nodeId)
        : pagePacket.tables;

    if (parsed.nodeId && tables.length === 0) {
        return {
            rawValue: null,
            warnings: [`Table node not found: ${parsed.nodeId}`],
        };
    }

    const label = normalizeTableText(parsed.label);

    for (const table of tables) {
        for (const row of table.rows) {
            for (const [cellIndex, cell] of row.entries()) {
                if (normalizeTableText(cell) !== label) {
                    continue;
                }

                const value = row
                    .slice(cellIndex + 1)
                    .map(cellValue => normalizeRawValue(cellValue))
                    .find(cellValue => cellValue !== null);

                if (value !== undefined) {
                    return {
                        rawValue: value,
                        warnings: [],
                    };
                }
            }
        }
    }

    return {
        rawValue: null,
        warnings: [`Table label not found: ${parsed.label}`],
    };
}

export function parseTableSelector(
    selector: string
):
    | { mode: "label"; nodeId: string | null; label: string }
    | { mode: "cell"; nodeId: string; rowIndex: number; cellIndex: number }
    | null {
    if (selector.startsWith("label=")) {
        return {
            mode: "label",
            nodeId: null,
            label: decodeSelectorValue(selector.slice("label=".length)),
        };
    }

    const labelSeparator = ":label=";
    const labelIndex = selector.indexOf(labelSeparator);

    if (labelIndex > 0) {
        return {
            mode: "label",
            nodeId: selector.slice(0, labelIndex),
            label: decodeSelectorValue(selector.slice(labelIndex + labelSeparator.length)),
        };
    }

    const cellSeparator = ":cell=";
    const cellIndex = selector.indexOf(cellSeparator);

    if (cellIndex <= 0) {
        return null;
    }

    const nodeId = selector.slice(0, cellIndex);
    const [rawRowIndex, rawCellIndex] = selector
        .slice(cellIndex + cellSeparator.length)
        .split(",");
    const rowIndex = Number(rawRowIndex);
    const columnIndex = Number(rawCellIndex);

    if (
        !nodeId ||
        !Number.isInteger(rowIndex) ||
        rowIndex < 0 ||
        !Number.isInteger(columnIndex) ||
        columnIndex < 0
    ) {
        return null;
    }

    return {
        mode: "cell",
        nodeId,
        rowIndex,
        cellIndex: columnIndex,
    };
}

export function parseJsonLdSelector(
    selector: string
): { nodeId: string; path: string } | null {
    const separatorIndex = selector.indexOf(":");

    if (separatorIndex <= 0) return null;

    const nodeId = selector.slice(0, separatorIndex);
    const path = selector.slice(separatorIndex + 1);

    if (!nodeId || !path.startsWith("$")) return null;

    return { nodeId, path };
}

export function readJsonPath(data: unknown, path: string): unknown {
    if (path === "$") return data;
    if (!path.startsWith("$")) return undefined;

    let current = data;
    let index = 1;

    while (index < path.length) {
        if (path[index] === ".") {
            const nextSeparator = findNextPathSeparator(path, index + 1);
            const key = path.slice(index + 1, nextSeparator);

            if (!key || !isRecord(current)) return undefined;

            current = current[key];
            index = nextSeparator;
            continue;
        }

        if (path[index] === "[") {
            const closeIndex = path.indexOf("]", index);

            if (closeIndex === -1) return undefined;

            const rawArrayIndex = path.slice(index + 1, closeIndex);
            const arrayIndex = Number(rawArrayIndex);

            if (
                !Number.isInteger(arrayIndex) ||
                arrayIndex < 0 ||
                !Array.isArray(current)
            ) {
                return undefined;
            }

            current = current[arrayIndex];
            index = closeIndex + 1;
            continue;
        }

        return undefined;
    }

    return current;
}

async function readDomSelector(
    page: Page,
    selector: SelectorCandidate
): Promise<SelectorValueReadResult> {
    const warnings: string[] = [];
    const locatorSelector =
        selector.kind === "xpath"
            ? `xpath=${selector.selector}`
            : selector.selector;

    const locator = page.locator(locatorSelector);
    const count = await locator.count();

    if (count === 0) {
        return {
            rawValue: null,
            warnings: [`Selector matched no elements: ${selector.selector}`],
        };
    }

    if (count > 1) {
        warnings.push(`Selector matched ${count} elements; using the first match.`);
    }

    const first = locator.first();
    const rawValue = await readDomAttribute(first, selector.attribute);

    return {
        rawValue: normalizeRawValue(rawValue),
        warnings,
    };
}

async function readDomAttribute(
    locator: ReturnType<Page["locator"]>,
    attribute: SelectorCandidate["attribute"]
): Promise<string | null> {
    if (attribute === "textContent" || attribute === "json") {
        return locator.textContent();
    }

    if (attribute === "content") {
        return locator.getAttribute("content");
    }

    if (attribute === "href" || attribute === "src") {
        return locator.evaluate((element, attr) => {
            if (attr === "href" && element instanceof HTMLAnchorElement) {
                return element.href;
            }

            if (attr === "src" && element instanceof HTMLImageElement) {
                return element.currentSrc || element.src;
            }

            return element.getAttribute(attr);
        }, attribute);
    }

    return null;
}

function parseMetaSelector(
    selector: string
): { cssSelector: string; attribute: string } | null {
    const attributeSeparator = selector.lastIndexOf("@");

    if (attributeSeparator <= 0 || attributeSeparator === selector.length - 1) {
        return null;
    }

    return {
        cssSelector: selector.slice(0, attributeSeparator),
        attribute: selector.slice(attributeSeparator + 1),
    };
}

function readMetaName(pagePacket: PagePacket, name: string): string | null {
    if (name === "description") return pagePacket.metadata.description;
    if (name === "robots") return pagePacket.metadata.robots;
    if (name.startsWith("twitter:")) return pagePacket.metadata.twitter[name] ?? null;

    return pagePacket.metadata.other[name] ?? null;
}

function readQuotedSelectorValue(selector: string, attribute: string): string | null {
    const singleQuoted = new RegExp(`^meta\\[${attribute}='([^']+)'\\]$`).exec(selector);
    if (singleQuoted) return singleQuoted[1] ?? null;

    const doubleQuoted = new RegExp(`^meta\\[${attribute}="([^"]+)"\\]$`).exec(selector);
    if (doubleQuoted) return doubleQuoted[1] ?? null;

    return null;
}

function findNextPathSeparator(path: string, start: number): number {
    const dotIndex = path.indexOf(".", start);
    const bracketIndex = path.indexOf("[", start);

    if (dotIndex === -1) return bracketIndex === -1 ? path.length : bracketIndex;
    if (bracketIndex === -1) return dotIndex;

    return Math.min(dotIndex, bracketIndex);
}

function stringifyRawValue(value: unknown): string | null {
    if (typeof value === "string") return normalizeRawValue(value);
    if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
    ) {
        return String(value);
    }

    return normalizeRawValue(JSON.stringify(value));
}

function normalizeRawValue(value: string | null | undefined): string | null {
    if (value == null) return null;

    const normalized = value.replace(/\s+/g, " ").trim();

    return normalized || null;
}

function normalizeTableText(value: string): string {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function decodeSelectorValue(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
