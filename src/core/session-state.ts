import type { InteractiveSessionInput } from "./session.ts";
import type { FieldType } from "./llm-extractor/types.ts";
import type { ExtractionTemplate } from "./templating/types.ts";
import type { ReuseWarning, SchemaPreview, TemplateMatchCandidate } from "./domain-store.ts";

export const PROPERTY_TYPES = ["string", "number", "boolean", "date", "url", "text"] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number];

export type SchemaProperty = {
  name: string;
  type: PropertyType;
};

export type SessionPhase =
  | "target-url"
  | "reuse-discovery"
  | "schema-select"
  | "reuse-blocked"
  | "schema-name"
  | "schema-type"
  | "schema-review"
  | "crawl-pending"
  | "crawl-running"
  | "crawl-done"
  | "crawl-failed";

export type CrawlSummary = {
  path: "template-reuse" | "existing-template" | "authored";
  fields: Array<{ name: string; type: string; found: boolean; value: unknown }>;
  artifactFolder: string;
  templatePath: string | null;
  warnings: string[];
};

export type ReuseSource = "schema-builder" | "template-reuse" | "selected-schema";

export type SessionState = {
  target: string;
  modeLabel: "interactive";
  properties: SchemaProperty[];
  draftTargetUrl: string;
  draftPropertyName: string;
  selectedTypeIndex: number;
  validationError: string | null;
  phase: SessionPhase;
  crawlStarted: boolean;
  reuseSource: ReuseSource;
  matchedTemplate: ExtractionTemplate | null;
  schemaPreviews: SchemaPreview[];
  selectedSchemaIndex: number;
  selectedSchema: SchemaPreview | null;
  reuseWarnings: ReuseWarning[];
  ambiguousTemplates: TemplateMatchCandidate[];
  crawlSummary: CrawlSummary | null;
  crawlError: string | null;
};

export type SessionEvent =
  | { type: "update-target-url"; value: string }
  | { type: "submit-target-url"; value: string }
  | { type: "no-template-reuse" }
  | { type: "schema-reuse-options"; schemas: SchemaPreview[]; warnings?: ReuseWarning[] }
  | { type: "template-reuse-found"; template: ExtractionTemplate }
  | { type: "template-reuse-ambiguous"; templates: TemplateMatchCandidate[]; warnings?: ReuseWarning[] }
  | { type: "select-next-schema" }
  | { type: "select-previous-schema" }
  | { type: "confirm-schema-reuse" }
  | { type: "skip-schema-reuse" }
  | { type: "update-draft-name"; value: string }
  | { type: "submit-name"; value?: string }
  | { type: "select-next-type" }
  | { type: "select-previous-type" }
  | { type: "confirm-property" }
  | { type: "remove-last-property" }
  | { type: "review-schema" }
  | { type: "back-to-editor" }
  | { type: "start-crawl" }
  | { type: "start-crawl-with-suggestion" }
  | { type: "crawl-started" }
  | { type: "crawl-finished"; summary: CrawlSummary }
  | { type: "crawl-failed"; message: string };

export type SessionViewModel = {
  title: string;
  subtitle: string;
  target: string;
  phase: SessionPhase;
  phaseLabel: string;
  instruction: string;
  status: string;
  draftPropertyName: string;
  selectedTypeIndex: number;
  availableTypes: Array<{ value: PropertyType; selected: boolean }>;
  properties: SchemaProperty[];
  validationError: string | null;
  hints: string[];
  schemaPreviews: Array<SchemaPreview & { selected: boolean }>;
  selectedSchemaPreview: SchemaPreview | null;
  reuseWarnings: ReuseWarning[];
  ambiguousTemplates: TemplateMatchCandidate[];
  crawlSummary: CrawlSummary | null;
  crawlError: string | null;
};

export function createInitialSessionState(input: InteractiveSessionInput): SessionState {
  return {
    target: input.target,
    modeLabel: "interactive",
    properties: [],
    draftTargetUrl: "",
    draftPropertyName: "",
    selectedTypeIndex: 0,
    validationError: null,
    phase: "target-url",
    crawlStarted: false,
    reuseSource: "schema-builder",
    matchedTemplate: null,
    schemaPreviews: [],
    selectedSchemaIndex: 0,
    selectedSchema: null,
    reuseWarnings: [],
    ambiguousTemplates: [],
    crawlSummary: null,
    crawlError: null,
  };
}

export function reduceSessionState(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "update-target-url":
      return {
        ...state,
        draftTargetUrl: event.value,
        validationError: null,
      };

    case "submit-target-url": {
      const target = event.value.trim();

      if (!target) {
        return {
          ...state,
          validationError: "Target URL is required.",
          phase: "target-url",
        };
      }

      return {
        ...state,
        target,
        validationError: null,
        phase: "reuse-discovery",
        reuseSource: "schema-builder",
        matchedTemplate: null,
        schemaPreviews: [],
        selectedSchemaIndex: 0,
        selectedSchema: null,
        reuseWarnings: [],
        ambiguousTemplates: [],
      };
    }

    case "no-template-reuse":
      if (state.phase !== "reuse-discovery") {
        return state;
      }

      return {
        ...state,
        validationError: null,
        phase: "schema-name",
        reuseSource: "schema-builder",
        matchedTemplate: null,
      };

    case "schema-reuse-options":
      if (state.phase !== "reuse-discovery") {
        return state;
      }

      if (event.schemas.length === 0) {
        return {
          ...state,
          validationError: null,
          phase: "schema-name",
          reuseSource: "schema-builder",
          matchedTemplate: null,
          schemaPreviews: [],
          selectedSchemaIndex: 0,
          selectedSchema: null,
          reuseWarnings: event.warnings ?? [],
          ambiguousTemplates: [],
        };
      }

      return {
        ...state,
        validationError: null,
        phase: "schema-select",
        reuseSource: "schema-builder",
        matchedTemplate: null,
        schemaPreviews: event.schemas,
        selectedSchemaIndex: 0,
        selectedSchema: null,
        reuseWarnings: event.warnings ?? [],
        ambiguousTemplates: [],
      };

    case "template-reuse-found":
      if (state.phase !== "reuse-discovery") {
        return state;
      }

      return {
        ...state,
        properties: schemaToProperties(event.template.schema),
        draftPropertyName: "",
        selectedTypeIndex: 0,
        validationError: null,
        phase: "crawl-pending",
        reuseSource: "template-reuse",
        matchedTemplate: event.template,
        schemaPreviews: [],
        selectedSchemaIndex: 0,
        selectedSchema: null,
        ambiguousTemplates: [],
      };

    case "template-reuse-ambiguous":
      if (state.phase !== "reuse-discovery") {
        return state;
      }

      return {
        ...state,
        validationError:
          "Multiple matching templates were found for this URL pattern. Resolve the duplicate templates before crawling.",
        phase: "reuse-blocked",
        reuseSource: "schema-builder",
        matchedTemplate: null,
        schemaPreviews: [],
        selectedSchemaIndex: 0,
        selectedSchema: null,
        reuseWarnings: event.warnings ?? [],
        ambiguousTemplates: event.templates,
      };

    case "select-next-schema":
      if (state.phase !== "schema-select" || state.schemaPreviews.length === 0) {
        return state;
      }

      return {
        ...state,
        selectedSchemaIndex: (state.selectedSchemaIndex + 1) % state.schemaPreviews.length,
      };

    case "select-previous-schema":
      if (state.phase !== "schema-select" || state.schemaPreviews.length === 0) {
        return state;
      }

      return {
        ...state,
        selectedSchemaIndex:
          (state.selectedSchemaIndex - 1 + state.schemaPreviews.length) %
          state.schemaPreviews.length,
      };

    case "confirm-schema-reuse": {
      if (state.phase !== "schema-select") {
        return state;
      }

      const selectedSchema = state.schemaPreviews[state.selectedSchemaIndex];

      if (!selectedSchema) {
        return {
          ...state,
          validationError: "Select a schema before continuing.",
        };
      }

      return {
        ...state,
        properties: selectedSchema.fieldSummaries.map(({ name, type }) => ({ name, type })),
        selectedSchema,
        validationError: null,
        phase: "schema-review",
        reuseSource: "selected-schema",
        matchedTemplate: null,
      };
    }

    case "skip-schema-reuse":
      if (state.phase !== "schema-select") {
        return state;
      }

      return {
        ...state,
        properties: [],
        selectedSchema: null,
        selectedSchemaIndex: 0,
        validationError: null,
        phase: "schema-name",
        reuseSource: "schema-builder",
        matchedTemplate: null,
      };

    case "update-draft-name":
      return {
        ...state,
        draftPropertyName: event.value,
        validationError: null,
      };

    case "submit-name": {
      const nextName = (event.value ?? state.draftPropertyName).trim();

      if (!nextName) {
        return {
          ...state,
          draftPropertyName: event.value ?? state.draftPropertyName,
          validationError: "Property name is required before choosing a type.",
          phase: "schema-name",
        };
      }

      return {
        ...state,
        draftPropertyName: nextName,
        validationError: null,
        phase: "schema-type",
      };
    }

    case "select-next-type":
      if (state.phase !== "schema-type") {
        return state;
      }

      return {
        ...state,
        selectedTypeIndex: (state.selectedTypeIndex + 1) % PROPERTY_TYPES.length,
      };

    case "select-previous-type":
      if (state.phase !== "schema-type") {
        return state;
      }

      return {
        ...state,
        selectedTypeIndex:
          (state.selectedTypeIndex - 1 + PROPERTY_TYPES.length) % PROPERTY_TYPES.length,
      };

    case "confirm-property": {
      const name = state.draftPropertyName.trim();
      const selectedType = PROPERTY_TYPES[state.selectedTypeIndex] ?? PROPERTY_TYPES[0];

      if (!name) {
        return {
          ...state,
          validationError: "Property name is required before adding a field.",
          phase: "schema-name",
        };
      }

      return {
        ...state,
        properties: [
          ...state.properties,
          {
            name,
            type: selectedType,
          },
        ],
        draftPropertyName: "",
        selectedTypeIndex: 0,
        validationError: null,
        phase: "schema-name",
      };
    }

    case "remove-last-property":
      if (state.properties.length === 0) {
        return state;
      }

      return {
        ...state,
        properties: state.properties.slice(0, -1),
        validationError: null,
        phase: "schema-name",
      };

    case "review-schema":
      if (state.properties.length === 0) {
        return {
          ...state,
          validationError: "Add at least one property before moving to schema review.",
          phase: "schema-name",
        };
      }

      return {
        ...state,
        validationError: null,
        phase: "schema-review",
      };

    case "back-to-editor":
      return {
        ...state,
        validationError: null,
        phase: "schema-name",
        reuseSource: "schema-builder",
        selectedSchema: null,
      };

    case "start-crawl":
      if (state.phase !== "schema-review" || state.properties.length === 0) {
        return {
          ...state,
          validationError: "Review at least one schema property before starting the crawl.",
        };
      }

      return {
        ...state,
        validationError: null,
        phase: "crawl-pending",
        reuseSource: state.reuseSource === "selected-schema" ? "selected-schema" : "schema-builder",
        matchedTemplate: null,
      };

    case "start-crawl-with-suggestion":
      if (state.phase !== "schema-name" || state.properties.length > 0) {
        return state;
      }

      return {
        ...state,
        validationError: null,
        phase: "crawl-pending",
        reuseSource: "schema-builder",
        matchedTemplate: null,
      };

    case "crawl-started":
      if (state.phase !== "crawl-pending") {
        return state;
      }

      return {
        ...state,
        phase: "crawl-running",
        crawlStarted: true,
      };

    case "crawl-finished":
      if (state.phase !== "crawl-running" && state.phase !== "crawl-pending") {
        return state;
      }

      return {
        ...state,
        phase: "crawl-done",
        crawlStarted: true,
        crawlSummary: event.summary,
        crawlError: null,
      };

    case "crawl-failed":
      if (state.phase !== "crawl-running" && state.phase !== "crawl-pending") {
        return state;
      }

      return {
        ...state,
        phase: "crawl-failed",
        crawlSummary: null,
        crawlError: event.message,
      };
  }
}

export function formatSchemaProperty(property: SchemaProperty): string {
  return `${property.name}: ${property.type}`;
}

export function createSessionViewModel(state: SessionState): SessionViewModel {
  const availableTypes = PROPERTY_TYPES.map((value, index) => ({
    value,
    selected: index === state.selectedTypeIndex,
  }));
  const schemaPreviews = state.schemaPreviews.map((schema, index) => ({
    ...schema,
    selected: index === state.selectedSchemaIndex,
  }));
  const selectedSchemaPreview = state.schemaPreviews[state.selectedSchemaIndex] ?? null;
  const common = {
    schemaPreviews,
    selectedSchemaPreview,
    reuseWarnings: state.reuseWarnings,
    ambiguousTemplates: state.ambiguousTemplates,
    crawlSummary: state.crawlSummary,
    crawlError: state.crawlError,
  };

  switch (state.phase) {
    case "target-url":
      return {
        title: "Turbo Crawl",
        subtitle: "Enter the URL of the website you want to crawl.",
        target: state.target,
        phase: state.phase,
        phaseLabel: "Target URL",
        instruction: "Enter the URL of the website you want to crawl.",
        status: "No target URL entered.",
        // draftTargetUrl: state.draftTargetUrl,
        draftPropertyName: state.draftPropertyName,
        selectedTypeIndex: state.selectedTypeIndex,
        availableTypes,
        properties: [],
        validationError: state.validationError,
        hints: [
          "Enter submits the target URL.",
          "Press q to quit.",
        ],
        ...common,
      };

    case "reuse-discovery":
      return {
        title: "Turbo Crawl",
        subtitle: "Checking stored templates for this URL pattern.",
        target: state.target,
        phase: state.phase,
        phaseLabel: "Reuse Discovery",
        instruction: "Looking for a matching template before schema authoring.",
        status: "Checking for a matching template.",
        draftPropertyName: state.draftPropertyName,
        selectedTypeIndex: state.selectedTypeIndex,
        availableTypes,
        properties: state.properties,
        validationError: state.validationError,
        hints: [
          "A matching template starts extraction without LLM use.",
          "If no template matches, schema authoring will open.",
          "Press q to quit.",
        ],
        ...common,
      };

    case "schema-select":
      return {
        title: "Turbo Crawl",
        subtitle: "Select an existing schema for this domain.",
        target: state.target,
        phase: state.phase,
        phaseLabel: "Schema Selection",
        instruction: "Choose a stored schema to reuse, or skip to create a new one.",
        status: `${state.schemaPreviews.length} reusable schema${state.schemaPreviews.length === 1 ? "" : "s"} available.`,
        draftPropertyName: state.draftPropertyName,
        selectedTypeIndex: state.selectedTypeIndex,
        availableTypes,
        properties: selectedSchemaPreview?.fieldSummaries.map(({ name, type }) => ({ name, type })) ?? [],
        validationError: state.validationError,
        hints: [
          "Up/Down changes the selected schema.",
          "Enter reuses the selected schema.",
          "Esc skips reuse and opens schema authoring.",
          "Press q to quit.",
        ],
        ...common,
      };

    case "reuse-blocked":
      return {
        title: "Turbo Crawl",
        subtitle: "Template reuse needs attention.",
        target: state.target,
        phase: state.phase,
        phaseLabel: "Reuse Blocked",
        instruction: "Resolve duplicate or incompatible templates before this crawl can continue.",
        status: `${state.ambiguousTemplates.length} matching templates require review.`,
        draftPropertyName: state.draftPropertyName,
        selectedTypeIndex: state.selectedTypeIndex,
        availableTypes,
        properties: state.properties,
        validationError: state.validationError,
        hints: [
          "Inspect the listed template artifacts.",
          "Remove or fix duplicates, then restart the crawl.",
          "Press q to quit.",
        ],
        ...common,
      };

    case "schema-name":
      return {
        title: "Turbo Crawl",
        subtitle: "Define the schema you want this crawl to produce.",
        target: state.target,
        phase: state.phase,
        phaseLabel: "Schema Builder",
        instruction: "Enter a property name and press Enter to choose its data type.",
        status:
          state.properties.length === 0
            ? "No schema properties yet."
            : `${state.properties.length} schema propert${state.properties.length === 1 ? "y" : "ies"} ready.`,
        draftPropertyName: state.draftPropertyName,
        selectedTypeIndex: state.selectedTypeIndex,
        availableTypes,
        properties: state.properties,
        validationError: state.validationError,
        hints: [
          "Enter submits the property name.",
          "Tab moves to schema review once you have at least one property.",
          "Tab with no properties lets the agent suggest the fields and starts the crawl.",
          "Esc removes the last property when the draft is empty.",
          "Press q to quit.",
        ],
        ...common,
      };

    case "schema-type":
      return {
        title: "Turbo Crawl",
        subtitle: "Choose the data type for the current property.",
        target: state.target,
        phase: state.phase,
        phaseLabel: "Property Type",
        instruction: `Select the type for "${state.draftPropertyName}".`,
        status: `Current type: ${PROPERTY_TYPES[state.selectedTypeIndex]}`,
        draftPropertyName: state.draftPropertyName,
        selectedTypeIndex: state.selectedTypeIndex,
        availableTypes,
        properties: state.properties,
        validationError: state.validationError,
        hints: [
          "Up/Down changes the selected type.",
          "Enter confirms the property and returns to schema authoring.",
          "Esc goes back to the property name step.",
          "Press q to quit.",
        ],
        ...common,
      };

    case "schema-review":
      return {
        title: "Turbo Crawl",
        subtitle: "Review the schema before the crawler starts.",
        target: state.target,
        phase: state.phase,
        phaseLabel: "Review Schema",
        instruction: "Confirm the fields below, then start the crawl.",
        status: `Ready to crawl with ${state.properties.length} field${state.properties.length === 1 ? "" : "s"}.`,
        draftPropertyName: state.draftPropertyName,
        selectedTypeIndex: state.selectedTypeIndex,
        availableTypes,
        properties: state.properties,
        validationError: state.validationError,
        hints: [
          "Enter starts the crawl session.",
          "Esc returns to schema authoring.",
          "Press q to quit.",
        ],
        ...common,
      };

    case "crawl-pending":
      if (state.reuseSource === "template-reuse" && state.matchedTemplate) {
        return {
          title: "Turbo Crawl",
          subtitle: "Starting the crawl session with a stored template.",
          target: state.target,
          phase: state.phase,
          phaseLabel: "Starting Crawl",
          instruction: "Extracting with the matched template.",
          status: `Reusing template ${state.matchedTemplate.urlPattern} without LLM extraction.`,
          draftPropertyName: state.draftPropertyName,
          selectedTypeIndex: state.selectedTypeIndex,
          availableTypes,
          properties: state.properties,
          validationError: state.validationError,
          hints: [
            "Template extraction skips compact packet and LLM artifacts.",
            "Press q to quit.",
          ],
          ...common,
        };
      }

      if (state.reuseSource === "selected-schema" && state.selectedSchema) {
        return {
          title: "Turbo Crawl",
          subtitle: "Starting the crawl session with a selected schema.",
          target: state.target,
          phase: state.phase,
          phaseLabel: "Starting Crawl",
          instruction: "Preparing the crawler with the selected stored schema.",
          status: `Reusing schema ${state.selectedSchema.label} for bootstrap extraction.`,
          draftPropertyName: state.draftPropertyName,
          selectedTypeIndex: state.selectedTypeIndex,
          availableTypes,
          properties: state.properties,
          validationError: state.validationError,
          hints: ["Press q to quit."],
          ...common,
        };
      }

      return {
        title: "Turbo Crawl",
        subtitle: "Starting the crawl session.",
        target: state.target,
        phase: state.phase,
        phaseLabel: "Starting Crawl",
        instruction: "Preparing the crawler with the selected schema.",
        status: "Booting crawl session...",
        draftPropertyName: state.draftPropertyName,
        selectedTypeIndex: state.selectedTypeIndex,
        availableTypes,
        properties: state.properties,
        validationError: state.validationError,
        hints: ["Press q to quit."],
        ...common,
      };

    case "crawl-running":
      if (state.reuseSource === "template-reuse" && state.matchedTemplate) {
        return {
          title: "Turbo Crawl",
          subtitle: "Crawler session using a stored template.",
          target: state.target,
          phase: state.phase,
          phaseLabel: "Crawl Running",
          instruction: `Using template ${state.matchedTemplate.urlPattern} for extraction.`,
          status: "Template extraction is running without an LLM request.",
          draftPropertyName: state.draftPropertyName,
          selectedTypeIndex: state.selectedTypeIndex,
          availableTypes,
          properties: state.properties,
          validationError: state.validationError,
          hints: [
            "Matching URL patterns reuse existing templates when available.",
            "Press q or Esc to exit.",
          ],
          ...common,
        };
      }

      if (state.reuseSource === "selected-schema" && state.selectedSchema) {
        return {
          title: "Turbo Crawl",
          subtitle: "Crawler session using a selected schema.",
          target: state.target,
          phase: state.phase,
          phaseLabel: "Crawl Running",
          instruction: `Using selected schema ${state.selectedSchema.label} for extraction.`,
          status: "Selected schema bootstrap is running.",
          draftPropertyName: state.draftPropertyName,
          selectedTypeIndex: state.selectedTypeIndex,
          availableTypes,
          properties: state.properties,
          validationError: state.validationError,
          hints: [
            "A template will be saved for this URL pattern when extraction succeeds.",
            "Press q or Esc to exit.",
          ],
          ...common,
        };
      }

      return {
        title: "Turbo Crawl",
        subtitle: "Crawler session storing domain artifacts.",
        target: state.target,
        phase: state.phase,
        phaseLabel: "Crawl Running",
        instruction: "Artifacts are written under data/<domain> for restart, template reuse, and export.",
        status: "Schema, templates, page packets, optional LLM output, and results are persisted locally.",
        draftPropertyName: state.draftPropertyName,
        selectedTypeIndex: state.selectedTypeIndex,
        availableTypes,
        properties: state.properties,
        validationError: state.validationError,
        hints: [
          "Matching URL patterns reuse existing templates when available.",
          "Filesystem failures include the artifact path that could not be saved.",
          "Press q or Esc to exit.",
        ],
        ...common,
      };

    case "crawl-done": {
      const summary = state.crawlSummary;
      const found = summary?.fields.filter((field) => field.found).length ?? 0;
      const total = summary?.fields.length ?? 0;
      const how =
        summary?.path === "authored"
          ? "The agent wrote a new template for this URL pattern."
          : "A saved template was reused; no model was called.";

      return {
        title: "Turbo Crawl",
        subtitle: "Crawl finished.",
        target: state.target,
        phase: state.phase,
        phaseLabel: "Done",
        instruction: `${found} of ${total} fields found. ${how}`,
        status: summary ? `Saved under ${summary.artifactFolder}` : "Saved.",
        draftPropertyName: state.draftPropertyName,
        selectedTypeIndex: state.selectedTypeIndex,
        availableTypes,
        properties: state.properties,
        validationError: state.validationError,
        hints: ["Press q to quit."],
        ...common,
      };
    }

    case "crawl-failed":
      return {
        title: "Turbo Crawl",
        subtitle: "Crawl failed.",
        target: state.target,
        phase: state.phase,
        phaseLabel: "Failed",
        instruction: state.crawlError ?? "Unknown error.",
        status: "Nothing was saved for this page.",
        draftPropertyName: state.draftPropertyName,
        selectedTypeIndex: state.selectedTypeIndex,
        availableTypes,
        properties: state.properties,
        validationError: state.validationError,
        hints: ["Press q to quit."],
        ...common,
      };
  }
}

function schemaToProperties(schema: Record<string, FieldType>): SchemaProperty[] {
  return Object.entries(schema)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, type]) => ({
      name,
      type,
    }));
}
