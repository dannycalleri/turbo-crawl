import { describe, expect, it } from "bun:test";
import type { CrawlOptions, CrawlOutcome, CrawlStartInput, ItemOutcome, ListingOutcome } from "../src/core/crawl-run.ts";
import { CrawlFailure, type CrawlFailureCode, type PolicyInfo } from "../src/core/policy/policy.ts";
import { createCrawler, type CrawlerOptions, type LibraryDependencies, type LLMProvider, type LLMRequest, type TemplateStore } from "../src/lib.ts";
import { memoryStore } from "./fixtures/memory-store.ts";
import type { LLMProvider as InternalProvider } from "../src/core/llm-extractor/providers/LLMProvider.ts";
import { ClaudeCliProvider } from "../src/core/llm-extractor/providers/ClaudeCliProvider.ts";
import { authorTemplate } from "../src/core/template-author/authorTemplate.ts";
import { createCrawlRunner, defaultStartCrawlDependencies } from "../src/core/crawl-run.ts";
import { createRobotsChecker, type RobotsFetch } from "../src/core/policy/robots.ts";
import type { PagePacket } from "../src/core/types.ts";
import type { RenderedPageContext } from "../src/core/crawler.ts";
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
  items: [
    { url: "https://site.com/news/rolex-daytona", text: "B", cssPath: "main > a.card" },
    { url: "https://site.com/about", text: "About", cssPath: "main > a.about" },
  ],
  itemUrlPatterns: ["/news/:story"],
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
    createBrowserSession: () => ({
      withRenderedPage: async () => { throw new Error("not rendered"); },
      withSnapshotPage: async () => { throw new Error("not rendered"); },
      close: async () => {},
    }),
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
      itemUrls: [
        { url: "https://site.com/news/rolex-daytona", text: "B", urlPattern: "/news/:story", cssPath: "main > a.card" },
        { url: "https://site.com/about", text: "About", urlPattern: "/about", cssPath: "main > a.about" },
      ],
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

describe("provider option", () => {
  function callerProvider() {
    const requests: LLMRequest[] = [];
    const provider: LLMProvider = {
      name: "gateway",
      async completeStructured(request) {
        requests.push(request);
        return { parsed: { ok: true }, raw: "raw answer" };
      },
    };
    return { provider, requests };
  }
  const agentRequest = { model: "", messages: [{ role: "user" as const, content: "Write a template" }], jsonSchema: { type: "object" }, timeoutMs: 1234 };

  it("sends every agent call to the caller's object with the model option, and starts no CLI agent", async () => {
    const f = fakes(async () => article);
    const caller = callerProvider();
    const crawler = createCrawler({ ...options, authoring: "allowed", provider: caller.provider, model: "anthropic/claude-haiku" }, f.deps);
    await crawler.extract("https://site.com/news/a");
    const resolve = f.runnerOptions[0]!.provider as () => InternalProvider;

    const agent = resolve();
    const answers = [await agent.completeStructured(agentRequest), await agent.completeStructured({ ...agentRequest, model: "other" })];

    expect(agent.name).toBe("gateway");
    expect(f.runnerOptions[0]!.model).toBe("anthropic/claude-haiku");
    expect(answers).toEqual([{ parsed: { ok: true }, raw: "raw answer" }, { parsed: { ok: true }, raw: "raw answer" }]);
    expect(caller.requests.map(request => request.model)).toEqual(["anthropic/claude-haiku", "anthropic/claude-haiku"]);
    expect(caller.requests[0]).toMatchObject({ messages: agentRequest.messages, jsonSchema: agentRequest.jsonSchema, timeoutMs: 1234 });
    expect(f.providerResolutions).toBe(0);
  });

  it("sends a null model when the caller gives none, and names the provider custom", async () => {
    const f = fakes(async () => article);
    const caller = callerProvider();
    createCrawler({ ...options, authoring: "allowed", provider: { completeStructured: caller.provider.completeStructured } }, f.deps);
    const agent = (f.runnerOptions[0]!.provider as () => InternalProvider)();

    await agent.completeStructured(agentRequest);

    expect(agent.name).toBe("custom");
    expect(caller.requests[0]!.model).toBeNull();
  });

  it("never calls the object when authoring is never", async () => {
    const f = fakes(async () => article);
    const caller = callerProvider();
    createCrawler({ ...options, provider: caller.provider }, f.deps);

    expect(() => (f.runnerOptions[0]!.provider as () => unknown)()).toThrow("authoring is \"never\"");
    expect(caller.requests).toHaveLength(0);
    expect(f.providerResolutions).toBe(0);
  });

  it("aborts the signal and rejects with the timeout when the object does not answer in time", async () => {
    const f = fakes(async () => article);
    let signal: AbortSignal | null = null;
    const hanging: LLMProvider = {
      name: "gateway",
      completeStructured: request => {
        signal = request.signal;
        return new Promise(() => {});
      },
    };
    createCrawler({ ...options, authoring: "allowed", provider: hanging }, f.deps);
    const agent = (f.runnerOptions[0]!.provider as () => InternalProvider)();

    const call = agent.completeStructured({ ...agentRequest, timeoutMs: 20 });

    await expect(call).rejects.toThrow("gateway: no answer after 20ms; the request was aborted. Raise TURBO_CRAWL_LLM_TIMEOUT_MS to wait longer.");
    expect(signal!.aborted).toBe(true);
  });

  it("does not abort the signal of a call that answers in time", async () => {
    const f = fakes(async () => article);
    const caller = callerProvider();
    createCrawler({ ...options, authoring: "allowed", provider: caller.provider }, f.deps);
    const agent = (f.runnerOptions[0]!.provider as () => InternalProvider)();

    await agent.completeStructured({ ...agentRequest, timeoutMs: 20 });
    await new Promise(resolve => setTimeout(resolve, 40));

    expect(caller.requests[0]!.signal.aborted).toBe(false);
  });

  it("treats an answer with no selectors for a field like the same answer from the claude CLI", async () => {
    const answer = { fields: { title: { expectedSample: null } }, urlPattern: "/news/:slug", sameTypeLinks: [], otherTypeLinks: [] };
    const f = fakes(async () => article);
    createCrawler({ ...options, authoring: "allowed", provider: { completeStructured: async () => ({ parsed: answer, raw: answer }) } }, f.deps);
    const objectProvider = (f.runnerOptions[0]!.provider as () => InternalProvider)();
    const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: answer });
    const cliProvider = new ClaudeCliProvider({
      run: async () => ({ exitCode: 0, stdout, stderr: "", timedOut: false, spawnError: null }),
    });
    const pagePacket = {
      url: "https://site.com/news/a",
      finalUrl: "https://site.com/news/a",
      title: "A",
      metadata: { canonicalUrl: null, description: null, robots: null, openGraph: {}, twitter: {}, other: {} },
      jsonLd: [],
      tables: [],
      links: [],
    } as unknown as PagePacket;
    const author = (provider: InternalProvider) =>
      authorTemplate({ schema: { title: "string" }, page: {} as Page, pagePacket, skeleton: "body", provider, timeoutMs: 1000 })
        .then(() => "authored", (error: Error) => error.message);

    const [fromObject, fromCli] = await Promise.all([author(objectProvider), author(cliProvider)]);

    expect(fromObject).toStartWith("The agent's answer did not match the template format: fields.title.selectors");
    expect(fromObject).toBe(fromCli);
  });

  it("throws for a provider without completeStructured, or an empty model", () => {
    const { deps } = fakes(async () => article);

    expect(() => createCrawler({ ...options, provider: {} as LLMProvider }, deps)).toThrow("options.provider needs a completeStructured(request) function");
    expect(() => createCrawler({ ...options, provider: callerProvider().provider, model: " " }, deps)).toThrow("options.model");
    expect(() => createCrawler({ ...options, model: "some-model" }, deps)).toThrow("options.model needs options.provider");
  });
});

describe("store option", () => {
  it("creates a crawler with a store and no dataDir, and passes the store to the runner", () => {
    const f = fakes(async () => article);
    const { store } = memoryStore();
    const { dataDir: _dataDir, ...noDataDir } = options;

    createCrawler({ ...noDataDir, store }, f.deps);

    expect(f.runnerOptions[0]!.store).toBe(store);
    expect(f.runnerOptions[0]!.dataDir).toBeUndefined();
  });

  it("throws without both dataDir and store, and names both", () => {
    const { dataDir: _dataDir, ...noDataDir } = options;

    expect(() => createCrawler(noDataDir, fakes(async () => article).deps)).toThrow("options.dataDir or options.store is required");
  });

  it("needs dataDir for writeArtifacts, even with a store", () => {
    const { dataDir: _dataDir, ...noDataDir } = options;

    expect(() => createCrawler({ ...noDataDir, store: memoryStore().store, writeArtifacts: true }, fakes(async () => article).deps))
      .toThrow("options.dataDir is required with writeArtifacts: true");
  });

  it("names the functions that a store lacks", () => {
    const { updateListingTemplate: _update, ...partial } = memoryStore().store;

    expect(() => createCrawler({ ...options, store: partial as TemplateStore }, fakes(async () => article).deps))
      .toThrow("options.store needs these functions: updateListingTemplate.");
  });
});

describe("extractHtml", () => {
  it("passes the snapshot to the runner as a detail page and maps the result like extract", async () => {
    const f = fakes(async () => article);
    const crawler = createCrawler(options, f.deps);

    const result = await crawler.extractHtml({
      url: "https://site.com/news/a",
      html: "<h1>Rolex</h1>",
      fields: { headline: "string" },
      require: ["headline"],
    });

    expect(f.started[0]).toEqual({
      target: "https://site.com/news/a",
      schema: { headline: "string" },
      require: ["headline"],
      expect: "detail",
      snapshotHtml: "<h1>Rolex</h1>",
    });
    expect(result).toMatchObject({ ok: true, finalUrl: "https://site.com/news/a", data: { headline: "Rolex", date: null } });
  });

  it("rejects a URL that is not absolute http or https", async () => {
    const crawler = createCrawler(options, fakes(async () => article).deps);

    for (const url of ["/item/1", "ftp://site.com/item/1", "not a url"]) {
      await expect(crawler.extractHtml({ url, html: "<p>x</p>" })).rejects.toThrow("url must be an absolute http or https URL");
    }
  });

  it("rejects empty HTML", async () => {
    const crawler = createCrawler(options, fakes(async () => article).deps);

    await expect(crawler.extractHtml({ url: "https://site.com/a", html: "  " })).rejects.toThrow("html must be the non-empty HTML");
  });

  it("rejects HTML larger than 10 MB, counted in UTF-8 bytes", async () => {
    const f = fakes(async () => article);
    const crawler = createCrawler(options, f.deps);
    const accented = "é".repeat(5 * 1024 * 1024 + 1);

    await expect(crawler.extractHtml({ url: "https://site.com/a", html: accented })).rejects.toThrow("larger than 10 MB");
    expect(f.started).toHaveLength(0);
  });

  it("names extractHtml in a field type error", async () => {
    const crawler = createCrawler(options, fakes(async () => article).deps);

    await expect(crawler.extractHtml({
      url: "https://site.com/a",
      html: "<p>x</p>",
      fields: { price: "money" as "number" },
    })).rejects.toThrow("extractHtml: field \"price\" has the unknown type");
  });
});

describe("concurrent calls", () => {
  function pagedFakes(renderMs: () => Promise<void>) {
    let open = 0;
    let maxOpen = 0;
    let closed = false;
    const robotsFetches: string[] = [];
    const fetch: RobotsFetch = async url => {
      robotsFetches.push(url);
      return { status: 404, text: async () => "" };
    };
    const deps: LibraryDependencies = {
      ...fakes(async () => article).deps,
      createBrowserSession: () => {
        const openPage = async <T>(handler: (context: RenderedPageContext) => T | Promise<T>): Promise<T> => {
          open += 1;
          maxOpen = Math.max(maxOpen, open);
          try {
            await renderMs();
            return await handler({ page: {} as Page, pagePacket: {} as PagePacket });
          } finally {
            open -= 1;
          }
        };
        return {
          withRenderedPage: (_url, handler) => openPage(handler),
          withSnapshotPage: (_url, _html, handler) => openPage(handler),
          close: async () => {
            closed = true;
          },
        };
      },
      createRobotsChecker: userAgent => createRobotsChecker({ userAgent, fetch }),
      createRunner: (runnerOptions, session) => ({
        async startCrawl(input) {
          const outcome = () => ({ ...article, target: input.target });
          if (input.snapshotHtml !== undefined) return session.withSnapshotPage(input.target, input.snapshotHtml, outcome);
          await runnerOptions.robots?.check(input.target);
          return session.withRenderedPage(input.target, outcome);
        },
      }),
    };
    return { deps, robotsFetches, get maxOpen() { return maxOpen; }, get closed() { return closed; } };
  }

  it("keeps at most maxConcurrentPages pages open and fetches robots.txt once per host", async () => {
    const f = pagedFakes(() => new Promise(resolve => setTimeout(resolve, 5)));
    const crawler = createCrawler({ ...options, maxConcurrentPages: 2 }, f.deps);
    const urls = Array.from({ length: 8 }, (_, i) => `https://${i % 2 ? "a" : "b"}.com/news/item-${i}`);

    const results = await Promise.all(urls.map(url => crawler.extract(url)));

    expect(results.map(result => result.ok && result.url)).toEqual(urls);
    expect(f.maxOpen).toBe(2);
    expect(f.robotsFetches.sort()).toEqual(["https://a.com/robots.txt", "https://b.com/robots.txt"]);
  });

  it("closes the browser only after the running calls finish, and refuses later calls", async () => {
    const releases: Array<() => void> = [];
    const f = pagedFakes(() => new Promise(resolve => releases.push(resolve)));
    const crawler = createCrawler(options, f.deps);

    const calls = [crawler.extract("https://a.com/news/one"), crawler.extract("https://a.com/news/two")];
    while (releases.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
    const closing = crawler.close();
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(f.closed).toBe(false);
    releases.forEach(release => release());
    expect((await Promise.all(calls)).every(result => result.ok)).toBe(true);
    await closing;
    expect(f.closed).toBe(true);
    await expect(crawler.extract("https://a.com/news/three")).rejects.toThrow("closed");
  });

  it("counts extractHtml calls against maxConcurrentPages, with no robots.txt fetch", async () => {
    const f = pagedFakes(() => new Promise(resolve => setTimeout(resolve, 5)));
    const crawler = createCrawler({ ...options, maxConcurrentPages: 2 }, f.deps);
    const urls = Array.from({ length: 6 }, (_, i) => `https://a.com/news/item-${i}`);

    const results = await Promise.all(urls.map((url, i) =>
      i % 2 ? crawler.extract(url) : crawler.extractHtml({ url, html: "<p>snapshot</p>" })));

    expect(results.every(result => result.ok)).toBe(true);
    expect(f.maxOpen).toBe(2);
    expect(f.robotsFetches).toEqual(["https://a.com/robots.txt"]);
  });

  it("rejects a maxConcurrentPages below 1", () => {
    expect(() => createCrawler({ ...options, maxConcurrentPages: 0 }, fakes(async () => article).deps)).toThrow("maxConcurrentPages");
  });
});
