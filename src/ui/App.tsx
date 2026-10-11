import { useEffect, useRef, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { runPendingCrawlStart, type CrawlOutcome, type CrawlRunner } from "../core/crawl-run.ts";
import { describeRuntimeError } from "../core/headless.ts";
import {
  discoverTemplateReuse,
  type TemplateReuseDiscovery,
} from "../core/reuse-discovery.ts";
import {
  createSessionViewModel,
  formatSchemaProperty,
  reduceSessionState,
  type CrawlSummary,
  type SessionEvent,
  type SessionState,
  type SessionViewModel,
} from "../core/session-state.ts";

function isEnterKey(name: string): boolean {
  return name === "enter" || name === "return";
}

function inputText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

export function toCrawlSummary(outcome: CrawlOutcome): CrawlSummary {
  return {
    path: outcome.path,
    fields: Object.entries(outcome.result.fieldResults).map(([name, field]) => ({
      name,
      type: field.type,
      found: field.selectorUsed !== null,
      value: field.normalizedValue,
    })),
    artifactFolder: outcome.artifactFolder,
    templatePath: outcome.templatePath,
    warnings: outcome.warnings,
  };
}

export function getAppCopy(model: SessionViewModel): string[] {
  const propertyLines =
    model.properties.length === 0
      ? ["No fields added yet."]
      : model.properties.map((property, index) => `${index + 1}. ${formatSchemaProperty(property)}`);

  const typeLines =
    model.phase === "schema-type"
      ? model.availableTypes.map((entry) => `${entry.selected ? ">" : " "} ${entry.value}`)
      : [];
  const schemaPreviewLines =
    model.phase === "schema-select"
      ? model.schemaPreviews.map((schema) => {
          const fields = schema.fieldSummaries
            .map((field) => `${field.name}: ${field.type}`)
            .join(", ");
          return `${schema.selected ? ">" : " "} ${schema.label} (${fields})`;
        })
      : [];
  const warningLines = model.reuseWarnings.map((warning) => `Warning: ${warning.message}`);
  const ambiguousTemplateLines =
    model.phase === "reuse-blocked"
      ? model.ambiguousTemplates.map((candidate) => `Template: ${candidate.path}`)
      : [];

  return [
    model.subtitle,
    `Target: ${model.target}`,
    `Phase: ${model.phaseLabel}`,
    `Status: ${model.status}`,
    `Instruction: ${model.instruction}`,
    ...(model.validationError ? [`Error: ${model.validationError}`] : []),
    ...propertyLines,
    ...typeLines,
    ...schemaPreviewLines,
    ...warningLines,
    ...ambiguousTemplateLines,
    ...model.hints.map((hint) => `Hint: ${hint}`),
  ];
}

function SchemaSummary({ model }: { model: SessionViewModel }) {
  return (
    <box
      title="Schema"
      style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
    >
      {model.properties.length === 0 ? (
        <text fg="#94a3b8">No schema properties yet.</text>
      ) : (
        model.properties.map((property, index) => (
          <text key={`${property.name}-${property.type}-${index}`}>
            {index + 1}. {formatSchemaProperty(property)}
          </text>
        ))
      )}
    </box>
  );
}

function PhasePanel({
  state,
  model,
  dispatch,
}: {
  state: SessionState;
  model: SessionViewModel;
  dispatch(event: SessionEvent): void;
}) {
  if(state.phase === "target-url") {
    return (
      <box
        title="Target URL"
        style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
      >
        <text>{model.instruction}</text>
        <box title="Target URL" style={{ border: true, height: 3 }}>
          <input
            focused
            value={state.target}
            placeholder="e.g. https://example.com"
            onInput={(value) => dispatch({ type: "update-target-url", value: inputText(value) })}
            onSubmit={(value) => dispatch({ type: "submit-target-url", value: inputText(value) })}
          />
        </box>
        <text fg="#94a3b8">Press Enter to submit the target URL.</text>
      </box>
    );
  }

  if (state.phase === "schema-name") {
    return (
      <box
        title="New Property"
        style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
      >
        <text>{model.instruction}</text>
        <box title="Property Name" style={{ border: true, height: 3 }}>
          <input
            focused
            value={state.draftPropertyName}
            placeholder="e.g. productTitle"
            onInput={(value) => dispatch({ type: "update-draft-name", value: inputText(value) })}
            onSubmit={(value) => dispatch({ type: "submit-name", value: inputText(value) })}
          />
        </box>
        <text fg="#94a3b8">
          {state.properties.length === 0
            ? "Press Tab now to let the agent suggest the fields."
            : "Press Tab to review the schema."}
        </text>
      </box>
    );
  }

  if (state.phase === "schema-select") {
    return (
      <box
        title="Schema Selection"
        style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
      >
        <text>{model.instruction}</text>
        {model.schemaPreviews.map((schema) => (
          <text key={schema.id} fg={schema.selected ? "#facc15" : "#e2e8f0"}>
            {schema.selected ? ">" : " "} {schema.label} -{" "}
            {schema.fieldSummaries.map((field) => `${field.name}: ${field.type}`).join(", ")}
          </text>
        ))}
        <text fg="#94a3b8">Enter reuses the selected schema. Esc creates a new schema.</text>
      </box>
    );
  }

  if (state.phase === "schema-type") {
    return (
      <box
        title="Choose Type"
        style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
      >
        <text>Property: {state.draftPropertyName}</text>
        {model.availableTypes.map((entry) => (
          <text key={entry.value} fg={entry.selected ? "#facc15" : "#e2e8f0"}>
            {entry.selected ? ">" : " "} {entry.value}
          </text>
        ))}
      </box>
    );
  }

  if (state.phase === "schema-review") {
    return (
      <box
        title="Review"
        style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
      >
        <text>{model.instruction}</text>
        <text fg="#94a3b8">Press Enter to start the crawl or Esc to keep editing the schema.</text>
      </box>
    );
  }

  if (state.phase === "crawl-done" && model.crawlSummary) {
    return (
      <box
        title="Result"
        style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
      >
        <text>{model.instruction}</text>
        {model.crawlSummary.fields.map((field) => (
          <text key={field.name} fg={field.found ? "#e2e8f0" : "#94a3b8"}>
            {field.found ? "✓" : "✗"} {field.name}: {field.found ? formatValue(field.value) : "not found"}
          </text>
        ))}
        {model.crawlSummary.warnings.map((warning) => (
          <text key={warning} fg="#facc15">
            Warning: {warning}
          </text>
        ))}
      </box>
    );
  }

  if (state.phase === "crawl-failed") {
    return (
      <box
        title="Error"
        style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
      >
        <text fg="#f87171">{model.instruction}</text>
      </box>
    );
  }

  if (state.phase === "crawl-pending") {
    return (
      <box
        title="Starting"
        style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
      >
        <text>{model.instruction}</text>
      </box>
    );
  }

  return (
    <box
      title="Crawler"
      style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
    >
      <text>{model.instruction}</text>
      <text fg="#94a3b8">{model.status}</text>
    </box>
  );
}

export function App({
  initialState,
  crawlRunner,
  templateReuseDiscovery = discoverTemplateReuse,
  providerLabel,
}: {
  initialState: SessionState;
  crawlRunner: CrawlRunner;
  templateReuseDiscovery?: TemplateReuseDiscovery;
  providerLabel?: string;
}) {
  const [state, setState] = useState(initialState);
  const renderer = useRenderer();
  const model = createSessionViewModel(state);
  const pendingCrawlRequested = useRef(false);

  const dispatch = (event: SessionEvent) => {
    setState((current) => reduceSessionState(current, event));
  };

  useEffect(() => {
    if (state.phase !== "reuse-discovery") {
      return;
    }

    let cancelled = false;

    void (async () => {
      const template = await templateReuseDiscovery(state.target);

      if (cancelled) {
        return;
      }

      if (template.ambiguousTemplates.length > 0) {
        dispatch({
          type: "template-reuse-ambiguous",
          templates: template.ambiguousTemplates,
          warnings: template.warnings,
        });
        return;
      }

      if (template.template) {
        dispatch({
              type: "template-reuse-found",
          template: template.template,
        });
        return;
      }

      dispatch({
        type: "schema-reuse-options",
        schemas: template.schemas,
        warnings: template.warnings,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [state.phase, state.target, templateReuseDiscovery]);

  useEffect(() => {
    if (state.phase !== "crawl-pending") {
      pendingCrawlRequested.current = false;
      return;
    }

    if (pendingCrawlRequested.current) {
      return;
    }

    pendingCrawlRequested.current = true;

    const pendingState = state;
    dispatch({ type: "crawl-started" });

    void (async () => {
      try {
        const outcome = await runPendingCrawlStart(pendingState, crawlRunner);
        if (outcome) {
          dispatch({ type: "crawl-finished", summary: toCrawlSummary(outcome) });
        }
      } catch (error) {
        dispatch({
          type: "crawl-failed",
          message: describeRuntimeError(error),
        });
      }
    })();
  }, [crawlRunner, state]);

  useKeyboard((key) => {
    if (key.name === "q") {
      renderer?.destroy();
      return;
    }

    if (state.phase === "schema-name") {
      if (key.name === "tab" && state.properties.length > 0) {
        dispatch({ type: "review-schema" });
      }

      if (key.name === "tab" && state.properties.length === 0 && state.draftPropertyName.trim() === "") {
        dispatch({ type: "start-crawl-with-suggestion" });
      }

      if (key.name === "escape" && state.draftPropertyName.trim() === "") {
        dispatch({ type: "remove-last-property" });
      }

      return;
    }

    if (state.phase === "schema-select") {
      if (key.name === "up") {
        dispatch({ type: "select-previous-schema" });
      }

      if (key.name === "down") {
        dispatch({ type: "select-next-schema" });
      }

      if (isEnterKey(key.name)) {
        dispatch({ type: "confirm-schema-reuse" });
      }

      if (key.name === "escape") {
        dispatch({ type: "skip-schema-reuse" });
      }

      return;
    }

    if (state.phase === "schema-type") {
      if (key.name === "up") {
        dispatch({ type: "select-previous-type" });
      }

      if (key.name === "down") {
        dispatch({ type: "select-next-type" });
      }

      if (isEnterKey(key.name)) {
        dispatch({ type: "confirm-property" });
      }

      if (key.name === "escape") {
        dispatch({ type: "back-to-editor" });
      }

      return;
    }

    if (state.phase === "schema-review") {
      if (isEnterKey(key.name)) {
        dispatch({ type: "start-crawl" });
      }

      if (key.name === "escape") {
        dispatch({ type: "back-to-editor" });
      }

      return;
    }

    if (
      (state.phase === "crawl-running" || state.phase === "crawl-done" || state.phase === "crawl-failed") &&
      key.name === "escape"
    ) {
      renderer?.destroy();
    }
  });

  return (
    <box style={{ width: "100%", height: "100%", padding: 1, flexDirection: "column", gap: 1 }}>
      <box
        title={model.title}
        style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
      >
        <text fg="#7dd3fc">{model.subtitle}</text>
        <text>Target: {model.target}</text>
        {providerLabel ? <text>Agent: {providerLabel}</text> : null}
        <text>Phase: {model.phaseLabel}</text>
        <text>Status: {model.status}</text>
        {model.validationError ? <text fg="#f87171">Error: {model.validationError}</text> : null}
      </box>

      <PhasePanel state={state} model={model} dispatch={dispatch} />
      <SchemaSummary model={model} />

      <box
        title="Hints"
        style={{ border: true, borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 }}
      >
        {model.hints.map((hint) => (
          <text key={hint}>{hint}</text>
        ))}
      </box>
    </box>
  );
}
