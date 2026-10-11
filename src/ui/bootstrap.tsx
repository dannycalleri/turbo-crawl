import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { CrawlRunner } from "../core/crawl-run.ts";
import type { TemplateReuseDiscovery } from "../core/reuse-discovery.ts";
import type { SessionState } from "../core/session-state.ts";
import { App } from "./App.tsx";

export async function startCrawlerTui(
  initialState: SessionState,
  crawlRunner: CrawlRunner,
  options: { providerLabel?: string; templateReuseDiscovery?: TemplateReuseDiscovery } = {},
): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  createRoot(renderer).render(<App
      initialState={initialState}
      crawlRunner={crawlRunner}
      providerLabel={options.providerLabel}
      templateReuseDiscovery={options.templateReuseDiscovery}
    />);
}
