import { describe, expect, it } from "bun:test";
import { compactForLLM } from "../src/core/compactPagePacket.ts";
import type { DomBlock } from "../src/core/extraction/dom.ts";
import type { JsonLdBlock } from "../src/core/extraction/jsonld.ts";
import type { PagePacket } from "../src/core/types.ts";

function createVisibleBlock(index: number, overrides: Partial<DomBlock> = {}): DomBlock {
  return {
    nodeId: `dom_${String(index + 1).padStart(3, "0")}`,
    tag: "p",
    text: `Visible block ${index}`,
    normalizedText: `Visible block ${index}`,
    cssPath: `main > p:nth-of-type(${index + 1})`,
    xpath: `/html/body/main/p[${index + 1}]`,
    attributes: {},
    role: null,
    ariaLabel: null,
    href: null,
    src: null,
    boundingBox: { x: 0, y: index, width: 100, height: 20 },
    isVisible: true,
    isInMainContent: true,
    isLikelyNoise: false,
    score: 0.45,
    ...overrides,
  };
}

function createEntityJsonLd(index: number, overrides: Partial<JsonLdBlock> = {}): JsonLdBlock {
  return {
    nodeId: `jsonld_${String(index + 1).padStart(3, "0")}`,
    type: "Product",
    data: {
      "@context": "https://schema.org",
      "@type": "Product",
      name: `Example Item ${index}`,
      description: "A detailed entity description for compaction tests.",
      brand: {
        "@type": "Brand",
        name: "Example Brand",
      },
      model: `Model ${index}`,
      mpn: `ID-${index}`,
      color: "Blue",
      material: "Steel",
      offers: {
        "@type": "Offer",
        price: "499",
        priceCurrency: "EUR",
        availability: "https://schema.org/InStock",
      },
      image: [
        "https://example.com/main.jpg",
        "https://example.com/detail.jpg",
      ],
      additionalProperty: Array.from({ length: 10 }, (_, propertyIndex) => ({
        "@type": "PropertyValue",
        name: `Property ${propertyIndex}`,
        value: `Value ${propertyIndex}`,
      })),
    },
    raw: `{"name":"Example Item ${index}"}`,
    ...overrides,
  };
}

function createPagePacket(overrides: Partial<PagePacket> = {}): PagePacket {
  return {
    url: "https://example.com/source",
    finalUrl: "https://example.com/final",
    fetchedAt: "2026-04-26T10:00:00.000Z",
    title: "Example Item",
    metadata: {
      canonicalUrl: "https://example.com/final",
      description: "A compact page packet fixture.",
      robots: "index,follow",
      openGraph: {
        "og:title": "OG Title",
        "og:description": "OG Description",
        "og:image": "https://example.com/og.jpg",
        "og:locale": "en_US",
      },
      twitter: {
        "twitter:title": "Twitter Title",
        "twitter:description": "Twitter Description",
        "twitter:image": "https://example.com/twitter.jpg",
        "twitter:card": "summary_large_image",
      },
      other: {
        viewport: "width=device-width",
        "product:identifier": "ID-001",
        "product:brand": "Example Brand",
      },
    },
    jsonLd: Array.from({ length: 6 }, (_, index) => createEntityJsonLd(index)),
    visibleBlocks: [
      createVisibleBlock(0, {
        tag: "h1",
        normalizedText: "Example Item Title",
        text: "Example Item Title",
        score: 0.95,
      }),
      createVisibleBlock(1, {
        normalizedText: "Identifier ID-001",
        text: "Identifier ID-001",
        attributes: { itemprop: "mpn" },
        score: 0.9,
      }),
      createVisibleBlock(2, {
        normalizedText: "Color Blue",
        text: "Color Blue",
        score: 0.75,
      }),
      ...Array.from({ length: 60 }, (_, index) =>
        createVisibleBlock(index + 3, {
          normalizedText: `Descriptive paragraph ${index} `.repeat(6).trim(),
          text: `Descriptive paragraph ${index} `.repeat(6).trim(),
          score: 0.45,
        }),
      ),
    ],
    links: Array.from({ length: 16 }, (_, index) => ({
      nodeId: `link_${String(index + 1).padStart(3, "0")}`,
      text: index % 2 === 0 ? `Identifier link ${index}` : `Generic link ${index}`,
      href: `https://example.com/item/${index}`,
      cssPath: `a:nth-of-type(${index + 1})`,
      score: index % 2 === 0 ? 0.7 : 0.3,
    })),
    images: Array.from({ length: 12 }, (_, index) => ({
      nodeId: `img_${String(index + 1).padStart(3, "0")}`,
      src: `https://example.com/image/${index}.jpg`,
      alt: index === 0 ? "Blue example item image" : `Image ${index}`,
      width: 800,
      height: 800,
      cssPath: `img:nth-of-type(${index + 1})`,
      score: index === 0 ? 0.9 : 0.4,
    })),
    tables: [
      {
        nodeId: "table_001",
        cssPath: "table:nth-of-type(1)",
        headers: ["Specification", "Value"],
        rows: [
          ["Identifier", "ID-001"],
          ["Brand", "Example Brand"],
          ["Color", "Blue"],
          ["Material", "Steel"],
          ["Price", "499 EUR"],
          ["Availability", "In stock"],
          ["Category", "Featured items"],
          ["Published", "2026-04-01"],
        ],
        score: 0.9,
      },
    ],
    stats: {
      rawHtmlLength: 1000,
      bodyTextLength: 500,
      visibleBlockCount: 63,
      jsonLdCount: 6,
      linkCount: 16,
      imageCount: 12,
      tableCount: 1,
    },
    ...overrides,
  };
}

describe("compactForLLM", () => {
  it("keeps important metadata, adds compaction summary, and preserves high-signal other meta", () => {
    const compacted = compactForLLM(createPagePacket());

    expect(compacted.url).toBe("https://example.com/source");
    expect(compacted.finalUrl).toBe("https://example.com/final");
    expect(compacted.fetchedAt).toBe("2026-04-26T10:00:00.000Z");
    expect(compacted.title).toBe("Example Item");
    expect(compacted.metadata).toEqual({
      canonicalUrl: "https://example.com/final",
      description: "A compact page packet fixture.",
      robots: "index,follow",
      openGraph: {
        "og:title": "OG Title",
        "og:description": "OG Description",
        "og:image": "https://example.com/og.jpg",
      },
      twitter: {
        "twitter:title": "Twitter Title",
        "twitter:description": "Twitter Description",
        "twitter:image": "https://example.com/twitter.jpg",
      },
      other: {
        "product:identifier": "ID-001",
        "product:brand": "Example Brand",
      },
    });

    expect(compacted.stats.visibleBlockCount).toBe(63);
    expect(compacted.compaction.signals).toContain("structured-data-rich");
    expect(compacted.compaction.signals).toContain("jsonld-primary");
    expect(compacted.compaction.retainedCounts.visibleBlocks).toBeLessThan(63);
    expect(compacted.compaction.omittedCounts.visibleBlocks).toBeGreaterThan(0);
    expect(compacted.compaction.footprint?.compactPacketBytes).toBeGreaterThan(0);
    expect(compacted.compaction.footprint?.compactPacketChars).toBeGreaterThan(0);
  });

  it("adapts collection budgets based on structured data richness", () => {
    const structuredRichPacket = createPagePacket();
    const domHeavyPacket = createPagePacket({
      title: null,
      metadata: {
        canonicalUrl: null,
        description: null,
        robots: null,
        openGraph: {},
        twitter: {},
        other: {},
      },
      jsonLd: [],
      tables: [],
      stats: {
        rawHtmlLength: 1000,
        bodyTextLength: 500,
        visibleBlockCount: 63,
        jsonLdCount: 0,
        linkCount: 16,
        imageCount: 12,
        tableCount: 0,
      },
    });

    const structuredRichCompacted = compactForLLM(structuredRichPacket);
    const domHeavyCompacted = compactForLLM(domHeavyPacket);

    expect(structuredRichCompacted.visibleBlocks.length).toBeLessThan(
      domHeavyCompacted.visibleBlocks.length,
    );
    expect(structuredRichCompacted.links.length).toBeLessThan(domHeavyCompacted.links.length);
    expect(structuredRichCompacted.images.length).toBeLessThan(domHeavyCompacted.images.length);
    expect(structuredRichCompacted.jsonLd.length).toBeGreaterThan(0);
    expect(domHeavyCompacted.jsonLd).toHaveLength(0);
  });

  it("summarizes parsed jsonld, preserves broken jsonld raw, and keeps high-signal dom/table content", () => {
    const packet = createPagePacket({
      jsonLd: [
        createEntityJsonLd(0),
        {
          nodeId: "jsonld_999",
          type: null,
          data: null,
          raw: '{"broken": true, "name": "Example Item", "identifier": "ID-001"' + "x".repeat(900),
        },
      ],
      visibleBlocks: [
        createVisibleBlock(0, {
          tag: "h1",
          normalizedText: "Example Item Title",
          text: "Example Item Title",
          score: 0.95,
        }),
        createVisibleBlock(1, {
          normalizedText: "Identifier ID-001",
          text: "Identifier ID-001",
          attributes: { itemprop: "mpn", class: "entity-identifier" },
          score: 0.9,
        }),
        createVisibleBlock(2, {
          normalizedText: "Identifier ID-001",
          text: "Identifier ID-001",
          attributes: { itemprop: "mpn" },
          score: 0.88,
        }),
        createVisibleBlock(3, {
          normalizedText: "This paragraph contains a long descriptive overview of the item with material, category, and pricing details.",
          text: "This paragraph contains a long descriptive overview of the item with material, category, and pricing details.",
          score: 0.6,
        }),
      ],
    });

    const compacted = compactForLLM(packet);

    const parsedJsonLd = compacted.jsonLd.find(block => block.nodeId === "jsonld_001");
    const brokenJsonLd = compacted.jsonLd.find(block => block.nodeId === "jsonld_999");
    const identifierBlock = compacted.visibleBlocks.find(block => block.text.includes("Identifier ID-001"));

    expect(parsedJsonLd?.raw).toBeUndefined();
    expect(parsedJsonLd?.data).toMatchObject({
      "@type": "Product",
      name: "Example Item 0",
      brand: {
        "@type": "Brand",
        name: "Example Brand",
      },
      model: "Model 0",
      mpn: "ID-0",
      offers: {
        "@type": "Offer",
        price: "499",
        priceCurrency: "EUR",
      },
    });

    expect(brokenJsonLd?.raw?.length ?? 0).toBeLessThan(650);
    expect(brokenJsonLd?.raw?.endsWith("…")).toBe(true);
    expect(identifierBlock).toMatchObject({
      nodeId: "dom_002",
      tag: "p",
      text: "Identifier ID-001",
      cssPath: "main > p:nth-of-type(2)",
      attributes: { itemprop: "mpn" },
      score: expect.any(Number),
    });

    expect(compacted.visibleBlocks.filter(block => block.text === "Identifier ID-001")).toHaveLength(1);
    expect(compacted.tables[0]?.nodeId).toBe("table_001");
    expect(compacted.tables[0]?.headers).toEqual(["Specification", "Value"]);
    expect(compacted.tables[0]?.rows).toEqual(
      expect.arrayContaining([
        ["Identifier", "ID-001"],
        ["Brand", "Example Brand"],
      ]),
    );
    expect(compacted.tables[0]).toMatchObject({
      nodeId: "table_001",
      headers: ["Specification", "Value"],
      score: expect.any(Number),
    });
    expect(compacted.tables[0]?.rows.length).toBeLessThanOrEqual(10);
  });

  it("uses requested schema fields to retain low-score relevant evidence", () => {
    const packet = createPagePacket({
      metadata: {
        canonicalUrl: "https://example.com/final",
        description: "A compact page packet fixture.",
        robots: "index,follow",
        openGraph: {},
        twitter: {},
        other: {
          "watch:dial": "Black dial",
          viewport: "width=device-width",
        },
      },
      visibleBlocks: [
        ...Array.from({ length: 80 }, (_, index) =>
          createVisibleBlock(index, {
            normalizedText: `Generic collection navigation related product ${index}`,
            text: `Generic collection navigation related product ${index}`,
            isInMainContent: false,
            score: 0.55,
          }),
        ),
        createVisibleBlock(100, {
          normalizedText: "Case diameter 40 mm",
          text: "Case diameter 40 mm",
          score: 0.21,
        }),
        createVisibleBlock(101, {
          normalizedText: "Dial color black",
          text: "Dial color black",
          score: 0.21,
        }),
        createVisibleBlock(102, {
          normalizedText: "Reference ABC-123",
          text: "Reference ABC-123",
          score: 0.21,
        }),
      ],
      images: [
        ...Array.from({ length: 18 }, (_, index) => ({
          nodeId: `img_generic_${index}`,
          src: `https://example.com/generic-${index}.jpg`,
          alt: `Gallery image ${index}`,
          width: 800,
          height: 800,
          cssPath: `img:nth-of-type(${index + 1})`,
          score: 0.7,
        })),
        {
          nodeId: "img_reference",
          src: "https://example.com/reference.jpg",
          alt: "Reference ABC-123 caseback",
          width: 800,
          height: 800,
          cssPath: "img.reference",
          score: 0.21,
        },
      ],
    });

    const compacted = compactForLLM(packet, {
      reference: "string",
      dialColor: "string",
      diameter: "number",
    });

    expect(compacted.visibleBlocks.map(block => block.text)).toEqual(
      expect.arrayContaining([
        "Case diameter 40 mm",
        "Dial color black",
        "Reference ABC-123",
      ]),
    );
    expect(compacted.metadata.other).toEqual({
      "watch:dial": "Black dial",
    });
    expect(compacted.images.map(image => image.nodeId)).toContain("img_reference");
  });

  it("keeps source identifiers and short quote text across high-signal compact sources", () => {
    const compacted = compactForLLM(createPagePacket(), {
      reference: "string",
      brand: "string",
      dialColor: "string",
    });

    expect(compacted.jsonLd[0]).toMatchObject({
      nodeId: expect.any(String),
      data: expect.any(Object),
    });
    expect(compacted.visibleBlocks[0]).toMatchObject({
      nodeId: expect.any(String),
      text: expect.any(String),
    });
    expect(compacted.images[0]).toMatchObject({
      nodeId: expect.any(String),
      alt: expect.any(String),
    });
    expect(compacted.links[0]).toMatchObject({
      nodeId: expect.any(String),
      text: expect.any(String),
    });
    expect(compacted.tables[0]).toMatchObject({
      nodeId: "table_001",
      rows: expect.arrayContaining([
        ["Identifier", "ID-001"],
      ]),
    });
  });

  it("exposes deterministic retained and omitted counts with compact footprint metadata", () => {
    const first = compactForLLM(createPagePacket(), {
      reference: "string",
      brand: "string",
    });
    const second = compactForLLM(createPagePacket(), {
      reference: "string",
      brand: "string",
    });

    expect(first.compaction.retainedCounts).toEqual(second.compaction.retainedCounts);
    expect(first.compaction.omittedCounts).toEqual(second.compaction.omittedCounts);
    expect(first.compaction.footprint).toEqual(second.compaction.footprint);
  });

  it("omits cookie consent tables and privacy chrome from the compact packet", () => {
    const packet = createPagePacket({
      visibleBlocks: [
        createVisibleBlock(0, {
          normalizedText: "Gestisci consenso cookie preferenze privacy fornitori legittimo interesse",
          text: "Gestisci consenso cookie preferenze privacy fornitori legittimo interesse",
          isInMainContent: false,
          score: 0.95,
        }),
        createVisibleBlock(1, {
          normalizedText: "Reference ABC-123",
          text: "Reference ABC-123",
          score: 0.4,
        }),
      ],
      tables: [
        {
          nodeId: "table_cookie",
          cssPath: "div.cookie table",
          headers: ["Nome", "Dominio", "Durata"],
          rows: [
            ["CMPS", ".casalemedia.com", "90 giorni"],
            ["IDE", ".doubleclick.net", "390 giorni"],
            ["cto_bundle", ".criteo.com", "13 mesi"],
          ],
          score: 0.95,
        },
        {
          nodeId: "table_specs",
          cssPath: "main table",
          headers: ["Specification", "Value"],
          rows: [
            ["Reference", "ABC-123"],
            ["Brand", "Example Brand"],
            ["Diameter", "39 mm"],
          ],
          score: 0.7,
        },
      ],
    });

    const compacted = compactForLLM(packet, {
      reference: "string",
      brand: "string",
      diameter: "number",
    });
    const serialized = JSON.stringify(compacted);

    expect(serialized).not.toContain("casalemedia");
    expect(serialized).not.toContain("doubleclick");
    expect(serialized).not.toContain("Gestisci consenso cookie");
    expect(compacted.tables.map(table => table.nodeId)).not.toContain("table_cookie");
    expect(compacted.tables.map(table => table.nodeId)).toContain("table_specs");
    expect(compacted.visibleBlocks.map(block => block.text)).toContain("Reference ABC-123");
  });
});
