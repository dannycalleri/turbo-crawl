import { createBrowserSession, type BrowserSession, type BrowserSessionOptions } from "./core/crawler.ts";
import {
  createCrawlRunner,
  defaultStartCrawlDependencies,
  type CrawlOptions,
  type CrawlOutcome,
  type CrawlRunner,
  type CrawlStartInput,
  resolveLlmTimeoutMs,
} from "./core/crawl-run.ts";
import { FIELD_TYPES, isFieldType } from "./core/llm-extractor/types.ts";
import { resolveProvider, type ResolvedProvider } from "./core/llm-extractor/providers/resolveProvider.ts";
import type { LLMProvider as InternalProvider } from "./core/llm-extractor/providers/LLMProvider.ts";
import { CrawlFailure, failureDetails } from "./core/policy/policy.ts";
import { createRobotsChecker, type RobotsChecker } from "./core/policy/robots.ts";
import { inferUrlPattern } from "./core/templating/inferUrlPattern.ts";
import { matchingPattern } from "./core/templating/urlPatterns.ts";
import type {
  CrawlError,
  Crawler,
  CrawlerOptions,
  ExtractHtmlInput,
  ExtractOptions,
  ExtractResult,
  FieldType,
  LinksResult,
  LLMProvider,
  TemplateStore,
} from "./lib-types.ts";

export type * from "./lib-types.ts";

export type LibraryDependencies = {
  createBrowserSession(options: BrowserSessionOptions): BrowserSession;
  createRobotsChecker(userAgent: string): RobotsChecker;
  resolveProvider(): ResolvedProvider;
  createRunner(options: CrawlOptions, session: BrowserSession): CrawlRunner;
};

const defaultLibraryDependencies: LibraryDependencies = {
  createBrowserSession: options => createBrowserSession(options),
  createRobotsChecker: userAgent => createRobotsChecker({ userAgent }),
  resolveProvider: () => resolveProvider({}),
  createRunner: (options, session) =>
    createCrawlRunner(options, {
      ...defaultStartCrawlDependencies,
      withRenderedPage: (url, handler) => session.withRenderedPage(url, handler),
      withSnapshotPage: (url, html, handler) => session.withSnapshotPage(url, html, handler),
    }),
};

FIELD_TYPES satisfies readonly FieldType[];
// dist/lib.d.ts declares createCrawler by hand; this keeps that declaration true.
createCrawler satisfies (options: CrawlerOptions) => Crawler;

export function createCrawler(
  options: CrawlerOptions,
  deps: LibraryDependencies = defaultLibraryDependencies,
): Crawler {
  validateOptions(options);

  const browser = deps.createBrowserSession({
    userAgent: options.userAgent,
    navigationTimeoutMs: options.navigationTimeoutMs,
    settleTimeoutMs: options.settleTimeoutMs,
  });
  const pages = createSemaphore(options.maxConcurrentPages ?? DEFAULT_MAX_CONCURRENT_PAGES);
  const session: BrowserSession = {
    withRenderedPage: (url, handler) => pages.run(() => browser.withRenderedPage(url, handler)),
    withSnapshotPage: (url, html, handler) => pages.run(() => browser.withSnapshotPage(url, html, handler)),
    close: () => browser.close(),
  };
  const running = new Set<Promise<unknown>>();
  let closed = false;
  const track = <T>(call: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error("This crawler is closed. Create a new one with createCrawler()."));
    const promise = call();
    running.add(promise);
    void promise.finally(() => running.delete(promise)).catch(() => {});
    return promise;
  };
  let resolved: ResolvedProvider | null = null;
  const callerProvider = options.provider ? adaptProvider(options.provider, options.model ?? null) : null;
  const runner = deps.createRunner(
    {
      provider: () => {
        if (options.authoring === "never") {
          throw new Error("authoring is \"never\", so no agent may be started.");
        }
        if (callerProvider) return callerProvider;
        resolved ??= deps.resolveProvider();
        return resolved.create();
      },
      get model() {
        return options.model ?? resolved?.model ?? null;
      },
      dataDir: options.dataDir,
      userAgent: options.userAgent,
      robots: options.respectRobots === false ? null : deps.createRobotsChecker(options.userAgent),
      authoring: options.authoring === "allowed",
      writeArtifacts: options.writeArtifacts === true,
      store: options.store,
    },
    session,
  );

  const extractDetail = (input: CrawlStartInput) => run<ExtractResult>(runner, input, outcome => {
    if (outcome.kind !== "item") throw new Error(`expected a detail result for ${input.target}`);
    return {
      ...pageResult(outcome),
      data: outcome.result.payload,
      missing: outcome.missing,
      stale: outcome.stale,
    };
  });

  return {
    extract: (url, extractOptions = {}) => track(async () => {
      validateExtractOptions(extractOptions);
      return extractDetail({
        target: url,
        schema: extractOptions.fields ?? {},
        require: extractOptions.require,
        expect: "detail",
      });
    }),
    extractHtml: input => track(async () => {
      validateExtractHtmlInput(input);
      return extractDetail({
        target: input.url,
        schema: input.fields ?? {},
        require: input.require,
        expect: "detail",
        snapshotHtml: input.html,
      });
    }),
    links: url => track(() =>
      run<LinksResult>(runner, { target: url, schema: {}, expect: "listing" }, outcome => {
        if (outcome.kind !== "listing") throw new Error(`expected a listing result for ${url}`);
        return {
          ...pageResult(outcome),
          itemUrls: outcome.items.map(item => ({
            ...item,
            urlPattern: matchingPattern(item.url, outcome.itemUrlPatterns) ?? inferUrlPattern(item.url),
          })),
          paginationUrls: outcome.paginationUrls,
          patterns: outcome.linkGroups,
        };
      })),
    async close() {
      closed = true;
      await Promise.allSettled(running);
      await session.close();
    },
  };
}

const DEFAULT_MAX_CONCURRENT_PAGES = 4;

function adaptProvider(provider: LLMProvider, model: string | null): InternalProvider {
  const name = typeof provider.name === "string" && provider.name.trim() !== "" ? provider.name : "custom";
  return {
    name,
    async completeStructured(request) {
      const timeoutMs = request.timeoutMs ?? resolveLlmTimeoutMs();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${name}: no answer after ${timeoutMs}ms; the request was aborted. Raise TURBO_CRAWL_LLM_TIMEOUT_MS to wait longer.`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          provider.completeStructured({
            model,
            messages: request.messages,
            jsonSchema: request.jsonSchema,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            timeoutMs,
            signal: controller.signal,
          }),
          timedOut,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function createSemaphore(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
      else active += 1;
      try {
        return await task();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
      }
    },
  };
}

async function run<T>(
  runner: CrawlRunner,
  input: CrawlStartInput,
  toResult: (outcome: CrawlOutcome) => T,
): Promise<T | CrawlError> {
  try {
    return toResult(await runner.startCrawl(input));
  } catch (error) {
    if (!(error instanceof CrawlFailure)) throw error;
    return {
      ok: false,
      schemaVersion: 1,
      url: input.target,
      code: error.code,
      message: error.message,
      ...failureDetails(error),
    };
  }
}

function pageResult(outcome: CrawlOutcome) {
  return {
    ok: true as const,
    schemaVersion: 1 as const,
    url: outcome.target,
    finalUrl: outcome.finalUrl,
    canonicalUrl: outcome.canonicalUrl,
    fetchedAt: outcome.fetchedAt,
    urlPattern: outcome.urlPattern,
    policy: outcome.policy,
    warnings: outcome.warnings,
    templateFit: outcome.templateFit,
  };
}

const STORE_FUNCTIONS = [
  "listTemplates",
  "listListingTemplates",
  "saveTemplate",
  "saveListingTemplate",
  "updateTemplate",
  "updateListingTemplate",
] as const satisfies ReadonlyArray<keyof TemplateStore>;

function validateOptions(options: CrawlerOptions): void {
  const fail = (message: string): never => {
    throw new TypeError(`createCrawler: ${message}`);
  };
  if (typeof options !== "object" || options === null) fail("options must be an object.");
  const hasDataDir = typeof options.dataDir === "string" && options.dataDir.trim() !== "";
  if (options.dataDir !== undefined && !hasDataDir) fail("options.dataDir must be a folder path.");
  if (!hasDataDir && options.store === undefined) {
    fail("options.dataDir or options.store is required: the folder or the store that holds the saved templates.");
  }
  if (!hasDataDir && options.writeArtifacts === true) {
    fail("options.dataDir is required with writeArtifacts: true, because page packets and agent transcripts are files.");
  }
  if (options.store !== undefined) {
    const missing = STORE_FUNCTIONS.filter(name => typeof (options.store as Record<string, unknown> | null)?.[name] !== "function");
    if (missing.length > 0) fail(`options.store needs these functions: ${missing.join(", ")}.`);
  }
  if (typeof options.userAgent !== "string" || options.userAgent.trim() === "") {
    fail("options.userAgent is required: a name for your crawler, e.g. \"MyBot/1.0 (+https://example.com/bot)\". There is no default.");
  }
  if (options.authoring !== "never" && options.authoring !== "allowed") {
    fail("options.authoring is required: \"never\" (saved templates only) or \"allowed\".");
  }
  for (const name of ["respectRobots", "writeArtifacts"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "boolean") fail(`options.${name} must be true or false.`);
  }
  if (options.maxConcurrentPages !== undefined && (!Number.isInteger(options.maxConcurrentPages) || options.maxConcurrentPages < 1)) {
    fail("options.maxConcurrentPages must be a whole number of 1 or more.");
  }
  if (options.provider !== undefined && typeof (options.provider as { completeStructured?: unknown } | null)?.completeStructured !== "function") {
    fail("options.provider needs a completeStructured(request) function that resolves to { parsed, raw }.");
  }
  if (options.model !== undefined && (typeof options.model !== "string" || options.model.trim() === "")) {
    fail("options.model must be a non-empty model id.");
  }
  if (options.model !== undefined && options.provider === undefined) {
    fail("options.model needs options.provider. To choose the model of claude, codex or LM Studio, set TURBO_CRAWL_MODEL.");
  }
  for (const name of ["navigationTimeoutMs", "settleTimeoutMs"] as const) {
    const value = options[name];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) fail(`options.${name} must be a number of milliseconds above 0.`);
  }
}

const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

function validateExtractHtmlInput(input: ExtractHtmlInput): void {
  const fail = (message: string): never => {
    throw new TypeError(`extractHtml: ${message}`);
  };
  if (typeof input !== "object" || input === null) fail("the argument must be an object with url and html.");
  const protocol = typeof input.url === "string" && URL.canParse(input.url) ? new URL(input.url).protocol : null;
  if (protocol !== "http:" && protocol !== "https:") {
    fail(`url must be an absolute http or https URL, e.g. "https://shop.example/item/1". Got ${JSON.stringify(input.url)}.`);
  }
  if (typeof input.html !== "string" || input.html.trim() === "") fail("html must be the non-empty HTML of the page.");
  if (Buffer.byteLength(input.html, "utf8") > MAX_SNAPSHOT_BYTES) {
    fail("html is larger than 10 MB. Remove inline data, such as base64 images, before you pass the page.");
  }
  validateExtractOptions(input, "extractHtml");
}

function validateExtractOptions(options: ExtractOptions, call = "extract"): void {
  for (const [name, type] of Object.entries(options.fields ?? {})) {
    if (!isFieldType(type)) {
      throw new TypeError(`${call}: field "${name}" has the unknown type "${type}". Use one of ${FIELD_TYPES.join(", ")}.`);
    }
  }
  if (options.require && options.fields) {
    const unknown = options.require.filter(name => !(name in options.fields!));
    if (unknown.length > 0) throw new TypeError(`${call}: require names ${unknown.join(", ")}, which fields does not list.`);
  }
}
