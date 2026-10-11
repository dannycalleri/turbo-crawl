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
import {
  buildAuthorResponseSchema,
  buildRepairMessages,
  parseAuthorResponse,
  type PageContextForAgent,
} from "../src/core/template-author/authorPrompt.ts";
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

describe("buildAuthorResponseSchema", () => {
  it("requires exactly the schema fields and nothing else", () => {
    const result = buildAuthorResponseSchema(schema) as {
      required: string[];
      additionalProperties: boolean;
      properties: { fields: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } };
    };
    const fields = result.properties.fields;

    expect(result.required).toEqual(["fields"]);
    expect(result.additionalProperties).toBe(false);
    expect(Object.keys(fields.properties)).toEqual(["title", "price"]);
    expect(fields.required).toEqual(["title", "price"]);
    expect(fields.additionalProperties).toBe(false);
  });
});

describe("parseAuthorResponse", () => {
  it("drops malformed selectors and keeps at most four per field", () => {
    const parsed = parseAuthorResponse(
      {
        fields: {
          title: {
            selectors: [
              { kind: "xpath", selector: "//h1", attribute: "textContent" },
              { kind: "css", selector: "", attribute: "textContent" },
              { kind: "css", selector: "h1", attribute: "innerHTML" },
              "h1",
              css("h1.a"),
              css("h1.b"),
              css("h1.c"),
              css("h1.d"),
              css("h1.e"),
            ],
            expectedSample: "Clock",
          },
          price: { selectors: [css(".price")] },
        },
      },
      schema,
    );

    expect(parsed.fields.title!.selectors.map(selector => selector.selector)).toEqual(["h1.a", "h1.b", "h1.c", "h1.d"]);
    expect(parsed.fields.title!.expectedSample).toBe("Clock");
    expect(parsed.fields.price!.expectedSample).toBeNull();
  });

  it("rejects an answer missing a field", () => {
    expect(() => parseAuthorResponse({ fields: { title: { selectors: [] } } }, schema)).toThrow(
      "did not match the template format",
    );
  });
});

describe("buildRepairMessages", () => {
  it("reports each failed selector with its reason and the value it read", () => {
    const page: PageContextForAgent = {
      url: "https://shop.example/products/clock-1",
      urlPattern: "/products/:slug",
      skeleton: "body",
      pagePacket: emptyPacket(),
    };
    const messages = buildRepairMessages({
      schema,
      page,
      previous: { fields: {} },
      failures: {
        price: [
          {
            selector: { kind: "css", selector: ".card", attribute: "textContent" },
            passed: false,
            rawValue: "Clock and more",
            normalizedValue: null,
            reason: "value is not a valid number",
          },
        ],
      },
    });
    const prompt = messages.find(message => message.role === "user")!.content;

    expect(prompt).toContain("fields only: price: number");
    expect(prompt).toContain('".card"');
    expect(prompt).toContain("value is not a valid number");
    expect(prompt).toContain('(read "Clock and more")');
    expect(prompt).not.toContain("title: string");
  });
});

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

    expect(authored.warnings).toEqual([]);
    expect(authored.template.urlPattern).toBe("/products/:slug");
    expect(authored.template.domain).toBe("shop.example");
    expect(authored.template.fields.title!.selectors.map(selector => selector.selector)).toEqual(["h1.product-title"]);
    expect(authored.template.fields.price!.selectors[0]!.kind).toBe("jsonld");

    const result = await extractWithTemplate({ page, pagePacket, template: authored.template });
    expect(result.payload).toEqual({ title: "Clock", price: 49 });
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
    expect(authored.warnings).toHaveLength(1);
    expect(authored.warnings[0]).toContain('"title"');

    const result = await extractWithTemplate({ page, pagePacket, template: authored.template });
    expect(result.payload).toEqual({ title: null, price: 49 });
  });
});
