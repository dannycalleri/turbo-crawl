import { describe, expect, it } from "bun:test";
import type { FieldType } from "../src/core/llm-extractor/types.ts";
import { decideTemplate, misfitReasons, missingFields, type TemplateTrial } from "../src/core/template-matcher/matchTemplate.ts";
import type { SelectorKind } from "../src/core/templating/types.ts";
import { createFieldTemplate } from "../src/core/template-author/validateSelectors.ts";

type FieldRead = { type: FieldType; value: unknown; kind?: SelectorKind; bodyMatched?: boolean };

const longBody = "A watch review paragraph. ".repeat(10);

function trial(id: string, urlPatterns: string[], fields: Record<string, FieldRead>, createdAt = "2026-11-01T00:00:00.000Z"): TemplateTrial {
  const schema = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.type]));
  return {
    candidate: {
      path: `/data/site.com/templates/${id}.json`,
      template: { id, domain: "site.com", urlPatterns, schema, createdFromUrl: "https://site.com/x", createdAt, fields: {} },
    },
    result: {
      payload: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value])),
      fieldResults: Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [
          name,
          {
            fieldName: name,
            type: field.type,
            rawValue: field.value === null ? null : String(field.value),
            normalizedValue: field.value,
            selectorUsed: field.value === null ? null : { kind: field.kind ?? "css", selector: "x", attribute: "textContent", score: 90, reusable: true },
            bodyMatched: field.bodyMatched ?? (field.value !== null && (field.kind ?? "css") === "css"),
            confidence: 0.9,
            warnings: [],
            candidatesTried: [],
          },
        ]),
      ),
      confidence: 0.9,
      templateId: id,
      usedTemplate: true,
      llmUsed: false,
      warnings: [],
    },
  };
}

const article = (overrides: Partial<Record<"headline" | "body", FieldRead>> = {}) => ({
  headline: { type: "string" as const, value: "Rolex Daytona", ...overrides.headline },
  body: { type: "text" as const, value: longBody, ...overrides.body },
});

describe("decideTemplate", () => {
  it("fits a template on a new URL shape and says the pattern is new", () => {
    const decision = decideTemplate([trial("a", ["/news/:slug"], article())], { url: "https://site.com/2026/11/04/rolex-daytona", fieldsGiven: false });

    expect(decision).toMatchObject({ kind: "fit", matchedPattern: false });
  });

  it("does not fit when every required value comes from meta or JSON-LD", () => {
    const aboutPage = trial("a", ["/news/:slug"], {
      headline: { type: "string", value: "About us", kind: "meta" },
      body: { type: "text", value: null },
    });
    const metaOnly = trial("b", ["/news/:slug"], { headline: { type: "string", value: "About us", kind: "meta" } });

    expect(decideTemplate([aboutPage], { url: "https://site.com/about", fieldsGiven: false }).kind).toBe("none");
    expect(decideTemplate([metaOnly], { url: "https://site.com/about", fieldsGiven: false }).kind).toBe("none");
  });

  it("does not fit when a required text field is shorter than 200 characters", () => {
    const caption = trial("a", ["/news/:slug"], article({ body: { type: "text", value: "Photo: Rolex" } }));

    expect(decideTemplate([caption], { url: "https://site.com/gallery/sunset-pier", fieldsGiven: false }).kind).toBe("none");
  });

  it("does not fit when an optional text field holds a short value", () => {
    const caption = trial("a", ["/news/:slug"], article({ body: { type: "text", value: "Photo: Rolex" } }));
    const noBody = trial("b", ["/news/:slug"], article({ body: { type: "text", value: null } }));

    expect(decideTemplate([caption], { url: "https://site.com/x/some-story", require: ["headline"], fieldsGiven: true }).kind).toBe("none");
    expect(decideTemplate([noBody], { url: "https://site.com/x/some-story", require: ["headline"], fieldsGiven: true }).kind).toBe("fit");
  });

  it("lets require narrow the fields that must have a value", () => {
    const noDate = trial("a", ["/news/:slug"], { ...article(), date: { type: "date", value: null } });

    expect(decideTemplate([noDate], { url: "https://site.com/news/some-story", fieldsGiven: true }).kind).toBe("stale");
    expect(decideTemplate([noDate], { url: "https://site.com/news/some-story", require: ["headline", "body"], fieldsGiven: true }))
      .toMatchObject({ kind: "fit", matchedPattern: true });
  });

  it("ranks by fields found, then by a known pattern", () => {
    const fewer = trial("fewer", ["/news/:slug"], { ...article(), date: { type: "date", value: null } });
    const more = trial("more", ["/blog/:slug"], { ...article(), date: { type: "date", value: "2026-11-04T00:00:00.000Z" } });
    const known = trial("known", ["/news/:slug"], { ...article(), date: { type: "date", value: "2026-11-04T00:00:00.000Z" } });
    const options = { url: "https://site.com/news/some-story", require: ["headline", "body"], fieldsGiven: false };

    expect(decideTemplate([fewer, more], options)).toMatchObject({ kind: "fit", trial: { candidate: { template: { id: "more" } } } });
    expect(decideTemplate([more, known], options)).toMatchObject({ kind: "fit", trial: { candidate: { template: { id: "known" } } } });
  });

  it("reports a tie as ambiguous without fields, and picks the newest with fields", () => {
    const older = trial("older", ["/a/:slug"], article(), "2026-10-01T00:00:00.000Z");
    const newer = trial("newer", ["/b/:slug"], article(), "2026-11-01T00:00:00.000Z");

    expect(decideTemplate([older, newer], { url: "https://site.com/c/some-item", fieldsGiven: false })).toMatchObject({ kind: "ambiguous" });
    expect(decideTemplate([older, newer], { url: "https://site.com/c/some-item", fieldsGiven: true }))
      .toMatchObject({ kind: "fit", trial: { candidate: { template: { id: "newer" } } } });
  });

  it("returns a stale result when only a template for this pattern no longer fits", () => {
    const redesigned = trial("a", ["/news/:slug"], article({ body: { type: "text", value: null } }));

    expect(decideTemplate([redesigned], { url: "https://site.com/news/some-story", fieldsGiven: false })).toMatchObject({
      kind: "stale",
      reasons: ["no value for body"],
    });
    expect(decideTemplate([redesigned], { url: "https://site.com/other/some-story", fieldsGiven: false }).kind).toBe("none");
  });

  it("returns a stale result on a URL that a typed pattern covers", () => {
    const redesigned = trial("a", ["/:brand/:slug--id:id.htm"], article({ body: { type: "text", value: null } }));

    expect(decideTemplate([redesigned], { url: "https://www.watches.example/omega/omega-speedmaster--id50011122.htm", fieldsGiven: false }).kind)
      .toBe("stale");
    expect(decideTemplate([redesigned], { url: "https://www.watches.example/rolex/rolex-submariner--mod1.htm", fieldsGiven: false }).kind)
      .toBe("none");
  });

  it("fits with values from JSON-LD when a css selector of a required field also reads a value", () => {
    const fromJsonLd = {
      headline: { type: "string" as const, value: "Rolex Daytona", kind: "jsonld" as const, bodyMatched: true },
      body: { type: "text" as const, value: longBody, kind: "jsonld" as const },
    };
    const noBody = { ...fromJsonLd, headline: { ...fromJsonLd.headline, bodyMatched: false } };
    const url = "https://site.com/news/some-story";

    expect(decideTemplate([trial("a", ["/news/:slug"], fromJsonLd)], { url, fieldsGiven: false }).kind).toBe("fit");
    expect(decideTemplate([trial("a", ["/news/:slug"], noBody)], { url, fieldsGiven: false })).toMatchObject({
      kind: "stale",
      reasons: ["no css selector of a required field reads a value on this page"],
    });
  });

  it("says why a stale template no longer fits when every field has a value", () => {
    const shortItem = trial("a", ["/news/:slug"], article({ body: { type: "text", value: "A short news item." } }));

    expect(decideTemplate([shortItem], { url: "https://site.com/news/some-story", fieldsGiven: false })).toMatchObject({
      kind: "stale",
      reasons: ["body is shorter than 200 characters"],
    });
  });
});

describe("a pairs field in the content fit", () => {
  const specs = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`Label ${i + 1}`, `Value ${i + 1}`]));
  const listing = (specsValue: unknown, brand: FieldRead = { type: "string", value: "Rolex" }) => trial("a", ["/:brand/:slug--id:id.htm"], {
    brand,
    price: { type: "number", value: 9500 },
    specs: { type: "pairs", value: specsValue },
  });

  it("fits a page with 2 spec rows when specs is not required, and reports specs as missing", () => {
    const page = listing(null);

    expect(misfitReasons(page, ["price"])).toEqual([]);
    expect(missingFields(page.candidate.template.schema, page.result.payload)).toEqual(["specs"]);
  });

  it("lets a pairs field read by css be the body selector of the fit", () => {
    const page = listing(specs(5), { type: "string", value: "Rolex", kind: "table" });

    expect(misfitReasons(page, ["brand", "specs"])).toEqual([]);
  });

  it("does not fit when a required pairs field has no value", () => {
    expect(misfitReasons(listing(null), ["price", "specs"])).toContain("no value for specs");
  });

  it("is not stale on a page with more spec rows, or other labels, than the authoring page", () => {
    const url = "https://shop.example/omega/seamaster--id51234567.htm";
    const authoredOnA = { Marca: "Rolex", Modello: "Submariner", Diametro: "40 mm" };
    const onB = [
      { Marca: "Omega", Modello: "Seamaster", "Numero di referenza": "210.30", "Larghezza ansa": "20 mm", Diametro: "42 mm" },
      { Cassa: "Acciaio", Vetro: "Zaffiro", Ansa: "20 mm" },
    ];
    for (const value of onB) {
      const page = listing(value);
      page.candidate.template.fields.specs = createFieldTemplate({
        fieldName: "specs",
        type: "pairs",
        selectors: [{ kind: "css", selector: "table.specs", attribute: "textContent", score: 90, reusable: true }],
        rawValue: JSON.stringify(authoredOnA),
        normalizedValue: authoredOnA,
      });

      expect(page.candidate.template.fields.specs.validation.valueShape).toBe("pairs");
      expect(decideTemplate([page], { url, fieldsGiven: true })).toMatchObject({ kind: "fit", matchedPattern: true });
    }
  });

  it("counts a pairs field with a value as one field found", () => {
    const withSpecs = trial("a", ["/:brand/:slug--id:id.htm"], { price: { type: "number", value: 9500 }, specs: { type: "pairs", value: specs(5) } });
    const withoutSpecs = trial("b", ["/:brand/:slug--id:id.htm"], { price: { type: "number", value: 9500 }, specs: { type: "pairs", value: null } });

    const decision = decideTemplate([withoutSpecs, withSpecs], { url: "https://shop.example/rolex/a--id1.htm", require: ["price"], fieldsGiven: false });

    expect(decision).toMatchObject({ kind: "fit", trial: { candidate: { template: { id: "a" } } } });
  });
});
