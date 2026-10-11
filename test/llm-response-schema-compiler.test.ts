import { describe, expect, it } from "bun:test";
import { compileLLMResponseJsonSchema } from "../src/core/llm-extractor/llmResponseSchemaCompiler.ts";

describe("compileLLMResponseJsonSchema", () => {
  it("encodes nullable payload fields with anyOf instead of type arrays", () => {
    const schema = compileLLMResponseJsonSchema({
      referenceNumber: "string",
      dialColor: "text",
      price: "number",
      inStock: "boolean",
      releaseDate: "date",
      productUrl: "url",
    });

    const payload = (schema.properties as Record<string, unknown>).payload as {
      properties: Record<string, unknown>;
    };

    expect(payload.properties.referenceNumber).toEqual({
      anyOf: [{ type: "string", maxLength: 240 }, { type: "null" }],
    });

    expect(payload.properties.dialColor).toEqual({
      anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }],
    });

    expect(payload.properties.price).toEqual({
      anyOf: [
        {
          type: "string",
          pattern: "^-?\\d+(?:[.,]\\d{1,4})?$",
          maxLength: 32,
        },
        { type: "null" },
      ],
    });

    expect(payload.properties.inStock).toEqual({
      anyOf: [{ type: "boolean" }, { type: "null" }],
    });

    expect(payload.properties.releaseDate).toEqual({
      anyOf: [{ type: "string", maxLength: 80 }, { type: "null" }],
    });

    expect(payload.properties.productUrl).toEqual({
      anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }],
    });
  });

  it("encodes nullable evidence fields with anyOf so null remains valid", () => {
    const schema = compileLLMResponseJsonSchema({
      referenceNumber: "string",
    });

    const evidence = (schema.properties as Record<string, unknown>).evidence as {
      properties: Record<string, unknown>;
    };
    const fieldEvidence = evidence.properties.referenceNumber as {
      properties: Record<string, unknown>;
    };

    expect(fieldEvidence.properties.sourceNodeId).toEqual({
      anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }],
    });

    expect(fieldEvidence.properties.quotedText).toEqual({
      anyOf: [{ type: "string", maxLength: 180 }, { type: "null" }],
    });
  });

  it("does not repeat verbose evidence descriptions for every field", () => {
    const schema = compileLLMResponseJsonSchema({
      reference: "string",
      model: "string",
      brand: "string",
      dialColor: "text",
      diameter: "number",
    });
    const serialized = JSON.stringify(schema);

    expect(serialized).not.toContain("The nodeId from visibleBlocks");
    expect(serialized).not.toContain("The exact supporting text");
    expect(serialized).toContain('"payload"');
    expect(serialized).toContain('"evidence"');
    expect(serialized).toContain('"confidence"');
  });

  it("constrains evidence confidence to compact numeric buckets", () => {
    const schema = compileLLMResponseJsonSchema({
      reference: "string",
    });

    const evidence = (schema.properties as Record<string, unknown>).evidence as {
      properties: Record<string, unknown>;
    };
    const fieldEvidence = evidence.properties.reference as {
      properties: Record<string, unknown>;
    };

    expect(fieldEvidence.properties.confidence).toEqual({
      type: "number",
      enum: [0, 0.25, 0.5, 0.75, 1],
    });
  });

  it("constrains evidence reasons to compact reason codes", () => {
    const schema = compileLLMResponseJsonSchema({
      diameter: "number",
    });

    const evidence = (schema.properties as Record<string, unknown>).evidence as {
      properties: Record<string, unknown>;
    };
    const fieldEvidence = evidence.properties.diameter as {
      properties: Record<string, unknown>;
    };

    expect(fieldEvidence.properties.reason).toEqual({
      type: "string",
      enum: [
        "found_in_jsonld",
        "found_in_metadata",
        "found_in_visible_text",
        "found_in_table",
        "found_in_image",
        "found_in_link",
        "found_in_url",
        "inferred_from_context",
        "not_found",
      ],
    });
  });

  it("requires numeric payload fields to use compact numeric strings", () => {
    const schema = compileLLMResponseJsonSchema({
      diameter: "number",
    });

    const payload = (schema.properties as Record<string, unknown>).payload as {
      properties: Record<string, unknown>;
    };

    expect(payload.properties.diameter).toEqual({
      anyOf: [
        {
          type: "string",
          pattern: "^-?\\d+(?:[.,]\\d{1,4})?$",
          maxLength: 32,
        },
        { type: "null" },
      ],
    });
  });
});
