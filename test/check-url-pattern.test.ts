import { describe, expect, it } from "bun:test";
import { checkUrlPattern } from "../src/core/template-author/checkUrlPattern.ts";

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
