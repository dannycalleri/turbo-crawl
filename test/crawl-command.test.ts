import { describe, expect, it } from "bun:test";
import { runCli, type CliDependencies } from "../src/cli.ts";
import type { HeadlessCrawlInput } from "../src/core/headless.ts";

type MemoryWriter = {
  output: string;
  write(chunk: string): boolean;
};

function createMemoryWriter(): MemoryWriter {
  return {
    output: "",
    write(chunk: string) {
      this.output += chunk;
      return true;
    },
  };
}

function createTestDependencies(config: { headlessExit?: number } = {}) {
  const headless: HeadlessCrawlInput[] = [];
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const deps: CliDependencies = {
    stdout,
    stderr,
    async runHeadlessCrawl(input) {
      headless.push(input);
      return config.headlessExit ?? 0;
    },
  };

  return { deps, headless, stdout, stderr };
}

describe("runCli crawl", () => {
  it("runs headless when no option is given", async () => {
    const { deps, headless } = createTestDependencies();

    const exitCode = await runCli(["crawl", "https://example.com"], deps);

    expect(exitCode).toBe(0);
    expect(headless.map(input => input.target)).toEqual(["https://example.com"]);
  });

  it("runs headless with the given options and returns the headless exit code", async () => {
    const { deps, headless } = createTestDependencies({ headlessExit: 3 });

    const exitCode = await runCli(
      ["crawl", "https://example.com", "--fields", "title:string", "--provider", "codex", "--data-dir", "/tmp/tc", "--max-repairs", "1", "--user-agent", "CliBot/1.0", "--json"],
      deps,
    );

    expect(exitCode).toBe(3);
    expect(headless).toEqual([
      {
        target: "https://example.com",
        fields: "title:string",
        provider: "codex",
        model: undefined,
        dataDir: "/tmp/tc",
        maxRepairs: 1,
        userAgent: "CliBot/1.0",
      },
    ]);
  });

  it("rejects the removed --tui option as unknown", async () => {
    const { deps, headless, stderr } = createTestDependencies();

    const exitCode = await runCli(["crawl", "https://example.com", "--tui"], deps);

    expect(exitCode).toBe(2);
    expect(headless).toHaveLength(0);
    expect(stderr.output).toContain("Unknown argument: tui");
  });

  it("exits 2 for invalid invocations", async () => {
    const { deps, headless, stderr } = createTestDependencies();

    const exitCode = await runCli(["crawl"], deps);

    expect(exitCode).toBe(2);
    expect(headless).toHaveLength(0);
    expect(stderr.output).toContain("Not enough non-option arguments");
  });
});
