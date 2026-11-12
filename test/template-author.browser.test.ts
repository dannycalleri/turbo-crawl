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

  it("asks for css selectors when every working selector reads JSON-LD, and keeps both", async () => {
    if (!page || !pagePacket) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const productNode = pagePacket.jsonLd.find(block => block.type === "Product")!.nodeId;
    const jsonLd = (path: string) => ({ kind: "jsonld", selector: `${productNode}:${path}`, attribute: "json" });
    const { provider, requests } = scriptedProvider([
      { fields: { title: { selectors: [jsonLd("$.name")], expectedSample: "Clock" }, price: { selectors: [jsonLd("$.offers.price")], expectedSample: "49.00" } }, ...productPattern },
      { fields: { title: { selectors: [css("h1.product-title")], expectedSample: "Clock" }, price: { selectors: [], expectedSample: null } } },
    ]);

    const authored = await authorTemplate({ schema, page, pagePacket, skeleton: "body", provider });

    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.find(message => message.role === "user")!.content).toContain("None of your working selectors is a css selector");
    expect(authored.warnings).toEqual([]);
    expect(authored.template.fields.title!.selectors.map(selector => selector.kind)).toEqual(["jsonld", "css"]);
    expect(authored.template.fields.price!.selectors.map(selector => selector.kind)).toEqual(["jsonld"]);
  });

  it("keeps at most 4 selectors per field and makes room for the css selector", async () => {
    if (!page || !pagePacket) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const productNode = pagePacket.jsonLd.find(block => block.type === "Product")!.nodeId;
    const nonCss = [
      { kind: "jsonld", selector: `${productNode}:$.name`, attribute: "json" },
      { kind: "meta", selector: "meta[property='og:title']@content", attribute: "content" },
      { kind: "meta", selector: "meta[name='description']@content", attribute: "content" },
      { kind: "meta", selector: "@currentUrl", attribute: "content" },
    ];
    const { provider } = scriptedProvider([
      { fields: { title: { selectors: nonCss, expectedSample: "Clock" }, price: { selectors: [{ kind: "jsonld", selector: `${productNode}:$.offers.price`, attribute: "json" }], expectedSample: "49.00" } }, ...productPattern },
      {
        fields: {
          title: { selectors: [{ kind: "jsonld", selector: `${productNode}:$.offers.price`, attribute: "json" }, css("h1.product-title")], expectedSample: "Clock" },
          price: { selectors: [], expectedSample: null },
        },
      },
    ]);

    const authored = await authorTemplate({ schema, page, pagePacket, skeleton: "body", provider });

    expect(authored.template.fields.title!.selectors.map(selector => selector.selector)).toEqual([
      `${productNode}:$.name`,
      "meta[property='og:title']@content",
      "meta[name='description']@content",
      "h1.product-title",
    ]);
  });

  it("warns that the template will not fit on reuse when the agent never gives a working css selector", async () => {
    if (!page || !pagePacket) {
      expect(browserLaunchError).toBeTruthy();
      return;
    }

    const productNode = pagePacket.jsonLd.find(block => block.type === "Product")!.nodeId;
    const { provider, requests } = scriptedProvider([
      {
        fields: {
          title: { selectors: [{ kind: "jsonld", selector: `${productNode}:$.name`, attribute: "json" }], expectedSample: "Clock" },
          price: { selectors: [{ kind: "jsonld", selector: `${productNode}:$.offers.price`, attribute: "json" }], expectedSample: "49.00" },
        },
        ...productPattern,
      },
    ]);

    const authored = await authorTemplate({ schema, page, pagePacket, skeleton: "body", provider, maxRepairs: 1 });

    expect(requests).toHaveLength(2);
    expect(authored.warnings).toEqual([
      "No field got a working css selector after 1 repair round(s); the template will not fit when it is reused.",
    ]);
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

describe("authorTemplate for a pairs field", () => {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let pagePacket: PagePacket | null = null;
  const pairsSchema: UserSchema = { specs: "pairs" };
  const specsHtml = `<!doctype html><html><body><main>
    <a href="https://shop.example/products/clock-2">Clock 2</a><a href="https://shop.example/category/clocks">All clocks</a>
    <table class="specs">
      <tr class="brand"><td>Marca</td><td>Rolex</td></tr>
      <tr><td>Modello:</td><td>Submariner</td></tr>
      <tr><td>Diametro</td><td>40 mm</td></tr>
    </table>
  </main></body></html>`;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  beforeEach(async () => {
    page = await browser!.newPage();
    await installPageContextHelpers(page);
    await page.setContent(specsHtml);
    pagePacket = await buildPagePacket(page);
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  const author = (provider: LLMProvider) =>
    authorTemplate({ schema: pairsSchema, page: page!, pagePacket: pagePacket!, skeleton: "body", provider, maxRepairs: 1 });
  const specs = (selector: { kind: string; selector: string; attribute: string }, expectedSample: string | null) =>
    ({ fields: { specs: { selectors: [selector], expectedSample } }, ...productPattern });

  it("keeps a container selector that reads 3 pairs, one with the expected label", async () => {
    const { provider, requests } = scriptedProvider([specs(css("table.specs"), "modello")]);

    const authored = await author(provider);

    expect(requests).toHaveLength(1);
    expect(authored.warnings).toEqual([]);
    expect(authored.template.fields.specs!.selectors.map(selector => selector.selector)).toEqual(["table.specs"]);
    expect(authored.template.fields.specs!.normalizedValue).toEqual({ Marca: "Rolex", Modello: "Submariner", Diametro: "40 mm" });
  });

  it("sends a row selector that reads 0 pairs to the repair round with the number it read", async () => {
    const { provider, requests } = scriptedProvider([
      specs(css("table.specs tr.brand"), "Marca"),
      { fields: { specs: { selectors: [css("table.specs")], expectedSample: "Marca" } } },
    ]);

    const authored = await author(provider);

    const repairPrompt = requests[1]!.messages.find(message => message.role === "user")!.content;
    expect(repairPrompt).toContain("read 0 pairs; a pairs field needs 3 or more");
    expect(repairPrompt).toContain("Pairs fields (type pairs):");
    expect(authored.template.fields.specs!.selectors.map(selector => selector.selector)).toEqual(["table.specs"]);
  });

  it("refuses a container without the expected label, and one with no expected label", async () => {
    const { provider, requests } = scriptedProvider([
      specs(css("table.specs"), "Bracciale"),
      { fields: { specs: { selectors: [css("main table")], expectedSample: null } } },
    ]);

    const authored = await author(provider);

    const repairPrompt = requests[1]!.messages.find(message => message.role === "user")!.content;
    expect(repairPrompt).toContain('read 3 pairs, but no row has the label "Bracciale"');
    expect(authored.template.fields.specs!.selectors).toEqual([]);
    expect(authored.warnings[0]).toContain('No working selector found for "specs"');
  });

  it("refuses a jsonld selector with a reason that names css and xpath", async () => {
    const { provider, requests } = scriptedProvider([
      specs({ kind: "jsonld", selector: "jsonld_01:$.specs", attribute: "json" }, "Marca"),
      { fields: { specs: { selectors: [{ kind: "xpath", selector: "//table[@class='specs']", attribute: "textContent" }], expectedSample: "Marca" } } },
    ]);

    const authored = await author(provider);

    const repairPrompt = requests[1]!.messages.find(message => message.role === "user")!.content;
    expect(repairPrompt).toContain("A pairs field needs a css or xpath selector, not jsonld.");
    expect(authored.template.fields.specs!.selectors.map(selector => selector.kind)).toEqual(["xpath"]);
    expect(authored.warnings).toContain("No field got a working css selector after 1 repair round(s); the template will not fit when it is reused.");
  });

  it("gives the count 0 for a selector that matches no element", async () => {
    const { provider, requests } = scriptedProvider([specs(css("table.spec"), "Marca"), specs(css("table.specs"), "Marca")]);

    await author(provider);

    const repairPrompt = requests[1]!.messages.find(message => message.role === "user")!.content;
    expect(repairPrompt).toContain('"table.spec" @textContent: read 0 pairs; a pairs field needs 3 or more (Selector matched no elements: table.spec)');
  });
});
