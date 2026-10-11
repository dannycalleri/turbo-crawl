import { afterEach, describe, expect, it } from "bun:test";
import { extractWithLLM } from "../src/core/llm-extractor/extractWithLLM.ts";
import type { StructuredLLMRequest } from "../src/core/llm-extractor/providers/LLMProvider.ts";
import type { UserSchema } from "../src/core/llm-extractor/types.ts";
import type { PagePacket } from "../src/core/types.ts";

const originalTimeoutEnv = process.env.TURBO_CRAWL_LLM_TIMEOUT_MS;

afterEach(() => {
  if (originalTimeoutEnv === undefined) {
    delete process.env.TURBO_CRAWL_LLM_TIMEOUT_MS;
  } else {
    process.env.TURBO_CRAWL_LLM_TIMEOUT_MS = originalTimeoutEnv;
  }
});

function createPagePacket(): PagePacket {
  return {
    url: "https://example.com/watch",
    finalUrl: "https://example.com/watch",
    fetchedAt: "2026-05-11T00:00:00.000Z",
    title: "Example Watch",
    metadata: {
      canonicalUrl: null,
      description: "Example watch.",
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
}

function createRawExtraction(userSchema: UserSchema) {
  return {
    payload: Object.fromEntries(Object.keys(userSchema).map(field => [field, null])),
    evidence: Object.fromEntries(
      Object.keys(userSchema).map(field => [
        field,
        {
          sourceNodeId: null,
          quotedText: null,
          confidence: 0,
          reason: "not_found",
        },
      ]),
    ),
  };
}

describe("extractWithLLM request controls", () => {
  it("uses a 10 minute default timeout and bounded completion budget", async () => {
    delete process.env.TURBO_CRAWL_LLM_TIMEOUT_MS;

    const captured: StructuredLLMRequest[] = [];
    const userSchema: UserSchema = {
      reference: "string",
      model: "string",
      brand: "string",
      dialColor: "string",
      diameter: "number",
    };

    await extractWithLLM({
      userSchema,
      pagePacket: createPagePacket(),
      model: "fixture-model",
      provider: {
        name: "lmstudio",
        async completeStructured(request) {
          captured.push(request);
          return {
            parsed: createRawExtraction(userSchema),
            raw: {},
          };
        },
      },
    });

    expect(captured[0]?.timeoutMs).toBe(600_000);
    expect(captured[0]?.maxTokens).toBe(1792);
    expect(captured[0]?.footprint?.totalRequestBytes).toBeGreaterThan(0);
  });

  it("uses TURBO_CRAWL_LLM_TIMEOUT_MS when provided", async () => {
    process.env.TURBO_CRAWL_LLM_TIMEOUT_MS = "900000";
    const captured: StructuredLLMRequest[] = [];
    const userSchema: UserSchema = {
      reference: "string",
    };

    await extractWithLLM({
      userSchema,
      pagePacket: createPagePacket(),
      model: "fixture-model",
      provider: {
        name: "lmstudio",
        async completeStructured(request) {
          captured.push(request);
          return {
            parsed: createRawExtraction(userSchema),
            raw: {},
          };
        },
      },
    });

    expect(captured[0]?.timeoutMs).toBe(900_000);
    expect(captured[0]?.maxTokens).toBe(1024);
  });

  it("does not retry provider failures", async () => {
    const captured: StructuredLLMRequest[] = [];
    const userSchema: UserSchema = {
      reference: "string",
    };

    await expect(
      extractWithLLM({
        userSchema,
        pagePacket: createPagePacket(),
        model: "fixture-model",
        provider: {
          name: "lmstudio",
          async completeStructured(request) {
            captured.push(request);
            const error = new Error("LM Studio returned non-JSON content");
            throw error;
          },
        },
      }),
    ).rejects.toThrow("LM Studio returned non-JSON content");

    expect(captured).toHaveLength(1);
  });
});
