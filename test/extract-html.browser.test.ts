import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBrowserSession } from "../src/core/crawler.ts";
import { createDomainStore, saveTemplate } from "../src/core/domain-store.ts";
import { createFieldTemplate } from "../src/core/template-author/validateSelectors.ts";
import type { SelectorCandidate } from "../src/core/templating/types.ts";
import { createCrawler } from "../src/lib.ts";
import { listingA, listingB } from "./fixtures/shop-listings.ts";

describe("withSnapshotPage", () => {
  let server: ReturnType<typeof Bun.serve>;
  const hits: string[] = [];
  const session = createBrowserSession({ userAgent: "SnapshotBot/1.0" });

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        hits.push(new URL(request.url).pathname);
        return new Response("", { status: 200 });
      },
    });
  });

  afterAll(async () => {
    server?.stop(true);
    await session.close();
  });

  it("opens the HTML at its URL, runs no script and sends no request", async () => {
    // The snapshot URL is on the local server, so a request that left the browser would reach it.
    const origin = `http://127.0.0.1:${server.port}`;
    const url = `${origin}/rolex/a--id1.htm`;
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/style.css">
      <script src="/app.js"></script>
      <script>document.documentElement.dataset.ran = "1"; navigator.serviceWorker.register("/sw.js");</script>
      </head><body><img src="/a.jpg"><img src="${origin}/b.jpg"><iframe src="/frame.html"></iframe>
      <a href="/omega/x--id1.htm">x</a></body></html>`;

    const seen = await session.withSnapshotPage(url, html, async ({ page, pagePacket }) => {
      await page.waitForLoadState("load");
      return {
        pageUrl: page.url(),
        ran: await page.evaluate(() => document.documentElement.dataset.ran ?? null),
        link: pagePacket.links[0]?.href ?? null,
        status: pagePacket.response.status,
        finalUrl: pagePacket.finalUrl,
      };
    });

    expect(seen).toEqual({
      pageUrl: url,
      ran: null,
      link: `${origin}/omega/x--id1.htm`,
      status: null,
      finalUrl: url,
    });
    expect(hits).toEqual([]);
  }, 30_000);

  it("opens a URL that the browser normalises, and keeps the caller's URL as finalUrl", async () => {
    for (const url of ["https://shop.example", "https://shop.example/a#specs", "https://SHOP.example/a", "https://shop.example/a b", "https://shop.example/a|b/{x}^"]) {
      const seen = await session.withSnapshotPage(url, "<h1>Listing</h1>", async ({ page, pagePacket }) => ({
        title: await page.locator("h1").innerText(),
        finalUrl: pagePacket.finalUrl,
      }));

      expect(seen).toEqual({ title: "Listing", finalUrl: url });
    }
  }, 30_000);
});

it("keeps the snapshot loaded when its HTML has a meta refresh", async () => {
  const session = createBrowserSession({ userAgent: "SnapshotBot/1.0" });
  const html = `<html><head><meta http-equiv="refresh" content="0.1"><meta http-equiv="refresh" content="0.1;url=/other"></head><body><h1>Listing</h1></body></html>`;

  try {
    const seen = await session.withSnapshotPage("https://shop.example/a", html, async ({ page }) => {
      await new Promise(resolve => setTimeout(resolve, 600));
      return { url: page.url(), title: await page.locator("h1").innerText() };
    });

    expect(seen).toEqual({ url: "https://shop.example/a", title: "Listing" });
  } finally {
    await session.close();
  }
}, 30_000);

describe("extractHtml on a real browser", () => {
  let dataDir = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "turbo-crawl-snapshot-"));
  });

  afterAll(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("fits a saved template to the snapshot and reports the page URL and pattern", async () => {
    const store = createDomainStore({ targetUrl: listingA.url, rootPath: dataDir });
    const css = (selector: string): SelectorCandidate[] => [{ kind: "css", selector, attribute: "textContent", score: 90, reusable: true }];
    await saveTemplate(store, {
      id: "template_0123456789abcdef",
      domain: store.domain,
      urlPatterns: ["/:brand/:slug--id:id.htm"],
      schema: { brand: "string", model: "string", price: "number" },
      createdFromUrl: listingA.url,
      createdAt: "2026-11-12T00:00:00.000Z",
      fields: {
        brand: createFieldTemplate({ fieldName: "brand", type: "string", selectors: css("h1 .brand"), rawValue: null, normalizedValue: null }),
        model: createFieldTemplate({ fieldName: "model", type: "string", selectors: css("h1 .model"), rawValue: null, normalizedValue: null }),
        price: createFieldTemplate({ fieldName: "price", type: "number", selectors: css("p.price"), rawValue: null, normalizedValue: null }),
      },
    });
    const crawler = createCrawler({ dataDir, userAgent: "SnapshotBot/1.0", authoring: "never" });

    try {
      const result = await crawler.extractHtml({ url: listingA.url, html: listingA.html });

      expect(result).toMatchObject({
        ok: true,
        url: listingA.url,
        finalUrl: listingA.url,
        urlPattern: "/:brand/:slug--id:id.htm",
        policy: { robots: "unknown", httpStatus: null, xRobotsTag: null, metaRobots: "index,follow" },
        data: { brand: "Rolex", model: "Submariner", price: 9500 },
        missing: [],
        stale: false,
        templateFit: { templateId: "template_0123456789abcdef", matchedPattern: true },
      });
    } finally {
      await crawler.close();
    }
  }, 60_000);

  it("reads every spec row of each listing with one pairs field, also rows the template never saw", async () => {
    const specsDir = await mkdtemp(path.join(tmpdir(), "turbo-crawl-snapshot-pairs-"));
    const store = createDomainStore({ targetUrl: listingA.url, rootPath: specsDir });
    const css = (selector: string): SelectorCandidate[] => [{ kind: "css", selector, attribute: "textContent", score: 90, reusable: true }];
    await saveTemplate(store, {
      id: "template_fedcba9876543210",
      domain: store.domain,
      urlPatterns: ["/:brand/:slug--id:id.htm"],
      schema: { brand: "string", model: "string", price: "number", specs: "pairs" },
      createdFromUrl: listingA.url,
      createdAt: "2026-11-12T00:00:00.000Z",
      fields: {
        brand: createFieldTemplate({ fieldName: "brand", type: "string", selectors: css("h1 .brand"), rawValue: null, normalizedValue: null }),
        model: createFieldTemplate({ fieldName: "model", type: "string", selectors: css("h1 .model"), rawValue: null, normalizedValue: null }),
        price: createFieldTemplate({ fieldName: "price", type: "number", selectors: css("p.price"), rawValue: null, normalizedValue: null }),
        specs: createFieldTemplate({ fieldName: "specs", type: "pairs", selectors: css("table.specs"), rawValue: null, normalizedValue: null }),
      },
    });
    const crawler = createCrawler({ dataDir: specsDir, userAgent: "SnapshotBot/1.0", authoring: "never" });

    try {
      const require = ["brand", "model", "price"];
      const [onA, onB] = await Promise.all([
        crawler.extractHtml({ ...listingA, require }),
        crawler.extractHtml({ ...listingB, require }),
      ]);

      expect(onA).toMatchObject({ ok: true, stale: false, missing: [] });
      expect(onB).toMatchObject({ ok: true, stale: false, missing: [], data: { brand: "Omega", price: 4200 } });
      expect(onA.ok && onA.data.specs).toEqual({ Marca: "Rolex", Modello: "Submariner", Diametro: "40 mm" });
      expect(onB.ok && onB.data.specs).toEqual({
        Marca: "Omega",
        Modello: "Seamaster",
        "Numero di referenza": "210.30",
        "Larghezza ansa": "20 mm",
        Diametro: "42 mm",
      });
    } finally {
      await crawler.close();
      await rm(specsDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("resolves to TEMPLATE_MISSING with no saved template and authoring never", async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), "turbo-crawl-snapshot-empty-"));
    const crawler = createCrawler({ dataDir: emptyDir, userAgent: "SnapshotBot/1.0", authoring: "never" });

    try {
      const result = await crawler.extractHtml({ url: listingA.url, html: listingA.html });

      expect(result).toMatchObject({ ok: false, code: "TEMPLATE_MISSING", url: listingA.url });
      expect(await readdir(emptyDir)).toEqual([]);
    } finally {
      await crawler.close();
      await rm(emptyDir, { recursive: true, force: true });
    }
  }, 60_000);
});
