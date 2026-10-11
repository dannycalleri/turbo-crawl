import { describe, expect, it } from "bun:test";
import type { Page } from "playwright";
import {
  parseJsonLdSelector,
  parseTableSelector,
  readJsonLdSelector,
  readJsonPath,
  readMetaSelector,
  readSelectorValue,
  readTableSelector,
} from "../src/core/template-extractor/selectorValueReader.ts";
import type { SelectorCandidate } from "../src/core/templating/types.ts";
import type { PagePacket } from "../src/core/types.ts";

function createPagePacket(overrides: Partial<PagePacket> = {}): PagePacket {
  return {
    url: "https://example.com/products/source",
    finalUrl: "https://example.com/products/final",
    fetchedAt: "2026-04-30T10:00:00.000Z",
    title: "Fixture product",
    metadata: {
      canonicalUrl: "https://example.com/products/final",
      description: "Fixture description",
      robots: "index,follow",
      openGraph: {
        "og:title": "Open Graph title",
      },
      twitter: {
        "twitter:title": "Twitter title",
      },
      other: {
        author: "Turbo Crawl",
      },
    },
    jsonLd: [
      {
        nodeId: "jsonld_001_1",
        type: "Product",
        raw: "{}",
        data: {
          name: "Black Bay 58",
          brand: { name: "Tudor" },
          offers: [{ price: 3750, availability: true }],
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

function candidate(overrides: Partial<SelectorCandidate>): SelectorCandidate {
  return {
    kind: "css",
    selector: ".value",
    attribute: "textContent",
    score: 90,
    reusable: true,
    ...overrides,
  };
}

type FakeNode = {
  textContent?: string | null;
  attributes?: Record<string, string | null>;
  properties?: Record<string, string | null>;
};

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

describe("selector value reader", () => {
  it("parses generated JSON-LD selectors", () => {
    expect(parseJsonLdSelector("jsonld_001_1:$.offers[0].price")).toEqual({
      nodeId: "jsonld_001_1",
      path: "$.offers[0].price",
    });

    expect(parseJsonLdSelector("jsonld_001_1.offers[0].price")).toBeNull();
  });

  it("reads generated JSON paths from JSON-LD data", () => {
    const data = {
      offers: [{ price: 3750, availability: true }],
      brand: { name: "Tudor" },
    };

    expect(readJsonPath(data, "$.offers[0].price")).toBe(3750);
    expect(readJsonPath(data, "$.offers[0].availability")).toBe(true);
    expect(readJsonPath(data, "$.brand.name")).toBe("Tudor");
    expect(readJsonPath(data, "$.offers[2].price")).toBeUndefined();
  });

  it("reads JSON-LD selector values and reports missing nodes or paths", () => {
    const packet = createPagePacket();

    expect(
      readJsonLdSelector(
        packet,
        candidate({
          kind: "jsonld",
          selector: "jsonld_001_1:$.offers[0].price",
          attribute: "json",
        }),
      ),
    ).toEqual({
      rawValue: "3750",
      warnings: [],
    });

    expect(
      readJsonLdSelector(
        packet,
        candidate({
          kind: "jsonld",
          selector: "jsonld_404:$.offers[0].price",
          attribute: "json",
        }),
      ),
    ).toEqual({
      rawValue: null,
      warnings: ["JSON-LD node not found: jsonld_404"],
    });

    expect(
      readJsonLdSelector(
        packet,
        candidate({
          kind: "jsonld",
          selector: "jsonld_001_1:$.offers[9].price",
          attribute: "json",
        }),
      ),
    ).toEqual({
      rawValue: null,
      warnings: ["JSON-LD path not found: jsonld_001_1:$.offers[9].price"],
    });
  });

  it("reads metadata selectors from the PagePacket", () => {
    const packet = createPagePacket();

    expect(
      readMetaSelector(
        packet,
        candidate({
          kind: "meta",
          selector: "link[rel='canonical']@href",
          attribute: "href",
        }),
      ).rawValue,
    ).toBe("https://example.com/products/final");

    expect(
      readMetaSelector(
        packet,
        candidate({
          kind: "meta",
          selector: "meta[name='description']@content",
          attribute: "content",
        }),
      ).rawValue,
    ).toBe("Fixture description");

    expect(
      readMetaSelector(
        packet,
        candidate({
          kind: "meta",
          selector: "meta[property='og:title']@content",
          attribute: "content",
        }),
      ).rawValue,
    ).toBe("Open Graph title");

    expect(
      readMetaSelector(
        packet,
        candidate({
          kind: "meta",
          selector: "meta[name='twitter:title']@content",
          attribute: "content",
        }),
      ).rawValue,
    ).toBe("Twitter title");

    expect(
      readMetaSelector(
        packet,
        candidate({
          kind: "meta",
          selector: "@currentUrl",
          attribute: "content",
        }),
      ).rawValue,
    ).toBe("https://example.com/products/final");
  });

  it("reports unsupported metadata selectors", () => {
    expect(
      readMetaSelector(
        createPagePacket(),
        candidate({
          kind: "meta",
          selector: "meta[itemprop='price']@content",
          attribute: "content",
        }),
      ),
    ).toEqual({
      rawValue: null,
      warnings: ["Unsupported metadata selector: meta[itemprop='price']@content"],
    });
  });

  it("reads table selectors from PagePacket tables", () => {
    const packet = createPagePacket({
      tables: [
        {
          nodeId: "table_005",
          cssPath: "table:nth-of-type(1)",
          headers: [],
          rows: [
            ["Referenza", "T157.407.11.041.00"],
            ["Colore quadrante", "Blu"],
            ["Diametro", "39mm"],
          ],
          score: 0.9,
        },
      ],
      stats: {
        ...createPagePacket().stats,
        tableCount: 1,
      },
    });

    expect(parseTableSelector("label=Colore%20quadrante")).toEqual({
      mode: "label",
      nodeId: null,
      label: "Colore quadrante",
    });

    expect(
      readTableSelector(
        packet,
        candidate({
          kind: "table",
          selector: "label=Colore%20quadrante",
          attribute: "textContent",
        }),
      ),
    ).toEqual({
      rawValue: "Blu",
      warnings: [],
    });

    expect(
      readTableSelector(
        packet,
        candidate({
          kind: "table",
          selector: "table_005:cell=2,1",
          attribute: "textContent",
        }),
      ),
    ).toEqual({
      rawValue: "39mm",
      warnings: [],
    });
  });

  it("reads CSS text content and warns when a selector matches multiple elements", async () => {
    const page = createFakePage({
      ".price": [
        { textContent: "  $3,750 \n" },
        { textContent: "$4,000" },
      ],
    });

    await expect(
      readSelectorValue({
        page,
        pagePacket: createPagePacket(),
        selector: candidate({
          kind: "css",
          selector: ".price",
          attribute: "textContent",
        }),
      }),
    ).resolves.toEqual({
      rawValue: "$3,750",
      warnings: ["Selector matched 2 elements; using the first match."],
    });
  });

  it("reads href and src DOM properties before falling back to attributes", async () => {
    const page = createFakePage({
      ".product-link": [
        {
          attributes: { href: "/relative-product" },
          properties: { href: "https://example.com/relative-product" },
        },
      ],
      ".product-image": [
        {
          attributes: { src: "/image.jpg" },
          properties: { src: "https://cdn.example.com/image.jpg" },
        },
      ],
    });

    await expect(
      readSelectorValue({
        page,
        pagePacket: createPagePacket(),
        selector: candidate({
          kind: "css",
          selector: ".product-link",
          attribute: "href",
        }),
      }),
    ).resolves.toEqual({
      rawValue: "https://example.com/relative-product",
      warnings: [],
    });

    await expect(
      readSelectorValue({
        page,
        pagePacket: createPagePacket(),
        selector: candidate({
          kind: "css",
          selector: ".product-image",
          attribute: "src",
        }),
      }),
    ).resolves.toEqual({
      rawValue: "https://cdn.example.com/image.jpg",
      warnings: [],
    });
  });

  it("uses Playwright XPath locators and reads content attributes", async () => {
    const page = createFakePage({
      "xpath=//meta[@name='description']": [
        {
          attributes: { content: "XPath description" },
        },
      ],
    });

    await expect(
      readSelectorValue({
        page,
        pagePacket: createPagePacket(),
        selector: candidate({
          kind: "xpath",
          selector: "//meta[@name='description']",
          attribute: "content",
        }),
      }),
    ).resolves.toEqual({
      rawValue: "XPath description",
      warnings: [],
    });
  });

  it("reports missing DOM selectors without reading attributes", async () => {
    const page = createFakePage({});

    await expect(
      readSelectorValue({
        page,
        pagePacket: createPagePacket(),
        selector: candidate({
          kind: "css",
          selector: ".missing",
          attribute: "textContent",
        }),
      }),
    ).resolves.toEqual({
      rawValue: null,
      warnings: ["Selector matched no elements: .missing"],
    });
  });
});
