import { describe, expect, it } from "bun:test";
import { runCli, type CliDependencies } from "../src/cli.ts";
import { chooseCrawlMode } from "../src/commands/crawl.ts";
import type { HeadlessCrawlInput } from "../src/core/headless.ts";
import type { InteractiveSessionInput } from "../src/core/session.ts";

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

function createTestDependencies(config: { bun?: boolean; tty?: boolean; headlessExit?: number } = {}) {
  const started: InteractiveSessionInput[] = [];
  const headless: HeadlessCrawlInput[] = [];
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const deps: CliDependencies = {
    stdout,
    stderr,
    async startInteractiveSession(input) {
      started.push(input);
    },
    async runHeadlessCrawl(input) {
      headless.push(input);
      return config.headlessExit ?? 0;
    },
    isInteractiveTerminal: () => config.tty ?? true,
    isBunRuntime: () => config.bun ?? true,
  };

  return { deps, started, headless, stdout, stderr };
}

describe("runCli crawl", () => {
  it("opens the TUI under Bun in an interactive terminal when no headless option is given", async () => {
    const { deps, started, headless } = createTestDependencies();

    const exitCode = await runCli(["crawl", "https://example.com"], deps);

    expect(exitCode).toBe(0);
    expect(started).toHaveLength(1);
    expect(started[0]?.target).toBe("https://example.com");
    expect(headless).toHaveLength(0);
  });

  it("runs headless with the given options and returns the headless exit code", async () => {
    const { deps, started, headless } = createTestDependencies({ headlessExit: 2 });

    const exitCode = await runCli(
      ["crawl", "https://example.com", "--fields", "title:string", "--provider", "codex", "--data-dir", "/tmp/tc", "--max-repairs", "1"],
      deps,
    );

    expect(exitCode).toBe(2);
    expect(started).toHaveLength(0);
    expect(headless).toEqual([
      {
        target: "https://example.com",
        fields: "title:string",
        provider: "codex",
        model: undefined,
        dataDir: "/tmp/tc",
        maxRepairs: 1,
      },
    ]);
  });

  it("refuses --tui outside Bun with a hint to use bunx", async () => {
    const { deps, started, stderr } = createTestDependencies({ bun: false });

    const exitCode = await runCli(["crawl", "https://example.com", "--tui"], deps);

    expect(exitCode).toBe(2);
    expect(started).toHaveLength(0);
    expect(stderr.output).toContain("bunx turbo-crawl");
  });

  it("returns a non-zero exit code for invalid invocations", async () => {
    const { deps, started, stderr } = createTestDependencies();

    const exitCode = await runCli(["crawl"], deps);

    expect(exitCode).toBe(1);
    expect(started).toHaveLength(0);
    expect(stderr.output).toContain("Not enough non-option arguments");
  });
});

describe("chooseCrawlMode", () => {
  const bunTty = { bun: true, interactiveTerminal: true };

  it("picks headless when --json, --fields or --no-tui is given", () => {
    expect(chooseCrawlMode({ json: true }, bunTty)).toBe("headless");
    expect(chooseCrawlMode({ fields: "a:string" }, bunTty)).toBe("headless");
    expect(chooseCrawlMode({ tui: false }, bunTty)).toBe("headless");
  });

  it("picks headless under Node or without a terminal", () => {
    expect(chooseCrawlMode({}, { bun: false, interactiveTerminal: true })).toBe("headless");
    expect(chooseCrawlMode({}, { bun: true, interactiveTerminal: false })).toBe("headless");
  });

  it("honours --tui only under Bun", () => {
    expect(chooseCrawlMode({ tui: true, json: true }, bunTty)).toBe("tui");
    expect(chooseCrawlMode({ tui: true }, { bun: false, interactiveTerminal: true })).toBe("tui-unavailable");
  });
});
