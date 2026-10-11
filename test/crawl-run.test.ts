import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  createCrawlStartInput,
  runPendingCrawlStart,
  startCrawl,
  type CrawlOutcome,
  type CrawlStartInput,
  type StartCrawlDependencies,
} from "../src/core/crawl-run.ts";
import type { LLMProvider } from "../src/core/llm-extractor/providers/LLMProvider.ts";
import type { AuthorTemplateInput } from "../src/core/template-author/authorTemplate.ts";
import { createInitialSessionState, reduceSessionState } from "../src/core/session-state.ts";
import type { PagePacket } from "../src/core/types.ts";
import type { ExtractionTemplate } from "../src/core/templating/types.ts";
import type { TemplateExtractionResult } from "../src/core/template-extractor/types.ts";
import type { Page } from "playwright";
import {
  createDomainStore,
  readJsonFile,
  readTemplateForPattern,
  savePageArtifacts,
  saveSchema,
  saveTemplate,
  type SchemaPreview,
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
    urlPattern: "/final",
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
  it("creates the crawl input from the target and schema", () => {
    const reviewedState = reduceSessionState(
      reduceSessionState(
        reduceSessionState(
          reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
            type: "submit-name",
            value: "title",
          }),
          { type: "confirm-property" },
        ),
        { type: "review-schema" },
      ),
      { type: "start-crawl" },
    );

    const input = createCrawlStartInput(reviewedState, new Date("2026-04-24T12:00:00.000Z"));

    expect(input).toEqual({
      target: "https://example.com",
      schema: [{ name: "title", type: "string" }],
      mode: "interactive",
      source: "schema-builder",
      startedAt: "2026-04-24T12:00:00.000Z",
    });
  });

  it("creates a crawl input for an automatically reused template", () => {
    const template = createTemplate();
    const pendingState = reduceSessionState(
      reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
        type: "submit-target-url",
        value: "https://example.com/final",
      }),
      {
        type: "template-reuse-found",
        template,
      },
    );

    const input = createCrawlStartInput(pendingState, new Date("2026-04-24T12:00:00.000Z"));

    expect(input).toEqual({
      target: "https://example.com/final",
      schema: [{ name: "title", type: "string" }],
      mode: "interactive",
      source: "template-reuse",
      template,
      startedAt: "2026-04-24T12:00:00.000Z",
    });
  });

  it("executes the crawl runner only when the session is ready to start", async () => {
    const calls: CrawlStartInput[] = [];
    const reviewedState = reduceSessionState(
      reduceSessionState(
        reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
          type: "submit-name",
          value: "publishedAt",
        }),
        { type: "select-next-type" },
      ),
      { type: "confirm-property" },
    );
    const pendingState = reduceSessionState(
      reduceSessionState(reviewedState, { type: "review-schema" }),
      { type: "start-crawl" },
    );

    await runPendingCrawlStart(
      pendingState,
      {
        async startCrawl(input) {
          calls.push(input);
          return {} as CrawlOutcome;
        },
      },
      new Date("2026-04-24T13:00:00.000Z"),
    );

    expect(calls).toEqual([
      {
        target: "https://example.com",
        schema: [{ name: "publishedAt", type: "number" }],
        mode: "interactive",
        source: "schema-builder",
        startedAt: "2026-04-24T13:00:00.000Z",
      },
    ]);
  });


  it("authors a template with the agent, saves it, and extracts through it", async () => {
    const harness = await createHarness();

    const outcome = await startCrawl(schemaBuilderInput({ title: "string" }), harness.options, harness.deps);

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
    expect(harness.savedSchemas).toEqual([{ title: "string" }]);
  });

  it("reuses a saved template for the same pattern and fields without calling the agent", async () => {
    const harness = await createHarness();
    await saveTemplate(harness.store, createTemplate());

    const outcome = await startCrawl(schemaBuilderInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome.path).toBe("existing-template");
    expect(outcome.llmUsed).toBe(false);
    expect(harness.authorCalls).toHaveLength(0);
    expect(harness.providerResolutions).toBe(0);
  });

  it("uses a template-reuse input without saving a schema, resolving a provider or calling the agent", async () => {
    const harness = await createHarness();
    const template = createTemplate();

    const outcome = await startCrawl(
      {
        target: "https://example.com/final",
        schema: [{ name: "title", type: "string" }],
        mode: "interactive",
        source: "template-reuse",
        template,
        startedAt: "2026-04-24T12:00:00.000Z",
      },
      harness.options,
      harness.deps,
    );

    expect(outcome.path).toBe("template-reuse");
    expect(harness.authorCalls).toHaveLength(0);
    expect(harness.savedSchemas).toHaveLength(0);
    expect(harness.providerResolutions).toBe(0);
  });

  it("does not save a selected schema again", async () => {
    const harness = await createHarness();
    const selectedSchema: SchemaPreview = {
      id: "2026-04-24T10:00:00",
      label: "2026-04-24T10:00:00",
      createdAt: "2026-04-24T10:00:00.000Z",
      path: "/tmp/schema.json",
      fieldCount: 1,
      fieldSummaries: [{ name: "title", type: "string" }],
    };

    await startCrawl(
      {
        target: "https://example.com/final",
        schema: [{ name: "title", type: "string" }],
        mode: "interactive",
        source: "selected-schema",
        selectedSchema,
        startedAt: "2026-04-24T12:00:00.000Z",
      },
      harness.options,
      harness.deps,
    );

    expect(harness.savedSchemas).toHaveLength(0);
    expect(harness.authorCalls).toHaveLength(1);
  });

  it("asks the agent to suggest fields when the schema is empty, then saves and uses them", async () => {
    const harness = await createHarness();

    const outcome = await startCrawl(schemaBuilderInput({}), harness.options, harness.deps);

    expect(harness.suggestCalls).toBe(1);
    expect(outcome.schema).toEqual({ title: "string" });
    expect(harness.savedSchemas).toEqual([{ title: "string" }]);
    expect(harness.authorCalls[0]?.schema).toEqual({ title: "string" });
  });

  it("passes authoring warnings through to the outcome", async () => {
    const harness = await createHarness({ authorWarnings: ["No working selector found for \"title\""] });

    const outcome = await startCrawl(schemaBuilderInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome.warnings).toContain("No working selector found for \"title\"");
  });
});

function schemaBuilderInput(schema: Record<string, "string" | "number">): CrawlStartInput {
  return {
    target: "https://example.com/final",
    schema: Object.entries(schema).map(([name, type]) => ({ name, type })),
    mode: "interactive",
    source: "schema-builder",
    startedAt: "2026-04-24T12:00:00.000Z",
  };
}

async function createHarness(config: { authorWarnings?: string[] } = {}) {
  const rootPath = await createTempDir();
  const store = createDomainStore({ targetUrl: "https://example.com/final", rootPath });
  const authorCalls: AuthorTemplateInput[] = [];
  const savedSchemas: unknown[] = [];
  const state = { providerResolutions: 0, suggestCalls: 0 };
  const provider: LLMProvider = {
    name: "claude",
    async completeStructured() {
      throw new Error("the fake provider is not called directly");
    },
  };

  const deps: StartCrawlDependencies = {
    async withRenderedPage(_url, handler) {
      return handler({ page: {} as Page, pagePacket: createPagePacket() });
    },
    createDomainStore: (input) => createDomainStore({ ...input, rootPath }),
    async saveSchema(inputStore, schema, createdAt) {
      savedSchemas.push(schema);
      return saveSchema(inputStore, schema, createdAt);
    },
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
    savedSchemas,
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
    },
  };
}
