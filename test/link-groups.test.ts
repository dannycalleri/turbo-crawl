import { describe, expect, it } from "bun:test";
import { groupLinks } from "../src/core/extraction/links.ts";

describe("groupLinks", () => {
  it("puts detail pages, model pages and extension-less pages in separate groups", () => {
    const urls = [
      "https://shop.example/rolex/a--id1.htm",
      "https://shop.example/omega/b--id2.htm",
      "https://shop.example/rolex/c--id3.htm",
      "https://shop.example/rolex/d--mod4.htm",
      "https://shop.example/rolex/e--mod5.htm",
      "https://shop.example/rolex/f--id6",
    ];

    const groups = groupLinks(urls, "https://shop.example/rolex/index.htm");

    expect(groups.map(group => [group.urlPattern, group.count])).toEqual([
      ["/rolex/:slug--id:id.htm", 2],
      ["/rolex/:slug--mod:id.htm", 2],
      ["/omega/:slug--id:id.htm", 1],
      ["/rolex/:slug--id:id", 1],
    ]);
  });
});
