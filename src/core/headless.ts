import { createCrawlRunner, type CrawlOptions, type CrawlOutcome, type CrawlRunner } from "./crawl-run.ts";
import type { FieldType, UserSchema } from "./llm-extractor/types.ts";
import {
  ProviderSelectionError,
  resolveProvider,
  type ResolvedProvider,
} from "./llm-extractor/providers/resolveProvider.ts";
import { discoverTemplateReuse, type ReuseDiscoveryOptions } from "./reuse-discovery.ts";
import { PROPERTY_TYPES } from "./session-state.ts";

export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

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
};

type Writer = { write(chunk: string): unknown };

export type HeadlessDependencies = {
  discover(target: string, dataDir?: string): Promise<ReuseDiscoveryOptions>;
  resolveProvider(input: { provider?: string; model?: string }): ResolvedProvider;
  createRunner(options: CrawlOptions): CrawlRunner;
  stdout: Writer;
  stderr: Writer;
  now(): Date;
};

export const defaultHeadlessDependencies: HeadlessDependencies = {
  discover: discoverTemplateReuse,
  resolveProvider,
  createRunner: options => createCrawlRunner(options),
  stdout: process.stdout,
  stderr: process.stderr,
  now: () => new Date(),
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
    if (!(PROPERTY_TYPES as readonly string[]).includes(type)) {
      throw new UsageError(`Unknown type "${type}" for field "${name}". Allowed types: ${PROPERTY_TYPES.join(", ")}.`);
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

  try {
    const target = normalizeTarget(input.target);
    const fields = input.fields === undefined ? null : parseFieldsOption(input.fields);
    if (input.maxRepairs !== undefined && (!Number.isInteger(input.maxRepairs) || input.maxRepairs < 0)) {
      throw new UsageError("--max-repairs must be a whole number of 0 or more.");
    }

    const discovery = await deps.discover(target, input.dataDir);

    if (discovery.ambiguousTemplates.length > 1) {
      log(`More than one saved template matches this URL pattern; remove all but one:\n${discovery.ambiguousTemplates
        .map(candidate => `  ${candidate.path}`)
        .join("\n")}`);
      return EXIT_RUNTIME;
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
      dataDir: input.dataDir,
      onProgress: log,
    });

    const startedAt = deps.now().toISOString();
    const outcome = reusable
      ? await runner.startCrawl({
          target,
          schema: Object.entries(reusable.schema).map(([name, type]) => ({ name, type })),
          mode: "interactive",
          source: "template-reuse",
          template: reusable,
          startedAt,
        })
      : await runner.startCrawl({
          target,
          schema: Object.entries(fields ?? {}).map(([name, type]) => ({ name, type })),
          mode: "interactive",
          source: "schema-builder",
          startedAt,
        });

    for (const warning of outcome.warnings) {
      log(`warning: ${warning}`);
    }

    deps.stdout.write(`${JSON.stringify(formatOutcome(outcome), null, 2)}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError || (error instanceof ProviderSelectionError && error.usageError)) {
      log(`error: ${error.message}`);
      return EXIT_USAGE;
    }

    log(`error: ${describeRuntimeError(error)}`);
    return EXIT_RUNTIME;
  }
}
