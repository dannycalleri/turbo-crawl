import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { capturePageSkeleton } from "../src/core/pageContext/skeleton.ts";

const items = Array.from({ length: 40 }, (_, index) => `<li class="item">Item ${index + 1}</li>`).join("");

const fixtureHtml = `
  <!doctype html>
  <html>
    <head><title>Skeleton fixture</title></head>
    <body>
      <main>
        <h1 class="product-title">Clock</h1>
        <script>window.secretScript = "do-not-send";</script>
        <div style="display:none">hidden secret text</div>
        <ul class="list">${items}</ul>
      </main>
    </body>
  </html>
`;

describe("capturePageSkeleton", () => {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let browserLaunchError: unknown = null;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      browserLaunchError = error;
    }
  });

  beforeEach(async () => {
    if (!browser) return;
    page = await browser.newPage();
    await page.setContent(fixtureHtml);
  });

  afterEach(async () => {
    await page?.close();
    page = null;
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("outlines visible structure, drops scripts and hidden text, collapses repeated siblings", async () => {
    if (!page) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const skeleton = await capturePageSkeleton(page, 120_000);
    const lines = skeleton.text.split("\n");
    const mainIndex = lines.findIndex(line => line.trim() === "main");
    const titleLine = lines.find(line => line.includes('h1.product-title "Clock"'));

    expect(skeleton.truncated).toBe(false);
    expect(mainIndex).toBeGreaterThanOrEqual(0);
    expect(titleLine).toBeDefined();
    // Nested one level deeper than <main>.
    expect(titleLine!.indexOf("h1")).toBe(lines[mainIndex]!.indexOf("main") + 2);
    expect(skeleton.text).not.toContain("do-not-send");
    expect(skeleton.text).not.toContain("secret");
    expect(skeleton.text).toContain('li.item "Item 3"');
    expect(skeleton.text).not.toContain('"Item 4"');
    expect(skeleton.text).toContain("+37 more");
  });

  it("describes a form that holds an input named id by its id attribute", async () => {
    if (!page) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }
    await page.setContent(`<form id="cart" class="cart-form"><input name="id" value="42"><button>Add to cart</button></form>`);

    const skeleton = await capturePageSkeleton(page, 120_000);

    expect(skeleton.text).toContain("form#cart.cart-form");
  });

  it("stays within a tiny byte budget and says it was truncated", async () => {
    if (!page) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const skeleton = await capturePageSkeleton(page, 100);

    expect(skeleton.bytes).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(skeleton.text, "utf8")).toBe(skeleton.bytes);
    expect(skeleton.truncated).toBe(true);
  });
});
