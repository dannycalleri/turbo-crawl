import { createBrowserSession, type BrowserSession, type BrowserSessionOptions } from "./core/crawler.ts";
import {
  createCrawlRunner,
  defaultStartCrawlDependencies,
  type CrawlOptions,
  type CrawlOutcome,
  type CrawlRunner,
  type CrawlStartInput,
} from "./core/crawl-run.ts";
import { FIELD_TYPES } from "./core/llm-extractor/types.ts";
import { resolveProvider, type ResolvedProvider } from "./core/llm-extractor/providers/resolveProvider.ts";
import { CrawlFailure } from "./core/policy/policy.ts";
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

export function createCrawler(
  options: CrawlerOptions,
  deps: LibraryDependencies = defaultLibraryDependencies,
): Crawler {
  validateOptions(options);

  const session = deps.createBrowserSession({
    userAgent: options.userAgent,
    navigationTimeoutMs: options.navigationTimeoutMs,
    settleTimeoutMs: options.settleTimeoutMs,
  });
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
    async extract(url, extractOptions = {}) {
      validateExtractOptions(extractOptions);
      return run<ExtractResult>(runner, url, {
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
    },
    async links(url) {
      return run<LinksResult>(runner, url, { target: url, schema: {}, expect: "listing" }, outcome => {
        if (outcome.kind !== "listing") throw new Error(`expected a listing result for ${url}`);
        return {
          ...pageResult(outcome),
          itemUrls: outcome.items.map(item => ({ ...item, urlPattern: inferUrlPattern(item.url) })),
          paginationUrls: outcome.paginationUrls,
          patterns: outcome.linkGroups,
        };
      });
    },
    close: () => session.close(),
  };
}

async function run<T>(
  runner: CrawlRunner,
  url: string,
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
      url,
      code: error.code,
      message: error.message,
      policy: error.policy,
      ...(error.code === "BLOCKED" ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(error.code === "AMBIGUOUS_TEMPLATE" ? { templatePaths: error.templatePaths } : {}),
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
  for (const name of ["navigationTimeoutMs", "settleTimeoutMs"] as const) {
    const value = options[name];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) fail(`options.${name} must be a number of milliseconds above 0.`);
  }
}

function validateExtractOptions(options: ExtractOptions): void {
  for (const [name, type] of Object.entries(options.fields ?? {})) {
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      throw new TypeError(`extract: field "${name}" has the unknown type "${type}". Use one of ${FIELD_TYPES.join(", ")}.`);
    }
  }
  if (options.require && options.fields) {
    const unknown = options.require.filter(name => !(name in options.fields!));
    if (unknown.length > 0) throw new TypeError(`extract: require names ${unknown.join(", ")}, which fields does not list.`);
  }
}
