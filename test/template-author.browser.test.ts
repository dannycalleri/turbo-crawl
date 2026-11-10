import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { extractDomBlocks } from "../src/core/extraction/dom.ts";
import { extractImages } from "../src/core/extraction/images.ts";
import { extractJsonLd } from "../src/core/extraction/jsonld.ts";
import { extractLinks } from "../src/core/extraction/links.ts";
import { extractMetadata } from "../src/core/extraction/metadata.ts";
import { extractTables } from "../src/core/extraction/tables.ts";
import type {
  LLMProvider,
  StructuredLLMRequest,
} from "../src/core/llm-extractor/providers/LLMProvider.ts";
import type { UserSchema } from "../src/core/llm-extractor/types.ts";
import { installPageContextHelpers } from "../src/core/pageContext/runtime.ts";
import { authorTemplate } from "../src/core/template-author/authorTemplate.ts";
import { extractWithTemplate } from "../src/core/template-extractor/extractWithTemplate.ts";
import type { PagePacket } from "../src/core/types.ts";

const schema: UserSchema = { title: "string", price: "number" };

function emptyPacket(): PagePacket {
  return {
    url: "https://shop.example/products/clock-1",
    finalUrl: "https://shop.example/products/clock-1",
    fetchedAt: "2026-10-11T10:00:00.000Z",
    title: "Clock",
    response: { status: 200, xRobotsTag: null, tdmReservation: null, tdmPolicy: null, retryAfter: null },
    metadata: { canonicalUrl: null, description: null, robots: null, openGraph: {}, twitter: {}, other: {} },
    jsonLd: [],
    visibleBlocks: [],
    links: [],
    images: [],
    tables: [],
    stats: {
      rawHtmlLength: 0,
      bodyTextLength: 0,
      visibleBlockCount: 0,
      jsonLdCount: 0,
      linkCount: 0,
      imageCount: 0,
      tableCount: 0,
    },
  };
}

function css(selector: string) {
  return { kind: "css", selector, attribute: "textContent" };
}

const fixtureHtml = `
  <!doctype html>
  <html>
    <head>
      <title>Clock | Shop</title>
      <meta property="og:title" content="Clock" />
      <meta name="description" content="A wall clock" />
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Product","name":"Clock","offers":{"@type":"Offer","price":"49.00","priceCurrency":"EUR"}}
      </script>
    </head>
    <body>
      <main>
        <h1 class="product-title">Clock</h1>
        <span class="price">€49.00</span>
        <a href="https://shop.example/products/clock-2">Clock 2</a>
        <a href="https://shop.example/products/clock-3">Clock 3</a>
        <a href="https://shop.example/category/clocks">All clocks</a>
      </main>
    </body>
  </html>
`;

async function buildPagePacket(page: Page): Promise<PagePacket> {
  const metadata = await extractMetadata(page);
  const jsonLd = await extractJsonLd(page);
  const visibleBlocks = await extractDomBlocks(page, { maxBlocks: 50 });
  const links = await extractLinks(page);
  const images = await extractImages(page);
  const tables = await extractTables(page);

  return {
    ...emptyPacket(),
    metadata,
    jsonLd,
    visibleBlocks,
    links,
    images,
    tables,
  };
}

const productPattern = {
  urlPattern: "/products/:slug",
  sameTypeLinks: ["https://shop.example/products/clock-2"],
  otherTypeLinks: ["https://shop.example/category/clocks"],
};

function scriptedProvider(answers: unknown[]) {
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

describe("authorTemplate on a live page", () => {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let pagePacket: PagePacket | null = null;
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
    await installPageContextHelpers(page);
    await page.setContent(fixtureHtml);
    pagePacket = await buildPagePacket(page);
  });

  afterEach(async () => {
    await page?.close();
    page = null;
    pagePacket = null;
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("repairs a selector that fails on the page and extracts with the result", async () => {
    if (!page || !pagePacket) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const productNode = pagePacket.jsonLd.find(block => block.type === "Product")!.nodeId;
    const { provider, requests } = scriptedProvider([
      {
        fields: {
          title: { selectors: [css(".nope")], expectedSample: "Clock" },
          price: {
            selectors: [{ kind: "jsonld", selector: `${productNode}:$.offers.price`, attribute: "json" }],
            expectedSample: "49.00",
          },
        },
        ...productPattern,
      },
      { fields: { title: { selectors: [css("h1.product-title")], expectedSample: "Clock" } } },
    ]);

    const authored = await authorTemplate({
      schema,
      page,
      pagePacket,
      skeleton: "body\n  main\n    h1.product-title \"Clock\"",
      provider,
      now: () => new Date("2026-10-11T10:00:00.000Z"),
    });

    expect(requests).toHaveLength(2);
    const repairPrompt = requests[1]!.messages.find(message => message.role === "user")!.content;
    expect(repairPrompt).toContain("failed when run on the live page");
    expect(repairPrompt).toContain('".nope"');
    expect(repairPrompt).toContain("Selector matched no elements");
    expect(Object.keys((requests[1]!.jsonSchema as { properties: { fields: { properties: object } } }).properties.fields.properties)).toEqual(["title"]);
    expect(Object.keys((requests[1]!.jsonSchema as { properties: object }).properties)).toEqual(["fields"]);

    expect(authored.warnings).toEqual([]);
    expect(authored.template.urlPatterns).toEqual(["/products/:slug"]);
    expect(authored.template.domain).toBe("shop.example");
    expect(authored.template.fields.title!.selectors.map(selector => selector.selector)).toEqual(["h1.product-title"]);
    expect(authored.template.fields.price!.selectors[0]!.kind).toBe("jsonld");

    const result = await extractWithTemplate({ page, pagePacket, template: authored.template });
    expect(result.payload).toEqual({ title: "Clock", price: 49 });
  });

  it("lists the page's same-site links and saves the pattern the agent repaired", async () => {
    if (!page || !pagePacket) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const fields = {
      title: { selectors: [css("h1.product-title")], expectedSample: "Clock" },
      price: { selectors: [css("span.price")], expectedSample: "€49.00" },
    };
    const { provider, requests } = scriptedProvider([
      { fields, ...productPattern, urlPattern: "/:a/:b" },
      { fields: {}, ...productPattern },
    ]);

    const authored = await authorTemplate({ schema, page, pagePacket, skeleton: "body", provider });

    const firstPrompt = requests[0]!.messages.find(message => message.role === "user")!.content;
    expect(firstPrompt).toContain(
      "Same-site links on this page:\nhttps://shop.example/products/clock-2\nhttps://shop.example/products/clock-3\nhttps://shop.example/category/clocks",
    );
    expect(requests).toHaveLength(2);
    const repairPrompt = requests[1]!.messages.find(message => message.role === "user")!.content;
    expect(repairPrompt).toContain(
      'Your previous urlPattern "/:a/:b" failed a check: /:a/:b matches https://shop.example/category/clocks, which you listed as another page type',
    );
    expect(Object.keys((requests[1]!.jsonSchema as { properties: { fields: { properties: object } } }).properties.fields.properties)).toEqual([]);
    expect(authored.warnings).toEqual([]);
    expect(authored.template.urlPatterns).toEqual(["/products/:slug"]);
    expect(firstPrompt).not.toContain("URL pattern: /products/:slug");
  });

  it("falls back to the heuristic pattern with a warning when only the pattern keeps failing", async () => {
    if (!page || !pagePacket) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const invented = { ...productPattern, sameTypeLinks: ["https://shop.example/products/invented"] };
    const { provider, requests } = scriptedProvider([
      {
        fields: {
          title: { selectors: [css("h1.product-title")], expectedSample: "Clock" },
          price: { selectors: [css("span.price")], expectedSample: "€49.00" },
        },
        ...invented,
      },
      { fields: {}, ...invented },
    ]);

    const authored = await authorTemplate({ schema, page, pagePacket, skeleton: "body", provider, maxRepairs: 2 });

    expect(requests).toHaveLength(3);
    expect(authored.template.urlPatterns).toEqual(["/products/:slug"]);
    expect(authored.warnings).toEqual([
      "No URL pattern from claude passed the checks after 2 repair round(s) (https://shop.example/products/invented is not in the list of links on this page); the template uses /products/:slug.",
    ]);
    expect(authored.template.fields.title!.selectors.map(selector => selector.selector)).toEqual(["h1.product-title"]);
  });

  it("saves an empty field with a warning when the agent never finds a working selector", async () => {
    if (!page || !pagePacket) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const { provider, requests } = scriptedProvider([
      {
        fields: {
          title: { selectors: [css(".nope")], expectedSample: null },
          price: { selectors: [css("span.price")], expectedSample: "€49.00" },
        },
      },
      { fields: { title: { selectors: [css(".still-wrong")], expectedSample: null } } },
    ]);

    const authored = await authorTemplate({
      schema,
      page,
      pagePacket,
      skeleton: "body",
      provider,
      maxRepairs: 2,
    });

    expect(requests).toHaveLength(3);
    expect(authored.template.fields.title!.selectors).toEqual([]);
    expect(authored.template.fields.price!.selectors.map(selector => selector.selector)).toEqual(["span.price"]);
    expect(authored.warnings).toHaveLength(2);
    expect(authored.warnings[0]).toContain('"title"');
    expect(authored.warnings[1]).toBe(
      "No URL pattern from claude passed the checks after 2 repair round(s) (no urlPattern was given); the template uses /products/:slug.",
    );
    expect(authored.template.urlPatterns).toEqual(["/products/:slug"]);

    const result = await extractWithTemplate({ page, pagePacket, template: authored.template });
    expect(result.payload).toEqual({ title: null, price: 49 });
  });
});
