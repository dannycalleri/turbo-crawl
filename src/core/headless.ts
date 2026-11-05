import { createCrawlRunner, type CrawlOptions, type CrawlOutcome, type CrawlRunner } from "./crawl-run.ts";
import { FIELD_TYPES, type FieldType, type UserSchema } from "./llm-extractor/types.ts";
import {
  ProviderSelectionError,
  resolveProvider,
  type ResolvedProvider,
} from "./llm-extractor/providers/resolveProvider.ts";
import { discoverTemplateReuse, type ReuseDiscoveryOptions } from "./reuse-discovery.ts";
import { ConfigError, resolveUserAgent } from "./config.ts";
import { CrawlFailure } from "./policy/policy.ts";
import { createRobotsChecker, type RobotsChecker } from "./policy/robots.ts";

export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;
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
};

type Writer = { write(chunk: string): unknown };

export type HeadlessDependencies = {
  discover(target: string, dataDir?: string): Promise<ReuseDiscoveryOptions>;
  resolveUserAgent(option: string | undefined): Promise<string>;
  createRobotsChecker(userAgent: string): RobotsChecker;
  resolveProvider(input: { provider?: string; model?: string }): ResolvedProvider;
  createRunner(options: CrawlOptions): CrawlRunner;
  stdout: Writer;
  stderr: Writer;
};

export const defaultHeadlessDependencies: HeadlessDependencies = {
  discover: discoverTemplateReuse,
  resolveUserAgent: option => resolveUserAgent(option),
  createRobotsChecker: userAgent => createRobotsChecker({ userAgent }),
  resolveProvider,
  createRunner: options => createCrawlRunner(options),
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
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      throw new UsageError(`Unknown type "${type}" for field "${name}". Allowed types: ${FIELD_TYPES.join(", ")}.`);
    }
    if (name in schema) {
      throw new UsageError(`Field "${name}" is listed twice in --fields.`);
    }

    schema[name] = type as FieldType;
  }

  if (Object.keys(schema).length === 0) {
    throw new UsageError("--fields is empty. Use name:type pairs separated by commas, or omit it to let the agent suggest fields.");
  }

  return schema;
}

function sameFieldNames(left: UserSchema, right: UserSchema): boolean {
  const a = Object.keys(left).sort().join(",");
  const b = Object.keys(right).sort().join(",");
  return a === b;
}

export function formatOutcome(outcome: CrawlOutcome): unknown {
  return {
    ok: true,
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
    templateId: outcome.templateId,
    templatePath: outcome.templatePath,
    artifactFolder: outcome.artifactFolder,
  };
}

export function describeRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/Executable doesn't exist|playwright install|browserType\.launch/i.test(message)) {
    return "Chromium for Playwright is not installed. Run `npx playwright install chromium` and try again.";
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

    const userAgent = await deps.resolveUserAgent(input.userAgent);
    const discovery = await deps.discover(target, input.dataDir);

    if (discovery.ambiguousTemplates.length > 1) {
      const paths = discovery.ambiguousTemplates.map(candidate => candidate.path);
      return fail(
        EXIT_RUNTIME,
        "AMBIGUOUS_TEMPLATE",
        `More than one saved template matches this URL pattern; remove all but one:\n${paths.map(file => `  ${file}`).join("\n")}`,
        { templatePaths: paths },
      );
    }

    for (const warning of discovery.warnings) {
      log(`warning: ${warning.message}`);
    }

    const reusable =
      discovery.template && (fields === null || sameFieldNames(discovery.template.schema, fields))
        ? discovery.template
        : null;

    // Resolve the provider before rendering, unless a saved template makes it unnecessary.
    let resolved: ResolvedProvider | null = null;
    if (!reusable) {
      resolved = deps.resolveProvider({ provider: input.provider, model: input.model });
      log(`Using ${resolved.name}${resolved.model ? ` (${resolved.model})` : ""} to write the template.`);
    }

    const runner = deps.createRunner({
      provider: () => {
        resolved ??= deps.resolveProvider({ provider: input.provider, model: input.model });
        return resolved.create();
      },
      model: resolved?.model ?? null,
      maxRepairs: input.maxRepairs,
      userAgent,
      robots: input.ignoreRobots ? null : deps.createRobotsChecker(userAgent),
      dataDir: input.dataDir,
      onProgress: log,
    });

    const outcome = reusable
      ? await runner.startCrawl({ target, source: "template-reuse", template: reusable })
      : await runner.startCrawl({ target, source: "fields", schema: fields ?? {} });

    for (const warning of outcome.warnings) {
      log(`warning: ${warning}`);
    }

    deps.stdout.write(`${JSON.stringify(formatOutcome(outcome), null, 2)}\n`);
    return EXIT_OK;
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof ConfigError ||
      (error instanceof ProviderSelectionError && error.usageError)
    ) {
      return fail(EXIT_USAGE, "INVALID_ARGUMENTS", error.message);
    }

    if (error instanceof CrawlFailure) {
      return fail(error.code === "ROBOTS_DISALLOWED" ? EXIT_ROBOTS_DISALLOWED : EXIT_RUNTIME, error.code, error.message, {
        policy: error.policy,
        ...(error.code === "BLOCKED" ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      });
    }

    return fail(EXIT_RUNTIME, "RUNTIME_ERROR", describeRuntimeError(error));
  }
}
