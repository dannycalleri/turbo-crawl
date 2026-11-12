import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { extractFieldWithTemplate } from "../src/core/template-extractor/extractFieldWithTemplate.ts";
import { createFieldTemplate } from "../src/core/template-author/validateSelectors.ts";
import type { SelectorCandidate, SelectorKind } from "../src/core/templating/types.ts";
import type { PagePacket } from "../src/core/types.ts";

const pagePacket = { url: "https://shop.example/rolex/a--id1.htm", finalUrl: "https://shop.example/rolex/a--id1.htm", jsonLd: [], tables: [] } as unknown as PagePacket;

describe("pairs field reader", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function readSpecs(html: string, selector: string, kind: SelectorKind = "css") {
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    const selectors: SelectorCandidate[] = [{ kind, selector, attribute: "textContent", score: 90, reusable: true }];
    const result = await extractFieldWithTemplate({
      page,
      pagePacket,
      field: createFieldTemplate({ fieldName: "specs", type: "pairs", selectors, rawValue: null, normalizedValue: null }),
    });
    return { value: result.normalizedValue, warnings: result.warnings, bodyMatched: result.bodyMatched };
  }

  it("reads table rows, with the first non-empty cell as the label", async () => {
    const result = await readSpecs(`<table class="specs">
      <tr><td>Marca</td><td>Rolex</td></tr>
      <tr><td></td><th>Modello</th><td>Submariner</td></tr>
      <tr><td>Diametro</td><td>40
        mm</td></tr>
    </table>`, "table.specs");

    expect(result).toEqual({
      value: { Marca: "Rolex", Modello: "Submariner", Diametro: "40 mm" },
      warnings: [],
      bodyMatched: true,
    });
  });

  it("reads a definition list and removes a final colon from the labels", async () => {
    const result = await readSpecs("<dl><dt>Cassa:</dt><dd>Acciaio</dd><dt>Vetro</dt><dd>Zaffiro</dd><dt>Ansa</dt><dd>20 mm</dd></dl>", "dl");

    expect(result.value).toEqual({ Cassa: "Acciaio", Vetro: "Zaffiro", Ansa: "20 mm" });
  });

  it("reads elements with a label child and a value child, also inside a list of two such rows", async () => {
    const result = await readSpecs(`<section id="specs">
      <ul><li><span>Marca</span><span>Rolex</span></li><li><span>Modello</span><b>Submariner</b></li></ul>
      <div class="row"><span>Diametro :</span><span><a href="#">40 mm</a></span></div>
    </section>`, "#specs");

    expect(result.value).toEqual({ Marca: "Rolex", Modello: "Submariner", Diametro: "40 mm" });
  });

  it("reads the rows of groups under a heading, not the heading and its group as one pair", async () => {
    const result = await readSpecs(`<div id="specs">
      <div><h3>Cassa</h3><dl><dt>Materiale</dt><dd>Acciaio</dd><dt>Vetro</dt><dd>Zaffiro</dd></dl></div>
      <div><h3>Movimento</h3><table><tr><td>Calibro</td><td>3235</td></tr><tr><td>Riserva</td><td>70 h</td></tr></table></div>
      <div><h3>Bracciale</h3><ul><li><span>Materiale</span><span>Acciaio</span></li><li><span>Fibbia</span><span>Oysterlock</span></li></ul></div>
    </div>`, "#specs");

    expect(result.value).toEqual({ Materiale: "Acciaio", Vetro: "Zaffiro", Calibro: "3235", Riserva: "70 h", Fibbia: "Oysterlock" });
    expect(result.warnings).toEqual(['Label "Materiale" appears more than once; kept the first value.']);
  });

  it("does not read a heading and a group of one row as one pair", async () => {
    const result = await readSpecs(`<div id="specs">
      <div><h3>Cassa</h3><div><span>Materiale</span><span>Acciaio</span></div></div>
      <div><h3>Movimento</h3><div><span>Calibro</span><span>3235</span></div></div>
      <div><span>Marca</span><span>Rolex</span></div>
    </div>`, "#specs");

    expect(result.value).toEqual({ Materiale: "Acciaio", Calibro: "3235", Marca: "Rolex" });
  });

  it("does not read a title and a group of one row as one pair, whatever the title or the group element", async () => {
    const row = (label: string, value: string) => `<div class="row"><span>${label}</span><span>${value}</span></div>`;
    const layouts = [
      `<div><h3>Cassa</h3><ul><li><span>Materiale</span><span>Acciaio</span></li></ul></div>`,
      `<div><header><h3>Cassa</h3></header>${row("Materiale", "Acciaio")}</div>`,
      `<div><strong>Cassa</strong>${row("Materiale", "Acciaio")}</div>`,
      `<div><div class="title">Cassa</div>${row("Materiale", "Acciaio")}</div>`,
    ];
    for (const group of layouts) {
      const result = await readSpecs(`<div id="specs">${group}<div><h3>Movimento</h3>${row("Calibro", "3235")}</div>${row("Marca", "Rolex")}</div>`, "#specs");

      expect(result.value).toEqual({ Materiale: "Acciaio", Calibro: "3235", Marca: "Rolex" });
    }
  });

  it("reads the same pairs whatever the CSS of the page, as a snapshot without stylesheets does", async () => {
    const result = await readSpecs(`<style>.v { display: flex; }</style><ul class="specs">
      <li><span>Diametro</span><span class="v"><b>40</b> <small>mm</small></span></li>
      <li><span>Marca</span><span>Rolex</span></li><li><span>Modello</span><span>Submariner</span></li>
    </ul>`, "ul.specs");

    expect(result.value).toEqual({ Diametro: "40 mm", Marca: "Rolex", Modello: "Submariner" });
  });

  it("reads cards with a heading as the label", async () => {
    const result = await readSpecs(`<div id="specs">
      <div><h4>Marca</h4><p>Rolex</p></div><div><h4>Modello</h4><p>Submariner</p></div><div><h4>Diametro</h4><p>40 mm</p></div>
    </div>`, "#specs");

    expect(result.value).toEqual({ Marca: "Rolex", Modello: "Submariner", Diametro: "40 mm" });
  });

  it("reads a value made of two parts, such as a number and its unit, as one value", async () => {
    const result = await readSpecs(`<ul class="specs">
      <li><span>Diametro</span><span><b>40</b> <small>mm</small></span></li>
      <li><span>Spessore</span><span><b>12</b> <small>mm</small></span></li>
      <li><span>Marca</span><span><a href="#">Rolex</a><span>(12)</span></span></li>
    </ul>`, "ul.specs");

    expect(result.value).toEqual({ Diametro: "40 mm", Spessore: "12 mm", Marca: "Rolex(12)" });
  });

  it("reads a label that is also the name of an object member as a label, not as a repeat", async () => {
    const result = await readSpecs(`<dl class="specs">
      <dt>constructor</dt><dd>Rolex</dd><dt>toString</dt><dd>Oyster</dd><dt>__proto__</dt><dd>40 mm</dd>
    </dl>`, "dl.specs");

    expect(Object.entries(result.value as object)).toEqual([["constructor", "Rolex"], ["toString", "Oyster"], ["__proto__", "40 mm"]]);
    expect(result.warnings).toEqual([]);
  });

  it("does not read a header cell with two parts as a pair", async () => {
    const result = await readSpecs(`<table class="specs">
      <tr><th colspan="2"><b>Dimensions</b> <small>(mm)</small></th></tr>
      <tr><td>Width</td><td>40</td></tr>
      <tr><td>Height</td><td>12</td></tr>
      <tr><td>Lug width</td><td>20</td></tr>
    </table>`, "table.specs");

    expect(result.value).toEqual({ Width: "40", Height: "12", "Lug width": "20" });
  });

  it("keeps the first value of a repeated label, with a warning that names it", async () => {
    const result = await readSpecs(`<table class="specs">
      <tr><td>Marca</td><td>Rolex</td></tr><tr><td>Marca</td><td>Tudor</td></tr>
      <tr><td>Modello</td><td>Submariner</td></tr><tr><td>Diametro</td><td>40 mm</td></tr>
    </table>`, "//table[@class='specs']", "xpath");

    expect(result.value).toEqual({ Marca: "Rolex", Modello: "Submariner", Diametro: "40 mm" });
    expect(result.warnings).toEqual(['Label "Marca" appears more than once; kept the first value.']);
  });

  it("does not read the rows of a table nested in a row as more pairs", async () => {
    const result = await readSpecs(`<table class="specs">
      <tr><td>Marca</td><td>Rolex</td></tr>
      <tr><td>Cassa</td><td><table><tr><td>Materiale</td><td>Acciaio</td></tr></table></td></tr>
      <tr><td>Diametro</td><td>40 mm</td></tr>
    </table>`, "table.specs");

    expect(result.value).toEqual({ Marca: "Rolex", Cassa: "Materiale Acciaio", Diametro: "40 mm" });
  });

  it("gives null with a warning when the container has fewer than 3 pairs", async () => {
    const result = await readSpecs(`<table class="specs"><tr><td>Marca</td><td>Rolex</td></tr><tr><td>Modello</td><td>Submariner</td></tr></table>`, "table.specs");

    expect(result.value).toBeNull();
    expect(result.warnings).toEqual(["Selector read 2 pairs; a pairs field needs 3 or more."]);
  });

  it("refuses a jsonld, meta or table selector", async () => {
    for (const kind of ["jsonld", "meta", "table"] as const) {
      const result = await readSpecs("<p>x</p>", "x", kind);

      expect(result.value).toBeNull();
      expect(result.warnings).toEqual([`A pairs field needs a css or xpath selector, not ${kind}.`]);
    }
  });
});
