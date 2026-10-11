import { z } from "zod";
import type { ChatMessage } from "../llm-extractor/providers/LLMProvider";
import type { UserSchema } from "../llm-extractor/types";
import type { PagePacket } from "../types";
import type { SelectorValidation } from "./validateSelectors";

export const AUTHOR_SELECTOR_KINDS = ["jsonld", "meta", "css", "table"] as const;
export const AUTHOR_ATTRIBUTES = ["textContent", "href", "src", "content", "json"] as const;
export const MAX_SELECTORS_PER_FIELD = 4;

export type AuthoredSelector = {
    kind: typeof AUTHOR_SELECTOR_KINDS[number];
    selector: string;
    attribute: typeof AUTHOR_ATTRIBUTES[number];
};

export type AuthoredField = {
    selectors: AuthoredSelector[];
    expectedSample: string | null;
};

export type AuthorResponse = {
    fields: Record<string, AuthoredField>;
};

export type PageContextForAgent = {
    url: string;
    urlPattern: string;
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
- css → a CSS selector for document.querySelector → "textContent", "href", "src" or "content"
- table → "label=<exact row label>" reads the cell next to that label in an HTML table → "textContent"
Rules:
- Give 1 to ${MAX_SELECTORS_PER_FIELD} selectors per field, most reliable first. Different kinds as fallbacks are good.
- Prefer JSON-LD and meta when they hold the value; then semantic CSS (itemprop, data-* attributes, ids, meaningful class names).
- Never use :nth-child/:nth-of-type positions, generated class names, or text that only appears on this page.
- The selector must point at the element holding just the value (e.g. the price element, not its whole card).
- expectedSample is the raw text you expect the first selector to read on this page, or null if the field is absent.`;

export function buildAuthorResponseSchema(schema: UserSchema): unknown {
    const fieldNames = Object.keys(schema);
    const selectorSchema = {
        type: "object",
        properties: {
            kind: { type: "string", enum: [...AUTHOR_SELECTOR_KINDS] },
            selector: { type: "string" },
            attribute: { type: "string", enum: [...AUTHOR_ATTRIBUTES] },
        },
        required: ["kind", "selector", "attribute"],
        additionalProperties: false,
    };
    const fieldSchema = {
        type: "object",
        properties: {
            selectors: { type: "array", items: selectorSchema },
            expectedSample: { type: ["string", "null"] },
        },
        required: ["selectors", "expectedSample"],
        additionalProperties: false,
    };

    return {
        type: "object",
        properties: {
            fields: {
                type: "object",
                properties: Object.fromEntries(fieldNames.map(name => [name, fieldSchema])),
                required: fieldNames,
                additionalProperties: false,
            },
        },
        required: ["fields"],
        additionalProperties: false,
    };
}

const authoredSelectorSchema = z.object({
    kind: z.enum(AUTHOR_SELECTOR_KINDS),
    selector: z.string().min(1),
    attribute: z.enum(AUTHOR_ATTRIBUTES),
});

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
        fields[name] = {
            // Drop individual malformed selectors instead of failing the whole answer.
            selectors: field.selectors
                .map(selector => authoredSelectorSchema.safeParse(selector))
                .filter(result => result.success)
                .map(result => result.data)
                .slice(0, MAX_SELECTORS_PER_FIELD),
            expectedSample: field.expectedSample ?? null,
        };
    }

    return { fields };
}

export function buildAuthorMessages(input: {
    schema: UserSchema;
    page: PageContextForAgent;
}): ChatMessage[] {
    return [
        { role: "system", content: SYSTEM_PROMPT },
        {
            role: "user",
            content: [
                `Write a template for these fields (name: type): ${formatSchema(input.schema)}`,
                SELECTOR_RULES,
                formatPageContext(input.page),
            ].join("\n\n"),
        },
    ];
}

export function buildRepairMessages(input: {
    schema: UserSchema;
    page: PageContextForAgent;
    previous: AuthorResponse;
    failures: Record<string, SelectorValidation[]>;
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

    return [
        { role: "system", content: SYSTEM_PROMPT },
        {
            role: "user",
            content: [
                `Your previous selectors for some fields failed when run on the live page. Write new selectors for these fields only: ${formatSchema(repairSchema)}`,
                `Failure report:\n${report}`,
                SELECTOR_RULES,
                formatPageContext(input.page),
            ].join("\n\n"),
        },
    ];
}

function formatSchema(schema: UserSchema): string {
    return Object.entries(schema).map(([name, type]) => `${name}: ${type}`).join(", ");
}

export function formatPageContext(page: PageContextForAgent): string {
    const { pagePacket } = page;
    const sections = [
        `URL: ${page.url}`,
        `URL pattern: ${page.urlPattern}`,
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
