import { afterEach, describe, expect, it, mock } from "bun:test";
import { LMStudioProvider } from "../src/core/llm-extractor/providers/LMStudioProvider.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("LMStudioProvider", () => {
  it("falls back to reasoning_content when content is empty", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                reasoning_content: "{\"payload\":{\"dialColor\":null},\"evidence\":{}}",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 10,
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = new LMStudioProvider("http://localhost:1234", 10_000);

    const result = await provider.completeStructured({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      jsonSchema: { type: "object" },
    });

    expect(result.parsed).toEqual({
      payload: { dialColor: null },
      evidence: {},
    });
  });

  it("throws a diagnostic error when both content and reasoning_content are empty", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                reasoning_content: "",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 45442,
            completion_tokens: 147,
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = new LMStudioProvider("http://localhost:1234", 10_000);

    await expect(
      provider.completeStructured({
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
        jsonSchema: { type: "object" },
      }),
    ).rejects.toThrow("LM Studio returned empty structured output content");
  });

  it("keeps the timeout active while reading the response body", async () => {
    globalThis.fetch = mock(async (_input, init) => {
      const signal = init?.signal;

      return {
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            if (!signal) {
              reject(new Error("Missing abort signal"));
              return;
            }

            signal.addEventListener("abort", () => {
              const error = new Error("Aborted while reading body");
              error.name = "AbortError";
              reject(error);
            });
          }),
      } as Response;
    }) as unknown as typeof fetch;

    const provider = new LMStudioProvider("http://localhost:1234", 10);

    await expect(
      provider.completeStructured({
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
        jsonSchema: { type: "object" },
      }),
    ).rejects.toThrow("LM Studio request timed out after 10ms");
  });

  it("classifies context length failures with request footprint diagnostics", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          error: "Current context length is 100905 tokens. Please use a bigger context length.",
        }),
        { status: 400 },
      );
    }) as unknown as typeof fetch;

    const provider = new LMStudioProvider("http://localhost:1234", 10_000);

    await expect(
      provider.completeStructured({
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
        jsonSchema: { type: "object" },
        footprint: {
          systemPromptBytes: 10,
          systemPromptChars: 10,
          userPromptBytes: 20,
          userPromptChars: 20,
          compactPacketBytes: 30,
          compactPacketChars: 30,
          userSchemaBytes: 5,
          userSchemaChars: 5,
          responseSchemaBytes: 40,
          responseSchemaChars: 40,
          totalRequestBytes: 120,
          totalRequestChars: 120,
          dominantComponents: [
            { name: "totalRequest", bytes: 120, chars: 120 },
            { name: "responseSchema", bytes: 40, chars: 40 },
          ],
        },
      }),
    ).rejects.toThrow("LLM extraction request is too large for the configured model context");
  });

  it("classifies LM Studio initial prompt token accounting failures", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          error: "The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input",
        }),
        { status: 400 },
      );
    }) as unknown as typeof fetch;

    const provider = new LMStudioProvider("http://localhost:1234", 10_000);

    await expect(
      provider.completeStructured({
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
        jsonSchema: { type: "object" },
        footprint: {
          systemPromptBytes: 10,
          systemPromptChars: 10,
          userPromptBytes: 20,
          userPromptChars: 20,
          compactPacketBytes: 30,
          compactPacketChars: 30,
          userSchemaBytes: 5,
          userSchemaChars: 5,
          responseSchemaBytes: 40,
          responseSchemaChars: 40,
          totalRequestBytes: 120,
          totalRequestChars: 120,
          dominantComponents: [
            { name: "totalRequest", bytes: 120, chars: 120 },
            { name: "responseSchema", bytes: 40, chars: 40 },
          ],
        },
      }),
    ).rejects.toThrow("provider context accounting");
  });

  it("reports completion token truncation without dumping partial content", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `{"payload":{"diameter":39.${"0".repeat(1200)}`,
              },
              finish_reason: "length",
            },
          ],
          usage: {
            prompt_tokens: 4086,
            completion_tokens: 1791,
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = new LMStudioProvider("http://localhost:1234", 10_000);

    await expect(
      provider.completeStructured({
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
        jsonSchema: { type: "object" },
      }),
    ).rejects.toThrow("LM Studio stopped generation because the completion token limit was reached");
  });

});
