import { chromium, type Browser, type Page } from "playwright";
import { extractMetadata } from "./extraction/metadata";
import { extractJsonLd } from "./extraction/jsonld";
import { extractDomBlocks } from "./extraction/dom";
import { extractLinks } from "./extraction/links";
import { dismissCookieBanner } from "./dismissCookieBanner";
import { extractImages } from "./extraction/images";
import { extractTables } from "./extraction/tables";
import type { PagePacket } from "./types";
import { installPageContextHelpers } from "./pageContext/runtime.ts";

export type CrawlerDependencies = {
  now(): Date;
  launchBrowser(): Promise<Browser>;
  installPageContextHelpers(page: Page): Promise<void>;
  dismissCookieBanner(page: Page): Promise<unknown>;
  extractMetadata(page: Page): Promise<PagePacket["metadata"]>;
  extractJsonLd(page: Page): Promise<PagePacket["jsonLd"]>;
  extractDomBlocks(
    page: Page,
    options: { maxBlocks: number },
  ): Promise<PagePacket["visibleBlocks"]>;
  extractLinks(page: Page): Promise<PagePacket["links"]>;
  extractImages(page: Page): Promise<PagePacket["images"]>;
  extractTables(page: Page): Promise<PagePacket["tables"]>;
};

export type RenderedPageContext = {
  page: Page;
  pagePacket: PagePacket;
};

const defaultCrawlerDependencies: CrawlerDependencies = {
  now: () => new Date(),
  launchBrowser: () => chromium.launch({ headless: true }),
  installPageContextHelpers,
  dismissCookieBanner,
  extractMetadata,
  extractJsonLd,
  extractDomBlocks,
  extractLinks,
  extractImages,
  extractTables,
};

export async function fetchRenderedPage(
  url: string,
  deps: CrawlerDependencies = defaultCrawlerDependencies,
): Promise<PagePacket> {
  return withRenderedPage(url, ({ pagePacket }) => pagePacket, deps);
}

export async function withRenderedPage<T>(
  url: string,
  handler: (context: RenderedPageContext) => Promise<T> | T,
  deps: CrawlerDependencies = defaultCrawlerDependencies,
): Promise<T> {
  const timeoutMs = 30_000;
  const maxVisibleBlocks = 250;
  const browser = await deps.launchBrowser();

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1200 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    });

    await deps.installPageContextHelpers(page);

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    await page
      .waitForLoadState("networkidle", {
        timeout: 10000,
      })
      .catch(() => {
        // Many sites never become fully idle. That's fine.
      });

    await deps.dismissCookieBanner(page);

    const finalUrl = page.url();
    const html = await page.content();
    const title = await page.title();
    const bodyText = await page.locator("body").innerText().catch(() => "");

    const metadata = await deps.extractMetadata(page);
    const jsonLd = await deps.extractJsonLd(page);
    const visibleBlocks = await deps.extractDomBlocks(page, {
      maxBlocks: maxVisibleBlocks,
    });
    const links = await deps.extractLinks(page);
    const images = await deps.extractImages(page);
    const tables = await deps.extractTables(page);

    await page.screenshot({
      fullPage: true,
      type: "png",
    });

    const pagePacket: PagePacket = {
      url,
      finalUrl,
      title,
      metadata,
      jsonLd,
      visibleBlocks,
      links,
      images,
      tables,
      fetchedAt: deps.now().toISOString(),
      stats: {
        rawHtmlLength: html.length,
        bodyTextLength: bodyText.length,
        visibleBlockCount: visibleBlocks.length,
        jsonLdCount: jsonLd.length,
        tableCount: tables.length,
        imageCount: images.length,
        linkCount: links.length,
      },
    };

    return await handler({
      page,
      pagePacket,
    });
  } finally {
    await browser.close();
  }
}
