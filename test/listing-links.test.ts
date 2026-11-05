import { describe, expect, it } from "bun:test";
import { groupLinks } from "../src/core/extraction/links.ts";
import { looksLikeListing } from "../src/core/template-author/classifyPage.ts";
import { parseClassifyResponse } from "../src/core/template-author/listingPrompt.ts";
import { itemLinksFit } from "../src/core/template-author/validateListingSelectors.ts";

const page = "https://shop.test/category/clocks";
const products = (count: number) => Array.from({ length: count }, (_, i) => `https://shop.test/products/clock-${i + 1}`);

describe("looksLikeListing", () => {
  it("needs a group of 4 links on this host with a pattern other than the page's", () => {
    expect(looksLikeListing(groupLinks(products(4), page), page)).toBe(true);
    expect(looksLikeListing(groupLinks(products(3), page), page)).toBe(false);
    expect(looksLikeListing(groupLinks(products(4).map(url => url.replace("shop.test", "cdn.test")), page), page)).toBe(false);
  });

  it("ignores links that share the page's own pattern, such as related products on a product page", () => {
    expect(looksLikeListing(groupLinks(products(6), "https://shop.test/products/clock-9"), "https://shop.test/products/clock-9")).toBe(false);
  });
});

describe("itemLinksFit", () => {
  it("fits 2 or more same-host links that mostly share one pattern, and reports that pattern", () => {
    expect(itemLinksFit([...products(4), "https://shop.test/blog/a-post"], page)).toEqual({
      fits: true,
      itemUrls: [...products(4), "https://shop.test/blog/a-post"],
      itemUrlPattern: "/products/:slug",
    });
  });

  it("does not fit one link, the page itself, or links to another host", () => {
    expect(itemLinksFit(products(1), page).fits).toBe(false);
    expect(itemLinksFit([page, ...products(1)], page).fits).toBe(false);
    expect(itemLinksFit(["https://other.test/products/a-1", "https://other.test/products/b-2"], page).fits).toBe(false);
  });

  it("does not fit links with mixed patterns, such as a whole navigation menu", () => {
    const menu = [...products(2), "https://shop.test/about", "https://shop.test/blog/a-post", "https://shop.test/contact"];

    expect(itemLinksFit(menu, page)).toMatchObject({ fits: false, reason: expect.stringContaining("one URL pattern") });
  });
});

describe("parseClassifyResponse", () => {
  it("drops malformed selectors and defaults missing lists to empty", () => {
    expect(parseClassifyResponse({ pageKind: "listing", itemLinks: ["a.card", 3, "  ", null] })).toEqual({
      pageKind: "listing",
      itemLinks: ["a.card"],
      nextPage: [],
      pageLinks: [],
    });
  });

  it("rejects an answer without a known page kind", () => {
    expect(() => parseClassifyResponse({ pageKind: "category" })).toThrow("listing format");
  });
});
