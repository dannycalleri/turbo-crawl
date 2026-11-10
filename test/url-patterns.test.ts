import { describe, expect, it } from "bun:test";
import { capPatterns, MAX_URL_PATTERNS, mergePatterns, normalizePatterns, templateCoversUrl, urlMatchesPattern } from "../src/core/templating/urlPatterns.ts";

describe("urlMatchesPattern", () => {
  it("matches typed placeholders inside one segment", () => {
    const pattern = "/:brand/:slug--id:id.htm";
    expect(urlMatchesPattern("https://www.watches.example/omega/omega-speedmaster--id50011122.htm", pattern)).toBe(true);
    expect(urlMatchesPattern("https://www.watches.example/rolex/rolex-submariner--mod1.htm", pattern)).toBe(false);
    expect(urlMatchesPattern("https://www.watches.example/omega/watches/omega-speedmaster--id50011122.htm", pattern)).toBe(false);
  });

  it("keeps an underscore after a placeholder as literal text", () => {
    expect(urlMatchesPattern("https://bookshop.example/catalogue/a-light-in-the-attic_1000", "/catalogue/:slug_:id")).toBe(true);
    expect(urlMatchesPattern("https://bookshop.example/catalogue/top100", "/catalogue/:slug_:id")).toBe(false);
    expect(urlMatchesPattern("https://site.com/p/abc", "/p/:product_slug")).toBe(true);
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

describe("mergePatterns", () => {
  it("merges two patterns that differ in one whole segment", () => {
    expect(mergePatterns(["/rolex/:slug", "/omega/:slug"])).toEqual(["/:slug/:slug"]);
    expect(mergePatterns(["/news/2025/:slug", "/news/2026/:slug"])).toEqual(["/news/:id/:slug"]);
    expect(mergePatterns(["/rolex/:slug", "/omega/:slug", "/tudor/:slug"])).toEqual(["/:slug/:slug"]);
  });

  it("keeps patterns apart when they differ in length, in query, in two segments, or inside a typed segment", () => {
    expect(mergePatterns(["/itm/:slug/:id", "/itm/:id"])).toEqual(["/itm/:slug/:id", "/itm/:id"]);
    expect(mergePatterns(["/index.php?route=a", "/home.php?route=b"])).toEqual(["/index.php?route=a", "/home.php?route=b"]);
    expect(mergePatterns(["/a/b", "/c/d"])).toEqual(["/a/b", "/c/d"]);
    expect(mergePatterns(["/:brand/:slug--id:id.htm", "/:brand/watches"])).toEqual(["/:brand/:slug--id:id.htm", "/:brand/watches"]);
  });

  it("removes duplicates", () => {
    expect(mergePatterns(["/products/:slug", "/products/:slug"])).toEqual(["/products/:slug"]);
  });
});

describe("capPatterns", () => {
  it("keeps the first pattern and the most recent ones", () => {
    const patterns = Array.from({ length: MAX_URL_PATTERNS + 1 }, (_, index) => `/p${index}/:slug/x${index}`);
    const capped = capPatterns(patterns);

    expect(capped).toHaveLength(MAX_URL_PATTERNS);
    expect(capped[0]).toBe("/p0/:slug/x0");
    expect(capped).not.toContain("/p1/:slug/x1");
    expect(capped.at(-1)).toBe(`/p${MAX_URL_PATTERNS}/:slug/x${MAX_URL_PATTERNS}`);
  });
});

describe("normalizePatterns", () => {
  it("runs the per-URL heuristic on each stored path, then merges", () => {
    expect(normalizePatterns([
      "/rolex/rolex-submariner-no-date--id49535507",
      "/rolex/rolex-daytona--id51234567",
      "/omega/omega-speedmaster--id50011122",
    ])).toEqual(["/:slug/:slug"]);
  });

  it("does not generalize a literal segment of a pattern that has placeholders", () => {
    expect(normalizePatterns(["/en-us/:slug", "/news/2024/:slug"])).toEqual(["/en-us/:slug", "/news/2024/:slug"]);
  });

  it("keeps typed patterns and query parts as they are", () => {
    expect(normalizePatterns(["/:brand/:slug--id:id.htm", "/index.php?product_id=:id&route=product/product"]))
      .toEqual(["/:brand/:slug--id:id.htm", "/index.php?product_id=:id&route=product/product"]);
  });
});
