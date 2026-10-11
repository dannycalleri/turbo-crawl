import type { PagePacket } from "../types";
import type { FieldType } from "../llm-extractor/types";
import type { SelectorCandidate } from "./types";
import { dedupeAndSortCandidates } from "./dedupeAndSortCandidates";

export function generateDomCandidates(input: {
    domNode: PagePacket["visibleBlocks"][number];
    fieldName: string;
    fieldType: FieldType;
}): SelectorCandidate[] {
    const { domNode, fieldName, fieldType } = input;
    const attrs = domNode.attributes ?? {};
    const tag = domNode.tag;

    const candidates: SelectorCandidate[] = [];

    const attribute = inferDomExtractionAttribute(domNode, fieldType);

    // 1. itemprop is usually very reusable.
    if (attrs.itemprop) {
        candidates.push({
            kind: "css",
            selector: `[itemprop="${escapeCssString(attrs.itemprop)}"]`,
            attribute,
            score: 95,
            reusable: true,
        });
    }

    // 2. test attributes are usually stable.
    for (const attr of ["data-testid", "data-test", "data-cy"]) {
        const value = attrs[attr];

        if (value && isStableToken(value)) {
            candidates.push({
                kind: "css",
                selector: `[${attr}="${escapeCssString(value)}"]`,
                attribute,
                score: 92,
                reusable: true,
            });
        }
    }

    // 3. stable id.
    if (attrs.id && isStableToken(attrs.id) && !looksEntitySpecific(attrs.id, domNode.text)) {
        candidates.push({
            kind: "css",
            selector: `#${cssEscape(attrs.id)}`,
            attribute,
            score: 82,
            reusable: true,
        });
    }

    // 4. useful class selector.
    const stableClasses = getStableClasses(attrs.class);

    if (stableClasses.length > 0) {
        candidates.push({
            kind: "css",
            selector: `${tag}${stableClasses
                .slice(0, 2)
                .map(cls => `.${cssEscape(cls)}`)
                .join("")}`,
            attribute,
            score: scoreClassSelector(stableClasses, fieldName),
            reusable: true,
        });
    }

    // 5. Field-specific generic selectors.
    const genericSelector = buildFieldSpecificSelector(fieldName, fieldType);

    if (genericSelector) {
        candidates.push({
            kind: "css",
            selector: genericSelector,
            attribute: "textContent",
            score: 60,
            reusable: true,
        });
    }

    // 6. CSS path fallback. Useful mostly on same layout.
    if (domNode.cssPath) {
        candidates.push({
            kind: "css",
            selector: domNode.cssPath,
            attribute,
            score: 35,
            reusable: false,
        });
    }

    // 7. XPath fallback.
    if (domNode.xpath) {
        candidates.push({
            kind: "xpath",
            selector: domNode.xpath,
            attribute,
            score: 25,
            reusable: false,
        });
    }

    return dedupeAndSortCandidates(candidates);
}

function inferDomExtractionAttribute(
    domNode: PagePacket["visibleBlocks"][number],
    fieldType: FieldType
): SelectorCandidate["attribute"] {
    if (fieldType === "url") {
        if (domNode.href) return "href";
        if (domNode.src) return "src";
    }

    return "textContent";
}

function buildFieldSpecificSelector(
    fieldName: string,
    fieldType: FieldType
): string | null {
    const name = fieldName.toLowerCase();

    if (name.includes("price") || name.includes("amount")) {
        return [
            "[itemprop='price']",
            "[class*='price' i]",
            "[id*='price' i]",
            "[data-testid*='price' i]",
            "[data-test*='price' i]"
        ].join(", ");
    }

    if (name.includes("description")) {
        return [
            "[itemprop='description']",
            "[class*='description' i]",
            "[id*='description' i]"
        ].join(", ");
    }

    if (
        name.includes("name") ||
        name.includes("title") ||
        name.includes("model")
    ) {
        return [
            "[itemprop='name']",
            "main h1",
            "article h1",
            "h1"
        ].join(", ");
    }

    if (name.includes("brand")) {
        return [
            "[itemprop='brand']",
            "[class*='brand' i]",
            "[id*='brand' i]"
        ].join(", ");
    }

    if (
        name.includes("available") ||
        name.includes("availability") ||
        name.includes("stock")
    ) {
        return [
            "[itemprop='availability']",
            "[class*='stock' i]",
            "[class*='availability' i]",
            "[id*='stock' i]",
            "[id*='availability' i]"
        ].join(", ");
    }

    if (fieldType === "url") {
        return "link[rel='canonical'], meta[property='og:url']";
    }

    return null;
}

function getStableClasses(className?: string): string[] {
    if (!className) return [];

    return className
        .split(/\s+/)
        .map(cls => cls.trim())
        .filter(Boolean)
        .filter(isStableToken)
        .filter(cls => !looksLikeUtilityClass(cls))
        .filter(cls => !looksGeneratedClass(cls));
}

function isStableToken(token: string): boolean {
    if (!token) return false;
    if (token.length > 80) return false;

    const lower = token.toLowerCase();

    // Hash-like or generated.
    if (/^[a-f0-9]{8,}$/.test(lower)) return false;
    if (/^css-[a-z0-9]+/.test(lower)) return false;
    if (/^sc-[a-z0-9]+/.test(lower)) return false;
    if (/^jsx-[a-z0-9]+/.test(lower)) return false;

    // Often generated by CSS modules/build tools.
    if (/\d{5,}/.test(lower)) return false;

    return true;
}

function looksGeneratedClass(cls: string): boolean {
    return /^css-|^sc-|^jsx-|^_[a-z0-9]+/.test(cls);
}

function looksLikeUtilityClass(cls: string): boolean {
    return /^(mt|mb|ml|mr|mx|my|pt|pb|pl|pr|px|py|p|m|text|bg|flex|grid|hidden|block|inline|w|h|gap|items|justify|rounded|shadow)-/.test(
        cls
    );
}

function looksEntitySpecific(token: string, valueText?: string): boolean {
    if (!valueText) return false;

    const tokenLower = token.toLowerCase();
    const words = valueText
        .toLowerCase()
        .split(/\s+/)
        .filter(word => word.length >= 4);

    return words.some(word => tokenLower.includes(word));
}

function scoreClassSelector(classes: string[], fieldName: string): number {
    const joined = classes.join(" ").toLowerCase();
    const field = fieldName.toLowerCase();

    let score = 65;

    if (field.includes("price") && /price|amount/.test(joined)) score += 15;
    if (field.includes("description") && /description|details/.test(joined)) score += 15;
    if ((field.includes("name") || field.includes("title")) && /name|title|product|model/.test(joined)) score += 15;
    if (field.includes("brand") && /brand|manufacturer/.test(joined)) score += 15;

    return Math.min(score, 85);
}

function cssEscape(value: string): string {
    return value.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, "\\$1");
}

function escapeCssString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}