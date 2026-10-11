import { describe, expect, it } from "bun:test";
import { measureStructuredRequestFootprint } from "../src/core/llm-extractor/requestDiagnostics.ts";

describe("measureStructuredRequestFootprint", () => {
  it("measures request components deterministically", () => {
    const input = {
      model: "fixture-model",
      messages: [
        { role: "system" as const, content: "Extract precisely." },
        { role: "user" as const, content: "SCHEMA:{\"title\":\"string\"}\nPACKET:{\"title\":\"Example\"}" },
      ],
      jsonSchema: {
        type: "object",
        properties: {
          payload: { type: "object" },
        },
      },
      temperature: 0,
      pagePacket: { title: "Example" },
      userSchema: { title: "string" },
    };

    const first = measureStructuredRequestFootprint(input);
    const second = measureStructuredRequestFootprint(input);

    expect(first).toEqual(second);
    expect(first.systemPromptBytes).toBeGreaterThan(0);
    expect(first.userPromptBytes).toBeGreaterThan(0);
    expect(first.compactPacketBytes).toBeGreaterThan(0);
    expect(first.userSchemaBytes).toBeGreaterThan(0);
    expect(first.responseSchemaBytes).toBeGreaterThan(0);
    expect(first.totalRequestBytes).toBeGreaterThan(first.systemPromptBytes + first.userPromptBytes);
    expect(first.dominantComponents[0]?.bytes).toBeGreaterThanOrEqual(
      first.dominantComponents[1]?.bytes ?? 0,
    );
  });

  it("carries retained and omitted counts into diagnostics", () => {
    const footprint = measureStructuredRequestFootprint({
      model: "fixture-model",
      messages: [{ role: "user" as const, content: "hello" }],
      jsonSchema: { type: "object" },
      pagePacket: {},
      userSchema: {},
      retainedCounts: {
        jsonLd: 1,
        visibleBlocks: 2,
        links: 3,
        images: 4,
        tables: 5,
      },
      omittedCounts: {
        jsonLd: 5,
        visibleBlocks: 4,
        links: 3,
        images: 2,
        tables: 1,
      },
    });

    expect(footprint.retainedCounts).toEqual({
      jsonLd: 1,
      visibleBlocks: 2,
      links: 3,
      images: 4,
      tables: 5,
    });
    expect(footprint.omittedCounts).toEqual({
      jsonLd: 5,
      visibleBlocks: 4,
      links: 3,
      images: 2,
      tables: 1,
    });
    expect(footprint.dominantComponents.map(component => component.name)).toContain("totalRequest");
  });
});
