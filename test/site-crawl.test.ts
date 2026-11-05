import { describe, expect, it } from "bun:test";
import type { CrawlOutcome, CrawlStartInput, ItemOutcome, ListingOutcome } from "../src/core/crawl-run.ts";
import { CrawlFailure } from "../src/core/policy/policy.ts";
import { crawlSite, normalizeCrawlUrl, type SiteCrawlEvent, type SiteCrawlLimits } from "../src/core/site-crawl.ts";

const policy = { robots: "allowed", tdmReservation: null, tdmPolicyUrl: null, xRobotsTag: null, metaRobots: null, httpStatus: 200 } as const;
const fit = { templateId: "t", templatePath: "t.json", matchedPattern: true };

function listing(url: string, items: string[], paginationUrls: string[] = []): ListingOutcome {
  return {
    kind: "listing",
    target: url,
    finalUrl: url,
    canonicalUrl: null,
    fetchedAt: "2026-11-05T00:00:00.000Z",
    urlPattern: "/category/clocks",
    policy,
    items: items.map(item => ({ url: item, text: "", cssPath: "a" })),
    paginationUrls,
    linkGroups: [],
    llmUsed: false,
    provider: null,
    templateFit: fit,
    artifactFolder: null,
    warnings: [],
  };
}

function item(url: string, schema: ItemOutcome["schema"]): ItemOutcome {
  return {
    kind: "item",
    target: url,
    finalUrl: url,
    canonicalUrl: null,
    fetchedAt: "2026-11-05T00:00:00.000Z",
    urlPattern: "/products/:slug",
    policy,
    path: "template-reuse",
    schema,
    result: { payload: {}, fieldResults: {}, confidence: 1, templateId: "t", usedTemplate: true, llmUsed: false, warnings: [] },
    llmUsed: false,
    provider: null,
    templateFit: fit,
    missing: [],
    stale: false,
    artifactFolder: null,
    warnings: [],
  };
}

const product = (n: number) => `https://shop.test/products/clock-${n}`;
const limits: SiteCrawlLimits = { maxPages: 10, maxItems: 200, delayMs: 0 };

async function crawl(options: {
  start: ListingOutcome;
  pages?: Record<string, ListingOutcome>;
  failing?: string[];
  throwing?: Record<string, Error>;
  isFatal?: (error: unknown) => boolean;
  limits?: Partial<SiteCrawlLimits>;
  schema?: ItemOutcome["schema"];
}) {
  const started: CrawlStartInput[] = [];
  const events: SiteCrawlEvent[] = [];
  const summary = await crawlSite({
    start: options.start,
    schema: options.schema ?? { title: "string" },
    limits: { ...limits, ...options.limits },
    onEvent: event => events.push(event),
    isFatal: options.isFatal,
    runner: {
      async startCrawl(input): Promise<CrawlOutcome> {
        started.push(input);
        if (input.expect === "listing") return options.pages![input.target]!;
        if (options.failing?.includes(input.target)) throw new CrawlFailure("HTTP_ERROR", `${input.target} answered 404.`, null);
        if (options.throwing?.[input.target]) throw options.throwing[input.target];
        return item(input.target, Object.keys(input.schema).length > 0 ? input.schema : { title: "string", price: "number" });
      },
    },
  });
  return { summary, started, events };
}

describe("crawlSite", () => {
  it("extracts every item of a page before it reads the next listing page", async () => {
    const page2 = "https://shop.test/category/clocks?page=2";
    const { summary, started } = await crawl({
      start: listing("https://shop.test/category/clocks", [product(1), product(2)], [page2]),
      pages: { [page2]: listing(page2, [product(3)]) },
    });

    expect(started.map(input => [input.expect, input.target, input.listingTemplatePath])).toEqual([
      ["detail", product(1), undefined],
      ["detail", product(2), undefined],
      ["listing", page2, "t.json"],
      ["detail", product(3), undefined],
    ]);
    expect(summary).toEqual({ listingPages: 2, extracted: 3, failed: 0 });
  });

  it("visits each URL once, ignoring fragments and utm_ parameters, and skips other hosts", async () => {
    const { started } = await crawl({
      start: listing("https://shop.test/category/clocks", [
        product(1),
        `${product(1)}?utm_source=mail#reviews`,
        `${product(1)}?color=red`,
        "https://other.test/products/clock-9",
      ]),
    });

    expect(started.map(input => input.target)).toEqual([product(1), `${product(1)}?color=red`]);
  });

  it("stops at --max-items and at --max-pages", async () => {
    const pages = Object.fromEntries([2, 3].map(n => {
      const url = `https://shop.test/category/clocks?page=${n}`;
      return [url, listing(url, [product(n * 10)], [`https://shop.test/category/clocks?page=${n + 1}`])];
    }));
    const start = listing("https://shop.test/category/clocks", [product(1), product(2), product(3)], ["https://shop.test/category/clocks?page=2"]);

    const byItems = await crawl({ start, pages, limits: { maxItems: 2 } });
    const byPages = await crawl({ start, pages, limits: { maxPages: 2 } });

    expect(byItems.summary).toEqual({ listingPages: 1, extracted: 2, failed: 0 });
    expect(byPages.summary).toEqual({ listingPages: 2, extracted: 4, failed: 0 });
  });

  it("does not read the next listing page once the item limit is reached", async () => {
    const page2 = "https://shop.test/category/clocks?page=2";
    const { summary, started } = await crawl({
      start: listing("https://shop.test/category/clocks", [product(1), product(2)], [page2]),
      pages: { [page2]: listing(page2, [product(3)]) },
      limits: { maxItems: 2 },
    });

    expect(started.map(input => input.target)).toEqual([product(1), product(2)]);
    expect(summary.listingPages).toBe(1);
  });

  it("gives the second item the fields suggested for the first one", async () => {
    const { started } = await crawl({ start: listing("https://shop.test/category/clocks", [product(1), product(2)]), schema: {} });

    expect(started.map(input => input.schema)).toEqual([{}, { title: "string", price: "number" }]);
  });

  it("reports a failed item and goes on with the next one", async () => {
    const { summary, events } = await crawl({
      start: listing("https://shop.test/category/clocks", [product(1), product(2), product(3)]),
      failing: [product(2)],
    });

    expect(events.map(event => event.kind)).toEqual(["item", "item-failed", "item"]);
    expect(summary).toEqual({ listingPages: 1, extracted: 2, failed: 1 });
  });

  it("turns any other item error into a failed item, but stops on a fatal one", async () => {
    const start = listing("https://shop.test/category/clocks", [product(1), product(2)]);
    const timeout = new Error("claude did not answer within 600000 ms");

    const survived = await crawl({ start, throwing: { [product(1)]: timeout } });
    expect(survived.events).toMatchObject([
      { kind: "item-failed", url: product(1), error: { code: "RUNTIME_ERROR", message: timeout.message } },
      { kind: "item" },
    ]);

    await expect(crawl({ start, throwing: { [product(1)]: timeout }, isFatal: error => error === timeout })).rejects.toBe(timeout);
  });

  it("waits the delay before every page it renders", async () => {
    const waits: number[] = [];
    await crawlSite({
      start: listing("https://shop.test/category/clocks", [product(1), product(2)]),
      schema: { title: "string" },
      limits: { ...limits, delayMs: 250 },
      onEvent: () => {},
      sleep: async ms => {
        waits.push(ms);
      },
      runner: { startCrawl: async input => item(input.target, input.schema) },
    });

    expect(waits).toEqual([250, 250]);
  });
});

describe("normalizeCrawlUrl", () => {
  it("drops the fragment and utm_ parameters and keeps the rest of the query", () => {
    expect(normalizeCrawlUrl("https://shop.test/p?page=2&UTM_Campaign=x&utm_source=y#top")).toBe("https://shop.test/p?page=2");
  });
});
