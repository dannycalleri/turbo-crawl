import { describe, expect, it } from "bun:test";
import { templateCoversUrl, urlMatchesPattern } from "../src/core/templating/urlPatterns.ts";

describe("urlMatchesPattern", () => {
  it("matches typed placeholders inside one segment", () => {
    const pattern = "/:brand/:slug--id:id.htm";
    expect(urlMatchesPattern("https://www.watches.example/omega/omega-speedmaster--id50011122.htm", pattern)).toBe(true);
    expect(urlMatchesPattern("https://www.watches.example/rolex/rolex-submariner--mod1.htm", pattern)).toBe(false);
    expect(urlMatchesPattern("https://www.watches.example/omega/watches/omega-speedmaster--id50011122.htm", pattern)).toBe(false);
  });

  it("matches only digits with :id", () => {
    expect(urlMatchesPattern("https://www.market.example/itm/123456789012", "/itm/:id")).toBe(true);
    expect(urlMatchesPattern("https://www.market.example/itm/rolex-submariner", "/itm/:id")).toBe(false);
  });

  it("requires the pattern's query keys and allows extra ones", () => {
    const pattern = "/search/index.htm?query=:q";
    expect(urlMatchesPattern("https://www.watches.example/search/index.htm?query=rolex&showpage=2", pattern)).toBe(true);
    expect(urlMatchesPattern("https://www.watches.example/search/index.htm?showpage=2", pattern)).toBe(false);
    expect(urlMatchesPattern("https://shop.example/index.php?route=product/category&path=20", "/index.php?product_id=:id&route=product/product"))
      .toBe(false);
  });

  it("decodes query values once, as the page URL is decoded", () => {
    expect(urlMatchesPattern("https://site.com/search?q=a+b", "/search?q=a+b")).toBe(true);
    expect(urlMatchesPattern("https://site.com/search?q=100%2525", "/search?q=100%2525")).toBe(true);
    expect(urlMatchesPattern("https://site.com/search?q=100%25", "/search?q=100%2525")).toBe(false);
  });

  it("ignores the fragment and a trailing slash, and compares decoded segments", () => {
    expect(urlMatchesPattern("https://site.com/news/some-story/#comments", "/news/:slug")).toBe(true);
    expect(urlMatchesPattern("https://site.com/montres/montre-%C3%A9l%C3%A9gante", "/montres/montre-élégante")).toBe(true);
  });

  it("keeps an encoded colon as literal text", () => {
    expect(urlMatchesPattern("https://wiki.example/wiki/Category:books", "/wiki/Category%3Abooks")).toBe(true);
    expect(urlMatchesPattern("https://wiki.example/wiki/Category:anything", "/wiki/Category%3Abooks")).toBe(false);
  });

  it("reads patterns written by older versions", () => {
    expect(urlMatchesPattern("https://bookshop.example/catalogue/sapiens_996/index.html", "/catalogue/:slug/index.html")).toBe(true);
    expect(urlMatchesPattern("https://site.com/assets/a1b2c3d4e5.html", "/assets/:hash")).toBe(true);
  });

  it("rejects a malformed pattern", () => {
    expect(urlMatchesPattern("https://site.com/a", "a")).toBe(false);
    expect(urlMatchesPattern("https://site.com/a?b", "/a?b")).toBe(false);
  });
});

describe("templateCoversUrl", () => {
  it("is true when any stored pattern matches", () => {
    const template = { urlPatterns: ["/news/:slug", "/:id/:id/:id/:slug"] };
    expect(templateCoversUrl(template, "https://site.com/2026/11/04/rolex-daytona")).toBe(true);
    expect(templateCoversUrl(template, "https://site.com/about")).toBe(false);
  });
});
