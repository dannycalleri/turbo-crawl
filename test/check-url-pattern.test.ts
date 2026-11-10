import { describe, expect, it } from "bun:test";
import { checkItemUrlPattern, checkPageUrlPattern, checkUrlPattern } from "../src/core/template-author/checkUrlPattern.ts";

const pageUrl = "https://www.watches.example/rolex/rolex-submariner-no-date--id49535507.htm";
const links = [
  "https://www.watches.example/rolex/rolex-daytona--id51234567.htm",
  "https://www.watches.example/omega/omega-seamaster--id50011122.htm",
  "https://www.watches.example/rolex/rolex-submariner--mod1.htm",
  "https://www.watches.example/rolex/index.htm",
];
const sameTypeLinks = links.slice(0, 2);
const otherTypeLinks = links.slice(2);

describe("checkUrlPattern", () => {
  it("accepts a pattern that agrees with the agent's examples", () => {
    expect(checkUrlPattern({ urlPattern: "/:brand/:slug--id:id.htm", sameTypeLinks, otherTypeLinks }, pageUrl, links)).toBeNull();
  });

  it("rejects a missing or malformed pattern", () => {
    expect(checkUrlPattern(null, pageUrl, links)).toBe("no urlPattern was given");
    expect(checkUrlPattern({ urlPattern: "rolex/*", sameTypeLinks, otherTypeLinks }, pageUrl, links)).toContain("is not a valid pattern");
  });

  it("rejects a pattern that the page URL does not match", () => {
    expect(checkUrlPattern({ urlPattern: "/omega/:slug--id:id.htm", sameTypeLinks: [], otherTypeLinks: [] }, pageUrl, links))
      .toContain("the page URL");
  });

  it("rejects an example that is not one of the page's links", () => {
    const invented = "https://www.watches.example/tudor/tudor-black-bay--id1.htm";
    expect(checkUrlPattern({ urlPattern: "/:brand/:slug--id:id.htm", sameTypeLinks: [invented], otherTypeLinks }, pageUrl, links))
      .toBe(`${invented} is not in the list of links on this page`);
  });

  it("rejects a pattern that is too narrow for its same-type examples", () => {
    expect(checkUrlPattern({ urlPattern: "/rolex/:slug--id:id.htm", sameTypeLinks, otherTypeLinks }, pageUrl, links))
      .toContain("which you listed as the same page type");
  });

  it("rejects a pattern that is too wide for its other-type examples", () => {
    expect(checkUrlPattern({ urlPattern: "/:a/:b", sameTypeLinks, otherTypeLinks }, pageUrl, links))
      .toContain("which you listed as another page type");
  });
});

describe("listing pattern checks", () => {
  const searchUrl = "https://www.watches.example/search/index.htm?query=submariner";
  const items = sameTypeLinks;

  it("accepts an item pattern that the listing page does not match", () => {
    expect(checkItemUrlPattern("/:brand/:slug--id:id.htm", searchUrl)).toBeNull();
    expect(checkItemUrlPattern("", searchUrl)).toBe("no itemUrlPattern was given");
    expect(checkItemUrlPattern("/:a/:b", "https://www.watches.example/rolex/index.htm")).toContain("cannot be the pattern of the item pages");
  });

  it("rejects an item pattern that matches a pagination link", () => {
    expect(checkItemUrlPattern("/:brand/:slug", "https://shop.example/rolex", ["https://shop.example/rolex/page-2"]))
      .toBe("/:brand/:slug matches the pagination link(s) https://shop.example/rolex/page-2, so it cannot be the pattern of the item pages");
    expect(checkItemUrlPattern("/:brand/:slug--id:id", "https://shop.example/rolex", ["https://shop.example/rolex/page-2"])).toBeNull();
  });

  it("accepts a page pattern that matches the page and its pagination, and no item", () => {
    const next = "https://www.watches.example/search/index.htm?query=submariner&showpage=2";
    expect(checkPageUrlPattern("/search/index.htm?query=:q", searchUrl, [next], items)).toBeNull();
    expect(checkPageUrlPattern("/search/index.htm?query=:q&showpage=:page", searchUrl, [next], items)).toContain("does not match");
    expect(checkPageUrlPattern("/search/index.htm", searchUrl, ["https://www.watches.example/search/page2.htm"], items))
      .toContain("does not match the pagination link(s)");
    expect(checkPageUrlPattern("/:a/:b", "https://www.watches.example/rolex/index.htm", [], items)).toContain("matches the item link(s)");
  });
});
