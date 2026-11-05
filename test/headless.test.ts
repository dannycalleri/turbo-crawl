import { describe, expect, it } from "bun:test";
import type { CrawlOptions, CrawlOutcome, CrawlStartInput } from "../src/core/crawl-run.ts";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_ROBOTS_DISALLOWED,
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
import { ConfigError } from "../src/core/config.ts";
import { CrawlFailure } from "../src/core/policy/policy.ts";
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
  urlPatterns: ["/products/:slug"],
  schema: { title: "string" },
  createdFromUrl: "https://example.com/products/one",
  createdAt: "2026-10-11T10:00:00.000Z",
  fields: {},
};

function discovery(overrides: Partial<ReuseDiscoveryOptions> = {}): ReuseDiscoveryOptions {
  return { template: null, warnings: [], ambiguousTemplates: [], ...overrides };
}

function outcome(input: CrawlStartInput): CrawlOutcome {
  return {
    target: input.target,
    finalUrl: input.target,
    policy: { robots: "allowed", tdmReservation: null, tdmPolicyUrl: null, xRobotsTag: null, metaRobots: null, httpStatus: 200 },
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
  resolveUserAgent?: (option: string | undefined) => Promise<string>;
} = {}) {
  let stdout = "";
  let stderr = "";
  const started: CrawlStartInput[] = [];
  const runnerOptions: CrawlOptions[] = [];
  const robotsCheckers: string[] = [];
  let resolveCalls = 0;

  const deps: HeadlessDependencies = {
    discover: async () => options.discovery ?? discovery(),
    resolveUserAgent: options.resolveUserAgent ?? (async option => option ?? "ConfigBot/1.0"),
    createRobotsChecker: userAgent => {
      robotsCheckers.push(userAgent);
      return { check: async () => "allowed" };
    },
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
  };

  return {
    deps,
    started,
    runnerOptions,
    robotsCheckers,
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
          { path: "data/example.com/templates/a.json", template },
          { path: "data/example.com/templates/b.json", template },
        ],
      }),
    });

    expect(await runHeadlessCrawl({ target }, h.deps)).toBe(EXIT_RUNTIME);
    expect(JSON.parse(h.stdout)).toMatchObject({
      ok: false,
      code: "AMBIGUOUS_TEMPLATE",
      templatePaths: ["data/example.com/templates/a.json", "data/example.com/templates/b.json"],
    });
    expect(h.stderr).toContain("data/example.com/templates/a.json");
    expect(h.stderr).toContain("data/example.com/templates/b.json");
    expect(h.started).toEqual([]);
  });

  it("reuses a single saved template without resolving a provider", async () => {
    const h = harness({ discovery: discovery({ template }) });

    expect(await runHeadlessCrawl({ target }, h.deps)).toBe(EXIT_OK);
    expect(h.resolveCalls).toBe(0);
    expect(h.started[0]).toMatchObject({ source: "template-reuse", template });
  });

  it("authors a new template when --fields differs from the saved one", async () => {
    const h = harness({ discovery: discovery({ template }) });

    expect(await runHeadlessCrawl({ target, fields: "title:string,price:number" }, h.deps)).toBe(EXIT_OK);
    expect(h.resolveCalls).toBe(1);
    expect(h.started[0]).toMatchObject({
      source: "fields",
      schema: { title: "string", price: "number" },
    });
    expect(h.stderr).toContain("Using claude to write the template.");
  });

  it("passes the resolved user agent to the crawl", async () => {
    const h = harness();

    expect(await runHeadlessCrawl({ target, fields: "title:string" }, h.deps)).toBe(EXIT_OK);
    expect(await runHeadlessCrawl({ target, fields: "title:string", userAgent: "CliBot/1.0" }, h.deps)).toBe(EXIT_OK);
    expect(h.runnerOptions.map(options => options.userAgent)).toEqual(["ConfigBot/1.0", "CliBot/1.0"]);
  });

  it("checks robots.txt with the resolved user agent unless --ignore-robots is given", async () => {
    const h = harness();

    await runHeadlessCrawl({ target, fields: "title:string" }, h.deps);
    await runHeadlessCrawl({ target, fields: "title:string", ignoreRobots: true }, h.deps);

    expect(h.robotsCheckers).toEqual(["ConfigBot/1.0"]);
    expect(h.runnerOptions[0]?.robots).not.toBeNull();
    expect(h.runnerOptions[1]?.robots).toBeNull();
  });

  it("exits 4 with a JSON error when robots.txt disallows the URL", async () => {
    const h = harness({
      startCrawl: async () => {
        throw new CrawlFailure("ROBOTS_DISALLOWED", "robots.txt disallows it.", null);
      },
    });

    expect(await runHeadlessCrawl({ target, fields: "title:string" }, h.deps)).toBe(EXIT_ROBOTS_DISALLOWED);
    expect(JSON.parse(h.stdout)).toEqual({
      ok: false,
      url: target,
      code: "ROBOTS_DISALLOWED",
      message: "robots.txt disallows it.",
      policy: null,
    });
  });

  it("exits 1 with the Retry-After delay when the site blocks the request", async () => {
    const policy = { robots: "allowed", tdmReservation: null, tdmPolicyUrl: null, xRobotsTag: null, metaRobots: null, httpStatus: 429 } as const;
    const h = harness({
      startCrawl: async () => {
        throw new CrawlFailure("BLOCKED", "answered 429", policy, 120);
      },
    });

    expect(await runHeadlessCrawl({ target, fields: "title:string" }, h.deps)).toBe(EXIT_RUNTIME);
    expect(JSON.parse(h.stdout)).toMatchObject({ ok: false, code: "BLOCKED", retryAfterSeconds: 120, policy });
  });

  it("prints invalid arguments as a JSON error too", async () => {
    const h = harness();

    expect(await runHeadlessCrawl({ target, fields: "price:money" }, h.deps)).toBe(EXIT_USAGE);
    expect(JSON.parse(h.stdout)).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
  });

  it("exits 2 naming the file when a config file is invalid", async () => {
    const h = harness({
      resolveUserAgent: async () => {
        throw new ConfigError("The config file /repo/turbo-crawl.json is not valid JSON: Unexpected token. Fix or remove it.");
      },
    });

    expect(await runHeadlessCrawl({ target, fields: "title:string" }, h.deps)).toBe(EXIT_USAGE);
    expect(h.stderr).toContain("/repo/turbo-crawl.json");
    expect(h.started).toHaveLength(0);
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
