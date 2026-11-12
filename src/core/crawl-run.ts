import { withRenderedPage, withSnapshotPage, type BrowserSessionOptions, type RenderedPageContext } from "./crawler.ts";
import type { PagePacket } from "./types.ts";
import type { TemplateStore } from "../lib-types.ts";
import { fileTemplateRepository, storeTemplateRepository } from "./template-repository.ts";
import type { LLMProvider } from "./llm-extractor/providers/LLMProvider.ts";
import type { UserSchema } from "./llm-extractor/types.ts";
import type { ExtractionTemplate } from "./templating/types.ts";
import { inferUrlPattern } from "./templating/inferUrlPattern.ts";
import { matchingPattern, urlMatchesPattern } from "./templating/urlPatterns.ts";
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
  type ClassifyPageInput,
  type PageClassification,
} from "./template-author/classifyPage.ts";
import { summarizeLinkGroups, type LinkGroup, type LinkItem } from "./extraction/links.ts";
import { readListingLinks, type ListingLinks } from "./template-author/validateListingSelectors.ts";
import type { ListingTemplate } from "./templating/types.ts";
import {
  addPatternToTemplate,
  createDomainStore,
  listTemplatesForDomain,
  savePageArtifacts,
  listListingTemplates,
  saveListingTemplate,
  saveTemplate,
  schemasMatch,
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
  /** The caller knows the page kind: "detail" never treats it as a listing, "listing" uses only listing templates. */
  expect?: "detail" | "listing";
  /** Only this saved listing template may read the page, and no agent is asked. */
  listingTemplatePath?: string;
  /** HTML that the caller rendered at `target`. turbo-crawl reads it as a detail page and does not fetch the page or robots.txt. */
  snapshotHtml?: string;
};

export type TemplateFit = {
  templateId: string;
  templatePath: string;
  matchedPattern: boolean;
};

type PageFacts = {
  target: string;
  finalUrl: string;
  canonicalUrl: string | null;
  fetchedAt: string;
  urlPattern: string;
  policy: PolicyInfo;
};

export type ItemOutcome = PageFacts & {
  kind: "item";
  path: "template-reuse" | "stale-template" | "authored";
  schema: UserSchema;
  result: TemplateExtractionResult;
  llmUsed: boolean;
  provider: LLMProvider["name"] | null;
  templateFit: TemplateFit;
  missing: string[];
  stale: boolean;
  artifactFolder: string | null;
  warnings: string[];
};

export type ListingOutcome = PageFacts & {
  kind: "listing";
  items: LinkItem[];
  itemUrlPatterns: string[];
  paginationUrls: string[];
  linkGroups: LinkGroup[];
  llmUsed: boolean;
  provider: LLMProvider["name"] | null;
  templateFit: TemplateFit;
  artifactFolder: string | null;
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
  store?: TemplateStore;
  onProgress?: (message: string) => void;
};

export type StartCrawlDependencies = {
  withRenderedPage<T>(
    url: string,
    handler: (context: RenderedPageContext) => Promise<T> | T,
    options?: BrowserSessionOptions,
  ): Promise<T>;
  withSnapshotPage<T>(
    url: string,
    html: string,
    handler: (context: RenderedPageContext) => Promise<T> | T,
    options?: BrowserSessionOptions,
  ): Promise<T>;
  createDomainStore(input: { targetUrl: string; rootPath?: string }): DomainStore;
  listTemplatesForDomain(store: DomainStore): Promise<ReuseDiscoveryResult<TemplateMatchCandidate>>;
  addPatternToTemplate(templatePath: string, url: string): Promise<void>;
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
  listListingTemplates(store: DomainStore): Promise<ReuseDiscoveryResult<ListingTemplateArtifact>>;
  readListingLinks(page: RenderedPageContext["page"], template: ListingTemplate): Promise<ListingLinks | null>;
  extractWithTemplate(input: {
    page: RenderedPageContext["page"];
    pagePacket: PagePacket;
    template: ExtractionTemplate;
  }): Promise<TemplateExtractionResult>;
};

export const defaultStartCrawlDependencies: StartCrawlDependencies = {
  withRenderedPage: (url, handler, options) => withRenderedPage(url, handler, options),
  withSnapshotPage: (url, html, handler, options) => withSnapshotPage(url, html, handler, options),
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
  listListingTemplates,
  readListingLinks,
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
  requested: CrawlStartInput,
  options: CrawlOptions,
  deps: StartCrawlDependencies = defaultStartCrawlDependencies,
): Promise<CrawlOutcome> {
  const { snapshotHtml } = requested;
  const isSnapshot = snapshotHtml !== undefined;
  const input: CrawlStartInput = isSnapshot
    ? { ...requested, expect: "detail", listingTemplatePath: undefined }
    : requested;
  const progress = options.onProgress ?? (() => {});
  let userSchema = input.schema;
  const fieldsGiven = Object.keys(userSchema).length > 0;
  const store = deps.createDomainStore({ targetUrl: input.target, rootPath: options.dataDir });
  const templates = options.store ? storeTemplateRepository(options.store, store.domain) : fileTemplateRepository(store, deps);

  const robots = isSnapshot ? null : options.robots ?? null;
  const robotsStatus: RobotsStatus = robots ? await robots.check(input.target) : "unknown";
  if (robotsStatus === "disallowed") {
    throw new CrawlFailure("ROBOTS_DISALLOWED", `robots.txt disallows ${input.target} for this user agent. Choose another URL, or turn off the robots check only with the site's permission.`, null);
  }

  progress(isSnapshot ? `Reading the snapshot of ${input.target}…` : `Rendering ${input.target}…`);

  const sessionOptions = { userAgent: options.userAgent };
  const openPage = <T>(handler: (context: RenderedPageContext) => Promise<T>): Promise<T> =>
    isSnapshot
      ? deps.withSnapshotPage(input.target, snapshotHtml, handler, sessionOptions)
      : deps.withRenderedPage(input.target, handler, sessionOptions);

  return renderOrTimeout(input.target, isSnapshot, () => openPage(async ({ page, pagePacket }) => {
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

    const saveArtifacts = (artifacts: PageArtifacts) =>
      options.writeArtifacts === false ? Promise.resolve(null) : deps.savePageArtifacts(store, artifacts).then(folder => folder.path);
    const [domainListings, domainTemplates] = await Promise.all([templates.listListingTemplates(), templates.listTemplates()]);
    const storedPatterns = [
      ...domainTemplates.candidates.flatMap(candidate => candidate.template.urlPatterns),
      ...domainListings.candidates.flatMap(candidate => [...candidate.template.urlPatterns, ...candidate.template.itemUrlPatterns]),
    ];
    const fieldCandidates = input.expect === "listing"
      ? []
      : domainTemplates.candidates.filter(candidate => !fieldsGiven || schemasMatch(candidate.template.schema, userSchema));
    const urlPattern = matchingPattern(finalUrl, storedPatterns) ?? inferUrlPattern(finalUrl);
    const facts: PageFacts = {
      target: input.target,
      finalUrl,
      canonicalUrl: pagePacket.metadata.canonicalUrl,
      fetchedAt: pagePacket.fetchedAt,
      urlPattern,
      policy,
    };
    const storeWarnings = [...domainListings.warnings, ...domainTemplates.warnings].map(warning => warning.message);
    const listingCandidates = input.expect === "detail"
      ? []
      : domainListings.candidates.filter(candidate => !input.listingTemplatePath || candidate.path === input.listingTemplatePath);
    const isItemPage = !input.listingTemplatePath && input.expect !== "listing" &&
      domainListings.candidates.some(candidate => urlMatchesPattern(finalUrl, candidate.template.itemUrlPatterns));
    const listingFit = isItemPage ? null : await findListingFit(page, listingCandidates, finalUrl, deps);
    const listingOutcome = async ({ candidate, links, matchedPattern }: ListingFit): Promise<ListingOutcome> => {
      if (!matchedPattern) await templates.addListingPattern(candidate.path, finalUrl);
      progress(`Read the links with the saved listing template ${candidate.path}.`);
      return {
        ...facts,
        kind: "listing",
        ...links,
        itemUrlPatterns: candidate.template.itemUrlPatterns,
        linkGroups: await deps.summarizeLinkGroups(page),
        llmUsed: false,
        provider: null,
        templateFit: { templateId: candidate.template.id, templatePath: candidate.path, matchedPattern },
        artifactFolder: await saveArtifacts({ pagePacket }),
        warnings: storeWarnings,
      };
    };

    // A related-products block can fit a listing template, so on a page that
    // a field template knows, a listing fit on a page it does not know waits for the field templates.
    const fieldKnowsPattern = fieldCandidates.some(candidate => urlMatchesPattern(finalUrl, candidate.template.urlPatterns));
    if (listingFit && (listingFit.matchedPattern || !fieldKnowsPattern)) {
      return listingOutcome(listingFit);
    }

    const trials: TemplateTrial[] = await Promise.all(fieldCandidates.map(async candidate => ({
      candidate,
      result: await deps.extractWithTemplate({ page, pagePacket, template: candidate.template }),
    })));
    const decision = decideTemplate(trials, { url: finalUrl, require: input.require, fieldsGiven });

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

    if (listingFit && (decision.kind !== "fit" || !decision.matchedPattern)) {
      return listingOutcome(listingFit);
    }

    if (decision.kind === "fit" || decision.kind === "stale") {
      const { candidate, result } = decision.trial;
      const matchedPattern = decision.kind === "fit" ? decision.matchedPattern : true;
      if (decision.kind === "fit" && !matchedPattern) {
        await templates.addPattern(candidate.path, finalUrl);
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
        ...facts,
        kind: "item",
        schema: candidate.template.schema,
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

    if (input.listingTemplatePath) {
      throw new CrawlFailure(
        "TEMPLATE_MISSING",
        `The listing template ${input.listingTemplatePath} does not fit ${finalUrl}, so its links were not read. The page may use another layout.`,
        policy,
      );
    }

    if (options.authoring === false) {
      throw new CrawlFailure(
        "TEMPLATE_MISSING",
        `No saved ${input.expect === "listing" ? "listing " : ""}template fits ${finalUrl}, and authoring is off. Run turbo-crawl on this page with authoring on to write one.`,
        policy,
      );
    }

    let resolvedProvider: LLMProvider | null = null;
    const getProvider = () =>
      (resolvedProvider ??= typeof options.provider === "function" ? options.provider() : options.provider);
    const skeleton = await deps.capturePageSkeleton(page);
    const timeoutMs = resolveLlmTimeoutMs();

    const askPageKind = input.expect !== "detail" && !isItemPage;
    const groups = askPageKind ? await deps.summarizeLinkGroups(page) : [];
    const classification: PageClassification = askPageKind
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

    if (input.expect === "listing" && classification.kind === "detail") {
      throw new CrawlFailure(
        "TEMPLATE_MISSING",
        `The agent says ${finalUrl} is not a listing page, so no listing template was written. Check the URL, or extract it as a detail page.`,
        policy,
      );
    }

    if (classification.kind === "listing") {
      const listingRef = await templates.saveListingTemplate(classification.template);
      progress(`Saved the listing template ${listingRef}.`);
      return {
        ...facts,
        urlPattern: classification.template.urlPatterns[0]!,
        kind: "listing",
        items: classification.items,
        itemUrlPatterns: classification.template.itemUrlPatterns,
        paginationUrls: classification.paginationUrls,
        linkGroups: groups,
        llmUsed: true,
        provider: classification.provider,
        templateFit: { templateId: classification.template.id, templatePath: listingRef, matchedPattern: true },
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
        warnings: [...storeWarnings, ...classification.warnings],
      };
    }

    const provider = getProvider();

    if (!fieldsGiven) {
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

    const templateRef = await templates.saveTemplate(authored.template);
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
      ...facts,
      urlPattern: authored.template.urlPatterns[0]!,
      kind: "item",
      schema: userSchema,
      path: "authored",
      result,
      llmUsed: true,
      provider: authored.provider,
      templateFit: { templateId: authored.template.id, templatePath: templateRef, matchedPattern: true },
      missing: missingFields(userSchema, result.payload),
      stale: false,
      artifactFolder,
      warnings,
    };
  }));
}

type ListingFit = { candidate: ListingTemplateArtifact; links: ListingLinks; matchedPattern: boolean };

async function findListingFit(
  page: RenderedPageContext["page"],
  candidates: ListingTemplateArtifact[],
  url: string,
  deps: StartCrawlDependencies,
): Promise<ListingFit | null> {
  const fits: ListingFit[] = [];
  for (const candidate of candidates) {
    const links = await deps.readListingLinks(page, candidate.template);
    if (links) fits.push({ candidate, links, matchedPattern: urlMatchesPattern(url, candidate.template.urlPatterns) });
  }
  return fits.sort((left, right) =>
    Number(right.matchedPattern) - Number(left.matchedPattern) ||
    right.candidate.template.createdAt.localeCompare(left.candidate.template.createdAt))[0] ?? null;
}

async function renderOrTimeout<T>(url: string, isSnapshot: boolean, render: () => Promise<T>): Promise<T> {
  try {
    return await render();
  } catch (error) {
    if (isSnapshot && error instanceof Error && /page\.goto/.test(error.message)) {
      throw new CrawlFailure(
        error.name === "TimeoutError" ? "TIMEOUT" : "HTTP_ERROR",
        `The snapshot of ${url} could not be opened (${error.message.split("\n")[0]}). turbo-crawl sends no request for a snapshot, so check the HTML and the URL; a very large page can need a larger navigationTimeoutMs.`,
        null,
      );
    }
    if (error instanceof Error && error.name === "TimeoutError" && /page\.goto/.test(error.message)) {
      throw new CrawlFailure("TIMEOUT", `${url} did not load in time (${error.message.split("\n")[0]}). The site may be slow or unreachable; try again later.`, null);
    }
    if (error instanceof Error && /page\.goto: net::ERR_/.test(error.message)) {
      throw new CrawlFailure("HTTP_ERROR", `${url} could not be reached (${error.message.split("\n")[0]}). Check the URL and the network, or try again later.`, null);
    }
    throw error;
  }
}

export function resolveLlmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.TURBO_CRAWL_LLM_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 600_000;
}
