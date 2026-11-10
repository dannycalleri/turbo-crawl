import { describe, expect, it } from "bun:test";
import type { CrawlOptions, CrawlOutcome, CrawlStartInput } from "../src/core/crawl-run.ts";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_ROBOTS_DISALLOWED,
  EXIT_TEMPLATE_MISSING,
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
import { ConfigError } from "../src/core/config.ts";
import { CrawlFailure } from "../src/core/policy/policy.ts";

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

function outcome(input: CrawlStartInput): CrawlOutcome {
  return {
    kind: "item",
    target: input.target,
    finalUrl: input.target,
    canonicalUrl: null,
    fetchedAt: "2026-11-05T00:00:00.000Z",
    policy: { robots: "allowed", tdmReservation: null, tdmPolicyUrl: null, xRobotsTag: null, metaRobots: null, httpStatus: 200 },
    urlPattern: "/products/:slug",
    path: "template-reuse",
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
          bodyMatched: true,
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
    llmUsed: false,
    provider: null,
    templateFit: { templateId: "template_fixture", templatePath: "data/example.com/templates/fixture.json", matchedPattern: true },
    missing: [],
    stale: false,
    artifactFolder: "data/example.com/pages/x",
    warnings: [],
  };
}

function harness(options: {
  /** The fake crawl asks for the provider, as startCrawl does when it must author. */
  authors?: boolean;
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
  let closes = 0;

  const deps: HeadlessDependencies = {
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
          if (options.authors) {
            const provider = runnerOptionsArg.provider;
            if (typeof provider === "function") provider();
          }
          return options.startCrawl ? options.startCrawl(input) : outcome(input);
        },
        close: async () => {
          closes += 1;
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
    get closes() {
      return closes;
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

  it("exits 1 and lists the paths when several templates fit", async () => {
    const paths = ["data/example.com/templates/a.json", "data/example.com/templates/b.json"];
    const h = harness({
      startCrawl: async () => {
        throw new CrawlFailure("AMBIGUOUS_TEMPLATE", `More than one saved template fits:\n  ${paths.join("\n  ")}`, null, null, paths);
      },
    });

    expect(await runHeadlessCrawl({ target }, h.deps)).toBe(EXIT_RUNTIME);
    expect(JSON.parse(h.stdout)).toMatchObject({ ok: false, code: "AMBIGUOUS_TEMPLATE", templatePaths: paths });
    expect(h.stderr).toContain("data/example.com/templates/b.json");
  });

  it("does not resolve a provider when the crawl does not need the agent", async () => {
    const h = harness();

    expect(await runHeadlessCrawl({ target, fields: "title:string" }, h.deps)).toBe(EXIT_OK);
    expect(h.resolveCalls).toBe(0);
    expect(h.started[0]).toEqual({ target, schema: { title: "string" }, require: undefined });
  });

  it("resolves the provider when the crawl needs the agent, and exposes its model", async () => {
    const h = harness({ authors: true });

    expect(await runHeadlessCrawl({ target }, h.deps)).toBe(EXIT_OK);
    expect(h.resolveCalls).toBe(1);
    expect(h.stderr).toContain("Using claude to write the template.");
    expect(h.runnerOptions[0]?.model).toBeNull();
  });

  it("turns authoring off with --no-author and exits 3 when no template fits", async () => {
    const h = harness({
      startCrawl: async () => {
        throw new CrawlFailure("TEMPLATE_MISSING", "No saved template fits.", null);
      },
    });

    expect(await runHeadlessCrawl({ target, author: false }, h.deps)).toBe(EXIT_TEMPLATE_MISSING);
    expect(h.runnerOptions[0]?.authoring).toBe(false);
    expect(JSON.parse(h.stdout)).toMatchObject({ ok: false, code: "TEMPLATE_MISSING" });
  });

  it("passes --require and --no-artifacts to the crawl", async () => {
    const h = harness();

    expect(await runHeadlessCrawl({ target, fields: "headline:string,body:text", require: "headline, body", artifacts: false }, h.deps)).toBe(EXIT_OK);
    expect(h.started[0]?.require).toEqual(["headline", "body"]);
    expect(h.runnerOptions[0]).toMatchObject({ authoring: true, writeArtifacts: false });
  });

  it("exits 2 when --require names a field that --fields does not list", async () => {
    const h = harness();

    expect(await runHeadlessCrawl({ target, fields: "headline:string", require: "body" }, h.deps)).toBe(EXIT_USAGE);
    expect(h.stderr).toContain("--require names body");
    expect(h.started).toEqual([]);
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

  it("exits 1 when the agent is needed but no provider is available", async () => {
    const h = harness({
      authors: true,
      resolveProvider: () => {
        throw new ProviderSelectionError("No coding agent found: pass --provider lmstudio.", false);
      },
    });

    expect(await runHeadlessCrawl({ target, fields: "title:string" }, h.deps)).toBe(EXIT_RUNTIME);
    expect(h.stderr).toContain("error: No coding agent found");
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
    const h = harness();

    expect(await runHeadlessCrawl({ target }, h.deps)).toBe(EXIT_OK);

    const printed = JSON.parse(h.stdout);
    expect(printed).toMatchObject({
      kind: "item",
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

  describe("following a listing", () => {
    const listing = (url: string): CrawlOutcome => ({
      kind: "listing",
      target: url,
      finalUrl: url,
      canonicalUrl: null,
      fetchedAt: "2026-11-05T00:00:00.000Z",
      urlPattern: "/category/clocks",
      policy: { robots: "allowed", tdmReservation: null, tdmPolicyUrl: null, xRobotsTag: null, metaRobots: null, httpStatus: 200 },
      items: ["clock-1", "clock-2"].map(slug => ({ url: `https://example.com/products/${slug}`, text: slug, cssPath: "a" })),
      itemUrlPatterns: ["/products/:slug"],
      paginationUrls: [],
      linkGroups: [],
      llmUsed: true,
      provider: "claude",
      templateFit: { templateId: "listing_x", templatePath: "listings/x.json", matchedPattern: true },
      artifactFolder: null,
      warnings: [],
    });
    const crawlWith = (failing: string[], authors = false) =>
      harness({
        authors,
        startCrawl: async input => {
          if (input.target.includes("/category/")) return listing(input.target);
          if (failing.some(slug => input.target.endsWith(slug))) throw new CrawlFailure("HTTP_ERROR", `${input.target} answered 404.`, null);
          return outcome(input);
        },
      });
    const categoryUrl = "https://example.com/category/clocks";

    it("prints one JSON line per item and a summary, and exits 0 when some items succeed", async () => {
      const h = crawlWith(["clock-2"]);

      expect(await runHeadlessCrawl({ target: categoryUrl, delayMs: 0 }, h.deps)).toBe(EXIT_OK);

      const lines = h.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(lines).toMatchObject([
        { ok: true, kind: "item", url: "https://example.com/products/clock-1" },
        { ok: false, url: "https://example.com/products/clock-2", code: "HTTP_ERROR" },
      ]);
      expect(h.started.map(input => input.expect)).toEqual([undefined, "detail", "detail"]);
      expect(h.stderr).toContain("Crawled 1 listing page(s): 1 item(s) extracted, 1 failed.");
    });

    it("exits 0 with every item extracted, resolves the provider once, and closes the browser", async () => {
      const h = crawlWith([], true);

      expect(await runHeadlessCrawl({ target: categoryUrl, delayMs: 0 }, h.deps)).toBe(EXIT_OK);
      expect(h.stdout.trim().split("\n")).toHaveLength(2);
      expect(h.stderr).toContain("2 item(s) extracted, 0 failed.");
      expect(h.resolveCalls).toBe(1);
      expect(h.stderr.match(/Using claude/g)).toHaveLength(1);
      expect(h.closes).toBe(1);
    });

    it("closes the browser when the crawl throws", async () => {
      const h = harness({
        startCrawl: async () => {
          throw new Error("browserType.launch: Executable doesn't exist");
        },
      });

      expect(await runHeadlessCrawl({ target: categoryUrl }, h.deps)).toBe(EXIT_RUNTIME);
      expect(h.closes).toBe(1);
    });

    it("exits 1 when every item fails", async () => {
      const h = crawlWith(["clock-1", "clock-2"]);

      expect(await runHeadlessCrawl({ target: categoryUrl, delayMs: 0 }, h.deps)).toBe(EXIT_RUNTIME);
    });

    it("prints only the listing with --no-follow", async () => {
      const h = crawlWith([]);

      expect(await runHeadlessCrawl({ target: categoryUrl, follow: false }, h.deps)).toBe(EXIT_OK);
      expect(JSON.parse(h.stdout)).toMatchObject({ kind: "listing", itemUrls: ["https://example.com/products/clock-1", "https://example.com/products/clock-2"] });
      expect(h.started).toHaveLength(1);
    });

    it("exits 2 on a limit that is not a whole number in range", async () => {
      for (const input of [{ maxPages: 0 }, { maxItems: 1.5 }, { delayMs: -1 }]) {
        const h = crawlWith([]);
        expect(await runHeadlessCrawl({ target: categoryUrl, ...input }, h.deps)).toBe(EXIT_USAGE);
        expect(h.started).toHaveLength(0);
      }
    });
  });
});
