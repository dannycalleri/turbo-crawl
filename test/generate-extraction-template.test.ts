import { describe, expect, it } from "bun:test";
import type { Page } from "playwright";
import { extractWithTemplate } from "../src/core/template-extractor/extractWithTemplate.ts";
import { generateExtractionTemplate } from "../src/core/templating/generateExtractionTemplate.ts";
import type { LLMExtractionResult } from "../src/core/llm-extractor/types.ts";
import type { PagePacket } from "../src/core/types.ts";

function createPagePacket(): PagePacket {
  return {
    url: "https://example.com/products/tissot",
    finalUrl: "https://example.com/products/tissot",
    fetchedAt: "2026-05-14T15:49:06.000Z",
    title: "TISSOT VISODATE 39mm",
    metadata: {
      canonicalUrl: "https://example.com/products/tissot",
      description: null,
      robots: null,
      openGraph: {},
      twitter: {},
      other: {},
    },
    jsonLd: [
      {
        nodeId: "jsonld_001_1",
        type: "Product",
        raw: "{}",
        data: {
          mpn: "T157.407.11.041.00",
          brand: { name: "Tissot" },
          name: "TISSOT VISODATE 39mm",
        },
      },
    ],
    visibleBlocks: [],
    links: [],
    images: [],
    tables: [
      {
        nodeId: "table_005",
        cssPath: "main table",
        headers: [],
        rows: [
          ["Referenza", "T157.407.11.041.00"],
          ["Colore quadrante", "Blu"],
          ["Diametro", "39mm"],
        ],
        score: 0.9,
      },
    ],
    stats: {
      rawHtmlLength: 10,
      bodyTextLength: 10,
      visibleBlockCount: 0,
      jsonLdCount: 1,
      linkCount: 0,
      imageCount: 0,
      tableCount: 1,
    },
  };
}

function createExtraction(): LLMExtractionResult {
  return {
    payload: {
      reference: "T157.407.11.041.00",
      brand: "Tissot",
      model: "TISSOT VISODATE 39mm",
      diameter: "39",
      dialColor: "Blu",
    },
    evidence: {
      reference: {
        sourceNodeId: "jsonld_001_1",
        quotedText: "T157.407.11.041.00",
        confidence: 1,
        reason: "found_in_jsonld",
      },
      brand: {
        sourceNodeId: "jsonld_001_1",
        quotedText: "Tissot",
        confidence: 1,
        reason: "found_in_jsonld",
      },
      model: {
        sourceNodeId: "jsonld_001_1",
        quotedText: "TISSOT VISODATE 39mm",
        confidence: 1,
        reason: "found_in_jsonld",
      },
      diameter: {
        sourceNodeId: "table_005",
        quotedText: "39mm",
        confidence: 1,
        reason: "found_in_table",
      },
      dialColor: {
        sourceNodeId: "table_005",
        quotedText: "Blu",
        confidence: 1,
        reason: "found_in_table",
      },
    },
    fieldReports: {},
    provider: "lmstudio",
    model: "qwen/qwen3-30b-a3b-2507@4bit",
    llmUsed: true,
    rawResponse: {},
    createdAt: "2026-05-14T15:49:06.000Z",
  };
}

describe("generateExtractionTemplate", () => {
  it("creates reusable table selectors for fields sourced from table evidence", async () => {
    const pagePacket = createPagePacket();
    const template = generateExtractionTemplate({
      schema: {
        reference: "string",
        brand: "string",
        model: "string",
        diameter: "number",
        dialColor: "string",
      },
      pagePacket,
      extraction: createExtraction(),
    });

    expect(template.fields.diameter?.selectors).toContainEqual(
      expect.objectContaining({
        kind: "table",
        selector: "label=Diametro",
        reusable: true,
      }),
    );
    expect(template.fields.dialColor?.selectors).toContainEqual(
      expect.objectContaining({
        kind: "table",
        selector: "label=Colore%20quadrante",
        reusable: true,
      }),
    );

    const result = await extractWithTemplate({
      page: {} as Page,
      pagePacket,
      template,
    });

    expect(result.payload).toMatchObject({
      diameter: 39,
      dialColor: "Blu",
    });
    expect(result.warnings).toEqual([]);
  });
});
