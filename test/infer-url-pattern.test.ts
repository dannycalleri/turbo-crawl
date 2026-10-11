import { describe, expect, it } from "bun:test";
import { inferUrlPattern } from "../src/core/templating/inferUrlPattern.ts";

describe("inferUrlPattern", () => {
  it("keeps stable category path segments and replaces hyphenated product slugs", () => {
    expect(
      inferUrlPattern(
        "https://www.orologeriamajer.it/it/orologi/automatici/tissot-visodate-39mm-t1574071104100.php",
      ),
    ).toBe("/it/orologi/automatici/:slug");
  });

  it("normalizes hyphenated slugs before common file extensions", () => {
    expect(inferUrlPattern("https://example.com/products/seiko-sport-5-gmt-batman-ssk003k1.php")).toBe(
      "/products/:slug",
    );
    expect(inferUrlPattern("https://example.com/products/black-bay-58.html")).toBe(
      "/products/:slug",
    );
  });

  it("still recognizes numeric and hash-like file basenames", () => {
    expect(inferUrlPattern("https://example.com/products/12345.php")).toBe("/products/:id");
    expect(inferUrlPattern("https://example.com/assets/a1b2c3d4e5.html")).toBe("/assets/:hash");
  });

  it("treats underscore-joined segments with an id as slugs", () => {
    expect(
      inferUrlPattern("https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"),
    ).toBe("/catalogue/:slug/index.html");
    expect(inferUrlPattern("https://example.com/books/sapiens_996")).toBe("/books/:slug");
    expect(inferUrlPattern("https://example.com/my_account")).toBe("/my_account");
  });
});
