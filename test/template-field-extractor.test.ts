import { describe, expect, it } from "bun:test";
import type { Page } from "playwright";
import { extractFieldWithTemplate } from "../src/core/template-extractor/extractFieldWithTemplate.ts";
import type { FieldTemplate, SelectorCandidate } from "../src/core/templating/types.ts";
import type { PagePacket } from "../src/core/types.ts";

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
      openGraph: {},
      twitter: {},
      other: {},
    },
    jsonLd: [],
    visibleBlocks: [],
    links: [],
    images: [],
    tables: [],
    stats: {
      rawHtmlLength: 10,
      bodyTextLength: 10,
      visibleBlockCount: 0,
      jsonLdCount: 0,
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

describe("extractFieldWithTemplate", () => {
  it("extracts the first valid selector and preserves the candidate trace", async () => {
    const firstSelector = selector({ selector: ".title", score: 95 });

    const result = await extractFieldWithTemplate({
      page: createFakePage({
        ".title": [{ textContent: "  Fixture Product  " }],
      }),
      pagePacket: createPagePacket(),
      field: field({
        fieldName: "title",
        type: "string",
        selectors: [firstSelector],
      }),
    });

    expect(result).toMatchObject({
      fieldName: "title",
      type: "string",
      rawValue: "Fixture Product",
      normalizedValue: "Fixture Product",
      selectorUsed: firstSelector,
      confidence: 95,
      warnings: [],
    });
    expect(result.candidatesTried).toEqual([
      {
        selector: firstSelector,
        rawValue: "Fixture Product",
        normalizedValue: "Fixture Product",
        valid: true,
        confidence: 95,
        warnings: [],
      },
    ]);
  });

  it("falls back to the next selector when the first candidate is invalid", async () => {
    const missingSelector = selector({ selector: ".missing", score: 90 });
    const priceSelector = selector({ selector: ".price", score: 80 });

    const result = await extractFieldWithTemplate({
      page: createFakePage({
        ".price": [{ textContent: "$3,750.00" }],
      }),
      pagePacket: createPagePacket(),
      field: field({
        fieldName: "price",
        type: "number",
        selectors: [missingSelector, priceSelector],
        validation: {
          expectedType: "number",
          valueShape: "number",
        },
      }),
    });

    expect(result.rawValue).toBe("$3,750.00");
    expect(result.normalizedValue).toBe(3750);
    expect(result.selectorUsed).toBe(priceSelector);
    expect(result.confidence).toBe(80);
    expect(result.candidatesTried).toHaveLength(2);
    expect(result.candidatesTried[0]).toMatchObject({
      selector: missingSelector,
      rawValue: null,
      normalizedValue: null,
      valid: false,
      confidence: 90,
      warnings: [
        "Selector matched no elements: .missing",
        "Selector did not produce a valid number value.",
      ],
    });
    expect(result.candidatesTried[1]).toMatchObject({
      selector: priceSelector,
      rawValue: "$3,750.00",
      normalizedValue: 3750,
      valid: true,
      confidence: 80,
      warnings: [],
    });
  });

  it("uses the learned numeric occurrence when a template source contains multiple numbers", async () => {
    const sizeSelector = selector({ selector: ".case-size" });

    const result = await extractFieldWithTemplate({
      page: createFakePage({
        ".case-size": [{ textContent: "36 x 35,2 mm" }],
      }),
      pagePacket: createPagePacket(),
      field: field({
        fieldName: "diameter",
        type: "number",
        rawValue: "35 x 34,2 mm",
        normalizedValue: 35,
        selectors: [sizeSelector],
        validation: {
          expectedType: "number",
          valueShape: "number",
        },
      }),
    });

    expect(result.rawValue).toBe("36 x 35,2 mm");
    expect(result.normalizedValue).toBe(36);
    expect(result.selectorUsed).toBe(sizeSelector);
  });

  it("does not collapse ambiguous multi-number text into one number", async () => {
    const sizeSelector = selector({ selector: ".case-size" });

    const result = await extractFieldWithTemplate({
      page: createFakePage({
        ".case-size": [{ textContent: "35 x 34,2 mm" }],
      }),
      pagePacket: createPagePacket(),
      field: field({
        fieldName: "diameter",
        type: "number",
        selectors: [sizeSelector],
        validation: {
          expectedType: "number",
          valueShape: "number",
        },
      }),
    });

    expect(result.normalizedValue).toBeNull();
    expect(result.selectorUsed).toBeNull();
    expect(result.warnings).toEqual([
      "Selector did not produce a valid number value.",
    ]);
  });

  it("treats boolean false as a valid normalized value", async () => {
    const availabilitySelector = selector({ selector: ".stock" });

    const result = await extractFieldWithTemplate({
      page: createFakePage({
        ".stock": [{ textContent: "Sold out" }],
      }),
      pagePacket: createPagePacket(),
      field: field({
        fieldName: "available",
        type: "boolean",
        selectors: [availabilitySelector],
        validation: {
          expectedType: "boolean",
          valueShape: "boolean",
        },
      }),
    });

    expect(result.rawValue).toBe("Sold out");
    expect(result.normalizedValue).toBe(false);
    expect(result.selectorUsed).toBe(availabilitySelector);
    expect(result.candidatesTried[0]?.valid).toBe(true);
  });

  it("normalizes relative URLs against the page packet final URL", async () => {
    const linkSelector = selector({
      selector: ".details",
      attribute: "href",
      score: 70,
    });

    const result = await extractFieldWithTemplate({
      page: createFakePage({
        ".details": [{ attributes: { href: "/products/details" } }],
      }),
      pagePacket: createPagePacket(),
      field: field({
        fieldName: "detailsUrl",
        type: "url",
        selectors: [linkSelector],
        validation: {
          expectedType: "url",
          valueShape: "url",
        },
      }),
    });

    expect(result.rawValue).toBe("/products/details");
    expect(result.normalizedValue).toBe("https://example.com/products/details");
  });

  it("returns a failed field result when all selectors are invalid", async () => {
    const missingSelector = selector({ selector: ".missing" });
    const invalidNumberSelector = selector({ selector: ".price" });

    const result = await extractFieldWithTemplate({
      page: createFakePage({
        ".price": [{ textContent: "not a number" }],
      }),
      pagePacket: createPagePacket(),
      field: field({
        fieldName: "price",
        type: "number",
        selectors: [missingSelector, invalidNumberSelector],
        validation: {
          expectedType: "number",
          valueShape: "number",
        },
      }),
    });

    expect(result).toMatchObject({
      fieldName: "price",
      type: "number",
      rawValue: null,
      normalizedValue: null,
      selectorUsed: null,
      confidence: 0,
      warnings: [
        "Selector matched no elements: .missing",
        "Selector did not produce a valid number value.",
      ],
    });
    expect(result.candidatesTried).toHaveLength(2);
    expect(result.candidatesTried.every(candidate => !candidate.valid)).toBe(true);
  });

  it("returns a clear warning when the field has no selectors", async () => {
    const result = await extractFieldWithTemplate({
      page: createFakePage({}),
      pagePacket: createPagePacket(),
      field: field({
        fieldName: "brand",
        type: "string",
        selectors: [],
      }),
    });

    expect(result).toEqual({
      fieldName: "brand",
      type: "string",
      rawValue: null,
      normalizedValue: null,
      selectorUsed: null,
      confidence: 0,
      warnings: ["No selectors available for field: brand"],
      candidatesTried: [],
    });
  });
});
