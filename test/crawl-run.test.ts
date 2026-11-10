import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
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
import type { ExtractionTemplate, ListingTemplate } from "../src/core/templating/types.ts";
import type { TemplateExtractionResult } from "../src/core/template-extractor/types.ts";
import type { Page } from "playwright";
import {
  createDomainStore,
  readJsonFile,
  listTemplatesForDomain,
  addPatternToTemplate,
  savePageArtifacts,
  listListingTemplates,
  saveListingTemplate,
  saveTemplate,
} from "../src/core/domain-store.ts";
import type { ListingLinks } from "../src/core/template-author/validateListingSelectors.ts";
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
    expect(outcome.urlPattern).toBe("/final");
    const [saved] = (await listTemplatesForDomain(harness.store)).candidates;
    expect(saved?.template.urlPatterns).toEqual(["/news/:slug", "/final"]);
  });

  it("does not write a template whose typed pattern covers the URL", async () => {
    const harness = await createHarness();
    await saveTemplate(harness.store, { ...createTemplate(), urlPatterns: ["/:page"] });

    const outcome = await startCrawl({ target: "https://example.com/final", schema: {} }, harness.options, harness.deps);

    expect(outcome.templateFit.matchedPattern).toBe(true);
    const [saved] = (await listTemplatesForDomain(harness.store)).candidates;
    expect(saved?.template.urlPatterns).toEqual(["/:page"]);
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

  it("reports the stored typed pattern and returns a stale result on a redesigned page, with no agent call", async () => {
    const harness = await createHarness({
      extractResult: createTemplateExtractionResult({ payload: { title: null }, fieldResults: {} }),
    });
    await saveTemplate(harness.store, { ...createTemplate(), urlPatterns: ["/:page"] });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome).toMatchObject({ urlPattern: "/:page", path: "stale-template", stale: true });
    expect(harness.authorCalls).toHaveLength(0);
    expect(harness.providerResolutions).toBe(0);
  });

  it("reports the new template's pattern after authoring", async () => {
    const harness = await createHarness({ authoredPatterns: ["/:page"] });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome).toMatchObject({ urlPattern: "/:page", path: "authored" });
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

  it("fails with HTTP_ERROR when the host cannot be reached", async () => {
    const harness = await createHarness({ renderError: new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/final") });

    const error = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps).catch(caught => caught);

    expect(error).toMatchObject({ code: "HTTP_ERROR", policy: null });
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
  const listingTemplate: ListingTemplate = {
    id: "listing_fixture",
    kind: "listing",
    domain: "example.com",
    urlPatterns: ["/final"],
    itemLinks: ["ul.grid a.card"],
    nextPage: ["a[rel=next]"],
    pageLinks: [],
    itemUrlPatterns: ["/products/:slug"],
    createdFromUrl: "https://example.com/final",
    createdAt: "2026-11-05T00:00:00.000Z",
  };
  const links: ListingLinks = {
    items: [
      { url: "https://example.com/products/a-1", text: "A", cssPath: "ul.grid > li > a.card" },
      { url: "https://example.com/products/b-2", text: "B", cssPath: "ul.grid > li > a.card" },
    ],
    paginationUrls: ["https://example.com/final?page=2"],
  };
  const productGroup: LinkGroup = {
    urlPattern: "/products/:slug",
    count: 4,
    samples: ["https://example.com/products/a-1", "https://example.com/products/b-2"],
  };

  it("returns the item and pagination links, saves the listing template, and authors no field template", async () => {
    const classification: PageClassification = {
      kind: "listing",
      template: listingTemplate,
      ...links,
      calls: [],
      provider: "claude",
      warnings: [],
    };
    const harness = await createHarness({ linkGroups: [productGroup], classification });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome).toMatchObject({
      kind: "listing",
      items: links.items,
      paginationUrls: links.paginationUrls,
      llmUsed: true,
      templateFit: { templateId: "listing_fixture", matchedPattern: true },
    });
    expect(harness.authorCalls).toHaveLength(0);
    expect(harness.classifyCalls[0]?.groups).toEqual([productGroup]);
    expect(await readJsonFile<unknown>(path.join(harness.store.listingsPath, "fixture.json"))).toEqual({ ...classification.template, itemUrlPattern: "/products/:slug" });
  });

  it("reads the links with a saved listing template that fits, with no agent call, and saves the new URL pattern", async () => {
    const harness = await createHarness({ linkGroups: [productGroup], listingLinks: () => links });
    const saved = await saveListingTemplate(harness.store, { ...listingTemplate, urlPatterns: ["/category/:slug"] });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome).toMatchObject({ kind: "listing", ...links, llmUsed: false, templateFit: { templatePath: saved.path, matchedPattern: false } });
    expect(harness.providerResolutions).toBe(0);
    expect(harness.classifyCalls).toHaveLength(0);
    expect((await readJsonFile<ListingTemplate>(saved.path)).urlPatterns).toEqual(["/category/:slug", "/final"]);
  });

  it("reports a stored pattern of a template with other fields, or of a listing's items, on a detail page", async () => {
    const harness = await createHarness({ listingLinks: () => null });
    await saveTemplate(harness.store, { ...createTemplate(), urlPatterns: ["/news/:slug"] });
    await saveTemplate(harness.store, { ...createTemplate({ id: "template_headline", schema: { headline: "string" } }), urlPatterns: ["/:page"] });

    const byOtherFields = await startCrawl({ ...fieldsInput({ title: "string" }), expect: "detail" }, harness.options, harness.deps);
    expect(byOtherFields).toMatchObject({ urlPattern: "/:page", path: "template-reuse" });

    const listingHarness = await createHarness({ listingLinks: () => null });
    await saveTemplate(listingHarness.store, { ...createTemplate(), urlPatterns: ["/news/:slug"] });
    await saveListingTemplate(listingHarness.store, { ...listingTemplate, urlPatterns: ["/category/:slug"], itemUrlPatterns: ["/:item"] });

    const byListingItems = await startCrawl({ ...fieldsInput({ title: "string" }), expect: "detail" }, listingHarness.options, listingHarness.deps);
    expect(byListingItems).toMatchObject({ urlPattern: "/:item", path: "template-reuse" });
  });

  it("does not write a listing template whose typed pattern covers the URL", async () => {
    const harness = await createHarness({ linkGroups: [productGroup], listingLinks: () => links });
    const saved = await saveListingTemplate(harness.store, { ...listingTemplate, urlPatterns: ["/:page"] });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome).toMatchObject({ kind: "listing", templateFit: { templatePath: saved.path, matchedPattern: true } });
    expect((await readJsonFile<ListingTemplate>(saved.path)).urlPatterns).toEqual(["/:page"]);
  });

  it("keeps a field template that knows the URL pattern over a listing template that fits on a new pattern", async () => {
    const harness = await createHarness({ listingLinks: () => links });
    await saveTemplate(harness.store, createTemplate());
    await saveListingTemplate(harness.store, { ...listingTemplate, urlPatterns: ["/category/:slug"] });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome).toMatchObject({ kind: "item", path: "template-reuse" });
  });

  it("keeps a stale field template that knows the URL pattern over a listing template that fits on a new pattern", async () => {
    const harness = await createHarness({
      listingLinks: () => links,
      extractResult: createTemplateExtractionResult({
        payload: { title: null },
        fieldResults: {
          title: { fieldName: "title", type: "string", rawValue: null, normalizedValue: null, selectorUsed: null, confidence: 0, warnings: [], candidatesTried: [] },
        },
      }),
    });
    await saveTemplate(harness.store, createTemplate());
    await saveListingTemplate(harness.store, { ...listingTemplate, urlPatterns: ["/category/:slug"] });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome).toMatchObject({ kind: "item", stale: true });
  });

  it("picks the newest of two listing templates that fit on a new pattern", async () => {
    const harness = await createHarness({ listingLinks: () => links });
    await saveListingTemplate(harness.store, { ...listingTemplate, id: "listing_a_older", urlPatterns: ["/a"], createdAt: "2026-10-01T00:00:00.000Z" });
    await saveListingTemplate(harness.store, { ...listingTemplate, id: "listing_b_newer", urlPatterns: ["/b"], createdAt: "2026-11-01T00:00:00.000Z" });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome).toMatchObject({ kind: "listing", templateFit: { templateId: "listing_b_newer" } });
  });

  it("warns about an unreadable listing template file on an item result too", async () => {
    const harness = await createHarness();
    await saveTemplate(harness.store, createTemplate());
    const broken = path.join(harness.store.listingsPath, "broken.json");
    await mkdir(harness.store.listingsPath, { recursive: true });
    await writeFile(broken, "{not json", "utf8");

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome.kind).toBe("item");
    expect(outcome.warnings.some(warning => warning.includes(broken))).toBe(true);
  });

  it("never treats the page as a listing when the caller expects a detail page", async () => {
    const harness = await createHarness({ linkGroups: [productGroup], listingLinks: () => links });
    await saveListingTemplate(harness.store, listingTemplate);

    const outcome = await startCrawl({ ...fieldsInput({ title: "string" }), expect: "detail" }, harness.options, harness.deps);

    expect(outcome.kind).toBe("item");
    expect(harness.classifyCalls).toHaveLength(0);
  });

  it("asks the agent for a listing without the pre-gate when the caller expects one, and fails if it is not one", async () => {
    const asListing = await createHarness({ classification: { kind: "listing", template: listingTemplate, ...links, calls: [], provider: "claude", warnings: [] } });
    await saveTemplate(asListing.store, createTemplate());

    const outcome = await startCrawl({ ...fieldsInput({}), expect: "listing" }, asListing.options, asListing.deps);

    expect(outcome).toMatchObject({ kind: "listing", items: links.items });
    expect(asListing.classifyCalls).toHaveLength(1);

    const notListing = await createHarness({ classification: { kind: "detail", calls: [] } });
    const failure = await startCrawl({ ...fieldsInput({}), expect: "listing" }, notListing.options, notListing.deps).catch(error => error);

    expect(failure).toBeInstanceOf(CrawlFailure);
    expect(failure.code).toBe("TEMPLATE_MISSING");
    expect(notListing.authorCalls).toHaveLength(0);
  });

  it("uses only the given listing template, saves a new pattern to it, and asks no agent when it does not fit", async () => {
    const harness = await createHarness({ linkGroups: [productGroup], listingLinks: () => links });
    const parent = await saveListingTemplate(harness.store, { ...listingTemplate, id: "listing_a_parent", urlPatterns: ["/category/:slug"], createdAt: "2026-10-01T00:00:00.000Z" });
    await saveListingTemplate(harness.store, { ...listingTemplate, id: "listing_b_newer", urlPatterns: ["/search"], createdAt: "2026-11-01T00:00:00.000Z" });

    const outcome = await startCrawl({ ...fieldsInput({}), expect: "listing", listingTemplatePath: parent.path }, harness.options, harness.deps);

    expect(outcome).toMatchObject({ kind: "listing", templateFit: { templateId: "listing_a_parent", matchedPattern: false } });
    expect((await readJsonFile<ListingTemplate>(parent.path)).urlPatterns).toEqual(["/category/:slug", "/final"]);

    const missing = await createHarness({ linkGroups: [productGroup], listingLinks: () => null });
    const other = await saveListingTemplate(missing.store, listingTemplate);
    const failure = await startCrawl({ ...fieldsInput({}), expect: "listing", listingTemplatePath: other.path }, missing.options, missing.deps).catch(error => error);

    expect(failure).toMatchObject({ code: "TEMPLATE_MISSING" });
    expect(missing.classifyCalls).toHaveLength(0);
    expect(missing.providerResolutions).toBe(0);
  });

  it("goes on to the field templates when no saved listing template fits", async () => {
    const harness = await createHarness({ listingLinks: () => null });
    await saveListingTemplate(harness.store, listingTemplate);

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome.kind).toBe("item");
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
  authoredPatterns?: string[];
  pagePacket?: Partial<PagePacket>;
  renderError?: Error;
  robots?: Record<string, RobotsStatus>;
  extractResult?: TemplateExtractionResult;
  linkGroups?: LinkGroup[];
  classification?: PageClassification;
  listingLinks?: (template: ListingTemplate) => ListingLinks | null;
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
        template: createTemplate({ schema: input.schema, ...(config.authoredPatterns ? { urlPatterns: config.authoredPatterns } : {}) }),
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
    listListingTemplates,
    async readListingLinks(_page, template) {
      return config.listingLinks?.(template) ?? null;
    },
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
