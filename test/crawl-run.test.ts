import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  startCrawl,
  type CrawlStartInput,
  type StartCrawlDependencies,
} from "../src/core/crawl-run.ts";
import type { LLMProvider } from "../src/core/llm-extractor/providers/LLMProvider.ts";
import type { AuthorTemplateInput } from "../src/core/template-author/authorTemplate.ts";
import type { PagePacket } from "../src/core/types.ts";
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

  it("passes authoring warnings through to the outcome", async () => {
    const harness = await createHarness({ authorWarnings: ["No working selector found for \"title\""] });

    const outcome = await startCrawl(fieldsInput({ title: "string" }), harness.options, harness.deps);

    expect(outcome.warnings).toContain("No working selector found for \"title\"");
  });
});

function fieldsInput(schema: Record<string, "string" | "number">): CrawlStartInput {
  return { target: "https://example.com/final", source: "fields", schema };
}

async function createHarness(config: { authorWarnings?: string[] } = {}) {
  const rootPath = await createTempDir();
  const store = createDomainStore({ targetUrl: "https://example.com/final", rootPath });
  const authorCalls: AuthorTemplateInput[] = [];
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
