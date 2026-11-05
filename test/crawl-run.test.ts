import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  startCrawl,
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
  readTemplateForPattern,
  savePageArtifacts,
  saveTemplate,
} from "../src/core/domain-store.ts";

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
    fieldResults: {},
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

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome.path).toBe("authored");
    expect(outcome.llmUsed).toBe(true);
    expect(outcome.provider).toBe("claude");
    expect(outcome.result.payload).toEqual({ title: "Fixture" });
    expect(harness.authorCalls).toHaveLength(1);
    expect(harness.authorCalls[0]?.skeleton).toBe("body\n  h1 \"Fixture\"");
    expect(harness.authorCalls[0]?.schema).toEqual({ title: "string" });

    const savedTemplate = await readTemplateForPattern(harness.store, "/final", { title: "string" });
    expect(savedTemplate?.id).toBe("template_fixture");
    expect(outcome.templatePath).not.toBeNull();

    const transcript = await readJsonFile<{ provider: string; llmUsed: boolean }>(
      path.join(outcome.artifactFolder, "packet.llm.json"),
    );
    expect(transcript).toMatchObject({ provider: "claude", llmUsed: true });
  });

  it("reuses a saved template for the same pattern and fields without calling the agent", async () => {
    const harness = await createHarness();
    await saveTemplate(harness.store, createTemplate());

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome.path).toBe("existing-template");
    expect(outcome.llmUsed).toBe(false);
    expect(harness.authorCalls).toHaveLength(0);
    expect(harness.providerResolutions).toBe(0);
  });

  it("uses a template-reuse input without resolving a provider or calling the agent", async () => {
    const harness = await createHarness();
    const template = createTemplate();

    const outcome = await startCrawl(
      { target: "https://example.com/final", source: "template-reuse", template },
      harness.options,
      harness.deps,
    );

    expect(outcome.path).toBe("template-reuse");
    expect(harness.authorCalls).toHaveLength(0);
    expect(harness.providerResolutions).toBe(0);
  });

  it("asks the agent to suggest fields when the schema is empty, then uses them", async () => {
    const harness = await createHarness();

    const outcome = await startCrawl(fieldsInput({}), harness.options, harness.deps);

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

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome.policy).toMatchObject({ robots: "allowed", tdmReservation: true, xRobotsTag: "noai", httpStatus: 200 });
    expect(outcome.result.payload).toEqual({ title: "Fixture" });
  });

  it("passes authoring warnings through to the outcome", async () => {
    const harness = await createHarness({ authorWarnings: ["No working selector found for \"title\""] });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome.warnings).toContain("No working selector found for \"title\"");
  });
});

function fieldsInput(schema: Record<string, "string" | "number">): CrawlStartInput {
  return { target: "https://example.com/final", source: "fields", schema };
}

async function createHarness(config: {
  authorWarnings?: string[];
  pagePacket?: Partial<PagePacket>;
  renderError?: Error;
  robots?: Record<string, RobotsStatus>;
} = {}) {
  const rootPath = await createTempDir();
  const store = createDomainStore({ targetUrl: "https://example.com/final", rootPath });
  const authorCalls: AuthorTemplateInput[] = [];
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
    readTemplateForPattern: (inputStore, urlPattern, userSchema) =>
      readTemplateForPattern(inputStore, urlPattern, userSchema),
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
    async extractWithTemplate() {
      return createTemplateExtractionResult();
    },
  };

  return {
    store,
    deps,
    authorCalls,
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
