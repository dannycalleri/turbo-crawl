import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { readDomLinks, summarizeLinkGroups } from "../src/core/extraction/links.ts";
import type { LLMProvider, StructuredLLMRequest } from "../src/core/llm-extractor/providers/LLMProvider.ts";
import { classifyPage } from "../src/core/template-author/classifyPage.ts";
import type { PagePacket } from "../src/core/types.ts";

const pageUrl = "https://shop.test/category/clocks";
const cards = Array.from({ length: 24 }, (_, i) => `<li class="card"><a class="card-link" href="/products/clock-${i + 1}#reviews">Clock ${i + 1}</a></li>`);
const posts = Array.from({ length: 6 }, (_, i) => `<a href="https://shop.test/blog/post-${i + 1}">Post</a>`);
const html = `<!doctype html><html><body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <main><ul class="grid">${cards.join("")}<li><a class="card-link" href="/products/clock-1">Clock 1 again</a></li></ul>
    <a rel="next" href="?page=2">Next</a></main>
  <aside>${posts.join("")}</aside>
</body></html>`;

function fakeProvider(answers: unknown[]) {
  const requests: StructuredLLMRequest[] = [];
  const provider: LLMProvider = {
    name: "claude",
    async completeStructured(request) {
      requests.push(request);
      const parsed = answers[Math.min(requests.length - 1, answers.length - 1)];
      return { parsed, raw: parsed };
    },
  };
  return { provider, requests };
}

describe("listing links on a real browser", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.route("https://shop.test/**", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(pageUrl);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("reads every matching link as an absolute URL, without fragments or duplicates", async () => {
    const links = await readDomLinks(page, "a.card-link");

    expect(links).toHaveLength(24);
    expect(links[0]).toBe("https://shop.test/products/clock-1");
  });

  it("groups the page's links on this host by URL pattern", async () => {
    const groups = await summarizeLinkGroups(page);

    expect(groups.slice(0, 2).map(group => [group.urlPattern, group.count])).toEqual([
      ["/products/:slug", 24],
      ["/blog/:slug", 6],
    ]);
  });

  it("asks the agent again for a failed item selector and keeps the repaired one", async () => {
    const { provider, requests } = fakeProvider([
      { pageKind: "listing", itemLinks: [".no-such-card a"], nextPage: ["a[rel=next]"], pageLinks: [] },
      { pageKind: "listing", itemLinks: ["ul.grid a.card-link"], nextPage: [], pageLinks: [] },
    ]);

    const result = await classifyPage({
      page,
      pagePacket: {
        url: pageUrl,
        finalUrl: pageUrl,
        title: "Clocks",
        metadata: { canonicalUrl: null, description: null, robots: null, openGraph: {}, twitter: {}, other: {} },
        jsonLd: [],
        tables: [],
      } as unknown as PagePacket,
      skeleton: "",
      groups: await summarizeLinkGroups(page),
      provider,
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)!.content).toContain(".no-such-card a");
    expect(result).toMatchObject({
      kind: "listing",
      template: { itemLinks: ["ul.grid a.card-link"], nextPage: ["a[rel=next]"], itemUrlPattern: "/products/:slug" },
      paginationUrls: ["https://shop.test/category/clocks?page=2"],
    });
    expect(result.kind === "listing" && result.itemUrls).toHaveLength(24);
  });
});
