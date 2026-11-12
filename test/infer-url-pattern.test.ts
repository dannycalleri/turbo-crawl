import { describe, expect, it } from "bun:test";
import { inferUrlPattern } from "../src/core/templating/inferUrlPattern.ts";

describe("inferUrlPattern", () => {
  it("keeps stable category path segments and replaces hyphenated product slugs", () => {
    expect(
      inferUrlPattern(
        "https://www.watchshop.example/it/orologi/automatici/tissot-visodate-39mm-t1574071104100.php",
      ),
    ).toBe("/it/orologi/automatici/:slug.php");
  });

  it("normalizes hyphenated slugs before common file extensions, and keeps the extension", () => {
    expect(inferUrlPattern("https://example.com/products/seiko-sport-5-gmt-batman-ssk003k1.php")).toBe(
      "/products/:slug.php",
    );
    expect(inferUrlPattern("https://example.com/products/black-bay-58.html")).toBe(
      "/products/:slug.html",
    );
  });

  it("still recognizes numeric and hash-like file basenames", () => {
    expect(inferUrlPattern("https://example.com/products/12345.php")).toBe("/products/:id.php");
    expect(inferUrlPattern("https://example.com/assets/a1b2c3d4e5.html")).toBe("/assets/:hash.html");
  });

  it("treats underscore-joined segments with an id as slugs", () => {
    expect(
      inferUrlPattern("https://bookshop.example/catalogue/a-light-in-the-attic_1000/index.html"),
    ).toBe("/catalogue/:slug/index.html");
    expect(inferUrlPattern("https://example.com/books/sapiens_996")).toBe("/books/:slug");
    expect(inferUrlPattern("https://example.com/my_account")).toBe("/my_account");
  });

  it("keeps a double-hyphen id affix, so detail pages and model pages get different patterns", () => {
    expect(inferUrlPattern("https://shop.example/rolex/rolex-submariner-no-date--id49535507.htm")).toBe(
      "/rolex/:slug--id:id.htm",
    );
    expect(inferUrlPattern("https://shop.example/rolex/x--id1.htm")).toBe("/rolex/:slug--id:id.htm");
    expect(inferUrlPattern("https://shop.example/rolex/submariner--mod37.htm")).toBe("/rolex/:slug--mod:id.htm");
    expect(inferUrlPattern("https://shop.example/rolex/rolex-submariner--id49535507")).toBe("/rolex/:slug--id:id");
  });

  it("keeps dotted version and asset segments literal", () => {
    expect(inferUrlPattern("https://example.com/api/v2.0/users")).toBe("/api/v2.0/users");
    expect(inferUrlPattern("https://example.com/static/jquery-3.6.0.min.js")).toBe("/static/jquery-3.6.0.min.js");
  });

  it("encodes a colon in a literal segment, so it cannot read as a placeholder", () => {
    expect(inferUrlPattern("https://wiki.example/wiki/Category:books")).toBe("/wiki/Category%3Abooks");
  });

  it("decodes percent-encoded segments before it classifies them", () => {
    expect(inferUrlPattern("https://example.com/montres/montre-%C3%A9l%C3%A9gante")).toBe("/montres/:slug");
  });

  it("gives the same pattern when it runs on its own output", () => {
    const urls = [
      "https://shop.example/rolex/rolex-submariner-no-date--id49535507.htm",
      "https://example.com/products/black-bay-58.html",
      "https://bookshop.example/catalogue/a-light-in-the-attic_1000/index.html",
      "https://example.com/products/12345.php",
      "https://example.com/assets/a1b2c3d4e5.html",
      "https://example.com/my_account",
    ];
    for (const url of urls) {
      const pattern = inferUrlPattern(url);
      expect(inferUrlPattern(`https://example.com${pattern}`)).toBe(pattern);
    }
  });
});
