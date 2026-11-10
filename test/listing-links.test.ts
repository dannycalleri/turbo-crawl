import { describe, expect, it } from "bun:test";
import {
  buildClassifyMessages,
  buildClassifyResponseSchema,
  buildListingRepairMessages,
  parseClassifyResponse,
} from "../src/core/template-author/listingPrompt.ts";
import type { PagePacket } from "../src/core/types.ts";
import { itemLinksFit } from "../src/core/template-author/validateListingSelectors.ts";

const page = "https://shop.test/category/clocks";
const products = (count: number) => Array.from({ length: count }, (_, i) => `https://shop.test/products/clock-${i + 1}`);

describe("itemLinksFit", () => {
  it("fits 2 or more same-host links that match an item pattern, and keeps only those", () => {
    const chrono = "https://www.watches.example/search/index.htm?query=submariner";
    const watches = [
      "https://www.watches.example/rolex/rolex-submariner--id1.htm",
      "https://www.watches.example/omega/omega-seamaster--id2.htm",
      "https://www.watches.example/tudor/tudor-pelagos--id3.htm",
    ];
    const help = "https://www.watches.example/info/shipping.htm";

    expect(itemLinksFit([...watches, help], chrono, ["/:brand/:slug--id:id.htm"])).toEqual({ fits: true, itemUrls: watches });
  });

  it("does not fit one matching link, the page itself, or links to another host", () => {
    const patterns = ["/products/:slug"];
    expect(itemLinksFit(products(1), page, patterns).fits).toBe(false);
    expect(itemLinksFit([page, ...products(1)], page, patterns).fits).toBe(false);
    expect(itemLinksFit(["https://other.test/products/a-1", "https://other.test/products/b-2"], page, patterns).fits).toBe(false);
  });

  it("does not fit links that the item pattern does not match, such as a navigation menu", () => {
    const menu = [products(1)[0]!, "https://shop.test/about", "https://shop.test/blog/a-post", "https://shop.test/contact"];

    expect(itemLinksFit(menu, page, ["/products/:slug"])).toEqual({
      fits: false,
      reason: "1 of 4 link(s) on this host match /products/:slug; a listing needs at least 2",
    });
  });
});

describe("parseClassifyResponse", () => {
  it("drops malformed selectors and defaults missing lists to empty", () => {
    expect(parseClassifyResponse({ pageKind: "listing", itemLinks: ["a.card", 3, "  ", null] })).toEqual({
      pageKind: "listing",
      itemLinks: ["a.card"],
      nextPage: [],
      pageLinks: [],
      pageUrlPattern: "",
      itemUrlPattern: "",
    });
  });

  it("rejects an answer without a known page kind", () => {
    expect(() => parseClassifyResponse({ pageKind: "category" })).toThrow("listing format");
  });
});

describe("listing prompt", () => {
  const pageContext = {
    url: page,
    skeleton: "body",
    pagePacket: {
      title: "Clocks",
      metadata: { canonicalUrl: null, description: null, robots: null, openGraph: {}, twitter: {}, other: {} },
      jsonLd: [],
      tables: [],
    } as unknown as PagePacket,
  };

  it("requires both URL patterns in the answer", () => {
    const schema = buildClassifyResponseSchema() as { required: string[]; properties: Record<string, { type: string }> };

    expect(schema.required).toEqual(["pageKind", "itemLinks", "nextPage", "pageLinks", "pageUrlPattern", "itemUrlPattern"]);
    expect(schema.properties.itemUrlPattern).toEqual({ type: "string" });
  });

  it("explains the URL patterns and does not show the per-URL guess", () => {
    const prompt = buildClassifyMessages({ page: pageContext, groups: [] }).at(-1)!.content;

    expect(prompt).toContain("itemUrlPattern is the URL pattern of every item page");
    expect(prompt).toContain("This page's URL and its pagination links must match pageUrlPattern, and no item link may.");
    expect(prompt).not.toContain("URL pattern: ");
  });

  it("asks for a new pattern that failed a check, with the failed selectors", () => {
    const previous = parseClassifyResponse({ pageKind: "listing", itemLinks: ["a.card"], itemUrlPattern: "/:a/:b", pageUrlPattern: "/category/:slug" });
    const prompt = buildListingRepairMessages({
      page: pageContext,
      groups: [],
      previous,
      failures: { itemLinks: [{ selector: "a.card", passed: false, links: [], reason: "not checked, because the itemUrlPattern failed a check" }] },
      patternFailures: { itemUrlPattern: { pattern: "/:a/:b", reason: "the listing page matches /:a/:b" } },
    }).at(-1)!.content;

    expect(prompt).toContain("write new selectors for itemLinks only");
    expect(prompt).toContain('Your previous itemUrlPattern "/:a/:b" failed a check: the listing page matches /:a/:b. Write a new itemUrlPattern.');
  });
});
