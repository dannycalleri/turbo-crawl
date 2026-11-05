import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import type { FieldType } from "../src/core/llm-extractor/types.ts";
import { extractFieldWithTemplate } from "../src/core/template-extractor/extractFieldWithTemplate.ts";
import { createFieldTemplate, toSelectorCandidate } from "../src/core/template-author/validateSelectors.ts";
import type { AuthoredSelector } from "../src/core/template-author/authorPrompt.ts";
import type { PagePacket } from "../src/core/types.ts";

const articleHtml = `<!doctype html>
<html><body>
  <article class="post">
    <time class="published" datetime="2026-11-04T09:30:00Z">4 novembre 2026</time>
    <div class="entry-content">
      <p>The Rolex   Daytona returns.</p>
      <script>window.tracking = "do not read";</script>
      <style>.x { color: red }</style>
      <p>It keeps the <strong>same</strong> movement.</p>
      <div class="more" style="display: none"><p>Hidden behind read more.</p></div>
    </div>
    <table class="specs"><tr><td>Movement</td><td>Calibre 4131</td></tr></table>
  </article>
</body></html>`;

describe("DOM field reads on a real browser", () => {
  let browser: Browser | null = null;
  let page: Page | null = null;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true }).catch(() => null);
    page = (await browser?.newPage()) ?? null;
    await page?.setContent(articleHtml);
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function read(type: FieldType, selector: AuthoredSelector) {
    return extractFieldWithTemplate({
      page: page!,
      pagePacket: { url: "https://site.com/news/a", finalUrl: "https://site.com/news/a" } as PagePacket,
      field: createFieldTemplate({ fieldName: "field", type, selectors: [toSelectorCandidate(selector)], rawValue: null, normalizedValue: null }),
    });
  }

  it("reads text fields without scripts or styles, with paragraph breaks and hidden text", async () => {
    if (!page) return;

    const body = await read("text", { kind: "css", selector: ".entry-content", attribute: "textContent" });

    expect(body.normalizedValue).toBe("The Rolex Daytona returns.\nIt keeps the same movement.\nHidden behind read more.");
  });

  it("separates table cells in text fields", async () => {
    if (!page) return;

    const specs = await read("text", { kind: "css", selector: "table.specs", attribute: "textContent" });

    expect(specs.normalizedValue).toBe("Movement Calibre 4131");
  });

  it("keeps string fields on one line", async () => {
    if (!page) return;

    const title = await read("string", { kind: "css", selector: ".entry-content p", attribute: "textContent" });

    expect(title.normalizedValue).toBe("The Rolex Daytona returns.");
  });

  it("reads any attribute with attr:<name> and parses the date", async () => {
    if (!page) return;

    const published = await read("date", { kind: "css", selector: "time.published", attribute: "attr:datetime" });
    const fromText = await read("date", { kind: "css", selector: "time.published", attribute: "textContent" });

    expect(published.normalizedValue).toBe("2026-11-04T09:30:00.000Z");
    expect(fromText.normalizedValue).toBeNull();
    expect(fromText.rawValue).toBeNull();
    expect(fromText.candidatesTried[0]?.rawValue).toBe("4 novembre 2026");
  });
});
