import { withRenderedPage, type RenderedPageContext } from "./crawler.ts";
import type { SchemaProperty, SessionState } from "./session-state.ts";
import type { PagePacket } from "./types.ts";
import type { LLMProvider } from "./llm-extractor/providers/LLMProvider.ts";
import type { UserSchema } from "./llm-extractor/types.ts";
import type { ExtractionTemplate } from "./templating/types.ts";
import { inferUrlPattern } from "./templating/inferUrlPattern.ts";
import { extractWithTemplate } from "./template-extractor/extractWithTemplate.ts";
import type { TemplateExtractionResult } from "./template-extractor/types.ts";
import { capturePageSkeleton, type PageSkeleton } from "./pageContext/skeleton.ts";
import {
  authorTemplate,
  type AuthoredTemplateResult,
  type AuthorTemplateInput,
} from "./template-author/authorTemplate.ts";
import { suggestSchema } from "./template-author/suggestSchema.ts";
import {
  createDomainStore,
  readTemplateForPattern,
  savePageArtifacts,
  saveSchema,
  saveTemplate,
  type DomainStore,
  type PageArtifacts,
  type PagePacketFolder,
  type SchemaPreview,
  type SchemaArtifact,
  type TemplateArtifact,
} from "./domain-store.ts";

type CrawlStartInputBase = {
  target: string;
  schema: SchemaProperty[];
  mode: "interactive";
  startedAt: string;
};

export type CrawlStartInput =
  | (CrawlStartInputBase & {
      source: "schema-builder";
    })
  | (CrawlStartInputBase & {
      source: "template-reuse";
      template: ExtractionTemplate;
    })
  | (CrawlStartInputBase & {
      source: "selected-schema";
      selectedSchema: SchemaPreview;
    });

export type CrawlOutcome = {
  target: string;
  finalUrl: string;
  urlPattern: string;
  path: "template-reuse" | "existing-template" | "authored";
  schema: UserSchema;
  result: TemplateExtractionResult;
  llmUsed: boolean;
  provider: LLMProvider["name"] | null;
  templateId: string;
  templatePath: string | null;
  artifactFolder: string;
  warnings: string[];
};

export type CrawlRunner = {
  startCrawl(input: CrawlStartInput): Promise<CrawlOutcome>;
};

export type CrawlOptions = {
  /** Resolved lazily so a missing provider only fails when a template must be authored. */
  provider: LLMProvider | (() => LLMProvider);
  model?: string | null;
  maxRepairs?: number;
  dataDir?: string;
  onProgress?: (message: string) => void;
};

export type StartCrawlDependencies = {
  withRenderedPage<T>(
    url: string,
    handler: (context: RenderedPageContext) => Promise<T> | T,
  ): Promise<T>;
  createDomainStore(input: { targetUrl: string; rootPath?: string }): DomainStore;
  saveSchema(
    store: DomainStore,
    schema: UserSchema,
    createdAt: Date,
  ): Promise<SchemaArtifact>;
  readTemplateForPattern(
    store: DomainStore,
    urlPattern: string,
    userSchema: UserSchema,
  ): Promise<ExtractionTemplate | null>;
  saveTemplate(
    store: DomainStore,
    template: ExtractionTemplate,
  ): Promise<TemplateArtifact>;
  savePageArtifacts(
    store: DomainStore,
    artifacts: PageArtifacts,
  ): Promise<PagePacketFolder>;
  capturePageSkeleton(page: RenderedPageContext["page"]): Promise<PageSkeleton>;
  authorTemplate(input: AuthorTemplateInput): Promise<AuthoredTemplateResult>;
  suggestSchema: typeof suggestSchema;
  extractWithTemplate(input: {
    page: RenderedPageContext["page"];
    pagePacket: PagePacket;
    template: ExtractionTemplate;
  }): Promise<TemplateExtractionResult>;
};

export function createCrawlStartInput(
  state: SessionState,
  now: Date = new Date(),
): CrawlStartInput {
  if (state.reuseSource === "template-reuse" && state.matchedTemplate) {
    return {
      target: state.target,
      schema: Object.entries(state.matchedTemplate.schema)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, type]) => ({
          name,
          type,
        })),
      mode: state.modeLabel,
      source: "template-reuse",
      template: state.matchedTemplate,
      startedAt: now.toISOString(),
    };
  }

  if (state.reuseSource === "selected-schema" && state.selectedSchema) {
    return {
      target: state.target,
      schema: state.selectedSchema.fieldSummaries.map(({ name, type }) => ({ name, type })),
      mode: state.modeLabel,
      source: "selected-schema",
      selectedSchema: state.selectedSchema,
      startedAt: now.toISOString(),
    };
  }

  return {
    target: state.target,
    schema: state.properties,
    mode: state.modeLabel,
    source: "schema-builder",
    startedAt: now.toISOString(),
  };
}

export async function runPendingCrawlStart(
  state: SessionState,
  runner: CrawlRunner,
  now: Date = new Date(),
): Promise<CrawlOutcome | null> {
  if (state.phase !== "crawl-pending") {
    return null;
  }

  return runner.startCrawl(createCrawlStartInput(state, now));
}

export const defaultStartCrawlDependencies: StartCrawlDependencies = {
  withRenderedPage,
  createDomainStore,
  saveSchema,
  readTemplateForPattern,
  saveTemplate,
  savePageArtifacts,
  capturePageSkeleton,
  authorTemplate,
  suggestSchema,
  extractWithTemplate,
};

export function createCrawlRunner(
  options: CrawlOptions,
  deps: StartCrawlDependencies = defaultStartCrawlDependencies,
): CrawlRunner {
  return {
    startCrawl: input => startCrawl(input, options, deps),
  };
}

export async function startCrawl(
  input: CrawlStartInput,
  options: CrawlOptions,
  deps: StartCrawlDependencies = defaultStartCrawlDependencies,
): Promise<CrawlOutcome> {
  const progress = options.onProgress ?? (() => {});
  let userSchema =
    input.source === "template-reuse"
      ? input.template.schema
      : input.schema.reduce((acc: UserSchema, tuple: SchemaProperty) => {
          acc[tuple.name] = tuple.type;
          return acc;
        }, {} as UserSchema);
  const store = deps.createDomainStore({ targetUrl: input.target, rootPath: options.dataDir });

  progress(`Rendering ${input.target}…`);

  return deps.withRenderedPage(input.target, async ({ page, pagePacket }) => {
    const finalUrl = pagePacket.finalUrl || pagePacket.url;
    const urlPattern = inferUrlPattern(finalUrl);
    const reuseTemplate =
      input.source === "template-reuse"
        ? input.template
        : Object.keys(userSchema).length === 0
          ? null
          : await deps.readTemplateForPattern(store, urlPattern, userSchema);
    const base = () => ({ target: input.target, finalUrl, urlPattern, schema: userSchema });

    if (reuseTemplate) {
      progress(`Extracting with the saved template for ${urlPattern}…`);
      const result = await deps.extractWithTemplate({ page, pagePacket, template: reuseTemplate });
      const folder = await deps.savePageArtifacts(store, { pagePacket, result });

      return {
        ...base(),
        path: input.source === "template-reuse" ? "template-reuse" : "existing-template",
        result,
        llmUsed: false,
        provider: null,
        templateId: reuseTemplate.id,
        templatePath: null,
        artifactFolder: folder.path,
        warnings: result.warnings,
      };
    }

    const provider = typeof options.provider === "function" ? options.provider() : options.provider;
    const skeleton = await deps.capturePageSkeleton(page);
    const timeoutMs = resolveLlmTimeoutMs();

    if (Object.keys(userSchema).length === 0) {
      progress(`Asking ${provider.name} to suggest fields for this page…`);
      const suggestion = await deps.suggestSchema({
        pagePacket,
        skeleton: skeleton.text,
        provider,
        model: options.model ?? null,
        timeoutMs,
      });
      userSchema = suggestion.schema;
      progress(`Suggested fields: ${suggestion.fields.map(field => `${field.name}:${field.type}`).join(", ")}`);
    }

    if (input.source === "schema-builder") {
      await deps.saveSchema(store, userSchema, new Date(input.startedAt));
    }
    const authored = await deps.authorTemplate({
      schema: userSchema,
      page,
      pagePacket,
      skeleton: skeleton.text,
      provider,
      model: options.model ?? null,
      maxRepairs: options.maxRepairs,
      timeoutMs,
      onProgress: progress,
    });

    const templateArtifact = await deps.saveTemplate(store, authored.template);
    const result = await deps.extractWithTemplate({ page, pagePacket, template: authored.template });
    const warnings = [...authored.warnings, ...result.warnings];
    const folder = await deps.savePageArtifacts(store, {
      pagePacket,
      llmResult: {
        provider: authored.provider,
        model: authored.model,
        llmUsed: true,
        calls: authored.calls,
        warnings: authored.warnings,
        createdAt: authored.template.createdAt,
      },
      result,
    });

    return {
      ...base(),
      path: "authored",
      result,
      llmUsed: true,
      provider: authored.provider,
      templateId: authored.template.id,
      templatePath: templateArtifact.path,
      artifactFolder: folder.path,
      warnings,
    };
  });
}

export function resolveLlmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.TURBO_CRAWL_LLM_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 600_000;
}
