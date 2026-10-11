import { describe, expect, it } from "bun:test";
import type { CrawlOptions, CrawlOutcome, CrawlStartInput } from "../src/core/crawl-run.ts";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  normalizeTarget,
  parseFieldsOption,
  runHeadlessCrawl,
  UsageError,
  type HeadlessDependencies,
} from "../src/core/headless.ts";
import type { LLMProvider } from "../src/core/llm-extractor/providers/LLMProvider.ts";
import {
  ProviderSelectionError,
  type ResolvedProvider,
} from "../src/core/llm-extractor/providers/resolveProvider.ts";
import type { ReuseDiscoveryOptions } from "../src/core/reuse-discovery.ts";
import type { ExtractionTemplate } from "../src/core/templating/types.ts";

function usageError(run: () => unknown): UsageError {
  try {
    run();
  } catch (error) {
    if (error instanceof UsageError) return error;
    throw error;
  }
  throw new Error("expected a UsageError");
}

describe("parseFieldsOption", () => {
  it("parses name:type pairs", () => {
    expect(parseFieldsOption(" title:string, price : number ,")).toEqual({ title: "string", price: "number" });
  });

  it("names the allowed types for an unknown type", () => {
    const error = usageError(() => parseFieldsOption("price:float"));

    expect(error.message).toContain('Unknown type "float"');
    expect(error.message).toContain("string, number, boolean, date, url, text");
  });

  it("rejects a malformed entry", () => {
    expect(usageError(() => parseFieldsOption("title")).message).toContain('Invalid --fields entry "title"');
    expect(usageError(() => parseFieldsOption("a:string:x")).message).toContain("Invalid --fields entry");
  });

  it("rejects a duplicate field", () => {
    expect(usageError(() => parseFieldsOption("title:string,title:text")).message).toContain("listed twice");
  });
});

describe("normalizeTarget", () => {
  it("adds https to a bare hostname", () => {
    expect(normalizeTarget("example.com/products/clock")).toBe("https://example.com/products/clock");
  });

  it("rejects non-http schemes", () => {
    expect(usageError(() => normalizeTarget("ftp://example.com")).message).toContain("not a valid http(s) URL");
  });
});

const template: ExtractionTemplate = {
  id: "template_fixture",
  domain: "example.com",
  urlPattern: "/products/:slug",
  schema: { title: "string" },
  createdFromUrl: "https://example.com/products/one",
  createdAt: "2026-10-11T10:00:00.000Z",
  fields: {},
};

function discovery(overrides: Partial<ReuseDiscoveryOptions> = {}): ReuseDiscoveryOptions {
  return { template: null, schemas: [], warnings: [], ambiguousTemplates: [], ...overrides };
}

function outcome(input: CrawlStartInput): CrawlOutcome {
  return {
    target: input.target,
    finalUrl: input.target,
    urlPattern: "/products/:slug",
    path: input.source === "template-reuse" ? "template-reuse" : "authored",
    schema: { title: "string" },
    result: {
      payload: { title: "Clock" },
      fieldResults: {
        title: {
          fieldName: "title",
          type: "string",
          rawValue: "Clock",
          normalizedValue: "Clock",
          selectorUsed: { kind: "css", selector: "h1", attribute: "textContent", score: 90, reusable: true },
          confidence: 90,
          warnings: [],
          candidatesTried: [],
        },
      },
      confidence: 90,
      templateId: "template_fixture",
      usedTemplate: true,
      llmUsed: false,
      warnings: [],
    },
    llmUsed: input.source !== "template-reuse",
    provider: input.source === "template-reuse" ? null : "claude",
    templateId: "template_fixture",
    templatePath: null,
    artifactFolder: "data/example.com/pages/x",
    warnings: [],
  };
}

function harness(options: {
  discovery?: ReuseDiscoveryOptions;
  resolveProvider?: () => ResolvedProvider;
  startCrawl?: (input: CrawlStartInput) => Promise<CrawlOutcome>;
} = {}) {
  let stdout = "";
  let stderr = "";
  const started: CrawlStartInput[] = [];
  const runnerOptions: CrawlOptions[] = [];
  let resolveCalls = 0;

  const deps: HeadlessDependencies = {
    discover: async () => options.discovery ?? discovery(),
    resolveProvider: () => {
      resolveCalls += 1;
      return (
        options.resolveProvider?.() ?? {
          name: "claude",
          model: null,
          create: () => ({ name: "claude" }) as LLMProvider,
        }
      );
    },
    createRunner: runnerOptionsArg => {
      runnerOptions.push(runnerOptionsArg);
      return {
        startCrawl: async input => {
          started.push(input);
          return options.startCrawl ? options.startCrawl(input) : outcome(input);
        },
      };
    },
    stdout: { write: chunk => (stdout += chunk) },
    stderr: { write: chunk => (stderr += chunk) },
    now: () => new Date("2026-10-11T10:00:00.000Z"),
  };

  return {
    deps,
    started,
    runnerOptions,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get resolveCalls() {
      return resolveCalls;
    },
  };
}

const target = "https://example.com/products/clock-1";

describe("runHeadlessCrawl", () => {
  it("exits 2 on bad --fields without crawling", async () => {
    const h = harness();

    expect(await runHeadlessCrawl({ target, fields: "price:float" }, h.deps)).toBe(EXIT_USAGE);
    expect(h.stderr).toContain('error: Unknown type "float"');
    expect(h.started).toEqual([]);
  });

  it("exits 1 and lists the paths when several templates match", async () => {
    const h = harness({
      discovery: discovery({
        ambiguousTemplates: [
          { urlPattern: "/products/:slug", urlPatternHash: "a", path: "data/example.com/templates/a.json", template },
          { urlPattern: "/products/:slug", urlPatternHash: "b", path: "data/example.com/templates/b.json", template },
        ],
      }),
    });

    expect(await runHeadlessCrawl({ target }, h.deps)).toBe(EXIT_RUNTIME);
    expect(h.stderr).toContain("data/example.com/templates/a.json");
    expect(h.stderr).toContain("data/example.com/templates/b.json");
    expect(h.started).toEqual([]);
  });

  it("reuses a single saved template without resolving a provider", async () => {
    const h = harness({ discovery: discovery({ template }) });

    expect(await runHeadlessCrawl({ target }, h.deps)).toBe(EXIT_OK);
    expect(h.resolveCalls).toBe(0);
    expect(h.started[0]).toMatchObject({ source: "template-reuse", template, schema: [{ name: "title", type: "string" }] });
  });

  it("authors a new template when --fields differs from the saved one", async () => {
    const h = harness({ discovery: discovery({ template }) });

    expect(await runHeadlessCrawl({ target, fields: "title:string,price:number" }, h.deps)).toBe(EXIT_OK);
    expect(h.resolveCalls).toBe(1);
    expect(h.started[0]).toMatchObject({
      source: "schema-builder",
      schema: [
        { name: "title", type: "string" },
        { name: "price", type: "number" },
      ],
    });
    expect(h.stderr).toContain("Using claude to write the template.");
  });

  it("exits 1 when no provider is available", async () => {
    const h = harness({
      resolveProvider: () => {
        throw new ProviderSelectionError("No coding agent found: pass --provider lmstudio.", false);
      },
    });

    expect(await runHeadlessCrawl({ target, fields: "title:string" }, h.deps)).toBe(EXIT_RUNTIME);
    expect(h.stderr).toContain("error: No coding agent found");
    expect(h.started).toEqual([]);
  });

  it("tells the user to install Chromium when Playwright has no browser", async () => {
    const h = harness({
      startCrawl: async () => {
        throw new Error("browserType.launch: Executable doesn't exist at /tmp/chromium");
      },
    });

    expect(await runHeadlessCrawl({ target, fields: "title:string" }, h.deps)).toBe(EXIT_RUNTIME);
    expect(h.stderr).toContain("npx playwright install chromium");
  });

  it("prints the data, per-field details and llmUsed as JSON", async () => {
    const h = harness({ discovery: discovery({ template }) });

    expect(await runHeadlessCrawl({ target }, h.deps)).toBe(EXIT_OK);

    const printed = JSON.parse(h.stdout);
    expect(printed).toMatchObject({
      url: target,
      path: "template-reuse",
      llmUsed: false,
      data: { title: "Clock" },
      fields: {
        title: {
          type: "string",
          found: true,
          value: "Clock",
          selector: { kind: "css", selector: "h1", attribute: "textContent" },
        },
      },
    });
  });
});
