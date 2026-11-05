import { withRenderedPage, type BrowserSessionOptions, type RenderedPageContext } from "./crawler.ts";
import type { PagePacket } from "./types.ts";
import type { LLMProvider } from "./llm-extractor/providers/LLMProvider.ts";
import type { UserSchema } from "./llm-extractor/types.ts";
import type { ExtractionTemplate } from "./templating/types.ts";
import { inferUrlPattern } from "./templating/inferUrlPattern.ts";
import { buildPolicy, CrawlFailure, failureForStatus, type PolicyInfo } from "./policy/policy.ts";
import { decideTemplate, missingFields, type TemplateTrial } from "./template-matcher/matchTemplate.ts";
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
  classifyPage,
  looksLikeListing,
  type ClassifyPageInput,
  type PageClassification,
} from "./template-author/classifyPage.ts";
import { summarizeLinkGroups, type LinkGroup } from "./extraction/links.ts";
import type { ListingTemplate } from "./templating/types.ts";
import {
  addPatternToTemplate,
  createDomainStore,
  listTemplatesForDomain,
  savePageArtifacts,
  saveListingTemplate,
  saveTemplate,
  type DomainStore,
  type ListingTemplateArtifact,
  type ReuseDiscoveryResult,
  type TemplateMatchCandidate,
  type PageArtifacts,
  type PagePacketFolder,
  type TemplateArtifact,
} from "./domain-store.ts";

export type CrawlStartInput = {
  target: string;
  schema: UserSchema;
  require?: string[];
};

export type TemplateFit = {
  templateId: string;
  templatePath: string;
  matchedPattern: boolean;
};

export type ItemOutcome = {
  kind: "item";
  target: string;
  finalUrl: string;
  urlPattern: string;
  path: "template-reuse" | "stale-template" | "authored";
  schema: UserSchema;
  result: TemplateExtractionResult;
  llmUsed: boolean;
  provider: LLMProvider["name"] | null;
  templateFit: TemplateFit;
  missing: string[];
  stale: boolean;
  artifactFolder: string | null;
  policy: PolicyInfo;
  warnings: string[];
};

export type ListingOutcome = {
  kind: "listing";
  target: string;
  finalUrl: string;
  urlPattern: string;
  itemUrls: string[];
  paginationUrls: string[];
  llmUsed: boolean;
  provider: LLMProvider["name"] | null;
  templateFit: TemplateFit;
  artifactFolder: string | null;
  policy: PolicyInfo;
  warnings: string[];
};

export type CrawlOutcome = ItemOutcome | ListingOutcome;

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
  authoring?: boolean;
  writeArtifacts?: boolean;
  onProgress?: (message: string) => void;
};

export type StartCrawlDependencies = {
  withRenderedPage<T>(
    url: string,
    handler: (context: RenderedPageContext) => Promise<T> | T,
    options?: BrowserSessionOptions,
  ): Promise<T>;
  createDomainStore(input: { targetUrl: string; rootPath?: string }): DomainStore;
  listTemplatesForDomain(
    store: DomainStore,
    options: { fields?: UserSchema },
  ): Promise<ReuseDiscoveryResult<TemplateMatchCandidate>>;
  addPatternToTemplate(templatePath: string, urlPattern: string): Promise<void>;
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
  summarizeLinkGroups(page: RenderedPageContext["page"]): Promise<LinkGroup[]>;
  classifyPage(input: ClassifyPageInput): Promise<PageClassification>;
  saveListingTemplate(store: DomainStore, template: ListingTemplate): Promise<ListingTemplateArtifact>;
  extractWithTemplate(input: {
    page: RenderedPageContext["page"];
    pagePacket: PagePacket;
    template: ExtractionTemplate;
  }): Promise<TemplateExtractionResult>;
};

export const defaultStartCrawlDependencies: StartCrawlDependencies = {
  withRenderedPage: (url, handler, options) => withRenderedPage(url, handler, options),
  createDomainStore,
  listTemplatesForDomain,
  addPatternToTemplate,
  saveTemplate,
  savePageArtifacts,
  capturePageSkeleton,
  authorTemplate,
  suggestSchema,
  summarizeLinkGroups,
  classifyPage,
  saveListingTemplate,
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
  let userSchema = input.schema;
  const fieldsGiven = Object.keys(userSchema).length > 0;
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
    const saved = await deps.listTemplatesForDomain(store, { fields: fieldsGiven ? userSchema : undefined });
    const storeWarnings = saved.warnings.map(warning => warning.message);
    const trials: TemplateTrial[] = [];
    for (const candidate of saved.candidates) {
      trials.push({ candidate, result: await deps.extractWithTemplate({ page, pagePacket, template: candidate.template }) });
    }
    const decision = decideTemplate(trials, { urlPattern, require: input.require, fieldsGiven });
    const saveArtifacts = (artifacts: PageArtifacts) =>
      options.writeArtifacts === false ? Promise.resolve(null) : deps.savePageArtifacts(store, artifacts).then(folder => folder.path);

    if (decision.kind === "ambiguous") {
      const paths = decision.trials.map(trial => trial.candidate.path);
      throw new CrawlFailure(
        "AMBIGUOUS_TEMPLATE",
        `More than one saved template fits ${finalUrl}. Pass --fields to choose one, or remove all but one of:\n${paths.map(file => `  ${file}`).join("\n")}`,
        policy,
        null,
        paths,
      );
    }

    if (decision.kind === "fit" || decision.kind === "stale") {
      const { candidate, result } = decision.trial;
      const matchedPattern = decision.kind === "fit" ? decision.matchedPattern : true;
      if (decision.kind === "fit" && !matchedPattern) {
        await deps.addPatternToTemplate(candidate.path, urlPattern);
      }
      progress(decision.kind === "fit"
        ? `Extracted with the saved template ${candidate.path}.`
        : `The saved template for ${urlPattern} no longer fits this page; returning a stale result.`);
      const missing = missingFields(candidate.template.schema, result.payload);
      const warnings = [
        ...storeWarnings,
        ...(decision.kind === "stale"
          ? [`The template ${candidate.path} no longer fits this page (${decision.reasons.join("; ")}); the page layout may have changed. Re-author it.`]
          : []),
        ...result.warnings,
      ];

      return {
        kind: "item",
        target: input.target,
        finalUrl,
        urlPattern,
        schema: candidate.template.schema,
        policy,
        path: decision.kind === "fit" ? "template-reuse" : "stale-template",
        result,
        llmUsed: false,
        provider: null,
        templateFit: { templateId: candidate.template.id, templatePath: candidate.path, matchedPattern },
        missing,
        stale: decision.kind === "stale",
        artifactFolder: await saveArtifacts({ pagePacket, result }),
        warnings,
      };
    }

    if (options.authoring === false) {
      throw new CrawlFailure(
        "TEMPLATE_MISSING",
        `No saved template fits ${finalUrl}, and authoring is off. Run turbo-crawl on this page with authoring on to write one.`,
        policy,
      );
    }

    let resolvedProvider: LLMProvider | null = null;
    const getProvider = () =>
      (resolvedProvider ??= typeof options.provider === "function" ? options.provider() : options.provider);
    const skeleton = await deps.capturePageSkeleton(page);
    const timeoutMs = resolveLlmTimeoutMs();

    const groups = await deps.summarizeLinkGroups(page);
    const classification: PageClassification = looksLikeListing(groups, finalUrl)
      ? await deps.classifyPage({
          page,
          pagePacket,
          skeleton: skeleton.text,
          groups,
          provider: getProvider(),
          model: options.model ?? null,
          maxRepairs: options.maxRepairs,
          timeoutMs,
          onProgress: progress,
        })
      : { kind: "detail", calls: [] };

    if (classification.kind === "listing") {
      const listingArtifact = await deps.saveListingTemplate(store, classification.template);
      progress(`Saved the listing template ${listingArtifact.path}.`);
      return {
        kind: "listing",
        target: input.target,
        finalUrl,
        urlPattern,
        itemUrls: classification.itemUrls,
        paginationUrls: classification.paginationUrls,
        llmUsed: true,
        provider: classification.provider,
        templateFit: { templateId: classification.template.id, templatePath: listingArtifact.path, matchedPattern: true },
        artifactFolder: await saveArtifacts({
          pagePacket,
          llmResult: {
            provider: classification.provider,
            model: options.model ?? null,
            llmUsed: true,
            calls: classification.calls,
            warnings: classification.warnings,
            createdAt: classification.template.createdAt,
          },
        }),
        policy,
        warnings: [...storeWarnings, ...classification.warnings],
      };
    }

    const provider = getProvider();

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
    const warnings = [...storeWarnings, ...authored.warnings, ...result.warnings];
    const artifactFolder = await saveArtifacts({
      pagePacket,
      llmResult: {
        provider: authored.provider,
        model: authored.model,
        llmUsed: true,
        calls: [...classification.calls, ...authored.calls],
        warnings: authored.warnings,
        createdAt: authored.template.createdAt,
      },
      result,
    });

    return {
      kind: "item",
      target: input.target,
      finalUrl,
      urlPattern,
      schema: userSchema,
      policy,
      path: "authored",
      result,
      llmUsed: true,
      provider: authored.provider,
      templateFit: { templateId: authored.template.id, templatePath: templateArtifact.path, matchedPattern: true },
      missing: missingFields(userSchema, result.payload),
      stale: false,
      artifactFolder,
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
