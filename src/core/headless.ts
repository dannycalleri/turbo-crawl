import { isMissingExecutableError } from "./browserInstall.ts";
import { createBrowserSession } from "./crawler.ts";
import {
  createCrawlRunner,
  defaultStartCrawlDependencies,
  type CrawlOptions,
  type CrawlOutcome,
  type CrawlRunner,
} from "./crawl-run.ts";
import { crawlSite, DEFAULT_SITE_CRAWL_LIMITS, type SiteCrawlLimits } from "./site-crawl.ts";
import { FIELD_TYPES, isFieldType, type UserSchema } from "./llm-extractor/types.ts";
import {
  ProviderSelectionError,
  resolveProvider,
  type ResolvedProvider,
} from "./llm-extractor/providers/resolveProvider.ts";
import { ConfigError, resolveUserAgent } from "./config.ts";
import { CrawlFailure, failureDetails } from "./policy/policy.ts";
import { createRobotsChecker, type RobotsChecker } from "./policy/robots.ts";

export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;
export const EXIT_TEMPLATE_MISSING = 3;
export const EXIT_ROBOTS_DISALLOWED = 4;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type HeadlessCrawlInput = {
  target: string;
  fields?: string;
  provider?: string;
  model?: string;
  dataDir?: string;
  maxRepairs?: number;
  userAgent?: string;
  ignoreRobots?: boolean;
  author?: boolean;
  artifacts?: boolean;
  require?: string;
  follow?: boolean;
  maxPages?: number;
  maxItems?: number;
  delayMs?: number;
};

type Writer = { write(chunk: string): unknown };

export type HeadlessDependencies = {
  resolveUserAgent(option: string | undefined): Promise<string>;
  createRobotsChecker(userAgent: string): RobotsChecker;
  resolveProvider(input: { provider?: string; model?: string }): ResolvedProvider;
  createRunner(options: CrawlOptions): CrawlRunner & { close?(): Promise<void> };
  stdout: Writer;
  stderr: Writer;
};

export const defaultHeadlessDependencies: HeadlessDependencies = {
  resolveUserAgent: option => resolveUserAgent(option),
  createRobotsChecker: userAgent => createRobotsChecker({ userAgent }),
  resolveProvider,
  createRunner: options => {
    const session = createBrowserSession({ userAgent: options.userAgent });
    const runner = createCrawlRunner(options, {
      ...defaultStartCrawlDependencies,
      withRenderedPage: (url, handler) => session.withRenderedPage(url, handler),
    });
    return { ...runner, close: () => session.close() };
  },
  stdout: process.stdout,
  stderr: process.stderr,
};

export function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return url.toString();
  } catch {
    throw new UsageError(`"${raw}" is not a valid http(s) URL.`);
  }
}

export function parseFieldsOption(raw: string): UserSchema {
  const schema: UserSchema = {};

  for (const entry of raw.split(",").map(part => part.trim()).filter(Boolean)) {
    const [name, type, ...rest] = entry.split(":").map(part => part.trim());

    if (!name || !type || rest.length > 0) {
      throw new UsageError(`Invalid --fields entry "${entry}". Use name:type, e.g. title:string,price:number.`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new UsageError(`Invalid field name "${name}". Use letters, digits and underscores.`);
    }
    if (!isFieldType(type)) {
      throw new UsageError(`Unknown type "${type}" for field "${name}". Allowed types: ${FIELD_TYPES.join(", ")}.`);
    }
    if (name in schema) {
      throw new UsageError(`Field "${name}" is listed twice in --fields.`);
    }

    schema[name] = type;
  }

  if (Object.keys(schema).length === 0) {
    throw new UsageError("--fields is empty. Use name:type pairs separated by commas, or omit it to let the agent suggest fields.");
  }

  return schema;
}

export function parseRequireOption(raw: string, fields: UserSchema | null): string[] {
  const names = raw.split(",").map(part => part.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new UsageError("--require is empty. List field names separated by commas, e.g. --require headline,body.");
  }
  const unknown = fields ? names.filter(name => !(name in fields)) : [];
  if (unknown.length > 0) {
    throw new UsageError(`--require names ${unknown.join(", ")}, which --fields does not list.`);
  }
  return names;
}

function exitCodeFor(error: CrawlFailure): number {
  if (error.code === "ROBOTS_DISALLOWED") return EXIT_ROBOTS_DISALLOWED;
  if (error.code === "TEMPLATE_MISSING") return EXIT_TEMPLATE_MISSING;
  return EXIT_RUNTIME;
}

export function formatOutcome(outcome: CrawlOutcome): unknown {
  if (outcome.kind === "listing") {
    return {
      ok: true,
      kind: "listing",
      url: outcome.target,
      finalUrl: outcome.finalUrl,
      urlPattern: outcome.urlPattern,
      llmUsed: outcome.llmUsed,
      provider: outcome.provider,
      itemUrls: outcome.items.map(item => item.url),
      paginationUrls: outcome.paginationUrls,
      policy: outcome.policy,
      warnings: outcome.warnings,
      templateFit: outcome.templateFit,
      artifactFolder: outcome.artifactFolder,
    };
  }

  return {
    ok: true,
    kind: "item",
    url: outcome.target,
    finalUrl: outcome.finalUrl,
    urlPattern: outcome.urlPattern,
    path: outcome.path,
    llmUsed: outcome.llmUsed,
    provider: outcome.provider,
    data: outcome.result.payload,
    fields: Object.fromEntries(
      Object.entries(outcome.result.fieldResults).map(([name, field]) => [
        name,
        {
          type: field.type,
          found: field.selectorUsed !== null,
          value: field.normalizedValue,
          selector: field.selectorUsed
            ? { kind: field.selectorUsed.kind, selector: field.selectorUsed.selector, attribute: field.selectorUsed.attribute }
            : null,
        },
      ]),
    ),
    policy: outcome.policy,
    warnings: outcome.warnings,
    missing: outcome.missing,
    stale: outcome.stale,
    templateFit: outcome.templateFit,
    artifactFolder: outcome.artifactFolder,
  };
}

export function parseSiteCrawlLimits(input: Pick<HeadlessCrawlInput, "maxPages" | "maxItems" | "delayMs">): SiteCrawlLimits {
  const limit = (name: string, value: number | undefined, fallback: number, min: number) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < min) throw new UsageError(`--${name} must be a whole number of ${min} or more.`);
    return value;
  };
  return {
    maxPages: limit("max-pages", input.maxPages, DEFAULT_SITE_CRAWL_LIMITS.maxPages, 1),
    maxItems: limit("max-items", input.maxItems, DEFAULT_SITE_CRAWL_LIMITS.maxItems, 1),
    delayMs: limit("delay-ms", input.delayMs, DEFAULT_SITE_CRAWL_LIMITS.delayMs, 0),
  };
}

function isMissingBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist|playwright install|browserType\.launch/i.test(message);
}

export function describeRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/Host system is missing dependencies/i.test(message)) {
    return "Chromium cannot start because system libraries are missing. Run `npx playwright install --with-deps --only-shell chromium` and try again.";
  }
  if (isMissingExecutableError(error)) {
    return "Chromium for Playwright is not installed. Run `npx playwright install --only-shell chromium` and try again.";
  }

  return message;
}

export async function runHeadlessCrawl(
  input: HeadlessCrawlInput,
  deps: HeadlessDependencies = defaultHeadlessDependencies,
): Promise<number> {
  const log = (message: string) => deps.stderr.write(`${message}\n`);
  const fail = (exitCode: number, code: string, message: string, extra: Record<string, unknown> = {}) => {
    log(`error: ${message}`);
    deps.stdout.write(`${JSON.stringify({ ok: false, url: input.target, code, message, ...extra }, null, 2)}\n`);
    return exitCode;
  };

  try {
    const target = normalizeTarget(input.target);
    const fields = input.fields === undefined ? null : parseFieldsOption(input.fields);
    if (input.maxRepairs !== undefined && (!Number.isInteger(input.maxRepairs) || input.maxRepairs < 0)) {
      throw new UsageError("--max-repairs must be a whole number of 0 or more.");
    }

    const require = input.require === undefined ? undefined : parseRequireOption(input.require, fields);
    const limits = parseSiteCrawlLimits(input);
    const userAgent = await deps.resolveUserAgent(input.userAgent);

    let resolved: ResolvedProvider | null = null;
    const runner = deps.createRunner({
      provider: () => {
        if (!resolved) {
          resolved = deps.resolveProvider({ provider: input.provider, model: input.model });
          log(`Using ${resolved.name}${resolved.model ? ` (${resolved.model})` : ""} to write the template.`);
        }
        return resolved.create();
      },
      // Read by startCrawl only after it has asked for the provider.
      get model() {
        return resolved?.model ?? null;
      },
      maxRepairs: input.maxRepairs,
      userAgent,
      robots: input.ignoreRobots ? null : deps.createRobotsChecker(userAgent),
      authoring: input.author !== false,
      writeArtifacts: input.artifacts !== false,
      dataDir: input.dataDir,
      onProgress: log,
    });

    try {
      const outcome = await runner.startCrawl({ target, schema: fields ?? {}, require });

      for (const warning of outcome.warnings) {
        log(`warning: ${warning}`);
      }

      if (outcome.kind === "item" || input.follow === false) {
        deps.stdout.write(`${JSON.stringify(formatOutcome(outcome), null, 2)}\n`);
        return EXIT_OK;
      }

      log(`${target} is a listing page: extracting its items and following its pagination.`);
      const summary = await crawlSite({
        start: outcome,
        schema: fields ?? {},
        require,
        limits,
        runner,
        isFatal: isMissingBrowserError,
        onEvent: event => {
          if (event.kind === "listing-failed") {
            log(`warning: skipped the listing page ${event.url}: ${event.error.message}`);
            return;
          }
          if (event.kind === "item") {
            for (const warning of event.outcome.warnings) log(`warning: ${warning}`);
          } else {
            log(`error: ${event.error.message}`);
          }
          const line = event.kind === "item"
            ? formatOutcome(event.outcome)
            : { ok: false, url: event.url, code: event.error.code, message: event.error.message, ...event.error.details };
          deps.stdout.write(`${JSON.stringify(line)}\n`);
        },
      });
      log(`Crawled ${summary.listingPages} listing page(s): ${summary.extracted} item(s) extracted, ${summary.failed} failed.`);
      return summary.extracted > 0 ? EXIT_OK : EXIT_RUNTIME;
    } finally {
      await runner.close?.();
    }
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof ConfigError ||
      (error instanceof ProviderSelectionError && error.usageError)
    ) {
      return fail(EXIT_USAGE, "INVALID_ARGUMENTS", error.message);
    }

    if (error instanceof CrawlFailure) {
      return fail(exitCodeFor(error), error.code, error.message, failureDetails(error));
    }

    return fail(EXIT_RUNTIME, "RUNTIME_ERROR", describeRuntimeError(error));
  }
}
