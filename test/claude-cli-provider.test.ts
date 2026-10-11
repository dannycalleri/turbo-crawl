import { describe, expect, it } from "bun:test";
import {
  buildClaudeArgs,
  ClaudeCliProvider,
  parseClaudeEnvelope,
} from "../src/core/llm-extractor/providers/ClaudeCliProvider.ts";
import type { StructuredLLMRequest } from "../src/core/llm-extractor/providers/LLMProvider.ts";
import type { ProcessResult, RunProcess } from "../src/core/llm-extractor/providers/runProcess.ts";

const jsonSchema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };

function request(overrides: Partial<StructuredLLMRequest> = {}): StructuredLLMRequest {
  return {
    model: "",
    messages: [
      { role: "system", content: "You write selectors." },
      { role: "user", content: "Page context here." },
    ],
    jsonSchema,
    ...overrides,
  };
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, spawnError: null, ...overrides };
}

function envelope(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });
}

function fakeRun(result: ProcessResult) {
  const calls: Parameters<RunProcess>[0][] = [];
  const run: RunProcess = async input => {
    calls.push(input);
    return result;
  };
  return { run, calls };
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("buildClaudeArgs", () => {
  it("passes the schema, disables tools and uses the system message as system prompt", () => {
    const args = buildClaudeArgs(request());

    expect(JSON.parse(argValue(args, "--json-schema")!)).toEqual(jsonSchema);
    expect(argValue(args, "--tools")).toBe("");
    expect(argValue(args, "--system-prompt")).toBe("You write selectors.");
    expect(args).not.toContain("--model");
  });

  it("adds --model only when a model is set", () => {
    expect(argValue(buildClaudeArgs(request({ model: "sonnet" })), "--model")).toBe("sonnet");
  });
});

describe("parseClaudeEnvelope", () => {
  it("prefers structured_output", () => {
    expect(parseClaudeEnvelope(envelope({ result: "ignored", structured_output: { title: "Clock" } }))).toEqual({
      title: "Clock",
    });
  });

  it("falls back to fenced JSON in result", () => {
    const stdout = envelope({ result: "```json\n{\"title\":\"Clock\"}\n```" });
    expect(parseClaudeEnvelope(stdout)).toEqual({ title: "Clock" });
  });

  it("rejects an error envelope with the login hint", () => {
    expect(() => parseClaudeEnvelope(envelope({ is_error: true, result: "Not logged in" }))).toThrow(
      /Not logged in.*Run `claude` once/,
    );
  });

  it("rejects output that is not JSON", () => {
    expect(() => parseClaudeEnvelope("Welcome to Claude")).toThrow("did not print a JSON result");
  });
});

describe("ClaudeCliProvider", () => {
  it("sends only the user prompt on stdin and returns structured_output", async () => {
    const { run, calls } = fakeRun(processResult({ stdout: envelope({ structured_output: { title: "Clock" } }) }));
    const provider = new ClaudeCliProvider({ run });

    const response = await provider.completeStructured(request({ timeoutMs: 1234 }));

    expect(response.parsed).toEqual({ title: "Clock" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("claude");
    expect(calls[0]!.stdin).toBe("Page context here.");
    expect(calls[0]!.timeoutMs).toBe(1234);
  });

  it("reports an is_error envelope on non-zero exit with the login hint", async () => {
    const { run } = fakeRun(processResult({ exitCode: 1, stdout: envelope({ is_error: true, result: "Invalid API key" }) }));

    await expect(new ClaudeCliProvider({ run }).completeStructured(request())).rejects.toThrow(
      /Claude Code returned an error: Invalid API key\. Run `claude` once/,
    );
  });

  it("reports a non-zero exit with stderr and the login hint", async () => {
    const { run } = fakeRun(processResult({ exitCode: 2, stderr: "boom" }));

    await expect(new ClaudeCliProvider({ run }).completeStructured(request())).rejects.toThrow(
      /`claude` exited with code 2: boom\. Run `claude` once/,
    );
  });

  it("explains a missing executable", async () => {
    const spawnError = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const { run } = fakeRun(processResult({ exitCode: null, spawnError }));

    await expect(new ClaudeCliProvider({ run }).completeStructured(request())).rejects.toThrow(
      /`claude` was not found on PATH\. Run `claude` once/,
    );
  });

  it("points at TURBO_CRAWL_LLM_TIMEOUT_MS on timeout", async () => {
    const { run } = fakeRun(processResult({ exitCode: null, timedOut: true }));

    await expect(new ClaudeCliProvider({ run }).completeStructured(request({ timeoutMs: 50 }))).rejects.toThrow(
      /no answer after 50ms.*TURBO_CRAWL_LLM_TIMEOUT_MS/,
    );
  });
});
