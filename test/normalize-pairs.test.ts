import { describe, expect, it } from "bun:test";
import { compileLLMResponseJsonSchema } from "../src/core/llm-extractor/llmResponseSchemaCompiler.ts";
import { compilePayloadZodSchema } from "../src/core/llm-extractor/schemaCompiler.ts";
import { normalizeValue } from "../src/core/llm-extractor/validation/normalizeValue.ts";

const pairs = (value: unknown) => normalizeValue({ value, type: "pairs" });

describe("pairs values", () => {
  it("keeps an object of 3 or more text values, with collapsed whitespace", () => {
    expect(pairs({ " Marca ": "Rolex", Modello: "Sub\n mariner", Diametro: "40 mm" })).toEqual({
      Marca: "Rolex",
      Modello: "Sub mariner",
      Diametro: "40 mm",
    });
  });

  it("keeps labels that are also names of object members", () => {
    expect(pairs(JSON.parse('{"constructor":"a","toString":"b","__proto__":"c"}'))).toEqual(
      JSON.parse('{"constructor":"a","toString":"b","__proto__":"c"}'),
    );
  });

  it("gives null for fewer than 3 usable pairs, an array or a string", () => {
    expect(pairs({ Marca: "Rolex", Modello: "", Diametro: 40 })).toBeNull();
    expect(pairs([["Marca", "Rolex"]])).toBeNull();
    expect(pairs("Marca: Rolex")).toBeNull();
  });

  it("is an object of strings, or null, in the LLM answer schemas", () => {
    const zod = compilePayloadZodSchema({ specs: "pairs" });
    const json = compileLLMResponseJsonSchema({ specs: "pairs" });
    const payload = (json.properties as Record<string, { properties: Record<string, unknown> }>).payload!;

    expect(zod.safeParse({ specs: { Marca: "Rolex" } }).success).toBe(true);
    expect(zod.safeParse({ specs: null }).success).toBe(true);
    expect(zod.safeParse({ specs: { Marca: 1 } }).success).toBe(false);
    expect(payload.properties.specs).toEqual({
      anyOf: [{ type: "object", additionalProperties: { type: "string", maxLength: 240 } }, { type: "null" }],
    });
  });
});
