import { createCrawlRunner } from "./crawl-run.ts";
import { resolveProvider } from "./llm-extractor/providers/resolveProvider.ts";
import { discoverTemplateReuse } from "./reuse-discovery.ts";
import { createInitialSessionState } from "./session-state.ts";

export type InteractiveSessionInput = {
  target: string;
  mode?: "interactive";
  provider?: string;
  model?: string;
  dataDir?: string;
  maxRepairs?: number;
};

export function isBunRuntime(): boolean {
  return typeof process.versions.bun === "string";
}

export async function startInteractiveSession(input: InteractiveSessionInput): Promise<void> {
  if (!isBunRuntime()) {
    throw new Error("The interactive TUI needs Bun. Run `bunx @fragmentoid/turbo-crawl crawl <url> --tui`, or drop --tui to run headless.");
  }

  // Loaded lazily: OpenTUI depends on bun:ffi and must never load under Node.
  const { startCrawlerTui } = await import("../ui/bootstrap.tsx");
  const resolved = (() => {
    try {
      return resolveProvider({ provider: input.provider, model: input.model });
    } catch {
      return null;
    }
  })();

  await startCrawlerTui(
    createInitialSessionState({ target: input.target, mode: input.mode }),
    createCrawlRunner({
      provider: () => (resolved ?? resolveProvider({ provider: input.provider, model: input.model })).create(),
      model: resolved?.model ?? null,
      maxRepairs: input.maxRepairs,
      dataDir: input.dataDir,
    }),
    {
      providerLabel: resolved ? `${resolved.name}${resolved.model ? ` · ${resolved.model}` : ""}` : "no agent found",
      templateReuseDiscovery: target => discoverTemplateReuse(target, input.dataDir),
    },
  );
}
