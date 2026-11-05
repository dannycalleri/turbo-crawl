import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { extractWithTemplate } from "../src/core/template-extractor/extractWithTemplate.ts";
import type { ExtractionTemplate, FieldTemplate, SelectorCandidate } from "../src/core/templating/types.ts";
import type { PagePacket } from "../src/core/types.ts";

type FakeNode = {
  textContent?: string | null;
  attributes?: Record<string, string | null>;
  properties?: Record<string, string | null>;
};

const fixtureHtml = `
  <!doctype html>
  <html>
    <head>
      <title>Template Fixture</title>
      <meta name="description" content="Template fixture description" />
    </head>
    <body>
      <main>
        <h1 data-testid="product-title">Black Bay 58</h1>
        <span class="price">$3,750.00</span>
      </main>
    </body>
  </html>
`;

function createFakePage(nodesBySelector: Record<string, FakeNode[]>): Page {
  return {
    locator(selector: string) {
      const nodes = nodesBySelector[selector] ?? [];

      function locatorFor(node: FakeNode | undefined) {
        return {
          async count() {
            return nodes.length;
          },
          first() {
            return locatorFor(nodes[0]);
          },
          async textContent() {
            return node?.textContent ?? null;
          },
          async getAttribute(name: string) {
            return node?.attributes?.[name] ?? null;
          },
          async evaluate(_fn: unknown, attribute: string) {
            return node?.properties?.[attribute] ?? node?.attributes?.[attribute] ?? null;
          },
        };
      }

      return locatorFor(nodes[0]);
    },
  } as unknown as Page;
}

function createPagePacket(overrides: Partial<PagePacket> = {}): PagePacket {
  return {
    url: "https://example.com/products/source",
    finalUrl: "https://example.com/products/black-bay-58",
    fetchedAt: "2026-04-30T10:00:00.000Z",
    title: "Template fixture",
    metadata: {
      canonicalUrl: "https://example.com/products/black-bay-58",
      description: "Template fixture description",
      robots: "index,follow",
      openGraph: {},
      twitter: {},
      other: {},
    },
    jsonLd: [
      {
        nodeId: "jsonld_001_1",
        type: "Product",
        raw: "{}",
        data: {
          brand: { name: "Tudor" },
        },
      },
    ],
    visibleBlocks: [],
    links: [],
    images: [],
    tables: [],
    stats: {
      rawHtmlLength: 10,
      bodyTextLength: 10,
      visibleBlockCount: 0,
      jsonLdCount: 1,
      linkCount: 0,
      imageCount: 0,
      tableCount: 0,
    },
    ...overrides,
  };
}

function selector(overrides: Partial<SelectorCandidate>): SelectorCandidate {
  return {
    kind: "css",
    selector: ".value",
    attribute: "textContent",
    score: 90,
    reusable: true,
    ...overrides,
  };
}

function field(overrides: Partial<FieldTemplate>): FieldTemplate {
  return {
    fieldName: "title",
    type: "string",
    sourceNodeId: null,
    rawValue: null,
    normalizedValue: null,
    selectors: [selector({ selector: ".title" })],
    validation: {
      expectedType: "string",
      valueShape: "text",
    },
    ...overrides,
  };
}

function template(overrides: Partial<ExtractionTemplate>): ExtractionTemplate {
  return {
    id: "template_fixture",
    domain: "example.com",
    urlPattern: "/products/:slug",
    schema: {
      title: "string",
    },
    createdFromUrl: "https://example.com/products/source",
    createdAt: "2026-04-30T10:00:00.000Z",
    fields: {
      title: field({ fieldName: "title", type: "string" }),
    },
    ...overrides,
  };
}

describe("extractWithTemplate", () => {
  it("builds payload, field results, aggregate confidence, and warnings", async () => {
    const result = await extractWithTemplate({
      page: createFakePage({
        ".title": [{ textContent: "Black Bay 58" }],
        ".price": [{ textContent: "not a number" }],
      }),
      pagePacket: createPagePacket(),
      template: template({
        fields: {
          title: field({
            fieldName: "title",
            type: "string",
            selectors: [selector({ selector: ".title", score: 90 })],
          }),
          price: field({
            fieldName: "price",
            type: "number",
            selectors: [selector({ selector: ".price", score: 80 })],
            validation: {
              expectedType: "number",
              valueShape: "number",
            },
          }),
        },
      }),
    });

    expect(result).toMatchObject({
      payload: {
        title: "Black Bay 58",
        price: null,
      },
      confidence: 45,
      templateId: "template_fixture",
      usedTemplate: true,
      llmUsed: false,
      warnings: ["price: Selector did not produce a valid number value."],
    });
    expect(result.fieldResults.title?.selectorUsed?.selector).toBe(".title");
    expect(result.fieldResults.price?.selectorUsed).toBeNull();
  });

  it("returns an empty result with a warning when the template has no fields", async () => {
    await expect(
      extractWithTemplate({
        page: createFakePage({}),
        pagePacket: createPagePacket(),
        template: template({
          fields: {},
          schema: {},
        }),
      }),
    ).resolves.toEqual({
      payload: {},
      fieldResults: {},
      confidence: 0,
      templateId: "template_fixture",
      usedTemplate: true,
      llmUsed: false,
      warnings: ["Template has no fields: template_fixture"],
    });
  });
});

describe("extractWithTemplate Playwright integration", () => {
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

  it("extracts CSS, XPath, JSON-LD, and metadata fields without the LLM", async () => {
    if (!page) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const extraction = await extractWithTemplate({
      page,
      pagePacket: createPagePacket(),
      template: template({
        schema: {
          title: "string",
          price: "number",
          brand: "string",
          description: "text",
        },
        fields: {
          title: field({
            fieldName: "title",
            type: "string",
            selectors: [
              selector({
                kind: "css",
                selector: "[data-testid='product-title']",
                attribute: "textContent",
                score: 92,
              }),
            ],
          }),
          price: field({
            fieldName: "price",
            type: "number",
            selectors: [
              selector({
                kind: "xpath",
                selector: "//span[@class='price']",
                attribute: "textContent",
                score: 70,
              }),
            ],
            validation: {
              expectedType: "number",
              valueShape: "number",
            },
          }),
          brand: field({
            fieldName: "brand",
            type: "string",
            selectors: [
              selector({
                kind: "jsonld",
                selector: "jsonld_001_1:$.brand.name",
                attribute: "json",
                score: 95,
              }),
            ],
          }),
          description: field({
            fieldName: "description",
            type: "text",
            selectors: [
              selector({
                kind: "meta",
                selector: "meta[name='description']@content",
                attribute: "content",
                score: 85,
              }),
            ],
            validation: {
              expectedType: "text",
              valueShape: "text",
            },
          }),
        },
      }),
    });

    expect(extraction.payload).toEqual({
      title: "Black Bay 58",
      price: 3750,
      brand: "Tudor",
      description: "Template fixture description",
    });
    expect(extraction.confidence).toBe(85.5);
    expect(extraction.usedTemplate).toBe(true);
    expect(extraction.llmUsed).toBe(false);
    expect(extraction.warnings).toEqual([]);
  });
});
