import { z } from "zod";
import type { LinkGroup } from "../extraction/links";
import type { ChatMessage } from "../llm-extractor/providers/LLMProvider";
import { formatPageContext, type PageContextForAgent } from "./authorPrompt";
import { LINK_ROLES, type LinkRole, type LinkSelectorValidation } from "./validateListingSelectors";

export const MAX_LINK_SELECTORS = 4;

export type ClassifyResponse = {
    pageKind: "detail" | "listing";
    itemLinks: string[];
    nextPage: string[];
    pageLinks: string[];
    pageUrlPattern: string;
    itemUrlPattern: string;
};

export type ListingPatternFailures = Partial<Record<"itemUrlPattern" | "pageUrlPattern", string>>;

const SYSTEM_PROMPT = [
    "You decide if a web page is a listing of items or the page of one item, and for a listing you write durable CSS selectors for its links.",
    "The selectors will be reused on every page with the same layout, so they must not depend on this page's specific values.",
    "Answer only with JSON matching the provided schema.",
].join(" ");

const LISTING_RULES = `pageKind:
- "listing": the page's main content is a list or grid of items (products, articles, results), each linking to its own page. Category, archive, search and tag pages are listings.
- "detail": the page shows one item, even when it also links to related items.
Selectors (only for a listing; give empty arrays for a detail page):
- itemLinks: CSS selectors for document.querySelectorAll that match the <a> element of every item in the main list, and nothing else (no navigation, footer, related or sponsored links).
- nextPage: CSS selectors that match the <a> element to the next page of the list. Empty when the page has none.
- pageLinks: CSS selectors that match the <a> elements to the other numbered pages of the list. Empty when the page has none.
Rules:
- Each selector must match <a> elements with an href.
- Give 1 to ${MAX_LINK_SELECTORS} selectors per list, most reliable first.
- Prefer semantic class names, ids, rel="next" and aria labels. Never use :nth-child/:nth-of-type positions, generated class names, or text that only appears on this page.
URL patterns (only for a listing; give "" for a detail page):
- itemUrlPattern is the URL pattern of every item page that the list links to. pageUrlPattern is the URL pattern of this page and of its other pages (next page, numbered pages, and other lists with the same layout).
- Start with "/". Keep as literal text the parts that are the same on every page of the type. Replace the parts that change with a placeholder: ":" and a lowercase name, e.g. "/:brand/:slug--id:id.htm" or "/search/index.htm?query=:q". ":id" stands for digits only; any other placeholder stands for any text without "/". Add query keys only when they identify the page; a URL can have more keys than its pattern.
- Every item link must match itemUrlPattern, and this page's URL must not. This page's URL and its pagination links must match pageUrlPattern, and no item link may.`;

export function buildClassifyResponseSchema(): unknown {
    const selectors = { type: "array", items: { type: "string" } };
    return {
        type: "object",
        properties: {
            pageKind: { type: "string", enum: ["detail", "listing"] },
            itemLinks: selectors,
            nextPage: selectors,
            pageLinks: selectors,
            pageUrlPattern: { type: "string" },
            itemUrlPattern: { type: "string" },
        },
        required: ["pageKind", ...LINK_ROLES, "pageUrlPattern", "itemUrlPattern"],
        additionalProperties: false,
    };
}

const selectorList = z.array(z.unknown()).optional().transform(values =>
    (values ?? [])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map(value => value.trim())
        .slice(0, MAX_LINK_SELECTORS));

const patternText = z.string().optional().transform(value => value?.trim() ?? "");

const classifyResponseSchema = z.object({
    pageKind: z.enum(["detail", "listing"]),
    itemLinks: selectorList,
    nextPage: selectorList,
    pageLinks: selectorList,
    pageUrlPattern: patternText,
    itemUrlPattern: patternText,
});

export function parseClassifyResponse(raw: unknown): ClassifyResponse {
    const parsed = classifyResponseSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`The agent's answer did not match the listing format: ${parsed.error.issues
            .slice(0, 3)
            .map(issue => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`);
    }
    return parsed.data;
}

export function buildClassifyMessages(input: { page: PageContextForAgent; groups: LinkGroup[] }): ChatMessage[] {
    return [
        { role: "system", content: SYSTEM_PROMPT },
        {
            role: "user",
            content: [
                "Is this page a listing or a detail page? For a listing, write the link selectors.",
                LISTING_RULES,
                `Links on this host, grouped by URL pattern:\n${formatGroups(input.groups)}`,
                formatPageContext(input.page),
            ].join("\n\n"),
        },
    ];
}

export function buildListingRepairMessages(input: {
    page: PageContextForAgent;
    groups: LinkGroup[];
    previous: ClassifyResponse;
    failures: Partial<Record<LinkRole, LinkSelectorValidation[]>>;
    patternFailures: ListingPatternFailures;
}): ChatMessage[] {
    const report = Object.entries(input.failures)
        .map(([role, attempts]) => `${role}:\n${attempts!
            .map(attempt => `  - ${JSON.stringify(attempt.selector)}: ${attempt.reason}`)
            .join("\n")}`)
        .join("\n");

    return [
        { role: "system", content: SYSTEM_PROMPT },
        {
            role: "user",
            content: [
                Object.keys(input.failures).length > 0
                    ? `This page is a listing. Your previous selectors failed when run on the live page. Answer pageKind "listing" and write new selectors for ${Object.keys(input.failures).join(", ")} only; give empty arrays for the others.`
                    : `This page is a listing. Your previous selectors worked. Answer pageKind "listing" and give empty selector arrays.`,
                ...(report ? [`Failure report:\n${report}`] : []),
                ...Object.entries(input.patternFailures).map(([key, reason]) =>
                    `Your previous ${key} ${JSON.stringify(input.previous[key as keyof ListingPatternFailures])} failed a check: ${reason}. Write a new ${key}.`),
                LISTING_RULES,
                `Links on this host, grouped by URL pattern:\n${formatGroups(input.groups)}`,
                formatPageContext(input.page),
            ].join("\n\n"),
        },
    ];
}

function formatGroups(groups: LinkGroup[]): string {
    return groups
        .slice(0, 20)
        .map(group => `- ${group.urlPattern}: ${group.count} link(s), e.g. ${group.samples.join(", ")}`)
        .join("\n") || "(none)";
}
