import { describe, expect, it } from "bun:test";
import {
  flattenJsonLd,
  getJsonLdType,
  isRecord,
  parsePossiblyBrokenJson,
} from "../src/core/extraction/jsonld.ts";

describe("jsonld helpers", () => {
  it("returns null for broken json", () => {
    expect(parsePossiblyBrokenJson("{bad json")).toBeNull();
  });

  it("flattens top-level arrays", () => {
    expect(flattenJsonLd([{ "@type": "Product" }, { "@type": "Offer" }])).toEqual([
      { "@type": "Product" },
      { "@type": "Offer" },
    ]);
  });

  it("flattens @graph payloads", () => {
    expect(
      flattenJsonLd({
        "@context": "https://schema.org",
        "@graph": [{ "@type": "Product" }, { "@type": "Offer" }],
      }),
    ).toEqual([{ "@type": "Product" }, { "@type": "Offer" }]);
  });

  it("normalizes jsonld types", () => {
    expect(getJsonLdType({ "@type": "Product" })).toBe("Product");
    expect(getJsonLdType({ "@type": ["Product", "Thing"] })).toBe("Product,Thing");
    expect(getJsonLdType("nope")).toBeNull();
  });

  it("identifies plain records only", () => {
    expect(isRecord({ foo: "bar" })).toBe(true);
    expect(isRecord(["foo"])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });
});
