import { z } from "zod";
import type { ChatMessage } from "../llm-extractor/providers/LLMProvider";
import type { UserSchema } from "../llm-extractor/types";
import type { PagePacket } from "../types";
import type { PatternAnswer } from "./checkUrlPattern";
import type { SelectorValidation } from "./validateSelectors";

export const AUTHOR_SELECTOR_KINDS = ["jsonld", "meta", "css", "table"] as const;
const PAIRS_SELECTOR_KINDS = ["css", "xpath"] as const;
const ALL_SELECTOR_KINDS = ["jsonld", "meta", "css", "table", "xpath"] as const;
export const AUTHOR_ATTRIBUTES = ["textContent", "href", "src", "content", "json"] as const;
const ANY_ATTRIBUTE = /^attr:[A-Za-z_:][-A-Za-z0-9_:.]*$/;
export const MAX_SELECTORS_PER_FIELD = 4;
export const MAX_PROMPT_LINKS = 80;
const MAX_EXAMPLE_LINKS = 10;

export type AuthoredSelector = {
    kind: typeof ALL_SELECTOR_KINDS[number];
    selector: string;
    attribute: typeof AUTHOR_ATTRIBUTES[number] | `attr:${string}`;
};

export type AuthoredField = {
    selectors: AuthoredSelector[];
    expectedSample: string | null;
};

export type AuthorResponse = {
    fields: Record<string, AuthoredField>;
    pattern: PatternAnswer | null;
};

export type PageContextForAgent = {
    url: string;
    urlPattern?: string;
    skeleton: string;
    pagePacket: PagePacket;
};

const SYSTEM_PROMPT = [
    "You write durable scraping selectors for a web page template.",
    "The template will be reused on every page that matches the same URL pattern, so selectors must not depend on this page's specific values.",
    "Answer only with JSON matching the provided schema.",
].join(" ");

const SELECTOR_RULES = `Selector formats (kind → selector → attribute):
- jsonld → "<nodeId>:$.path.to.value" using a nodeId listed under JSON-LD, e.g. "jsonld_01:$.offers.price" → "json"
- meta → "meta[property='og:title']@content", "meta[name='description']@content", "link[rel='canonical']@href", or "@currentUrl" → "content" (use "href" for the canonical link)
- css → a CSS selector for document.querySelector → "textContent", "href", "src", "content", or "attr:<name>" for any other attribute (e.g. "attr:datetime" on a time element)
- table → "label=<exact row label>" reads the cell next to that label in an HTML table → "textContent"
Rules:
- Give 1 to ${MAX_SELECTORS_PER_FIELD} selectors per field, most reliable first. Different kinds as fallbacks are good.
- Prefer JSON-LD and meta when they hold the value; then semantic CSS (itemprop, data-* attributes, ids, meaningful class names).
- When the value is visible on the page, include at least one css selector for it: the template is matched to pages by its page-body selectors.
- For date fields, prefer machine-readable dates: JSON-LD datePublished, meta[property='article:published_time']@content, or time[datetime] with "attr:datetime". Dates written in words are not accepted.
- Never use :nth-child/:nth-of-type positions, generated class names, or text that only appears on this page.
- The selector must point at the element holding just the value (e.g. the price element, not its whole card).
- expectedSample is the raw text you expect the first selector to read on this page, or null if the field is absent.`;

const PAIRS_RULES = `Pairs fields (type pairs):
- A pairs field reads every label/value row inside one element: table rows, dt/dd pairs, or elements with a label child and a value child.
- Give a css selector, or an xpath selector, for the element that holds all the rows, e.g. the specification table or list. This replaces the rule about the element holding just the value.
- Do not point at one row. The template is reused on pages with other rows, so the selector must find the whole group.
- expectedSample is the label of one row on this page, e.g. "Diameter", not its value.`;

export const PATTERN_SYNTAX = `- Start with "/". Keep as literal text the parts that are the same on every page of the type. Replace the parts that change from page to page with a placeholder: ":" and a lowercase name, e.g. "/:brand/:slug--id:id.htm", "/search/index.htm?query=:q" or "/index.php?product_id=:id&route=product/product". ":id" stands for digits only; any other placeholder stands for any text without "/". Add query keys only when they identify the page; a URL can have more keys than its pattern.`;

const PATTERN_RULES = `URL pattern:
- urlPattern is the URL pattern of every page of the same type as this page on this site.
${PATTERN_SYNTAX}
- sameTypeLinks: up to ${MAX_EXAMPLE_LINKS} links from the list of same-site links that are pages of the same type. otherTypeLinks: up to ${MAX_EXAMPLE_LINKS} links from that list that are pages of other types (listings, categories, help pages). Copy each link exactly.
- The pattern must match this page's URL and every sameTypeLinks link, and must not match any otherTypeLinks link.`;

export function buildAuthorResponseSchema(schema: UserSchema, askPattern: boolean): unknown {
    const fieldNames = Object.keys(schema);
    const selectorSchema = (kinds: readonly string[]) => ({
        type: "object",
        properties: {
            kind: { type: "string", enum: [...kinds] },
            selector: { type: "string" },
            attribute: {
                type: "string",
                description: `One of ${AUTHOR_ATTRIBUTES.join(", ")}, or attr:<name> for any other HTML attribute.`,
            },
        },
        required: ["kind", "selector", "attribute"],
        additionalProperties: false,
    });
    const fieldSchema = (kinds: readonly string[]) => ({
        type: "object",
        properties: {
            selectors: { type: "array", items: selectorSchema(kinds) },
            expectedSample: { type: ["string", "null"] },
        },
        required: ["selectors", "expectedSample"],
        additionalProperties: false,
    });

    const links = { type: "array", items: { type: "string" }, maxItems: MAX_EXAMPLE_LINKS };
    const patternProperties = askPattern
        ? { urlPattern: { type: "string" }, sameTypeLinks: links, otherTypeLinks: links }
        : {};

    return {
        type: "object",
        properties: {
            fields: {
                type: "object",
                properties: Object.fromEntries(fieldNames.map(name =>
                    [name, fieldSchema(schema[name] === "pairs" ? PAIRS_SELECTOR_KINDS : AUTHOR_SELECTOR_KINDS)])),
                required: fieldNames,
                additionalProperties: false,
            },
            ...patternProperties,
        },
        required: ["fields", ...Object.keys(patternProperties)],
        additionalProperties: false,
    };
}

const patternAnswerSchema = z.object({
    urlPattern: z.string(),
    sameTypeLinks: z.array(z.string()).transform(links => links.slice(0, MAX_EXAMPLE_LINKS)),
    otherTypeLinks: z.array(z.string()).transform(links => links.slice(0, MAX_EXAMPLE_LINKS)),
});

const selectorOfKinds = <K extends string>(kinds: readonly [K, ...K[]]) => z.object({
    kind: z.enum(kinds),
    selector: z.string().min(1),
    attribute: z.union([z.enum(AUTHOR_ATTRIBUTES), z.string().regex(ANY_ATTRIBUTE).transform(value => value as `attr:${string}`)]),
});
const authoredSelectorSchema = selectorOfKinds(AUTHOR_SELECTOR_KINDS);
// Keeps a selector of another kind, so the validation can tell the agent that a pairs field needs css or xpath.
const pairsSelectorSchema = selectorOfKinds(ALL_SELECTOR_KINDS);

export function parseAuthorResponse(raw: unknown, schema: UserSchema): AuthorResponse {
    const fieldsShape = Object.fromEntries(
        Object.keys(schema).map(name => [
            name,
            z.object({
                selectors: z.array(z.unknown()),
                expectedSample: z.string().nullable().optional(),
            }),
        ]),
    );
    const parsed = z.object({ fields: z.object(fieldsShape) }).safeParse(raw);

    if (!parsed.success) {
        throw new Error(`The agent's answer did not match the template format: ${parsed.error.issues
            .slice(0, 3)
            .map(issue => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`);
    }

    const fields: Record<string, AuthoredField> = {};
    for (const name of Object.keys(schema)) {
        const field = parsed.data.fields[name]!;
        const selectorSchema = schema[name] === "pairs" ? pairsSelectorSchema : authoredSelectorSchema;
        fields[name] = {
            // Drop individual malformed selectors instead of failing the whole answer.
            selectors: field.selectors
                .map(selector => selectorSchema.safeParse(selector))
                .filter(result => result.success)
                .map(result => result.data)
                .slice(0, MAX_SELECTORS_PER_FIELD),
            expectedSample: field.expectedSample ?? null,
        };
    }

    const pattern = patternAnswerSchema.safeParse(raw);
    return { fields, pattern: pattern.success ? pattern.data : null };
}

export function buildAuthorMessages(input: {
    schema: UserSchema;
    page: PageContextForAgent;
    links: string[];
}): ChatMessage[] {
    return [
        { role: "system", content: SYSTEM_PROMPT },
        {
            role: "user",
            content: [
                `Write a template for these fields (name: type): ${formatSchema(input.schema)}`,
                SELECTOR_RULES,
                ...pairsRules(input.schema),
                PATTERN_RULES,
                formatPageContext(input.page),
                formatLinks(input.links),
            ].join("\n\n"),
        },
    ];
}

export function buildRepairMessages(input: {
    schema: UserSchema;
    page: PageContextForAgent;
    previous: AuthorResponse;
    failures: Record<string, SelectorValidation[]>;
    links: string[];
    patternFailure: string | null;
    bodyMissing: boolean;
}): ChatMessage[] {
    const failedFields = Object.keys(input.failures);
    const report = failedFields
        .map(name => {
            const attempts = input.failures[name]!;
            const lines = attempts.length === 0
                ? ["  (no selectors were given)"]
                : attempts.map(attempt =>
                    `  - ${attempt.selector.kind} ${JSON.stringify(attempt.selector.selector)} @${attempt.selector.attribute}: ${attempt.reason}${attempt.rawValue !== null ? ` (read ${JSON.stringify(truncate(attempt.rawValue, 120))})` : ""}`);
            return `${name} (${input.schema[name]}):\n${lines.join("\n")}`;
        })
        .join("\n");

    const repairSchema = Object.fromEntries(failedFields.map(name => [name, input.schema[name]!])) as UserSchema;

    const askSelectors = failedFields.length > 0 || input.bodyMissing;
    const askPattern = input.patternFailure !== null;
    const parts: string[] = [];
    if (failedFields.length > 0) {
        parts.push(
            `Your previous selectors for some fields failed when run on the live page. Write new selectors for these fields only: ${formatSchema(repairSchema)}`,
            `Failure report:\n${report}`,
        );
    }
    if (input.bodyMissing) {
        parts.push(`None of your working selectors is a css selector, and the template is matched to pages by its page-body selectors. Write a css selector for each field whose value is visible on the page: ${formatSchema(input.schema)}. Leave the others empty.`);
    }
    parts.push(askSelectors ? SELECTOR_RULES : "Your previous selectors all worked. Leave fields empty.");
    if (askSelectors) parts.push(...pairsRules(input.bodyMissing ? input.schema : repairSchema));
    if (askPattern) {
        parts.push(
            `Your previous urlPattern ${JSON.stringify(input.previous.pattern?.urlPattern ?? null)} failed a check: ${input.patternFailure}. Write a new urlPattern, sameTypeLinks and otherTypeLinks.`,
            PATTERN_RULES,
        );
    }
    parts.push(formatPageContext(input.page));
    if (askPattern) parts.push(formatLinks(input.links));

    return [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: parts.join("\n\n") },
    ];
}

function pairsRules(schema: UserSchema): string[] {
    return Object.values(schema).includes("pairs") ? [PAIRS_RULES] : [];
}

function formatLinks(links: string[]): string {
    return `Same-site links on this page:\n${links.join("\n") || "(none)"}`;
}

function formatSchema(schema: UserSchema): string {
    return Object.entries(schema).map(([name, type]) => `${name}: ${type}`).join(", ");
}

export function formatPageContext(page: PageContextForAgent): string {
    const { pagePacket } = page;
    const sections = [
        `URL: ${page.url}`,
        ...(page.urlPattern ? [`URL pattern: ${page.urlPattern}`] : []),
        `Page title: ${pagePacket.title ?? "(none)"}`,
        `Meta tags:\n${formatMeta(pagePacket) || "(none)"}`,
        `JSON-LD:\n${formatJsonLd(pagePacket) || "(none)"}`,
        `Tables:\n${formatTables(pagePacket) || "(none)"}`,
        `Page structure (tag#id.classes[attributes] "own text"; indentation is nesting):\n${page.skeleton}`,
    ];
    return sections.join("\n\n");
}

function formatMeta(pagePacket: PagePacket): string {
    const { metadata } = pagePacket;
    const lines: string[] = [];
    if (metadata.canonicalUrl) lines.push(`link[rel='canonical']@href = ${JSON.stringify(metadata.canonicalUrl)}`);
    if (metadata.description) lines.push(`meta[name='description']@content = ${JSON.stringify(truncate(metadata.description, 200))}`);
    for (const [key, value] of Object.entries(metadata.openGraph)) {
        lines.push(`meta[property='${key}']@content = ${JSON.stringify(truncate(value, 200))}`);
    }
    for (const [key, value] of Object.entries(metadata.twitter)) {
        lines.push(`meta[name='${key}']@content = ${JSON.stringify(truncate(value, 200))}`);
    }
    for (const [key, value] of Object.entries(metadata.other)) {
        lines.push(`meta[name='${key}']@content = ${JSON.stringify(truncate(value, 200))}`);
    }
    return lines.slice(0, 60).join("\n");
}

function formatJsonLd(pagePacket: PagePacket): string {
    return pagePacket.jsonLd
        .filter(block => block.data !== null)
        .slice(0, 12)
        .map(block => `${block.nodeId} (${block.type ?? "unknown type"}): ${truncate(JSON.stringify(block.data), 6_000)}`)
        .join("\n");
}

function formatTables(pagePacket: PagePacket): string {
    return pagePacket.tables
        .slice(0, 6)
        .map(table => `${table.nodeId}:\n${table.rows
            .slice(0, 15)
            .map(row => `  | ${row.map(cell => truncate(cell, 60)).join(" | ")} |`)
            .join("\n")}`)
        .join("\n");
}

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
