import { describe, expect, it } from "bun:test";
import type { UserSchema } from "../src/core/llm-extractor/types.ts";
import {
  buildAuthorResponseSchema,
  buildRepairMessages,
  parseAuthorResponse,
  type PageContextForAgent,
} from "../src/core/template-author/authorPrompt.ts";
import type { PagePacket } from "../src/core/types.ts";

const schema: UserSchema = { title: "string", price: "number" };

function emptyPacket(): PagePacket {
  return {
    url: "https://shop.example/products/clock-1",
    finalUrl: "https://shop.example/products/clock-1",
    fetchedAt: "2026-10-11T10:00:00.000Z",
    title: "Clock",
    response: { status: 200, xRobotsTag: null, tdmReservation: null, tdmPolicy: null, retryAfter: null },
    metadata: { canonicalUrl: null, description: null, robots: null, openGraph: {}, twitter: {}, other: {} },
    jsonLd: [],
    visibleBlocks: [],
    links: [],
    images: [],
    tables: [],
    stats: {
      rawHtmlLength: 0,
      bodyTextLength: 0,
      visibleBlockCount: 0,
      jsonLdCount: 0,
      linkCount: 0,
      imageCount: 0,
      tableCount: 0,
    },
  };
}

function css(selector: string) {
  return { kind: "css", selector, attribute: "textContent" };
}

describe("buildAuthorResponseSchema", () => {
  it("requires exactly the schema fields and nothing else", () => {
    const result = buildAuthorResponseSchema(schema, false) as {
      required: string[];
      additionalProperties: boolean;
      properties: { fields: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } };
    };
    const fields = result.properties.fields;

    expect(result.required).toEqual(["fields"]);
    expect(result.additionalProperties).toBe(false);
    expect(Object.keys(fields.properties)).toEqual(["title", "price"]);
    expect(fields.required).toEqual(["title", "price"]);
    expect(fields.additionalProperties).toBe(false);
  });

  it("asks for the URL pattern and its example links only when asked", () => {
    const asked = buildAuthorResponseSchema(schema, true) as { required: string[]; properties: Record<string, unknown> };

    expect(asked.required).toEqual(["fields", "urlPattern", "sameTypeLinks", "otherTypeLinks"]);
    expect(Object.keys(asked.properties)).toEqual(["fields", "urlPattern", "sameTypeLinks", "otherTypeLinks"]);
  });
});

describe("parseAuthorResponse", () => {
  it("accepts attr:<name> for any HTML attribute and drops a malformed attr:", () => {
    const parsed = parseAuthorResponse(
      {
        fields: {
          title: {
            selectors: [
              { kind: "css", selector: "time.published", attribute: "attr:datetime" },
              { kind: "css", selector: "time", attribute: "attr:" },
              { kind: "css", selector: "time", attribute: "attr:data value" },
            ],
            expectedSample: null,
          },
          price: { selectors: [css(".price")] },
        },
      },
      schema,
    );

    expect(parsed.fields.title!.selectors).toEqual([{ kind: "css", selector: "time.published", attribute: "attr:datetime" }]);
  });

  it("drops malformed selectors and keeps at most four per field", () => {
    const parsed = parseAuthorResponse(
      {
        fields: {
          title: {
            selectors: [
              { kind: "xpath", selector: "//h1", attribute: "textContent" },
              { kind: "css", selector: "", attribute: "textContent" },
              { kind: "css", selector: "h1", attribute: "innerHTML" },
              "h1",
              css("h1.a"),
              css("h1.b"),
              css("h1.c"),
              css("h1.d"),
              css("h1.e"),
            ],
            expectedSample: "Clock",
          },
          price: { selectors: [css(".price")] },
        },
      },
      schema,
    );

    expect(parsed.fields.title!.selectors.map(selector => selector.selector)).toEqual(["h1.a", "h1.b", "h1.c", "h1.d"]);
    expect(parsed.fields.title!.expectedSample).toBe("Clock");
    expect(parsed.fields.price!.expectedSample).toBeNull();
  });

  it("reads the pattern answer, or null when it is missing", () => {
    const fields = { title: { selectors: [], expectedSample: null }, price: { selectors: [], expectedSample: null } };
    const parsed = parseAuthorResponse(
      { fields, urlPattern: "/products/:slug", sameTypeLinks: ["https://shop.example/products/a"], otherTypeLinks: [] },
      schema,
    );

    expect(parsed.pattern).toEqual({ urlPattern: "/products/:slug", sameTypeLinks: ["https://shop.example/products/a"], otherTypeLinks: [] });
    expect(parseAuthorResponse({ fields }, schema).pattern).toBeNull();
  });

  it("rejects an answer missing a field", () => {
    expect(() => parseAuthorResponse({ fields: { title: { selectors: [] } } }, schema)).toThrow(
      "did not match the template format",
    );
  });
});

describe("buildRepairMessages", () => {
  it("reports each failed selector with its reason and the value it read", () => {
    const page: PageContextForAgent = {
      url: "https://shop.example/products/clock-1",
      urlPattern: "/products/:slug",
      skeleton: "body",
      pagePacket: emptyPacket(),
    };
    const messages = buildRepairMessages({
      schema,
      page,
      previous: { fields: {}, pattern: null },
      links: [],
      patternFailure: null,
      bodyMissing: false,
      failures: {
        price: [
          {
            selector: { kind: "css", selector: ".card", attribute: "textContent" },
            passed: false,
            rawValue: "Clock and more",
            normalizedValue: null,
            reason: "value is not a valid number",
          },
        ],
      },
    });
    const prompt = messages.find(message => message.role === "user")!.content;

    expect(prompt).toContain("fields only: price: number");
    expect(prompt).toContain('".card"');
    expect(prompt).toContain("value is not a valid number");
    expect(prompt).toContain('(read "Clock and more")');
    expect(prompt).not.toContain("title: string");
    expect(prompt).not.toContain("urlPattern");
  });

  it("asks only for a new pattern when the selectors worked and the pattern failed", () => {
    const page: PageContextForAgent = {
      url: "https://shop.example/products/clock-1",
      urlPattern: "/products/:slug",
      skeleton: "body",
      pagePacket: emptyPacket(),
    };
    const messages = buildRepairMessages({
      schema: {},
      page,
      previous: { fields: {}, pattern: { urlPattern: "/:a/:b", sameTypeLinks: [], otherTypeLinks: [] } },
      failures: {},
      links: ["https://shop.example/category/clocks"],
      patternFailure: "/:a/:b matches https://shop.example/category/clocks, which you listed as another page type",
      bodyMissing: false,
    });
    const prompt = messages.find(message => message.role === "user")!.content;

    expect(prompt).toContain("Leave fields empty");
    expect(prompt).toContain('Your previous urlPattern "/:a/:b" failed a check: /:a/:b matches https://shop.example/category/clocks');
    expect(prompt).toContain("Same-site links on this page:\nhttps://shop.example/category/clocks");
    expect(prompt).not.toContain("Failure report");
  });

  it("asks for a css selector for every field when none of the working selectors is css", () => {
    const page: PageContextForAgent = { url: "https://shop.example/products/clock-1", skeleton: "body", pagePacket: emptyPacket() };
    const prompt = buildRepairMessages({
      schema,
      page,
      previous: { fields: {}, pattern: null },
      failures: {},
      links: [],
      patternFailure: null,
      bodyMissing: true,
    }).find(message => message.role === "user")!.content;

    expect(prompt).toContain("None of your working selectors is a css selector");
    expect(prompt).toContain("Write a css selector for each field whose value is visible on the page: title: string, price: number");
    expect(prompt).not.toContain("Leave fields empty");
  });
});
