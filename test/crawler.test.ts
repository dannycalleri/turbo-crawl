import { describe, expect, it } from "bun:test";
import type { Browser, Page } from "playwright";
import {
  fetchRenderedPage,
  withRenderedPage,
  type CrawlerDependencies,
} from "../src/core/crawler.ts";

function createCrawlerFixture() {
  const calls: string[] = [];

  const page = {
    async goto(target: string) {
      calls.push(`goto:${target}`);
    },
    async waitForLoadState(state: string) {
      calls.push(`wait:${state}`);
    },
    async content() {
      return "<html><body>Hello world</body></html>";
    },
    async title() {
      return "Fixture Title";
    },
    locator(selector: string) {
      expect(selector).toBe("body");
      return {
        async innerText() {
          return "Hello world";
        },
      };
    },
    url() {
      return "https://example.com/final";
    },
    async screenshot() {
      calls.push("screenshot");
      return new Uint8Array([1, 2, 3]);
    },
  } as unknown as Page;

  const browser = {
    async newPage() {
      calls.push("newPage");
      return page;
    },
    async close() {
      calls.push("close");
    },
  } as unknown as Browser;

  const deps: CrawlerDependencies = {
    now: () => new Date("2026-04-26T10:00:00.000Z"),
    async launchBrowser() {
      calls.push("launchBrowser");
      return browser;
    },
    async installPageContextHelpers() {
      calls.push("installHelpers");
    },
    async dismissCookieBanner() {
      calls.push("dismissCookieBanner");
    },
    async extractMetadata() {
      calls.push("extractMetadata");
      return {
        canonicalUrl: "https://example.com/final",
        description: "Fixture description",
        robots: "index,follow",
        openGraph: {},
        twitter: {},
        other: {},
      };
    },
    async extractJsonLd() {
      calls.push("extractJsonLd");
      return [{ nodeId: "jsonld_001", type: "Product", data: {}, raw: "{}" }];
    },
    async extractDomBlocks() {
      calls.push("extractDomBlocks");
      return [
        {
          nodeId: "dom_001",
          tag: "p",
          text: "Hello world",
          normalizedText: "Hello world",
          cssPath: "main > p",
          xpath: "/html/body/main/p[1]",
          attributes: {},
          role: null,
          ariaLabel: null,
          href: null,
          src: null,
          boundingBox: null,
          isVisible: true,
          isInMainContent: true,
          isLikelyNoise: false,
          score: 0.7,
        },
      ];
    },
    async extractLinks() {
      calls.push("extractLinks");
      return [
        {
          nodeId: "link_001",
          text: "Read more",
          href: "https://example.com/read-more",
          cssPath: 'a[data-testid="read-more"]',
          score: 0.5,
        },
      ];
    },
    async extractImages() {
      calls.push("extractImages");
      return [
        {
          nodeId: "img_001",
          src: "https://example.com/image.jpg",
          alt: "Example image",
          width: 400,
          height: 400,
          cssPath: 'img[data-testid="hero-image"]',
          score: 0.5,
        },
      ];
    },
    async extractTables() {
      calls.push("extractTables");
      return [
        {
          nodeId: "table_001",
          cssPath: "table.specs",
          headers: ["Label", "Value"],
          rows: [["Brand", "Turbo"]],
          score: 0.6,
        },
      ];
    },
  };

  return {
    calls,
    page,
    deps,
  };
}

describe("fetchRenderedPage", () => {
  it("orchestrates helper injection, extraction, and stats calculation", async () => {
    const { calls, deps } = createCrawlerFixture();

    const packet = await fetchRenderedPage("https://example.com/start", deps);

    expect(packet).toMatchObject({
      url: "https://example.com/start",
      finalUrl: "https://example.com/final",
      fetchedAt: "2026-04-26T10:00:00.000Z",
      title: "Fixture Title",
      stats: {
        rawHtmlLength: 37,
        bodyTextLength: 11,
        visibleBlockCount: 1,
        jsonLdCount: 1,
        tableCount: 1,
        imageCount: 1,
        linkCount: 1,
      },
    });

    expect(calls).toEqual([
      "launchBrowser",
      "newPage",
      "installHelpers",
      "goto:https://example.com/start",
      "wait:networkidle",
      "dismissCookieBanner",
      "extractMetadata",
      "extractJsonLd",
      "extractDomBlocks",
      "extractLinks",
      "extractImages",
      "extractTables",
      "screenshot",
      "close",
    ]);
  });
});

describe("withRenderedPage", () => {
  it("passes the live page and rendered packet to the handler before closing the browser", async () => {
    const { calls, page, deps } = createCrawlerFixture();

    const result = await withRenderedPage(
      "https://example.com/start",
      (context) => {
        calls.push("handler");
        expect(context.page).toBe(page);
        expect(context.pagePacket.finalUrl).toBe("https://example.com/final");

        return {
          title: context.pagePacket.title,
          closeHasNotRunYet: !calls.includes("close"),
        };
      },
      deps,
    );

    expect(result).toEqual({
      title: "Fixture Title",
      closeHasNotRunYet: true,
    });
    expect(calls.at(-2)).toBe("handler");
    expect(calls.at(-1)).toBe("close");
  });

  it("closes the browser when the handler throws", async () => {
    const { calls, deps } = createCrawlerFixture();

    await expect(
      withRenderedPage(
        "https://example.com/start",
        () => {
          calls.push("handler");
          throw new Error("handler failed");
        },
        deps,
      ),
    ).rejects.toThrow("handler failed");

    expect(calls.at(-2)).toBe("handler");
    expect(calls.at(-1)).toBe("close");
  });
});
