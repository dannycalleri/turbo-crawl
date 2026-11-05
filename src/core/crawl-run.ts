import { withRenderedPage, type BrowserSessionOptions, type RenderedPageContext } from "./crawler.ts";
import type { PagePacket } from "./types.ts";
import type { LLMProvider } from "./llm-extractor/providers/LLMProvider.ts";
import type { UserSchema } from "./llm-extractor/types.ts";
import type { ExtractionTemplate } from "./templating/types.ts";
import { inferUrlPattern } from "./templating/inferUrlPattern.ts";
import { buildPolicy, CrawlFailure, failureForStatus, type PolicyInfo } from "./policy/policy.ts";
import type { RobotsChecker, RobotsStatus } from "./policy/robots.ts";
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
  saveTemplate,
  type DomainStore,
  type PageArtifacts,
  type PagePacketFolder,
  type TemplateArtifact,
} from "./domain-store.ts";

export type CrawlStartInput =
  | {
      target: string;
      schema: UserSchema;
      source: "fields";
    }
  | {
      target: string;
      template: ExtractionTemplate;
      source: "template-reuse";
    };

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
  policy: PolicyInfo;
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
  userAgent?: string;
  robots?: RobotsChecker | null;
  onProgress?: (message: string) => void;
};

export type StartCrawlDependencies = {
  withRenderedPage<T>(
    url: string,
    handler: (context: RenderedPageContext) => Promise<T> | T,
    options?: BrowserSessionOptions,
  ): Promise<T>;
  createDomainStore(input: { targetUrl: string; rootPath?: string }): DomainStore;
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

export const defaultStartCrawlDependencies: StartCrawlDependencies = {
  withRenderedPage: (url, handler, options) => withRenderedPage(url, handler, options),
  createDomainStore,
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
  let userSchema = input.source === "template-reuse" ? input.template.schema : input.schema;
  const store = deps.createDomainStore({ targetUrl: input.target, rootPath: options.dataDir });

  const robots = options.robots ?? null;
  const robotsStatus: RobotsStatus = robots ? await robots.check(input.target) : "unknown";
  if (robotsStatus === "disallowed") {
    throw new CrawlFailure("ROBOTS_DISALLOWED", `robots.txt disallows ${input.target} for this user agent. Choose another URL, or turn off the robots check only with the site's permission.`, null);
  }

  progress(`Rendering ${input.target}…`);

  return renderOrTimeout(input.target, () => deps.withRenderedPage(input.target, async ({ page, pagePacket }) => {
    const finalUrl = pagePacket.finalUrl || pagePacket.url;
    let policy = buildPolicy(pagePacket, robotsStatus);
    if (robots && finalUrl !== input.target && (await robots.check(finalUrl)) === "disallowed") {
      policy = { ...policy, robots: "disallowed" };
      throw new CrawlFailure(
        "ROBOTS_DISALLOWED",
        `${input.target} redirected to ${finalUrl}, which robots.txt disallows for this user agent. Choose another URL, or turn off the robots check only with the site's permission.`,
        policy,
      );
    }
    const statusFailure = failureForStatus(finalUrl, policy, pagePacket.response.retryAfter);
    if (statusFailure) throw statusFailure;

    const urlPattern = inferUrlPattern(finalUrl);
    const reuseTemplate =
      input.source === "template-reuse"
        ? input.template
        : Object.keys(userSchema).length === 0
          ? null
          : await deps.readTemplateForPattern(store, urlPattern, userSchema);
    const base = () => ({ target: input.target, finalUrl, urlPattern, schema: userSchema, policy });

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
  }, { userAgent: options.userAgent }));
}

async function renderOrTimeout<T>(url: string, render: () => Promise<T>): Promise<T> {
  try {
    return await render();
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError" && /page\.goto/.test(error.message)) {
      throw new CrawlFailure("TIMEOUT", `${url} did not load in time (${error.message.split("\n")[0]}). The site may be slow or unreachable; try again later.`, null);
    }
    throw error;
  }
}

export function resolveLlmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.TURBO_CRAWL_LLM_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 600_000;
}
