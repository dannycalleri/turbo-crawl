import { describe, expect, it } from "bun:test";
import { buildExtractionPrompt } from "../src/core/llm-extractor/promptBuilder.ts";
import { measureStructuredRequestFootprint } from "../src/core/llm-extractor/requestDiagnostics.ts";
import type { PagePacket } from "../src/core/types.ts";

const pagePacket: PagePacket = {
  url: "https://example.com/watch",
  finalUrl: "https://example.com/watch",
  fetchedAt: "2026-04-26T00:00:00.000Z",
  title: "Example Watch",
  metadata: {
    canonicalUrl: null,
    description: "Example watch description",
    robots: null,
    openGraph: {},
    twitter: {},
    other: {},
  },
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

describe("buildExtractionPrompt", () => {
  it("keeps schema enforcement out of the prompt body", () => {
    const messages = buildExtractionPrompt({
      userSchema: {
        referenceNumber: "string",
        dialColor: "string",
      },
      pagePacket,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain(
      "The response schema is enforced separately from this prompt.",
    );
    expect(messages[1]?.content).toContain("Schema=");
    expect(messages[1]?.content).toContain("confidence must be exactly one of 0,0.25,0.5,0.75,1");
    expect(messages[1]?.content).toContain("reason must be exactly one of");
    expect(messages[1]?.content).toContain("no prose");
    expect(messages[1]?.content).toContain("number fields as compact numeric strings");
    expect(messages[1]?.content).not.toContain("RESPONSE JSON SCHEMA:");
    expect(messages[1]?.content).not.toContain('"payload"');
  });

  it("keeps the extraction prompt compact for oversized packets", () => {
    const oversizedPacket = {
      ...pagePacket,
      visibleBlocks: Array.from({ length: 60 }, (_, index) => ({
        nodeId: `dom_${index}`,
        tag: "p",
        text: `Repeated navigation and related products ${index}`.repeat(8),
        cssPath: `main > p:nth-of-type(${index + 1})`,
        attributes: {},
        score: 0.2,
      })),
      images: Array.from({ length: 42 }, (_, index) => ({
        nodeId: `img_${index}`,
        src: `https://example.com/${index}.jpg`,
        alt: `Product detail ${index}`,
        width: 800,
        height: 800,
        score: 0.3,
      })),
    };
    const compactMessages = buildExtractionPrompt({
      userSchema: {
        reference: "string",
        model: "string",
        brand: "string",
        dialColor: "string",
        diameter: "number",
      },
      pagePacket: oversizedPacket as PagePacket,
    });
    const verboseMessages = [
      {
        role: "system" as const,
        content: [
          "You are a precise webpage data extraction engine.",
          "You extract structured data from compact representations of rendered webpages.",
          "You do not invent values.",
          "You return only JSON matching the provided schema.",
          "The response schema is enforced separately from this prompt.",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: [
          "Extract data from the webpage packet below.",
          "",
          "USER SCHEMA:",
          JSON.stringify({
            reference: "string",
            model: "string",
            brand: "string",
            dialColor: "string",
            diameter: "number",
          }, null, 2),
          "",
          "EXTRACTION RULES:",
          "- Return only JSON.",
          "- The response must match the JSON Schema exactly.",
          "- Extract the main entity represented by the page.",
          "- Ignore navigation, footer, cookie banners, related products, ads, and newsletter blocks.",
          "- Prefer JSON-LD and metadata when they clearly describe the main entity.",
          "- Prefer visible page content when JSON-LD is missing or contradictory.",
          "- Use null for fields that are missing or uncertain.",
          "- For every field, provide evidence.",
          "- For sourceNodeId, use a nodeId from jsonLd, visibleBlocks, links, images, or tables.",
          "- Use sourceNodeId null only when the value comes from metadata or the current URL.",
          "- quotedText should be the shortest exact text/value supporting the field.",
          "- confidence must be between 0 and 1.",
          "",
          "PAGE PACKET:",
          JSON.stringify(oversizedPacket, null, 2),
        ].join("\n"),
      },
    ];

    const compact = measureStructuredRequestFootprint({
      model: "fixture",
      messages: compactMessages,
      jsonSchema: { type: "object" },
      pagePacket: oversizedPacket,
      userSchema: {},
    });
    const verbose = measureStructuredRequestFootprint({
      model: "fixture",
      messages: verboseMessages,
      jsonSchema: { type: "object" },
      pagePacket: oversizedPacket,
      userSchema: {},
    });

    expect(compact.userPromptBytes).toBeLessThan(verbose.userPromptBytes * 0.65);
  });
});
