import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { buildCodexArgs, CodexCliProvider } from "../src/core/llm-extractor/providers/CodexCliProvider.ts";
import type { StructuredLLMRequest } from "../src/core/llm-extractor/providers/LLMProvider.ts";
import type { ProcessResult, RunProcess } from "../src/core/llm-extractor/providers/runProcess.ts";

const jsonSchema = { type: "object", properties: { title: { type: "string" } } };

function request(overrides: Partial<StructuredLLMRequest> = {}): StructuredLLMRequest {
  return {
    model: "",
    messages: [
      { role: "system", content: "System rules." },
      { role: "user", content: "User prompt." },
    ],
    jsonSchema,
    ...overrides,
  };
}

function argValue(args: string[], flag: string): string {
  const value = args[args.indexOf(flag) + 1];
  if (args.indexOf(flag) === -1 || value === undefined) throw new Error(`missing ${flag}`);
  return value;
}

type Seen = { args: string[]; stdin: string; workDir: string; schema: string };

// Behaves like `codex exec`: writes its final message to --output-last-message.
function fakeCodex(answer: string | null, result: Partial<ProcessResult> = {}) {
  const seen: Seen[] = [];
  const run: RunProcess = async input => {
    seen.push({
      args: input.args,
      stdin: input.stdin,
      workDir: argValue(input.args, "--cd"),
      schema: await readFile(argValue(input.args, "--output-schema"), "utf8"),
    });
    if (answer !== null) {
      await writeFile(argValue(input.args, "--output-last-message"), answer, "utf8");
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, spawnError: null, ...result };
  };
  return { run, seen };
}

describe("buildCodexArgs", () => {
  it("adds --model only when set and reads the prompt from stdin", () => {
    const base = { schemaPath: "/w/schema.json", outputPath: "/w/out.json", workDir: "/w" };

    expect(buildCodexArgs(base)).not.toContain("--model");
    expect(buildCodexArgs(base).at(-1)).toBe("-");
    expect(argValue(buildCodexArgs({ ...base, model: "gpt-5" }), "--model")).toBe("gpt-5");
  });
});

describe("CodexCliProvider", () => {
  it("parses the last message, writes the schema file and removes its temp dir", async () => {
    const { run, seen } = fakeCodex('{"title":"Clock"}');

    const response = await new CodexCliProvider({ run }).completeStructured(request());

    expect(response.parsed).toEqual({ title: "Clock" });
    expect(JSON.parse(seen[0]!.schema)).toEqual(jsonSchema);
    expect(seen[0]!.stdin).toBe("System rules.\n\nUser prompt.");
    expect(existsSync(seen[0]!.workDir)).toBe(false);
  });

  it("removes its temp dir when the process fails", async () => {
    const { run, seen } = fakeCodex(null, { exitCode: 1, stderr: "not logged in" });

    await expect(new CodexCliProvider({ run }).completeStructured(request())).rejects.toThrow(
      /`codex` exited with code 1: not logged in\. Run `codex login`/,
    );
    expect(existsSync(seen[0]!.workDir)).toBe(false);
  });

  it("reports an answer that is not JSON", async () => {
    const { run, seen } = fakeCodex("Sure! Here are the selectors.");

    await expect(new CodexCliProvider({ run }).completeStructured(request())).rejects.toThrow(
      "Codex answer was not JSON: Sure! Here are the selectors.",
    );
    expect(existsSync(seen[0]!.workDir)).toBe(false);
  });

  it("reports a run that wrote no answer", async () => {
    const { run } = fakeCodex(null);

    await expect(new CodexCliProvider({ run }).completeStructured(request())).rejects.toThrow(
      "Codex finished without writing its answer.",
    );
  });
});
