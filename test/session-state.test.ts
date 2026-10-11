import { describe, expect, it } from "bun:test";
import {
  createInitialSessionState,
  createSessionViewModel,
  reduceSessionState,
  type CrawlSummary,
} from "../src/core/session-state.ts";
import type { SchemaPreview } from "../src/core/domain-store.ts";

describe("reduceSessionState", () => {
  const schemaPreview: SchemaPreview = {
    id: "schema-one",
    label: "2026-05-10T20:02:33",
    createdAt: "2026-05-10T20:02:33",
    path: "data/example.com/schemas/2026-05-10T20:02:33.json",
    fieldCount: 2,
    fieldSummaries: [
      { name: "price", type: "number" },
      { name: "title", type: "string" },
    ],
  };

  function enterTargetUrl(target: string) {
    return reduceSessionState(
      reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
        type: "submit-target-url",
        value: target,
      }),
      { type: "no-template-reuse" },
    );
  }

  it("initializes with an empty schema and target-url phase", () => {
    const state = createInitialSessionState({
      target: "https://example.com",
    });

    expect(state.phase).toBe("target-url");
    expect(state.properties).toEqual([]);
    expect(state.draftTargetUrl).toBe("");
    expect(state.crawlStarted).toBe(false);
  });

  it("stores a draft target URL before submission", () => {
    const state = reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
      type: "update-target-url",
      value: "https://news.example.com",
    });

    expect(state.phase).toBe("target-url");
    expect(state.target).toBe("https://example.com");
    expect(state.draftTargetUrl).toBe("https://news.example.com");
    expect(state.validationError).toBeNull();
  });

  it("rejects empty target URLs", () => {
    const state = reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
      type: "submit-target-url",
      value: "   ",
    });

    expect(state.phase).toBe("target-url");
    expect(state.validationError).toBe("Target URL is required.");
  });

  it("accepts a submitted target URL and advances to reuse discovery", () => {
    const state = reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
      type: "submit-target-url",
      value: "  https://docs.example.com  ",
    });

    expect(state.phase).toBe("reuse-discovery");
    expect(state.target).toBe("https://docs.example.com");
    expect(state.validationError).toBeNull();
  });

  it("falls back to schema authoring when no matching template is found", () => {
    const discovering = reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
      type: "submit-target-url",
      value: "https://docs.example.com",
    });
    const state = reduceSessionState(discovering, { type: "no-template-reuse" });

    expect(state.phase).toBe("schema-name");
    expect(state.reuseSource).toBe("schema-builder");
  });

  it("opens schema selection when reusable schemas are discovered", () => {
    const discovering = reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
      type: "submit-target-url",
      value: "https://docs.example.com",
    });
    const state = reduceSessionState(discovering, {
      type: "schema-reuse-options",
      schemas: [schemaPreview],
    });

    expect(state.phase).toBe("schema-select");
    expect(state.schemaPreviews).toEqual([schemaPreview]);
    expect(state.selectedSchemaIndex).toBe(0);
  });

  it("supports schema selection navigation, confirmation, and skip fallback", () => {
    const secondSchema: SchemaPreview = {
      ...schemaPreview,
      id: "schema-two",
      label: "second",
      path: "data/example.com/schemas/second.json",
      fieldSummaries: [{ name: "brand", type: "string" }],
      fieldCount: 1,
    };
    const selecting = reduceSessionState(
      reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
        type: "submit-target-url",
        value: "https://docs.example.com",
      }),
      {
        type: "schema-reuse-options",
        schemas: [schemaPreview, secondSchema],
      },
    );
    const moved = reduceSessionState(selecting, { type: "select-next-schema" });
    const confirmed = reduceSessionState(moved, { type: "confirm-schema-reuse" });
    const skipped = reduceSessionState(selecting, { type: "skip-schema-reuse" });

    expect(moved.selectedSchemaIndex).toBe(1);
    expect(confirmed.phase).toBe("schema-review");
    expect(confirmed.reuseSource).toBe("selected-schema");
    expect(confirmed.selectedSchema).toEqual(secondSchema);
    expect(confirmed.properties).toEqual([{ name: "brand", type: "string" }]);
    expect(skipped.phase).toBe("schema-name");
    expect(skipped.reuseSource).toBe("schema-builder");
    expect(skipped.properties).toEqual([]);
  });

  it("falls directly to schema authoring when no reusable schemas exist", () => {
    const discovering = reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
      type: "submit-target-url",
      value: "https://docs.example.com",
    });
    const state = reduceSessionState(discovering, {
      type: "schema-reuse-options",
      schemas: [],
      warnings: [
        {
          operation: "read-json",
          path: "data/example.com/schemas/bad.json",
          message: "Unable to read schema JSON",
          recoverable: true,
        },
      ],
    });

    expect(state.phase).toBe("schema-name");
    expect(state.reuseWarnings).toHaveLength(1);
  });

  it("blocks reuse when duplicate matching templates are discovered", () => {
    const template = {
      id: "template_fixture",
      domain: "example.com",
      urlPattern: "/products/:slug",
      schema: {
        title: "string",
      },
      createdFromUrl: "https://example.com/products/one",
      createdAt: "2026-04-24T15:00:00.000Z",
      fields: {},
    } as const;
    const discovering = reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
      type: "submit-target-url",
      value: "https://example.com/products/two",
    });
    const state = reduceSessionState(discovering, {
      type: "template-reuse-ambiguous",
      templates: [
        {
          urlPattern: "/products/:slug",
          urlPatternHash: "hash",
          path: "data/example.com/templates/a.json",
          template,
        },
      ],
    });

    expect(state.phase).toBe("reuse-blocked");
    expect(state.validationError).toContain("Multiple matching templates");
    expect(state.ambiguousTemplates).toHaveLength(1);
  });

  it("starts a template-reuse crawl when discovery returns one valid template", () => {
    const template = {
      id: "template_fixture",
      domain: "example.com",
      urlPattern: "/products/:slug",
      schema: {
        title: "string",
      },
      createdFromUrl: "https://example.com/products/one",
      createdAt: "2026-04-24T15:00:00.000Z",
      fields: {},
    } as const;

    const discovering = reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
      type: "submit-target-url",
      value: "https://example.com/products/two",
    });
    const state = reduceSessionState(discovering, {
      type: "template-reuse-found",
      template,
    });

    expect(state.phase).toBe("crawl-pending");
    expect(state.reuseSource).toBe("template-reuse");
    expect(state.matchedTemplate).toBe(template);
    expect(state.properties).toEqual([{ name: "title", type: "string" }]);
  });

  it("rejects empty property names", () => {
    const state = reduceSessionState(enterTargetUrl("https://example.com"), {
      type: "submit-name",
      value: "   ",
    });

    expect(state.phase).toBe("schema-name");
    expect(state.validationError).toContain("Property name is required");
  });

  it("adds a property when the name and type are confirmed", () => {
    const withName = reduceSessionState(enterTargetUrl("https://example.com"), {
      type: "submit-name",
      value: "title",
    });
    const withType = reduceSessionState(withName, { type: "select-next-type" });
    const completed = reduceSessionState(withType, { type: "confirm-property" });

    expect(completed.phase).toBe("schema-name");
    expect(completed.properties).toEqual([{ name: "title", type: "number" }]);
    expect(completed.draftPropertyName).toBe("");
  });

  it("prevents schema review and crawl start when no properties exist", () => {
    const initial = enterTargetUrl("https://example.com");
    const reviewAttempt = reduceSessionState(initial, { type: "review-schema" });
    const crawlAttempt = reduceSessionState(reviewAttempt, { type: "start-crawl" });

    expect(reviewAttempt.phase).toBe("schema-name");
    expect(reviewAttempt.validationError).toContain("Add at least one property");
    expect(crawlAttempt.crawlStarted).toBe(false);
  });

  it("supports removing the last property", () => {
    const withProperty = reduceSessionState(
      reduceSessionState(enterTargetUrl("https://example.com"), {
        type: "submit-name",
        value: "title",
      }),
      { type: "confirm-property" },
    );

    const removed = reduceSessionState(withProperty, { type: "remove-last-property" });

    expect(removed.properties).toEqual([]);
    expect(removed.phase).toBe("schema-name");
  });

  it("moves into crawl-running only after explicit review and start events", () => {
    const authored = reduceSessionState(
      reduceSessionState(enterTargetUrl("https://example.com"), {
        type: "submit-name",
        value: "publishedAt",
      }),
      { type: "confirm-property" },
    );
    const reviewed = reduceSessionState(authored, { type: "review-schema" });
    const pending = reduceSessionState(reviewed, { type: "start-crawl" });
    const running = reduceSessionState(pending, { type: "crawl-started" });

    expect(reviewed.phase).toBe("schema-review");
    expect(pending.phase).toBe("crawl-pending");
    expect(running.phase).toBe("crawl-running");
    expect(running.crawlStarted).toBe(true);
  });
  it("starts a crawl with agent-suggested fields only from an empty schema builder", () => {
    const empty = enterTargetUrl("https://example.com/products/clock-1");
    const started = reduceSessionState(empty, { type: "start-crawl-with-suggestion" });
    const withProperty = reduceSessionState(
      reduceSessionState(empty, { type: "submit-name", value: "title" }),
      { type: "confirm-property" },
    );
    const discovering = reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
      type: "submit-target-url",
      value: "https://example.com/products/clock-1",
    });

    expect(started.phase).toBe("crawl-pending");
    expect(started.reuseSource).toBe("schema-builder");
    expect(reduceSessionState(withProperty, { type: "start-crawl-with-suggestion" })).toBe(withProperty);
    expect(reduceSessionState(discovering, { type: "start-crawl-with-suggestion" })).toBe(discovering);
  });

  const summary: CrawlSummary = {
    path: "authored",
    fields: [
      { name: "title", type: "string", found: true, value: "Clock" },
      { name: "price", type: "number", found: false, value: null },
    ],
    artifactFolder: "data/example.com/pages/abc",
    templatePath: "data/example.com/templates/t.json",
    warnings: [],
  };

  function runningCrawl() {
    return reduceSessionState(
      reduceSessionState(enterTargetUrl("https://example.com/products/clock-1"), {
        type: "start-crawl-with-suggestion",
      }),
      { type: "crawl-started" },
    );
  }

  it("records the summary when the crawl finishes", () => {
    const done = reduceSessionState(runningCrawl(), { type: "crawl-finished", summary });
    const view = createSessionViewModel(done);

    expect(done.phase).toBe("crawl-done");
    expect(done.crawlSummary).toBe(summary);
    expect(done.crawlError).toBeNull();
    expect(view.phaseLabel).toBe("Done");
    expect(view.instruction).toBe("1 of 2 fields found. The agent wrote a new template for this URL pattern.");
    expect(view.status).toBe("Saved under data/example.com/pages/abc");
  });

  it("says no model was called when a saved template was reused", () => {
    const done = reduceSessionState(runningCrawl(), {
      type: "crawl-finished",
      summary: { ...summary, path: "template-reuse" },
    });

    expect(createSessionViewModel(done).instruction).toContain("no model was called");
  });

  it("records the error when the crawl fails", () => {
    const failed = reduceSessionState(runningCrawl(), { type: "crawl-failed", message: "Claude Code: not logged in." });
    const view = createSessionViewModel(failed);

    expect(failed.phase).toBe("crawl-failed");
    expect(failed.crawlError).toBe("Claude Code: not logged in.");
    expect(view.phaseLabel).toBe("Failed");
    expect(view.instruction).toBe("Claude Code: not logged in.");
  });

  it("ignores crawl results outside a running crawl", () => {
    const editing = enterTargetUrl("https://example.com");

    expect(reduceSessionState(editing, { type: "crawl-finished", summary })).toBe(editing);
    expect(reduceSessionState(editing, { type: "crawl-failed", message: "x" })).toBe(editing);
  });
});
