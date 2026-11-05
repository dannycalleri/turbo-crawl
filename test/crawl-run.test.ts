import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  startCrawl,
  type CrawlOutcome,
  type ItemOutcome,
  type CrawlOptions,
  type CrawlStartInput,
  type StartCrawlDependencies,
} from "../src/core/crawl-run.ts";
import type { LLMProvider } from "../src/core/llm-extractor/providers/LLMProvider.ts";
import type { AuthorTemplateInput } from "../src/core/template-author/authorTemplate.ts";
import type { PagePacket } from "../src/core/types.ts";
import { CrawlFailure } from "../src/core/policy/policy.ts";
import type { RobotsStatus } from "../src/core/policy/robots.ts";
import type { ExtractionTemplate } from "../src/core/templating/types.ts";
import type { TemplateExtractionResult } from "../src/core/template-extractor/types.ts";
import type { Page } from "playwright";
import {
  createDomainStore,
  readJsonFile,
  listTemplatesForDomain,
  addPatternToTemplate,
  savePageArtifacts,
  saveListingTemplate,
  saveTemplate,
} from "../src/core/domain-store.ts";
import type { LinkGroup } from "../src/core/extraction/links.ts";
import type { ClassifyPageInput, PageClassification } from "../src/core/template-author/classifyPage.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "turbo-crawl-run-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function createPagePacket(): PagePacket {
  return {
    url: "https://example.com",
    finalUrl: "https://example.com/final",
    fetchedAt: "2026-04-24T10:00:00.000Z",
    title: "Fixture",
    response: { status: 200, xRobotsTag: null, tdmReservation: null, tdmPolicy: null, retryAfter: null },
    metadata: {
      canonicalUrl: "https://example.com/final",
      description: "Fixture description",
      robots: "index,follow",
      openGraph: {},
      twitter: {},
      other: {},
    },
    jsonLd: [],
    visibleBlocks: [],
    links: [],
    images: [],
    tables: [],
    stats: {
      rawHtmlLength: 10,
      bodyTextLength: 10,
      visibleBlockCount: 0,
      jsonLdCount: 0,
      linkCount: 0,
      imageCount: 0,
      tableCount: 0,
    },
  };
}

function createTemplate(overrides: Partial<ExtractionTemplate> = {}): ExtractionTemplate {
  return {
    id: "template_fixture",
    domain: "example.com",
    urlPatterns: ["/final"],
    schema: {
      title: "string",
    },
    createdFromUrl: "https://example.com/final",
    createdAt: "2026-04-24T15:00:00.000Z",
    fields: {
      title: {
        fieldName: "title",
        type: "string",
        sourceNodeId: null,
        rawValue: "Fixture",
        normalizedValue: "Fixture",
        selectors: [
          {
            kind: "css",
            selector: "h1",
            attribute: "textContent",
            score: 90,
            reusable: true,
          },
        ],
        validation: {
          expectedType: "string",
          valueShape: "text",
        },
      },
    },
    ...overrides,
  };
}

function createTemplateExtractionResult(
  overrides: Partial<TemplateExtractionResult> = {},
): TemplateExtractionResult {
  return {
    payload: {
      title: "Fixture",
    },
    fieldResults: {
      title: {
        fieldName: "title",
        type: "string",
        rawValue: "Fixture",
        normalizedValue: "Fixture",
        selectorUsed: { kind: "css", selector: "h1", attribute: "textContent", score: 90, reusable: true },
        confidence: 0.9,
        warnings: [],
        candidatesTried: [],
      },
    },
    confidence: 90,
    templateId: "template_fixture",
    usedTemplate: true,
    llmUsed: false,
    warnings: [],
    ...overrides,
  };
}

describe("crawl start stub wiring", () => {
  it("authors a template with the agent, saves it, and extracts through it", async () => {
    const harness = await createHarness();

    const outcome = asItem(await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps));

    expect(outcome.path).toBe("authored");
    expect(outcome.llmUsed).toBe(true);
    expect(outcome.provider).toBe("claude");
    expect(outcome.result.payload).toEqual({ title: "Fixture" });
    expect(harness.authorCalls).toHaveLength(1);
    expect(harness.authorCalls[0]?.skeleton).toBe("body\n  h1 \"Fixture\"");
    expect(harness.authorCalls[0]?.schema).toEqual({ title: "string" });

    const saved = (await listTemplatesForDomain(harness.store)).candidates.map(candidate => candidate.template.id);
    expect(saved).toEqual(["template_fixture"]);
    expect(outcome.templateFit).toMatchObject({ templateId: "template_fixture", matchedPattern: true });

    const transcript = await readJsonFile<{ provider: string; llmUsed: boolean }>(
      path.join(outcome.artifactFolder!, "packet.llm.json"),
    );
    expect(transcript).toMatchObject({ provider: "claude", llmUsed: true });
  });

  it("extracts with a saved template that fits, without resolving a provider", async () => {
    const harness = await createHarness();
    await saveTemplate(harness.store, createTemplate());

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome).toMatchObject({ path: "template-reuse", llmUsed: false, stale: false, missing: [] });
    expect(outcome.templateFit.matchedPattern).toBe(true);
    expect(harness.authorCalls).toHaveLength(0);
    expect(harness.providerResolutions).toBe(0);
  });

  it("records the page's URL pattern on a template that fits a new URL shape", async () => {
    const harness = await createHarness();
    await saveTemplate(harness.store, { ...createTemplate(), urlPatterns: ["/news/:slug"] });

    const outcome = await startCrawl({ target: "https://example.com/final", schema: {} }, harness.options, harness.deps);

    expect(outcome.templateFit.matchedPattern).toBe(false);
    const [saved] = (await listTemplatesForDomain(harness.store)).candidates;
    expect(saved?.template.urlPatterns).toEqual(["/news/:slug", "/final"]);
  });

  it("fails with TEMPLATE_MISSING and never resolves a provider when authoring is off", async () => {
    const harness = await createHarness();

    const error = await startCrawl(fieldsInput({ title: "string" }), { ...harness.options, authoring: false }, harness.deps)
      .catch(caught => caught);

    expect(error).toBeInstanceOf(CrawlFailure);
    expect(error.code).toBe("TEMPLATE_MISSING");
    expect(error.policy).toMatchObject({ httpStatus: 200 });
    expect(harness.providerResolutions).toBe(0);
  });

  it("returns a stale result when the template for this pattern no longer fits", async () => {
    const harness = await createHarness({
      extractResult: createTemplateExtractionResult({ payload: { title: null }, fieldResults: {} }),
    });
    await saveTemplate(harness.store, createTemplate());

    const outcome = await startCrawl(fieldsInput({ title: "string" }), { ...harness.options, authoring: false }, harness.deps);

    expect(outcome).toMatchObject({ path: "stale-template", stale: true, missing: ["title"], llmUsed: false });
    expect(outcome.warnings.join("\n")).toContain("may have changed");
  });

  it("writes no page artifacts when artifacts are off", async () => {
    const harness = await createHarness();
    await saveTemplate(harness.store, createTemplate());

    const outcome = await startCrawl(fieldsInput({ title: "string" }), { ...harness.options, writeArtifacts: false }, harness.deps);

    expect(outcome.artifactFolder).toBeNull();
    expect(await Bun.file(path.join(harness.store.packetsPath)).exists()).toBe(false);
  });

  it("asks the agent to suggest fields when the schema is empty, then uses them", async () => {
    const harness = await createHarness();

    const outcome = asItem(await startCrawl(fieldsInput({}), harness.options, harness.deps));

    expect(harness.suggestCalls).toBe(1);
    expect(outcome.schema).toEqual({ title: "string" });
    expect(harness.authorCalls[0]?.schema).toEqual({ title: "string" });
  });

  it("refuses a URL that robots.txt disallows before rendering it", async () => {
    const harness = await createHarness({ robots: { "https://example.com/final": "disallowed" } });

    const error = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps).catch(caught => caught);

    expect(error).toBeInstanceOf(CrawlFailure);
    expect(error).toMatchObject({ code: "ROBOTS_DISALLOWED", policy: null });
    expect(harness.renders).toBe(0);
  });

  it("refuses a redirect into a disallowed URL without returning data", async () => {
    const harness = await createHarness({
      robots: { "https://example.com/blocked": "disallowed" },
      pagePacket: { finalUrl: "https://example.com/blocked" },
    });

    const error = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps).catch(caught => caught);

    expect(error).toMatchObject({ code: "ROBOTS_DISALLOWED" });
    expect(error.policy.robots).toBe("disallowed");
    expect(harness.robotsChecks).toEqual(["https://example.com/final", "https://example.com/blocked"]);
    expect(harness.authorCalls).toHaveLength(0);
  });

  it("fails with BLOCKED and the Retry-After delay when the page answers 429", async () => {
    const harness = await createHarness({
      pagePacket: { response: { status: 429, xRobotsTag: null, tdmReservation: null, tdmPolicy: null, retryAfter: "120" } },
    });

    const error = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps).catch(caught => caught);

    expect(error).toMatchObject({ code: "BLOCKED", retryAfterSeconds: 120 });
    expect(harness.authorCalls).toHaveLength(0);
  });

  it("fails with TIMEOUT when navigation times out", async () => {
    const timeout = Object.assign(new Error("page.goto: Timeout 30000ms exceeded."), { name: "TimeoutError" });
    const harness = await createHarness({ renderError: timeout });

    const error = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps).catch(caught => caught);

    expect(error).toMatchObject({ code: "TIMEOUT", policy: null });
  });

  it("reports the policy signals and keeps the data when the page reserves TDM", async () => {
    const harness = await createHarness({
      robots: {},
      pagePacket: { response: { status: 200, xRobotsTag: "noai", tdmReservation: "1", tdmPolicy: null, retryAfter: null } },
    });

    const outcome = asItem(await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps));

    expect(outcome.policy).toMatchObject({ robots: "allowed", tdmReservation: true, xRobotsTag: "noai", httpStatus: 200 });
    expect(outcome.result.payload).toEqual({ title: "Fixture" });
  });

  it("passes authoring warnings through to the outcome", async () => {
    const harness = await createHarness({ authorWarnings: ["No working selector found for \"title\""] });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome.warnings).toContain("No working selector found for \"title\"");
  });
});

describe("listing pages", () => {
  const productGroup: LinkGroup = {
    urlPattern: "/products/:slug",
    count: 4,
    samples: ["https://example.com/products/a-1", "https://example.com/products/b-2"],
  };

  it("returns the item and pagination links, saves the listing template, and authors no field template", async () => {
    const classification: PageClassification = {
      kind: "listing",
      template: {
        id: "listing_fixture",
        kind: "listing",
        domain: "example.com",
        urlPatterns: ["/final"],
        itemLinks: ["ul.grid a.card"],
        nextPage: ["a[rel=next]"],
        pageLinks: [],
        itemUrlPattern: "/products/:slug",
        createdFromUrl: "https://example.com/final",
        createdAt: "2026-11-05T00:00:00.000Z",
      },
      itemUrls: ["https://example.com/products/a-1", "https://example.com/products/b-2"],
      paginationUrls: ["https://example.com/final?page=2"],
      calls: [],
      provider: "claude",
      warnings: [],
    };
    const harness = await createHarness({ linkGroups: [productGroup], classification });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome).toMatchObject({
      kind: "listing",
      itemUrls: classification.itemUrls,
      paginationUrls: classification.paginationUrls,
      llmUsed: true,
      templateFit: { templateId: "listing_fixture", matchedPattern: true },
    });
    expect(harness.authorCalls).toHaveLength(0);
    expect(harness.classifyCalls[0]?.groups).toEqual([productGroup]);
    expect(await readJsonFile<unknown>(path.join(harness.store.listingsPath, "fixture.json"))).toEqual(classification.template);
  });

  it("authors a field template on the same page when the agent says it is a detail page", async () => {
    const harness = await createHarness({ linkGroups: [productGroup], classification: { kind: "detail", calls: [] } });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome.kind).toBe("item");
    expect(harness.classifyCalls).toHaveLength(1);
    expect(harness.authorCalls).toHaveLength(1);
    expect(harness.providerResolutions).toBe(1);
  });

  it("does not ask the agent for the page kind when no link group could hold the items", async () => {
    const harness = await createHarness({ linkGroups: [{ ...productGroup, count: 3 }] });

    await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(harness.classifyCalls).toHaveLength(0);
    expect(harness.authorCalls).toHaveLength(1);
  });
});

function asItem(outcome: CrawlOutcome): ItemOutcome {
  if (outcome.kind !== "item") throw new Error(`expected an item outcome, got ${outcome.kind}`);
  return outcome;
}

function fieldsInput(schema: Record<string, "string" | "number">): CrawlStartInput {
  return { target: "https://example.com/final", schema };
}

async function createHarness(config: {
  authorWarnings?: string[];
  pagePacket?: Partial<PagePacket>;
  renderError?: Error;
  robots?: Record<string, RobotsStatus>;
  extractResult?: TemplateExtractionResult;
  linkGroups?: LinkGroup[];
  classification?: PageClassification;
} = {}) {
  const rootPath = await createTempDir();
  const store = createDomainStore({ targetUrl: "https://example.com/final", rootPath });
  const authorCalls: AuthorTemplateInput[] = [];
  const classifyCalls: ClassifyPageInput[] = [];
  const state = { providerResolutions: 0, suggestCalls: 0, renders: 0 };
  const robotsChecks: string[] = [];
  const provider: LLMProvider = {
    name: "claude",
    async completeStructured() {
      throw new Error("the fake provider is not called directly");
    },
  };

  const deps: StartCrawlDependencies = {
    async withRenderedPage(_url, handler) {
      state.renders += 1;
      if (config.renderError) throw config.renderError;
      return handler({ page: {} as Page, pagePacket: { ...createPagePacket(), ...config.pagePacket } });
    },
    createDomainStore: (input) => createDomainStore({ ...input, rootPath }),
    listTemplatesForDomain,
    addPatternToTemplate,
    saveTemplate,
    savePageArtifacts,
    async capturePageSkeleton() {
      return { text: "body\n  h1 \"Fixture\"", bytes: 20, truncated: false };
    },
    async authorTemplate(input) {
      authorCalls.push(input);
      return {
        template: createTemplate({ schema: input.schema }),
        warnings: config.authorWarnings ?? [],
        provider: input.provider.name,
        model: input.model ?? null,
        calls: [],
      };
    },
    async suggestSchema() {
      state.suggestCalls += 1;
      return { schema: { title: "string" }, fields: [{ name: "title", type: "string", description: "" }] };
    },
    async summarizeLinkGroups() {
      return config.linkGroups ?? [];
    },
    async classifyPage(input) {
      classifyCalls.push(input);
      return config.classification ?? { kind: "detail", calls: [] };
    },
    saveListingTemplate,
    async extractWithTemplate() {
      return config.extractResult ?? createTemplateExtractionResult();
    },
  };

  return {
    store,
    deps,
    authorCalls,
    classifyCalls,
    robotsChecks,
    get renders() {
      return state.renders;
    },
    get providerResolutions() {
      return state.providerResolutions;
    },
    get suggestCalls() {
      return state.suggestCalls;
    },
    options: {
      provider: () => {
        state.providerResolutions += 1;
        return provider;
      },
      dataDir: rootPath,
      robots: config.robots
        ? {
            async check(url: string) {
              robotsChecks.push(url);
              return config.robots![url] ?? "allowed";
            },
          }
        : null,
    } satisfies CrawlOptions,
  };
}
