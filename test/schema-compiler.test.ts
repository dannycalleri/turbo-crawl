import { describe, expect, it } from "bun:test";
import { compileLLMResponseZodSchema } from "../src/core/llm-extractor/schemaCompiler.ts";

describe("compileLLMResponseZodSchema", () => {
  it("accepts only compact evidence confidence buckets", () => {
    const schema = compileLLMResponseZodSchema({
      reference: "string",
    });

    expect(
      schema.safeParse({
        payload: {
          reference: "ABC-123",
        },
        evidence: {
          reference: {
            sourceNodeId: null,
            quotedText: "ABC-123",
            confidence: 0.75,
            reason: "found_in_visible_text",
          },
        },
      }).success,
    ).toBe(true);

    expect(
      schema.safeParse({
        payload: {
          reference: "ABC-123",
        },
        evidence: {
          reference: {
            sourceNodeId: null,
            quotedText: "ABC-123",
            confidence: 0.9,
            reason: "found_in_visible_text",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts compact numeric strings for number payload fields and rejects JSON numbers", () => {
    const schema = compileLLMResponseZodSchema({
      diameter: "number",
    });

    expect(
      schema.safeParse({
        payload: {
          diameter: "39",
        },
        evidence: {
          diameter: {
            sourceNodeId: null,
            quotedText: "39 mm",
            confidence: 0.75,
            reason: "found_in_visible_text",
          },
        },
      }).success,
    ).toBe(true);

    expect(
      schema.safeParse({
        payload: {
          diameter: 39,
        },
        evidence: {
          diameter: {
            sourceNodeId: null,
            quotedText: "39 mm",
            confidence: 0.75,
            reason: "found_in_visible_text",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects long decimal numeric strings for number payload fields", () => {
    const schema = compileLLMResponseZodSchema({
      diameter: "number",
    });

    expect(
      schema.safeParse({
        payload: {
          diameter: `39.${"0".repeat(20)}`,
        },
        evidence: {
          diameter: {
            sourceNodeId: null,
            quotedText: "39 mm",
            confidence: 0.75,
            reason: "found_in_visible_text",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects free-form or runaway evidence reason strings", () => {
    const schema = compileLLMResponseZodSchema({
      diameter: "number",
    });

    expect(
      schema.safeParse({
        payload: {
          diameter: "39",
        },
        evidence: {
          diameter: {
            sourceNodeId: null,
            quotedText: "39 mm",
            confidence: 0.75,
            reason: `Table states diameter ${"the ".repeat(80)}`,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects overlong quoted evidence text", () => {
    const schema = compileLLMResponseZodSchema({
      diameter: "number",
    });

    expect(
      schema.safeParse({
        payload: {
          diameter: "39",
        },
        evidence: {
          diameter: {
            sourceNodeId: null,
            quotedText: "39 mm ".repeat(50),
            confidence: 0.75,
            reason: "found_in_table",
          },
        },
      }).success,
    ).toBe(false);
  });
});
