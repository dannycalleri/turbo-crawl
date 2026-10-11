import { describe, expect, it } from "bun:test";
import type { LLMProvider } from "../src/core/llm-extractor/providers/LLMProvider.ts";
import {
  filterSuggestedFields,
  MAX_SUGGESTED_FIELDS,
  suggestSchema,
} from "../src/core/template-author/suggestSchema.ts";
import type { PagePacket } from "../src/core/types.ts";

function pagePacket(): PagePacket {
  return {
    url: "https://shop.example/products/clock-1",
    finalUrl: "https://shop.example/products/clock-1",
    fetchedAt: "2026-10-11T10:00:00.000Z",
    title: "Clock",
    metadata: { canonicalUrl: null, description: null, robots: null, openGraph: {}, twitter: {}, other: {} },
    jsonLd: [],
    visibleBlocks: [],
    links: [],
    images: [],
    tables: [],
    stats: {
      rawHtmlLength: 0,
      bodyTextLength: 0,
      visibleBlockCount: 0,
      jsonLdCount: 0,
      linkCount: 0,
      imageCount: 0,
      tableCount: 0,
    },
  };
}

function providerAnswering(parsed: unknown): LLMProvider {
  return {
    name: "codex",
    async completeStructured() {
      return { parsed, raw: parsed };
    },
  };
}

describe("filterSuggestedFields", () => {
  it("drops invalid names, unknown types and duplicates", () => {
    const fields = filterSuggestedFields({
      fields: [
        { name: "title", type: "string", description: "Product name" },
        { name: "Price", type: "number", description: "" },
        { name: "2nd", type: "string" },
        { name: "brand-name", type: "string" },
        { name: "rating", type: "float" },
        { name: 42, type: "number" },
        { name: "title", type: "text" },
        { name: "in_stock", type: "boolean" },
      ],
    });

    expect(fields).toEqual([
      { name: "title", type: "string", description: "Product name" },
      { name: "in_stock", type: "boolean", description: "" },
    ]);
  });

  it(`keeps at most ${MAX_SUGGESTED_FIELDS} fields`, () => {
    const fields = filterSuggestedFields({
      fields: Array.from({ length: 20 }, (_, index) => ({ name: `field_${index}`, type: "string", description: "" })),
    });

    expect(fields).toHaveLength(MAX_SUGGESTED_FIELDS);
    expect(fields.at(-1)?.name).toBe(`field_${MAX_SUGGESTED_FIELDS - 1}`);
  });

  it("returns nothing for an answer in the wrong shape", () => {
    expect(filterSuggestedFields({ suggestions: [] })).toEqual([]);
  });
});

describe("suggestSchema", () => {
  it("turns the usable suggestions into a schema", async () => {
    const result = await suggestSchema({
      pagePacket: pagePacket(),
      skeleton: "body",
      provider: providerAnswering({
        fields: [
          { name: "title", type: "string", description: "" },
          { name: "Bad Name", type: "string", description: "" },
          { name: "price", type: "number", description: "" },
        ],
      }),
    });

    expect(result.schema).toEqual({ title: "string", price: "number" });
  });

  it("fails with a --fields hint when nothing usable remains", async () => {
    await expect(
      suggestSchema({
        pagePacket: pagePacket(),
        skeleton: "body",
        provider: providerAnswering({ fields: [{ name: "Bad Name", type: "string", description: "" }] }),
      }),
    ).rejects.toThrow(/codex did not suggest any usable fields.*--fields name:type/);
  });
});
