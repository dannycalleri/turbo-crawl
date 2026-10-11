import { act } from "react";
import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  createInitialSessionState,
  createSessionViewModel,
  reduceSessionState,
  type CrawlSummary,
  type SessionState,
} from "../src/core/session-state.ts";
import type { CrawlOutcome, CrawlRunner } from "../src/core/crawl-run.ts";
import type { SchemaPreview } from "../src/core/domain-store.ts";
import { App, getAppCopy } from "../src/ui/App.tsx";

describe("session view model", () => {
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

  it("shows the target-url entering screen for a new crawl session", () => {
    const state = createInitialSessionState({
      target: "https://example.com",
    });

    const view = createSessionViewModel(state);

    expect(getAppCopy(view).join("\n")).toContain("Target: https://example.com");
    expect(getAppCopy(view).join("\n")).toContain("Phase: Target URL");
    expect(getAppCopy(view).join("\n")).toContain("Status: No target URL entered.");
  });

  it("shows the schema builder after the target URL is submitted", () => {
    const state = enterTargetUrl("https://docs.example.com");
    const view = createSessionViewModel(state);

    expect(getAppCopy(view).join("\n")).toContain("Target: https://docs.example.com");
    expect(getAppCopy(view).join("\n")).toContain("Phase: Schema Builder");
    expect(getAppCopy(view).join("\n")).toContain("Status: No schema properties yet.");
  });

  it("shows reuse discovery after the target URL is submitted", () => {
    const state = reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
      type: "submit-target-url",
      value: "https://docs.example.com",
    });
    const view = createSessionViewModel(state);

    expect(getAppCopy(view).join("\n")).toContain("Target: https://docs.example.com");
    expect(getAppCopy(view).join("\n")).toContain("Phase: Reuse Discovery");
    expect(getAppCopy(view).join("\n")).toContain("Status: Checking for a matching template.");
  });

  it("shows template reuse status without schema builder copy", () => {
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
    const state = reduceSessionState(
      reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
        type: "submit-target-url",
        value: "https://example.com/products/two",
      }),
      {
        type: "template-reuse-found",
        template,
      },
    );

    const view = createSessionViewModel(state);
    const copy = getAppCopy(view).join("\n");

    expect(copy).toContain("Phase: Starting Crawl");
    expect(copy).toContain("Status: Reusing template /products/:slug without LLM extraction.");
    expect(copy).not.toContain("No schema properties yet.");
  });

  it("shows schema selection previews and selected fields", () => {
    const state = reduceSessionState(
      reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
        type: "submit-target-url",
        value: "https://example.com/products/two",
      }),
      {
        type: "schema-reuse-options",
        schemas: [schemaPreview],
      },
    );

    const view = createSessionViewModel(state);
    const copy = getAppCopy(view).join("\n");

    expect(copy).toContain("Phase: Schema Selection");
    expect(copy).toContain("Status: 1 reusable schema available.");
    expect(copy).toContain("> 2026-05-10T20:02:33 (price: number, title: string)");
    expect(copy).toContain("1. price: number");
    expect(copy).toContain("2. title: string");
  });

  it("shows selected schema status after confirmation", () => {
    const state = reduceSessionState(
      reduceSessionState(
        reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
          type: "submit-target-url",
          value: "https://example.com/products/two",
        }),
        {
          type: "schema-reuse-options",
          schemas: [schemaPreview],
        },
      ),
      { type: "confirm-schema-reuse" },
    );
    const pending = reduceSessionState(state, { type: "start-crawl" });

    const copy = getAppCopy(createSessionViewModel(pending)).join("\n");

    expect(copy).toContain("Status: Reusing schema 2026-05-10T20:02:33 for bootstrap extraction.");
  });

  it("shows manual schema status and recoverable warnings after empty schema discovery", () => {
    const state = reduceSessionState(
      reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
        type: "submit-target-url",
        value: "https://example.com/products/two",
      }),
      {
        type: "schema-reuse-options",
        schemas: [],
        warnings: [
          {
            operation: "read-json",
            path: "data/example.com/schemas/bad.json",
            message: "Unable to read schema JSON at data/example.com/schemas/bad.json",
            recoverable: true,
          },
        ],
      },
    );

    const copy = getAppCopy(createSessionViewModel(state)).join("\n");

    expect(copy).toContain("Phase: Schema Builder");
    expect(copy).toContain("Warning: Unable to read schema JSON");
  });

  it("shows ambiguous template blocked status", () => {
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
    const state = reduceSessionState(
      reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
        type: "submit-target-url",
        value: "https://example.com/products/two",
      }),
      {
        type: "template-reuse-ambiguous",
        templates: [
          {
            urlPattern: "/products/:slug",
            urlPatternHash: "hash",
            path: "data/example.com/templates/a.json",
            template,
          },
        ],
      },
    );

    const copy = getAppCopy(createSessionViewModel(state)).join("\n");

    expect(copy).toContain("Phase: Reuse Blocked");
    expect(copy).toContain("Error: Multiple matching templates were found");
    expect(copy).toContain("Template: data/example.com/templates/a.json");
  });

  it("shows the review screen with the collected schema", () => {
    const state = reduceSessionState(
      reduceSessionState(
        reduceSessionState(enterTargetUrl("https://example.com"), {
          type: "submit-name",
          value: "title",
        }),
        { type: "confirm-property" },
      ),
      { type: "review-schema" },
    );

    const view = createSessionViewModel(state);

    expect(getAppCopy(view).join("\n")).toContain("Phase: Review Schema");
    expect(getAppCopy(view).join("\n")).toContain("1. title: string");
  });

  it("shows the crawl-running screen after explicit confirmation", () => {
    const state = reduceSessionState(
      reduceSessionState(
        reduceSessionState(
          reduceSessionState(enterTargetUrl("https://example.com"), {
            type: "submit-name",
            value: "publishedAt",
          }),
          { type: "select-next-type" },
        ),
        { type: "confirm-property" },
      ),
      { type: "review-schema" },
    );

    const runningState = reduceSessionState(reduceSessionState(state, { type: "start-crawl" }), {
      type: "crawl-started",
    });

    const view = createSessionViewModel(runningState);

    expect(getAppCopy(view).join("\n")).toContain("Phase: Crawl Running");
    expect(getAppCopy(view).join("\n")).toContain("1. publishedAt: number");
    expect(getAppCopy(view).join("\n")).toContain(
      "Schema, templates, page packets, optional LLM output, and results are persisted locally.",
    );
  });
});

describe("App screens", () => {
  let destroy: (() => void) | null = null;

  afterEach(() => {
    act(() => destroy?.());
    destroy = null;
  });

  const idleRunner: CrawlRunner = {
    startCrawl: () => new Promise<CrawlOutcome>(() => {}),
  };

  function suggestionPending(): SessionState {
    return reduceSessionState(
      reduceSessionState(
        reduceSessionState(createInitialSessionState({ target: "https://example.com" }), {
          type: "submit-target-url",
          value: "https://example.com/products/clock-1",
        }),
        { type: "no-template-reuse" },
      ),
      { type: "start-crawl-with-suggestion" },
    );
  }

  async function render(initialState: SessionState, crawlRunner: CrawlRunner = idleRunner) {
    const setup = await testRender(<App initialState={initialState} crawlRunner={crawlRunner} providerLabel="claude" />, {
      width: 100,
      height: 60,
    });
    destroy = () => setup.renderer.destroy();
    const frame = async () => {
      await act(async () => {
        await setup.renderOnce();
      });
      return setup.captureCharFrame();
    };
    return { frame };
  }

  const summary: CrawlSummary = {
    path: "authored",
    fields: [
      { name: "title", type: "string", found: true, value: "Clock" },
      { name: "price", type: "number", found: true, value: 49 },
      { name: "brand", type: "string", found: false, value: null },
    ],
    artifactFolder: "data/example.com/pages/abc",
    templatePath: "data/example.com/templates/t.json",
    warnings: ["brand: Selector matched no elements"],
  };

  it("shows each field with its value on the done screen", async () => {
    const done = reduceSessionState(reduceSessionState(suggestionPending(), { type: "crawl-started" }), {
      type: "crawl-finished",
      summary,
    });
    const frame = await (await render(done)).frame();

    expect(frame).toContain("Phase: Done");
    expect(frame).toContain("title: Clock");
    expect(frame).toContain("price: 49");
    expect(frame).toContain("brand: not found");
    expect(frame).toContain("Agent: claude");
  });

  it("shows the error text on the failed screen", async () => {
    const failed = reduceSessionState(reduceSessionState(suggestionPending(), { type: "crawl-started" }), {
      type: "crawl-failed",
      message: "Claude Code: `claude` was not found on PATH.",
    });
    const frame = await (await render(failed)).frame();

    expect(frame).toContain("Phase: Failed");
    expect(frame).toContain("`claude` was not found on PATH.");
  });

  it("shows the running screen while the runner works, then the result", async () => {
    let finish: (outcome: CrawlOutcome) => void = () => {};
    const runner: CrawlRunner = {
      startCrawl: () => new Promise<CrawlOutcome>(resolve => (finish = resolve)),
    };
    const { frame } = await render(suggestionPending(), runner);

    expect(await frame()).toContain("Phase: Crawl Running");

    await act(async () => {
      finish({
        target: "https://example.com/products/clock-1",
        finalUrl: "https://example.com/products/clock-1",
        urlPattern: "/products/:slug",
        path: "authored",
        schema: { title: "string" },
        result: {
          payload: { title: "Clock" },
          fieldResults: {
            title: {
              fieldName: "title",
              type: "string",
              rawValue: "Clock",
              normalizedValue: "Clock",
              selectorUsed: { kind: "css", selector: "h1", attribute: "textContent", score: 90, reusable: true },
              confidence: 90,
              warnings: [],
              candidatesTried: [],
            },
          },
          confidence: 90,
          templateId: "t",
          usedTemplate: true,
          llmUsed: false,
          warnings: [],
        },
        llmUsed: true,
        provider: "claude",
        templateId: "t",
        templatePath: "data/example.com/templates/t.json",
        artifactFolder: "data/example.com/pages/abc",
        warnings: [],
      });
    });

    const after = await frame();
    expect(after).toContain("Phase: Done");
    expect(after).toContain("title: Clock");
  });

  it("shows the error from a runner that rejects", async () => {
    const runner: CrawlRunner = {
      startCrawl: async () => {
        throw new Error("browserType.launch: Executable doesn't exist");
      },
    };
    const { frame } = await render(suggestionPending(), runner);
    await act(async () => {
      await Promise.resolve();
    });

    const text = await frame();
    expect(text).toContain("Phase: Failed");
    expect(text).toContain("npx playwright install chromium");
  });
});
