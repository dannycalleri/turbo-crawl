export const FIELD_TYPES = ["string", "number", "boolean", "date", "url", "text", "pairs"] as const;

export type FieldType = typeof FIELD_TYPES[number];

export function isFieldType(value: unknown): value is FieldType {
    return (FIELD_TYPES as readonly unknown[]).includes(value);
}

export type UserSchema = Record<string, FieldType>;

/** A pairs value with fewer label/value pairs than this is null. */
export const MIN_PAIRS = 3;

export type FieldEvidence = {
  sourceNodeId: string | null;
  quotedText: string | null;
  confidence: number;
  reason: EvidenceReason;
};

export const EVIDENCE_REASON_VALUES = [
  "found_in_jsonld",
  "found_in_metadata",
  "found_in_visible_text",
  "found_in_table",
  "found_in_image",
  "found_in_link",
  "found_in_url",
  "inferred_from_context",
  "not_found",
] as const;

export type EvidenceReason = typeof EVIDENCE_REASON_VALUES[number];

export type RawLLMExtraction = {
  payload: Record<string, unknown>;
  evidence: Record<string, FieldEvidence>;
};

export type FieldReport = {
  fieldName: string;
  type: FieldType;

  rawValue: unknown;
  normalizedValue: unknown;

  evidence: FieldEvidence | null;
  sourceNodeExists: boolean;

  isValid: boolean;
  warnings: string[];
};

export type LLMExtractionResult = {
  payload: Record<string, unknown>;
  evidence: Record<string, FieldEvidence>;
  fieldReports: Record<string, FieldReport>;

  provider: import("./providers/LLMProvider").ProviderName;
  model: string;
  llmUsed: true;

  rawResponse: unknown;
  createdAt: string;
};

export type {
  ContentCategoryCounts,
  RequestFootprintComponent,
  RequestFootprintDiagnostics,
} from "./requestDiagnostics";
