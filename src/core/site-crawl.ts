import type { CrawlOutcome, CrawlRunner, CrawlStartInput, ItemOutcome, ListingOutcome } from "./crawl-run.ts";
import type { UserSchema } from "./llm-extractor/types.ts";
import { CrawlFailure, failureDetails } from "./policy/policy.ts";

export type SiteCrawlLimits = {
  maxPages: number;
  maxItems: number;
  delayMs: number;
};

export const DEFAULT_SITE_CRAWL_LIMITS: SiteCrawlLimits = { maxPages: 10, maxItems: 200, delayMs: 250 };

export type CrawlError = {
  code: string;
  message: string;
  details: Record<string, unknown>;
};

export type SiteCrawlEvent =
  | { kind: "item"; outcome: ItemOutcome }
  | { kind: "item-failed"; url: string; error: CrawlError }
  | { kind: "listing-failed"; url: string; error: CrawlError };

export type SiteCrawlSummary = {
  listingPages: number;
  extracted: number;
  failed: number;
};

export type SiteCrawlInput = {
  start: ListingOutcome;
  schema: UserSchema;
  require?: string[];
  limits: SiteCrawlLimits;
  runner: CrawlRunner;
  onEvent(event: SiteCrawlEvent): void;
  /** Errors that stop the whole crawl, such as a browser that cannot start. Others fail one page. */
  isFatal?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

export async function crawlSite(input: SiteCrawlInput): Promise<SiteCrawlSummary> {
  const { limits, runner } = input;
  const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const isFatal = input.isFatal ?? (() => false);
  const host = new URL(input.start.finalUrl).host;
  const visited = new Set([normalizeCrawlUrl(input.start.target), normalizeCrawlUrl(input.start.finalUrl)]);
  const visit = (url: string) => {
    const key = normalizeCrawlUrl(url);
    if (new URL(url).host !== host || visited.has(key)) return false;
    visited.add(key);
    return true;
  };
  const toCrawlError = (error: unknown): CrawlError => {
    if (isFatal(error)) throw error;
    if (error instanceof CrawlFailure) return { code: error.code, message: error.message, details: failureDetails(error) };
    return { code: "RUNTIME_ERROR", message: error instanceof Error ? error.message : String(error), details: {} };
  };

  let schema = input.schema;
  const summary: SiteCrawlSummary = { listingPages: 1, extracted: 0, failed: 0 };
  const itemLimitReached = () => summary.extracted + summary.failed >= limits.maxItems;
  const pending: ListingOutcome[] = [input.start];
  const pagesToRead: Array<{ url: string; listingTemplatePath: string }> = [];

  const render = async (start: Omit<CrawlStartInput, "require">): Promise<CrawlOutcome> => {
    if (limits.delayMs > 0) await sleep(limits.delayMs);
    return runner.startCrawl({ ...start, require: input.require });
  };

  while (pending.length > 0) {
    const listing = pending.shift()!;

    for (const item of listing.items) {
      if (itemLimitReached()) return summary;
      if (!visit(item.url)) continue;

      try {
        const outcome = await render({ target: item.url, schema, expect: "detail" });
        if (outcome.kind !== "item") continue;
        if (Object.keys(schema).length === 0) schema = outcome.schema;
        summary.extracted += 1;
        input.onEvent({ kind: "item", outcome });
      } catch (error) {
        summary.failed += 1;
        input.onEvent({ kind: "item-failed", url: item.url, error: toCrawlError(error) });
      }
    }

    const listingTemplatePath = listing.templateFit.templatePath;
    pagesToRead.push(...listing.paginationUrls.filter(visit).map(url => ({ url, listingTemplatePath })));
    while (pending.length === 0 && pagesToRead.length > 0 && summary.listingPages < limits.maxPages && !itemLimitReached()) {
      const page = pagesToRead.shift()!;
      try {
        const next = await render({ target: page.url, schema: {}, expect: "listing", listingTemplatePath: page.listingTemplatePath });
        if (next.kind !== "listing") continue;
        summary.listingPages += 1;
        pending.push(next);
      } catch (error) {
        input.onEvent({ kind: "listing-failed", url: page.url, error: toCrawlError(error) });
      }
    }
  }

  return summary;
}

export function normalizeCrawlUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (name.toLowerCase().startsWith("utm_")) url.searchParams.delete(name);
  }
  return url.toString();
}
