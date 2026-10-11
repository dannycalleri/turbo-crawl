import { z } from "zod";
import type { LLMProvider } from "../llm-extractor/providers/LLMProvider";
import type { FieldType, UserSchema } from "../llm-extractor/types";
import { PROPERTY_TYPES as FIELD_TYPES } from "../session-state";
import { inferUrlPattern } from "../templating/inferUrlPattern";
import type { PagePacket } from "../types";
import { formatPageContext } from "./authorPrompt";

export const MAX_SUGGESTED_FIELDS = 12;
const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export type SuggestedField = {
    name: string;
    type: FieldType;
    description: string;
};

const suggestionSchema = z.object({
    fields: z.array(z.object({
        name: z.unknown(),
        type: z.unknown(),
        description: z.unknown().optional(),
    })),
});

export function buildSuggestionResponseSchema(): unknown {
    return {
        type: "object",
        properties: {
            fields: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        type: { type: "string", enum: [...FIELD_TYPES] },
                        description: { type: "string" },
                    },
                    required: ["name", "type", "description"],
                    additionalProperties: false,
                },
            },
        },
        required: ["fields"],
        additionalProperties: false,
    };
}

export function filterSuggestedFields(raw: unknown): SuggestedField[] {
    const parsed = suggestionSchema.safeParse(raw);
    if (!parsed.success) {
        return [];
    }

    const seen = new Set<string>();
    const fields: SuggestedField[] = [];

    for (const field of parsed.data.fields) {
        if (typeof field.name !== "string" || typeof field.type !== "string") continue;
        if (!FIELD_NAME_PATTERN.test(field.name) || seen.has(field.name)) continue;
        if (!(FIELD_TYPES as readonly string[]).includes(field.type)) continue;

        seen.add(field.name);
        fields.push({
            name: field.name,
            type: field.type as FieldType,
            description: typeof field.description === "string" ? field.description : "",
        });
    }

    return fields.slice(0, MAX_SUGGESTED_FIELDS);
}

export async function suggestSchema(input: {
    pagePacket: PagePacket;
    skeleton: string;
    provider: LLMProvider;
    model?: string | null;
    timeoutMs?: number;
}): Promise<{ schema: UserSchema; fields: SuggestedField[] }> {
    const finalUrl = input.pagePacket.finalUrl || input.pagePacket.url;
    const response = await input.provider.completeStructured({
        model: input.model ?? "",
        messages: [
            {
                role: "system",
                content: "You design data schemas for web scraping. Answer only with JSON matching the provided schema.",
            },
            {
                role: "user",
                content: [
                    `Propose the fields worth extracting from this page's main entity (for example a product, article, listing or profile), at most ${MAX_SUGGESTED_FIELDS}.`,
                    "Use snake_case names. Types: string (short text), text (long text), number, boolean, date, url.",
                    "Only include fields that are visible on this page and likely present on similar pages of the same site. Skip navigation, footer and cookie content.",
                    formatPageContext({
                        url: finalUrl,
                        urlPattern: inferUrlPattern(finalUrl),
                        skeleton: input.skeleton,
                        pagePacket: input.pagePacket,
                    }),
                ].join("\n\n"),
            },
        ],
        jsonSchema: buildSuggestionResponseSchema(),
        temperature: 0,
        timeoutMs: input.timeoutMs,
    });

    const fields = filterSuggestedFields(response.parsed);
    if (fields.length === 0) {
        throw new Error(`${input.provider.name} did not suggest any usable fields for ${finalUrl}. Pass them explicitly with --fields name:type,...`);
    }

    return {
        schema: Object.fromEntries(fields.map(field => [field.name, field.type])),
        fields,
    };
}
