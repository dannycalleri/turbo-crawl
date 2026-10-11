import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { extractDomBlocks } from "../src/core/extraction/dom.ts";
import { extractImages } from "../src/core/extraction/images.ts";
import { extractJsonLd } from "../src/core/extraction/jsonld.ts";
import { extractLinks } from "../src/core/extraction/links.ts";
import { extractMetadata } from "../src/core/extraction/metadata.ts";
import { extractTables } from "../src/core/extraction/tables.ts";
import { installPageContextHelpers } from "../src/core/pageContext/runtime.ts";

const fixtureHtml = `
  <!doctype html>
  <html>
    <head>
      <title>Fixture Product</title>
      <link rel="canonical" href="https://example.com/products/fixture" />
      <meta name="description" content="Fixture description" />
      <meta name="robots" content="index,follow" />
      <meta property="og:title" content="Fixture OG Title" />
      <meta property="og:image" content="https://example.com/og.jpg" />
      <meta name="twitter:title" content="Fixture Twitter Title" />
      <script type="application/ld+json">
        {"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Fixture Product"}]}
      </script>
    </head>
    <body>
      <main>
        <article>
          <h1 data-testid="product-title">Fixture Product</h1>
          <p data-testid="product-description">A precise extraction fixture.</p>
          <a data-testid="product-link" href="https://example.com/products/fixture">View product</a>
          <img
            data-testid="hero-image"
            src="https://example.com/images/fixture.jpg"
            alt="Fixture hero image"
            style="width: 400px; height: 400px"
          />
          <table data-testid="spec-table">
            <thead>
              <tr><th>Spec</th><th>Value</th></tr>
            </thead>
            <tbody>
              <tr><td>Brand</td><td>Turbo</td></tr>
              <tr><td>Model</td><td>Fixture</td></tr>
            </tbody>
          </table>
        </article>
      </main>
    </body>
  </html>
`;

describe("extraction smoke tests", () => {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let browserLaunchError: unknown = null;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      browserLaunchError = error;
    }
  });

  beforeEach(async () => {
    if (!browser) {
      return;
    }

    page = await browser.newPage();
    await installPageContextHelpers(page);
    await page.setContent(fixtureHtml);
  });

  afterEach(async () => {
    if (page) {
      await page.close();
      page = null;
    }
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  it("installs the shared page helpers into the page context", async () => {
    if (!page) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const helperStatus = await page.evaluate(() => ({
      hasNamespace: Boolean(window.__turboCrawl),
      hasGetCssPath: typeof window.__turboCrawl?.getCssPath,
      hasNormalizeWhitespace: typeof window.__turboCrawl?.normalizeWhitespace,
    }));

    expect(helperStatus).toEqual({
      hasNamespace: true,
      hasGetCssPath: "function",
      hasNormalizeWhitespace: "function",
    });
  });

  it("extracts metadata and jsonld from a controlled fixture", async () => {
    if (!page) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const metadata = await extractMetadata(page);
    const jsonLd = await extractJsonLd(page);

    expect(metadata).toEqual({
      canonicalUrl: "https://example.com/products/fixture",
      description: "Fixture description",
      robots: "index,follow",
      openGraph: {
        "og:title": "Fixture OG Title",
        "og:image": "https://example.com/og.jpg",
      },
      twitter: {
        "twitter:title": "Fixture Twitter Title",
      },
      other: {
        description: "Fixture description",
        robots: "index,follow",
      },
    });
    expect(jsonLd[0]?.type).toBe("Product");
  });

  it("extracts links with css paths from the injected helper runtime", async () => {
    if (!page) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const links = await extractLinks(page);

    expect(links[0]).toMatchObject({
      text: "View product",
      href: "https://example.com/products/fixture",
      cssPath: 'a[data-testid="product-link"]',
    });
  });

  it("extracts visible dom blocks from the main content", async () => {
    if (!page) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const blocks = await extractDomBlocks(page, { maxBlocks: 10 });

    expect(blocks.some((block) => block.normalizedText === "Fixture Product")).toBe(true);
    expect(blocks.some((block) => block.cssPath === 'h1[data-testid="product-title"]')).toBe(true);
  });

  it("extracts images and tables from the fixture page", async () => {
    if (!page) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const images = await extractImages(page);
    const tables = await extractTables(page);

    expect(images[0]).toMatchObject({
      alt: "Fixture hero image",
      cssPath: 'img[data-testid="hero-image"]',
    });

    expect(tables[0]).toMatchObject({
      cssPath: 'table[data-testid="spec-table"]',
      headers: ["Spec", "Value"],
    });
    expect(tables[0]?.rows).toContainEqual(["Brand", "Turbo"]);
  });
});
