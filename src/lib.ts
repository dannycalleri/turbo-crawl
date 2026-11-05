import { createBrowserSession, type BrowserSession, type BrowserSessionOptions } from "./core/crawler.ts";
import {
  createCrawlRunner,
  defaultStartCrawlDependencies,
  type CrawlOptions,
  type CrawlOutcome,
  type CrawlRunner,
  type CrawlStartInput,
} from "./core/crawl-run.ts";
import { FIELD_TYPES, isFieldType } from "./core/llm-extractor/types.ts";
import { resolveProvider, type ResolvedProvider } from "./core/llm-extractor/providers/resolveProvider.ts";
import { CrawlFailure, failureDetails } from "./core/policy/policy.ts";
import { createRobotsChecker, type RobotsChecker } from "./core/policy/robots.ts";
import { inferUrlPattern } from "./core/templating/inferUrlPattern.ts";
import type {
  CrawlError,
  Crawler,
  CrawlerOptions,
  ExtractOptions,
  ExtractResult,
  FieldType,
  LinksResult,
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
  const runner = deps.createRunner(
    {
      provider: () => {
        if (options.authoring === "never") {
          throw new Error("authoring is \"never\", so no agent may be started.");
        }
        resolved ??= deps.resolveProvider();
        return resolved.create();
      },
      get model() {
        return resolved?.model ?? null;
      },
      dataDir: options.dataDir,
      userAgent: options.userAgent,
      robots: options.respectRobots === false ? null : deps.createRobotsChecker(options.userAgent),
      authoring: options.authoring === "allowed",
      writeArtifacts: options.writeArtifacts === true,
    },
    session,
  );

  return {
    extract: (url, extractOptions = {}) => track(async () => {
      validateExtractOptions(extractOptions);
      return run<ExtractResult>(runner, {
        target: url,
        schema: extractOptions.fields ?? {},
        require: extractOptions.require,
        expect: "detail",
      }, outcome => {
        if (outcome.kind !== "item") throw new Error(`expected a detail result for ${url}`);
        return {
          ...pageResult(outcome),
          data: outcome.result.payload,
          missing: outcome.missing,
          stale: outcome.stale,
        };
      });
    }),
    links: url => track(() =>
      run<LinksResult>(runner, { target: url, schema: {}, expect: "listing" }, outcome => {
        if (outcome.kind !== "listing") throw new Error(`expected a listing result for ${url}`);
        return {
          ...pageResult(outcome),
          itemUrls: outcome.items.map(item => ({ ...item, urlPattern: inferUrlPattern(item.url) })),
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

function validateOptions(options: CrawlerOptions): void {
  const fail = (message: string): never => {
    throw new TypeError(`createCrawler: ${message}`);
  };
  if (typeof options !== "object" || options === null) fail("options must be an object.");
  if (typeof options.dataDir !== "string" || options.dataDir.trim() === "") {
    fail("options.dataDir is required: the folder that holds the saved templates.");
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
  for (const name of ["navigationTimeoutMs", "settleTimeoutMs"] as const) {
    const value = options[name];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) fail(`options.${name} must be a number of milliseconds above 0.`);
  }
}

function validateExtractOptions(options: ExtractOptions): void {
  for (const [name, type] of Object.entries(options.fields ?? {})) {
    if (!isFieldType(type)) {
      throw new TypeError(`extract: field "${name}" has the unknown type "${type}". Use one of ${FIELD_TYPES.join(", ")}.`);
    }
  }
  if (options.require && options.fields) {
    const unknown = options.require.filter(name => !(name in options.fields!));
    if (unknown.length > 0) throw new TypeError(`extract: require names ${unknown.join(", ")}, which fields does not list.`);
  }
}
