import { describe, expect, it } from "bun:test";
import type { FieldType } from "../src/core/llm-extractor/types.ts";
import { decideTemplate, type TemplateTrial } from "../src/core/template-matcher/matchTemplate.ts";
import type { SelectorKind } from "../src/core/templating/types.ts";

type FieldRead = { type: FieldType; value: unknown; kind?: SelectorKind };

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
    const decision = decideTemplate([trial("a", ["/news/:slug"], article())], { urlPattern: "/:id/:id/:id/:slug", fieldsGiven: false });

    expect(decision).toMatchObject({ kind: "fit", matchedPattern: false });
  });

  it("does not fit when every required value comes from meta or JSON-LD", () => {
    const aboutPage = trial("a", ["/news/:slug"], {
      headline: { type: "string", value: "About us", kind: "meta" },
      body: { type: "text", value: null },
    });
    const metaOnly = trial("b", ["/news/:slug"], { headline: { type: "string", value: "About us", kind: "meta" } });

    expect(decideTemplate([aboutPage], { urlPattern: "/about", fieldsGiven: false }).kind).toBe("none");
    expect(decideTemplate([metaOnly], { urlPattern: "/about", fieldsGiven: false }).kind).toBe("none");
  });

  it("does not fit when a required text field is shorter than 200 characters", () => {
    const caption = trial("a", ["/news/:slug"], article({ body: { type: "text", value: "Photo: Rolex" } }));

    expect(decideTemplate([caption], { urlPattern: "/gallery/:slug", fieldsGiven: false }).kind).toBe("none");
  });

  it("does not fit when an optional text field holds a short value", () => {
    const caption = trial("a", ["/news/:slug"], article({ body: { type: "text", value: "Photo: Rolex" } }));
    const noBody = trial("b", ["/news/:slug"], article({ body: { type: "text", value: null } }));

    expect(decideTemplate([caption], { urlPattern: "/x/:slug", require: ["headline"], fieldsGiven: true }).kind).toBe("none");
    expect(decideTemplate([noBody], { urlPattern: "/x/:slug", require: ["headline"], fieldsGiven: true }).kind).toBe("fit");
  });

  it("lets require narrow the fields that must have a value", () => {
    const noDate = trial("a", ["/news/:slug"], { ...article(), date: { type: "date", value: null } });

    expect(decideTemplate([noDate], { urlPattern: "/news/:slug", fieldsGiven: true }).kind).toBe("stale");
    expect(decideTemplate([noDate], { urlPattern: "/news/:slug", require: ["headline", "body"], fieldsGiven: true }))
      .toMatchObject({ kind: "fit", matchedPattern: true });
  });

  it("ranks by fields found, then by a known pattern", () => {
    const fewer = trial("fewer", ["/news/:slug"], { ...article(), date: { type: "date", value: null } });
    const more = trial("more", ["/blog/:slug"], { ...article(), date: { type: "date", value: "2026-11-04T00:00:00.000Z" } });
    const known = trial("known", ["/news/:slug"], { ...article(), date: { type: "date", value: "2026-11-04T00:00:00.000Z" } });
    const options = { urlPattern: "/news/:slug", require: ["headline", "body"], fieldsGiven: false };

    expect(decideTemplate([fewer, more], options)).toMatchObject({ kind: "fit", trial: { candidate: { template: { id: "more" } } } });
    expect(decideTemplate([more, known], options)).toMatchObject({ kind: "fit", trial: { candidate: { template: { id: "known" } } } });
  });

  it("reports a tie as ambiguous without fields, and picks the newest with fields", () => {
    const older = trial("older", ["/a/:slug"], article(), "2026-10-01T00:00:00.000Z");
    const newer = trial("newer", ["/b/:slug"], article(), "2026-11-01T00:00:00.000Z");

    expect(decideTemplate([older, newer], { urlPattern: "/c/:slug", fieldsGiven: false })).toMatchObject({ kind: "ambiguous" });
    expect(decideTemplate([older, newer], { urlPattern: "/c/:slug", fieldsGiven: true }))
      .toMatchObject({ kind: "fit", trial: { candidate: { template: { id: "newer" } } } });
  });

  it("returns a stale result when only a template for this pattern no longer fits", () => {
    const redesigned = trial("a", ["/news/:slug"], article({ body: { type: "text", value: null } }));

    expect(decideTemplate([redesigned], { urlPattern: "/news/:slug", fieldsGiven: false })).toMatchObject({
      kind: "stale",
      reasons: ["no value for body"],
    });
    expect(decideTemplate([redesigned], { urlPattern: "/other/:slug", fieldsGiven: false }).kind).toBe("none");
  });

  it("says why a stale template no longer fits when every field has a value", () => {
    const shortItem = trial("a", ["/news/:slug"], article({ body: { type: "text", value: "A short news item." } }));

    expect(decideTemplate([shortItem], { urlPattern: "/news/:slug", fieldsGiven: false })).toMatchObject({
      kind: "stale",
      reasons: ["body is shorter than 200 characters"],
    });
  });
});
