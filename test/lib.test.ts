import { describe, expect, it } from "bun:test";
import type { CrawlOptions, CrawlOutcome, CrawlStartInput, ItemOutcome, ListingOutcome } from "../src/core/crawl-run.ts";
import { CrawlFailure, type CrawlFailureCode, type PolicyInfo } from "../src/core/policy/policy.ts";
import { createCrawler, type CrawlerOptions, type LibraryDependencies } from "../src/lib.ts";
import { createCrawlRunner, defaultStartCrawlDependencies } from "../src/core/crawl-run.ts";
import type { PagePacket } from "../src/core/types.ts";
import type { Page } from "playwright";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const policy: PolicyInfo = { robots: "allowed", tdmReservation: null, tdmPolicyUrl: null, xRobotsTag: null, metaRobots: null, httpStatus: 200 };
const facts = {
  target: "https://site.com/news/a",
  finalUrl: "https://site.com/news/a",
  canonicalUrl: "https://site.com/news/a",
  fetchedAt: "2026-11-05T10:00:00.000Z",
  urlPattern: "/news/:slug",
  policy,
};
const templateFit = { templateId: "template_x", templatePath: "templates/x.json", matchedPattern: true };

const article: ItemOutcome = {
  ...facts,
  kind: "item",
  path: "template-reuse",
  schema: { headline: "string", date: "date" },
  result: { payload: { headline: "Rolex", date: null }, fieldResults: {}, confidence: 1, templateId: "template_x", usedTemplate: true, llmUsed: false, warnings: [] },
  llmUsed: false,
  provider: null,
  templateFit,
  missing: ["date"],
  stale: false,
  artifactFolder: null,
  warnings: [],
};

const index: ListingOutcome = {
  ...facts,
  kind: "listing",
  items: [{ url: "https://site.com/news/rolex-daytona", text: "B", cssPath: "main > a.card" }],
  paginationUrls: ["https://site.com/news?page=2"],
  linkGroups: [{ urlPattern: "/news/:slug", count: 1, samples: ["https://site.com/news/rolex-daytona"] }],
  llmUsed: false,
  provider: null,
  templateFit,
  artifactFolder: null,
  warnings: [],
};

const options: CrawlerOptions = { dataDir: "templates", userAgent: "TestBot/1.0", authoring: "never" };

function fakes(startCrawl: (input: CrawlStartInput) => Promise<CrawlOutcome>) {
  const runnerOptions: CrawlOptions[] = [];
  const started: CrawlStartInput[] = [];
  let providerResolutions = 0;
  const deps: LibraryDependencies = {
    createBrowserSession: () => ({ withRenderedPage: async () => { throw new Error("not rendered"); }, close: async () => {} }),
    createRobotsChecker: () => ({ check: async () => "allowed" }),
    resolveProvider: () => {
      providerResolutions += 1;
      throw new Error("no agent here");
    },
    createRunner: runnerOptionsArg => {
      runnerOptions.push(runnerOptionsArg);
      return {
        startCrawl: input => {
          started.push(input);
          return startCrawl(input);
        },
      };
    },
  };
  return { deps, runnerOptions, started, get providerResolutions() { return providerResolutions; } };
}

describe("createCrawler", () => {
  it("throws an error that names a missing or empty userAgent", () => {
    const { deps } = fakes(async () => article);

    expect(() => createCrawler({ ...options, userAgent: undefined } as unknown as CrawlerOptions, deps)).toThrow("options.userAgent");
    expect(() => createCrawler({ ...options, userAgent: " " }, deps)).toThrow("options.userAgent");
    expect(() => createCrawler({ ...options, authoring: "sometimes" } as unknown as CrawlerOptions, deps)).toThrow("options.authoring");
  });

  it("never resolves a provider when authoring is never", async () => {
    const f = fakes(async () => article);
    const crawler = createCrawler(options, f.deps);

    await crawler.extract("https://site.com/news/a");
    const provider = f.runnerOptions[0]!.provider as () => unknown;

    expect(f.runnerOptions[0]!.authoring).toBe(false);
    expect(() => provider()).toThrow("authoring is \"never\"");
    expect(f.providerResolutions).toBe(0);
  });

  it("resolves to TEMPLATE_MISSING through the real runner and starts no provider when authoring is never", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "turbo-crawl-lib-"));
    const f = fakes(async () => article);
    const deps: LibraryDependencies = {
      ...f.deps,
      createRunner: runnerOptions =>
        createCrawlRunner(runnerOptions, {
          ...defaultStartCrawlDependencies,
          withRenderedPage: async (url, handler) =>
            handler({
              page: {} as Page,
              pagePacket: {
                url,
                finalUrl: url,
                fetchedAt: "2026-11-05T10:00:00.000Z",
                response: { status: 200, xRobotsTag: null, tdmReservation: null, tdmPolicy: null, retryAfter: null },
                metadata: { canonicalUrl: null, description: null, robots: null, openGraph: {}, twitter: {}, other: {} },
              } as PagePacket,
            }),
        }),
    };

    try {
      const result = await createCrawler({ ...options, dataDir }, deps).extract("https://site.com/news/a");

      expect(result).toMatchObject({ ok: false, code: "TEMPLATE_MISSING" });
      expect(f.providerResolutions).toBe(0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("extracts as a detail page and maps the result to the contract", async () => {
    const f = fakes(async () => article);
    const crawler = createCrawler(options, f.deps);

    const result = await crawler.extract("https://site.com/news/a", { fields: { headline: "string", date: "date" }, require: ["headline"] });

    expect(f.started[0]).toEqual({
      target: "https://site.com/news/a",
      schema: { headline: "string", date: "date" },
      require: ["headline"],
      expect: "detail",
    });
    expect(result).toEqual({
      ok: true,
      schemaVersion: 1,
      url: "https://site.com/news/a",
      finalUrl: "https://site.com/news/a",
      canonicalUrl: "https://site.com/news/a",
      fetchedAt: "2026-11-05T10:00:00.000Z",
      urlPattern: "/news/:slug",
      policy,
      warnings: [],
      templateFit,
      data: { headline: "Rolex", date: null },
      missing: ["date"],
      stale: false,
    });
  });

  it("reads links as a listing page, with the URL pattern of each item", async () => {
    const f = fakes(async () => index);
    const crawler = createCrawler(options, f.deps);

    const result = await crawler.links("https://site.com/news");

    expect(f.started[0]!.expect).toBe("listing");
    expect(result).toMatchObject({
      ok: true,
      schemaVersion: 1,
      itemUrls: [{ url: "https://site.com/news/rolex-daytona", text: "B", urlPattern: "/news/:slug", cssPath: "main > a.card" }],
      paginationUrls: ["https://site.com/news?page=2"],
      patterns: index.linkGroups,
    });
  });

  it("resolves every crawl failure to an error result instead of throwing", async () => {
    const codes: CrawlFailureCode[] = ["TEMPLATE_MISSING", "ROBOTS_DISALLOWED", "BLOCKED", "HTTP_ERROR", "TIMEOUT", "AMBIGUOUS_TEMPLATE"];

    for (const code of codes) {
      const failure = new CrawlFailure(code, `${code} happened`, code === "ROBOTS_DISALLOWED" ? null : policy, code === "BLOCKED" ? 120 : null, ["a.json", "b.json"]);
      const crawler = createCrawler(options, fakes(async () => { throw failure; }).deps);

      const result = await crawler.extract("https://site.com/news/a");

      expect(result).toEqual({
        ok: false,
        schemaVersion: 1,
        url: "https://site.com/news/a",
        code,
        message: `${code} happened`,
        policy: code === "ROBOTS_DISALLOWED" ? null : policy,
        ...(code === "BLOCKED" ? { retryAfterSeconds: 120 } : {}),
        ...(code === "AMBIGUOUS_TEMPLATE" ? { templatePaths: ["a.json", "b.json"] } : {}),
      });
    }
  });
});
