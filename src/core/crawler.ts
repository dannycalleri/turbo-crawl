import type { Browser, BrowserContext, Page, Response } from "playwright";
import { launchChromium } from "./browserInstall.ts";
import { extractMetadata } from "./extraction/metadata";
import { extractJsonLd } from "./extraction/jsonld";
import { extractDomBlocks } from "./extraction/dom";
import { extractLinks } from "./extraction/links";
import { dismissCookieBanner } from "./dismissCookieBanner";
import { extractImages } from "./extraction/images";
import { extractTables } from "./extraction/tables";
import type { PagePacket, PageResponse } from "./types";
import { installPageContextHelpers } from "./pageContext/runtime.ts";
import { DEFAULT_USER_AGENT } from "./config.ts";

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
  launchBrowser: () => launchChromium(),
  installPageContextHelpers,
  dismissCookieBanner,
  extractMetadata,
  extractJsonLd,
  extractDomBlocks,
  extractLinks,
  extractImages,
  extractTables,
};

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
export const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;
const MAX_VISIBLE_BLOCKS = 250;
const PAGE_VIEWPORT = { width: 1440, height: 1200 };

export type BrowserSessionOptions = {
  userAgent?: string;
  navigationTimeoutMs?: number;
  settleTimeoutMs?: number;
};

export type BrowserSession = {
  withRenderedPage<T>(
    url: string,
    handler: (context: RenderedPageContext) => Promise<T> | T,
  ): Promise<T>;
  /** Opens `html` as the page at `url`: no page scripts run and no request leaves the browser. */
  withSnapshotPage<T>(
    url: string,
    html: string,
    handler: (context: RenderedPageContext) => Promise<T> | T,
  ): Promise<T>;
  close(): Promise<void>;
};

export function createBrowserSession(
  options: BrowserSessionOptions = {},
  deps: CrawlerDependencies = defaultCrawlerDependencies,
): BrowserSession {
  let browser: Promise<Browser> | null = null;
  const launched = (): Promise<Browser> => {
    if (!browser) {
      const launching: Promise<Browser> = deps.launchBrowser().catch(error => {
        if (browser === launching) browser = null;
        throw error;
      });
      browser = launching;
    }
    return browser;
  };
  const pageOptions = {
    viewport: PAGE_VIEWPORT,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
  };

  return {
    async withRenderedPage(url, handler) {
      const page = await (await launched()).newPage(pageOptions);

      try {
        const pagePacket = await renderPage(page, url, options, deps);
        return await handler({ page, pagePacket });
      } finally {
        await page.close();
      }
    },
    async withSnapshotPage(url, html, handler) {
      // serviceWorkers: a worker's requests would bypass page.route.
      const context: BrowserContext = await (await launched()).newContext({
        ...pageOptions,
        javaScriptEnabled: false,
        serviceWorkers: "block",
      });

      try {
        const page = await context.newPage();
        const pagePacket = await openSnapshot(page, url, html, options, deps);
        return await handler({ page, pagePacket });
      } finally {
        await context.close();
      }
    },
    async close() {
      if (browser) {
        const launched = browser;
        browser = null;
        const opened = await launched.catch(() => null);
        await opened?.close();
      }
    },
  };
}

export async function fetchRenderedPage(
  url: string,
  deps: CrawlerDependencies = defaultCrawlerDependencies,
): Promise<PagePacket> {
  return withRenderedPage(url, ({ pagePacket }) => pagePacket, {}, deps);
}

export function withRenderedPage<T>(
  url: string,
  handler: (context: RenderedPageContext) => Promise<T> | T,
  options: BrowserSessionOptions = {},
  deps: CrawlerDependencies = defaultCrawlerDependencies,
): Promise<T> {
  return withOneTimeSession(options, deps, session => session.withRenderedPage(url, handler));
}

export function withSnapshotPage<T>(
  url: string,
  html: string,
  handler: (context: RenderedPageContext) => Promise<T> | T,
  options: BrowserSessionOptions = {},
  deps: CrawlerDependencies = defaultCrawlerDependencies,
): Promise<T> {
  return withOneTimeSession(options, deps, session => session.withSnapshotPage(url, html, handler));
}

async function withOneTimeSession<T>(
  options: BrowserSessionOptions,
  deps: CrawlerDependencies,
  use: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  const session = createBrowserSession(options, deps);

  try {
    return await use(session);
  } finally {
    await session.close();
  }
}

async function renderPage(
  page: Page,
  url: string,
  options: BrowserSessionOptions,
  deps: CrawlerDependencies,
): Promise<PagePacket> {
  await deps.installPageContextHelpers(page);

  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
  });

  await page
    .waitForLoadState("networkidle", {
      timeout: options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
    })
    .catch(() => {
      // Many sites never become fully idle. That's fine.
    });

  await deps.dismissCookieBanner(page);

  return capturePagePacket(page, url, response, deps);
}

async function openSnapshot(
  page: Page,
  url: string,
  html: string,
  options: BrowserSessionOptions,
  deps: CrawlerDependencies,
): Promise<PagePacket> {
  await deps.installPageContextHelpers(page);
  // Serve the first main-frame navigation, whatever URL encoding the browser used, and only once:
  // a meta refresh still runs with scripts off. "aborted" keeps the snapshot; "failed" would show an error page.
  let served = false;
  await page.route("**/*", route => {
    const request = route.request();
    if (!served && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      served = true;
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    }
    return route.abort("aborted");
  });

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
  });

  // The caller fetched the page, so the fulfilled 200 is not an HTTP status that turbo-crawl saw.
  return { ...(await capturePagePacket(page, url, null, deps)), finalUrl: url };
}

async function capturePagePacket(
  page: Page,
  url: string,
  response: Response | null,
  deps: CrawlerDependencies,
): Promise<PagePacket> {
  const finalUrl = page.url();
  const html = await page.content();
  const title = await page.title();
  const bodyText = await page.locator("body").innerText().catch(() => "");

  const metadata = await deps.extractMetadata(page);
  const jsonLd = await deps.extractJsonLd(page);
  const visibleBlocks = await deps.extractDomBlocks(page, {
    maxBlocks: MAX_VISIBLE_BLOCKS,
  });
  const links = await deps.extractLinks(page);
  const images = await deps.extractImages(page);
  const tables = await deps.extractTables(page);

  return {
    url,
    finalUrl,
    title,
    response: await describeResponse(response),
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
}

async function describeResponse(response: Response | null): Promise<PageResponse> {
  if (!response) {
    return { status: null, xRobotsTag: null, tdmReservation: null, tdmPolicy: null, retryAfter: null };
  }

  const headers = await response.allHeaders();
  return {
    status: response.status(),
    xRobotsTag: headers["x-robots-tag"] ?? null,
    tdmReservation: headers["tdm-reservation"] ?? null,
    tdmPolicy: headers["tdm-policy"] ?? null,
    retryAfter: headers["retry-after"] ?? null,
  };
}
