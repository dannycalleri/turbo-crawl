import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { readDomLinks, summarizeLinkGroups } from "../src/core/extraction/links.ts";
import type { LLMProvider, StructuredLLMRequest } from "../src/core/llm-extractor/providers/LLMProvider.ts";
import { installPageContextHelpers } from "../src/core/pageContext/runtime.ts";
import { classifyPage } from "../src/core/template-author/classifyPage.ts";
import { readListingLinks } from "../src/core/template-author/validateListingSelectors.ts";
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

const patterns = { pageUrlPattern: "/category/:slug", itemUrlPattern: "/products/:slug" };

const packet = (url: string) => ({
  url,
  finalUrl: url,
  title: "Listing",
  metadata: { canonicalUrl: null, description: null, robots: null, openGraph: {}, twitter: {}, other: {} },
  jsonLd: [],
  tables: [],
}) as unknown as PagePacket;

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
    await installPageContextHelpers(page);
    await page.route("https://shop.test/**", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(pageUrl);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("reads every matching link as an absolute URL, without fragments or duplicates", async () => {
    const links = await readDomLinks(page, "a.card-link");

    expect(links).toHaveLength(24);
    expect(links[0]).toMatchObject({ url: "https://shop.test/products/clock-1", text: "Clock 1" });
    expect(links[0]!.cssPath).toContain("a.card-link");
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
      { pageKind: "listing", itemLinks: [".no-such-card a"], nextPage: ["a[rel=next]"], pageLinks: [], ...patterns },
      { pageKind: "listing", itemLinks: ["ul.grid a.card-link"], nextPage: [], pageLinks: [], ...patterns },
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
      template: {
        itemLinks: ["ul.grid a.card-link"],
        nextPage: ["a[rel=next]"],
        urlPatterns: ["/category/:slug"],
        itemUrlPatterns: ["/products/:slug"],
      },
      paginationUrls: ["https://shop.test/category/clocks?page=2"],
    });
    expect(result.kind === "listing" && result.items).toHaveLength(24);
  });

  it("keeps a pagination selector that matches no link on this page, and reads with the first one that finds links", async () => {
    const { provider, requests } = fakeProvider([
      { pageKind: "listing", itemLinks: ["ul.grid a.card-link"], nextPage: ["li.next a"], pageLinks: [], ...patterns },
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

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ kind: "listing", template: { nextPage: ["li.next a"] }, paginationUrls: [] });

    const links = await readListingLinks(page, {
      ...(result as Extract<typeof result, { kind: "listing" }>).template,
      nextPage: ["li.next a", "a[rel=next]"],
    });
    expect(links?.paginationUrls).toEqual(["https://shop.test/category/clocks?page=2"]);
  });

  it("repairs a pagination selector that matches elements without an href", async () => {
    const { provider, requests } = fakeProvider([
      { pageKind: "listing", itemLinks: ["ul.grid a.card-link"], nextPage: ["ul.grid li"], pageLinks: [], ...patterns },
      { pageKind: "listing", itemLinks: [], nextPage: ["a[rel=next]"], pageLinks: [], ...patterns },
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
    expect(requests[1]!.messages.at(-1)!.content).toContain("none is a link with an href");
    expect(result).toMatchObject({ kind: "listing", template: { nextPage: ["a[rel=next]"] } });
  });

  it("keeps only the links that match the item pattern", async () => {
    const { provider } = fakeProvider([{ pageKind: "listing", itemLinks: ["main a"], nextPage: ["a[rel=next]"], pageLinks: [], ...patterns }]);

    const result = await classifyPage({ page, pagePacket: packet(pageUrl), skeleton: "", groups: [], provider });

    expect(result.kind === "listing" && result.items.map(item => item.url)).toEqual(
      Array.from({ length: 24 }, (_, i) => `https://shop.test/products/clock-${i + 1}`),
    );
  });

  it("repairs a page pattern that matches the item links", async () => {
    const { provider, requests } = fakeProvider([
      { pageKind: "listing", itemLinks: ["ul.grid a.card-link"], nextPage: ["a[rel=next]"], pageLinks: [], ...patterns, pageUrlPattern: "/:a/:b" },
      { pageKind: "listing", itemLinks: [], nextPage: [], pageLinks: [], ...patterns },
    ]);

    const result = await classifyPage({ page, pagePacket: packet(pageUrl), skeleton: "", groups: [], provider });

    expect(requests).toHaveLength(2);
    const repair = requests[1]!.messages.at(-1)!.content;
    expect(repair).toContain("Your previous selectors worked");
    expect(repair).toContain('Your previous pageUrlPattern "/:a/:b" failed a check: /:a/:b matches the item link(s) https://shop.test/products/clock-1');
    expect(result).toMatchObject({ kind: "listing", warnings: [], template: { urlPatterns: ["/category/:slug"], nextPage: ["a[rel=next]"] } });
  });

  it("falls back to the per-URL pattern with a warning when the page pattern never passes", async () => {
    const { provider, requests } = fakeProvider([
      { pageKind: "listing", itemLinks: ["ul.grid a.card-link"], nextPage: [], pageLinks: [], ...patterns, pageUrlPattern: "/:a/:b" },
    ]);

    const result = await classifyPage({ page, pagePacket: packet(pageUrl), skeleton: "", groups: [], provider, maxRepairs: 1 });

    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({
      kind: "listing",
      template: { urlPatterns: ["/category/clocks"], itemUrlPatterns: ["/products/:slug"] },
      warnings: [expect.stringContaining("No listing page pattern from claude passed the checks after 1 repair round(s) (/:a/:b matches the item link(s)")],
    });
  });

  it("reads a search page whose items are under several brands", async () => {
    const searchUrl = "https://www.watches.test/search/index.htm?query=submariner";
    const brands = ["rolex", "omega", "tudor"];
    const watches = Array.from({ length: 30 }, (_, i) => `/${brands[i % 3]}/${brands[i % 3]}-model-${i}--id${50000000 + i}.htm`);
    const searchPage = await browser.newPage();
    await installPageContextHelpers(searchPage);
    await searchPage.route("https://www.watches.test/**", route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><main><div class="results">${watches.map(href => `<a class="result" href="${href}">Watch</a>`).join("")}</div>
        <a class="next" href="/search/index.htm?query=submariner&showpage=2">Next</a></main>
        <footer>${brands.map(brand => `<a href="/${brand}/index.htm">${brand}</a>`).join("")}</footer></body></html>`,
    }));
    await searchPage.goto(searchUrl);
    const { provider } = fakeProvider([{
      pageKind: "listing",
      itemLinks: ["div.results a.result"],
      nextPage: ["a.next"],
      pageLinks: [],
      pageUrlPattern: "/search/index.htm?query=:q",
      itemUrlPattern: "/:brand/:slug--id:id.htm",
    }]);

    const result = await classifyPage({ page: searchPage, pagePacket: packet(searchUrl), skeleton: "", groups: [], provider });
    await searchPage.close();

    expect(result).toMatchObject({
      kind: "listing",
      warnings: [],
      template: { urlPatterns: ["/search/index.htm?query=:q"], itemUrlPatterns: ["/:brand/:slug--id:id.htm"] },
      paginationUrls: ["https://www.watches.test/search/index.htm?query=submariner&showpage=2"],
    });
    expect(result.kind === "listing" && result.items).toHaveLength(30);
  });

  it("repairs an item pattern that the listing page matches, and keeps the repaired pattern and selectors", async () => {
    const { provider, requests } = fakeProvider([
      { pageKind: "listing", itemLinks: ["ul.grid a.card-link"], nextPage: ["a[rel=next]"], pageLinks: [], ...patterns, itemUrlPattern: "/:a/:b" },
      { pageKind: "listing", itemLinks: ["ul.grid a.card-link"], nextPage: [], pageLinks: [], ...patterns },
    ]);

    const result = await classifyPage({ page, pagePacket: packet(pageUrl), skeleton: "", groups: [], provider });

    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)!.content).toContain('Your previous itemUrlPattern "/:a/:b" failed a check: the listing page');
    expect(result).toMatchObject({
      kind: "listing",
      warnings: [],
      template: { itemLinks: ["ul.grid a.card-link"], itemUrlPatterns: ["/products/:slug"], nextPage: ["a[rel=next]"] },
    });
  });

  it("repairs a valid item pattern that matches none of the item links", async () => {
    const { provider, requests } = fakeProvider([
      { pageKind: "listing", itemLinks: ["ul.grid a.card-link"], nextPage: [], pageLinks: [], ...patterns, itemUrlPattern: "/product/:slug" },
      { pageKind: "listing", itemLinks: ["ul.grid a.card-link"], nextPage: [], pageLinks: [], ...patterns },
    ]);

    const result = await classifyPage({ page, pagePacket: packet(pageUrl), skeleton: "", groups: [], provider });

    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)!.content).toContain(
      'Your previous itemUrlPattern "/product/:slug" failed a check: no itemLinks selector gave 2 or more links that match /product/:slug',
    );
    expect(result).toMatchObject({ kind: "listing", template: { itemUrlPatterns: ["/products/:slug"] } });
  });

  it("checks the page pattern again when a pagination selector passes in a later round", async () => {
    const { provider, requests } = fakeProvider([
      { pageKind: "listing", itemLinks: ["ul.grid a.card-link"], nextPage: [], pageLinks: ["ul.grid li"], ...patterns },
      { pageKind: "listing", itemLinks: [], nextPage: [], pageLinks: ["aside a"], ...patterns },
    ]);

    const result = await classifyPage({ page, pagePacket: packet(pageUrl), skeleton: "", groups: [], provider, maxRepairs: 1 });

    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({
      kind: "listing",
      template: { urlPatterns: ["/category/clocks"], pageLinks: ["aside a"] },
      warnings: [expect.stringContaining("/category/:slug does not match the pagination link(s) https://shop.test/blog/post-1")],
    });
  });

  it("quotes the item pattern that failed, when it was accepted in an earlier round", async () => {
    const listingUrl = "https://brands.test/rolex";
    const brandPage = await browser.newPage();
    await installPageContextHelpers(brandPage);
    await brandPage.route("https://brands.test/**", route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><main>${[1, 2, 3].map(n => `<a class="watch" href="/rolex/submariner--id${n}">Watch</a>`).join("")}
        <a class="next" href="/rolex/page-2">Next</a></main></body></html>`,
    }));
    await brandPage.goto(listingUrl);
    const answer = { pageKind: "listing", itemLinks: ["a.watch"], pageLinks: [], pageUrlPattern: "/rolex/:page" };
    const { provider, requests } = fakeProvider([
      { ...answer, nextPage: ["main"], itemUrlPattern: "/:brand/:slug" },
      { ...answer, itemLinks: [], nextPage: ["a.next"], itemUrlPattern: "" },
      { ...answer, nextPage: [], itemUrlPattern: "/:brand/:slug--id:id" },
    ]);

    await classifyPage({ page: brandPage, pagePacket: packet(listingUrl), skeleton: "", groups: [], provider, maxRepairs: 2 }).catch(() => null);
    await brandPage.close();

    expect(requests).toHaveLength(3);
    expect(requests[2]!.messages.at(-1)!.content).toContain(
      'Your previous itemUrlPattern "/:brand/:slug" failed a check: /:brand/:slug matches the pagination link(s) https://brands.test/rolex/page-2',
    );
  });

  it("repairs an item pattern that also matches the pagination links", async () => {
    const listingUrl = "https://brands.test/rolex";
    const brandPage = await browser.newPage();
    await installPageContextHelpers(brandPage);
    await brandPage.route("https://brands.test/**", route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><main>${[1, 2, 3].map(n => `<a class="watch" href="/rolex/submariner--id${n}">Watch</a>`).join("")}
        <a class="next" href="/rolex/page-2">Next</a></main></body></html>`,
    }));
    await brandPage.goto(listingUrl);
    const answer = { pageKind: "listing", itemLinks: ["a.watch"], nextPage: ["a.next"], pageLinks: [], pageUrlPattern: "/rolex/:page" };
    const { provider, requests } = fakeProvider([
      { ...answer, itemUrlPattern: "/:brand/:slug" },
      { ...answer, itemUrlPattern: "/:brand/:slug--id:id" },
    ]);

    const result = await classifyPage({ page: brandPage, pagePacket: packet(listingUrl), skeleton: "", groups: [], provider, maxRepairs: 1 });
    await brandPage.close();

    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)!.content).toContain(
      'Your previous itemUrlPattern "/:brand/:slug" failed a check: /:brand/:slug matches the pagination link(s) https://brands.test/rolex/page-2',
    );
    // /rolex and /rolex/page-2 differ in length, so no page pattern can match both; the page pattern falls back.
    expect(result).toMatchObject({
      kind: "listing",
      template: { itemUrlPatterns: ["/:brand/:slug--id:id"], itemLinks: ["a.watch"], urlPatterns: ["/rolex"] },
    });
  });
});
