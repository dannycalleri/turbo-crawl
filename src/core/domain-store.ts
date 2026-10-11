import { createHash } from "crypto";
import { access, mkdir, readdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { CompactPagePacket } from "./compactPagePacket.ts";
import type { FieldType, LLMExtractionResult, UserSchema } from "./llm-extractor/types.ts";
import type { TemplateExtractionResult } from "./template-extractor/types.ts";
import type { ExtractionTemplate } from "./templating/types.ts";
import type { PagePacket } from "./types.ts";

export type DomainStore = {
  rootPath: string;
  domain: string;
  domainPath: string;
  schemasPath: string;
  templatesPath: string;
  packetsPath: string;
};

export type SchemaArtifact = {
  schema: UserSchema;
  createdAt: string;
  path: string;
};

export type TemplateArtifact = {
  urlPattern: string;
  urlPatternHash: string;
  path: string;
  template?: ExtractionTemplate;
};

export type SchemaPreview = {
  id: string;
  label: string;
  createdAt: string | null;
  path: string;
  fieldCount: number;
  fieldSummaries: Array<{
    name: string;
    type: FieldType;
  }>;
};

export type TemplateMatchCandidate = TemplateArtifact & {
  template: ExtractionTemplate;
};

export type ReuseWarning = StorageError;

export type ReuseDiscoveryResult<T> = {
  candidates: T[];
  warnings: ReuseWarning[];
};

export type PagePacketFolder = {
  sourceUrl: string;
  finalUrl: string;
  urlPath: string;
  urlHash: string;
  path: string;
  packetPath: string;
  compactPacketPath: string;
  llmPath: string;
  resultPath: string;
};

export type FinalResultArtifact = {
  payload: Record<string, unknown>;
  fieldResults?: TemplateExtractionResult["fieldResults"];
  confidence?: number;
  templateId?: string;
  sourceUrl: string;
  finalUrl: string;
  path: string;
};

export type StorageError = {
  operation:
    | "create-directory"
    | "read-json"
    | "write-json"
    | "schema-path"
    | "schema-validation"
    | "template-validation"
    | "result-list";
  path: string;
  message: string;
  recoverable: boolean;
};

export type AgentTranscript = {
  provider: string;
  model: string | null;
  llmUsed: true;
  calls: unknown[];
  warnings: string[];
  createdAt: string;
};

export type PageArtifacts = {
  pagePacket: PagePacket;
  compactPacket?: CompactPagePacket;
  llmResult?: LLMExtractionResult | AgentTranscript;
  result?: TemplateExtractionResult;
};

export type TemplateLookupOptions = {
  onWarning?(warning: StorageError): void;
};

export type ResultListingOptions = {
  onWarning?(warning: StorageError): void;
};

type DomainStoreInput = {
  targetUrl: string;
  rootPath?: string;
};

const DEFAULT_ROOT_PATH = "data";
const HASH_LENGTH = 16;

export function createDomainStore(input: DomainStoreInput): DomainStore {
  const rootPath = input.rootPath ?? DEFAULT_ROOT_PATH;
  const domain = normalizeDomain(input.targetUrl);
  const domainPath = path.join(rootPath, domain);

  return {
    rootPath,
    domain,
    domainPath,
    schemasPath: path.join(domainPath, "schemas"),
    templatesPath: path.join(domainPath, "templates"),
    packetsPath: path.join(domainPath, "packets"),
  };
}

export function normalizeDomain(rawUrl: string): string {
  const hostname = new URL(rawUrl).hostname.toLowerCase();

  if (!hostname || hostname.includes("/") || hostname.includes("\\")) {
    throw new Error(`Unable to derive a safe domain folder from URL: ${rawUrl}`);
  }

  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

export function getUrlPatternHash(urlPattern: string): string {
  return hashStorageKey(urlPattern);
}

export function getUrlPathHash(rawUrl: string): string {
  return hashStorageKey(getUrlPath(rawUrl));
}

export function getPagePacketFolder(
  store: DomainStore,
  rawUrl: string,
  finalUrl: string = rawUrl,
): PagePacketFolder {
  const urlPath = getUrlPath(finalUrl);
  const urlHash = hashStorageKey(urlPath);
  const folderPath = path.join(store.packetsPath, urlHash);

  return {
    sourceUrl: rawUrl,
    finalUrl,
    urlPath,
    urlHash,
    path: folderPath,
    packetPath: path.join(folderPath, "packet.json"),
    compactPacketPath: path.join(folderPath, "packet.compact.json"),
    llmPath: path.join(folderPath, "packet.llm.json"),
    resultPath: path.join(folderPath, "result.json"),
  };
}

// Includes the field names so different schemas on one URL pattern get their own file.
// Without a schema it returns the legacy pattern-only name.
export function getTemplateArtifactPath(
  store: DomainStore,
  urlPattern: string,
  schema?: UserSchema,
): string {
  const key = schema
    ? `${urlPattern}\n${Object.keys(schema).sort().join(",")}`
    : urlPattern;
  return path.join(store.templatesPath, `${getUrlPatternHash(key)}.json`);
}

export function toUtcSecondTimestamp(date: Date): string {
  const timestamp = date.toISOString();
  return timestamp.slice(0, 19);
}

export async function ensureDomainStoreDirectories(store: DomainStore): Promise<void> {
  await Promise.all([
    mkdir(store.schemasPath, { recursive: true }),
    mkdir(store.templatesPath, { recursive: true }),
    mkdir(store.packetsPath, { recursive: true }),
  ]);
}

export async function saveSchema(
  store: DomainStore,
  schema: UserSchema,
  createdAt: Date,
): Promise<SchemaArtifact> {
  await ensureDomainStoreDirectories(store);

  const artifactPath = await getSchemaArtifactPath(store, createdAt);
  await writeJsonFile(artifactPath, schema);

  return {
    schema,
    createdAt: toUtcSecondTimestamp(createdAt),
    path: artifactPath,
  };
}

export async function saveTemplate(
  store: DomainStore,
  template: ExtractionTemplate,
): Promise<TemplateArtifact> {
  await ensureDomainStoreDirectories(store);

  const urlPatternHash = getUrlPatternHash(template.urlPattern);
  const artifactPath = getTemplateArtifactPath(store, template.urlPattern, template.schema);
  await writeJsonFile(artifactPath, template);

  return {
    urlPattern: template.urlPattern,
    urlPatternHash,
    path: artifactPath,
    template,
  };
}

export async function readTemplateForPattern(
  store: DomainStore,
  urlPattern: string,
  userSchema: UserSchema,
  options: TemplateLookupOptions = {},
): Promise<ExtractionTemplate | null> {
  const result = await readTemplateCandidatesForPattern(store, urlPattern);

  for (const warning of result.warnings) {
    options.onWarning?.(warning);
  }

  return (
    result.candidates.find((candidate) =>
      schemasMatch(candidate.template.schema, userSchema),
    )?.template ?? null
  );
}

export async function readTemplateCandidatesForPattern(
  store: DomainStore,
  urlPattern: string,
): Promise<ReuseDiscoveryResult<TemplateMatchCandidate>> {
  const warnings: ReuseWarning[] = [];
  const entries = await readDirectoryEntries(store.templatesPath);
  const candidates: TemplateMatchCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const artifactPath = path.join(store.templatesPath, entry.name);
    let value: unknown;

    try {
      value = await readJsonFile<unknown>(artifactPath);
    } catch (error) {
      warnings.push({
        operation: "read-json",
        path: artifactPath,
        message: `Unable to read template JSON at ${artifactPath}: ${getErrorMessage(error)}`,
        recoverable: true,
      });
      continue;
    }

    const template = validateTemplateArtifact(value, store, urlPattern, artifactPath, warnings);

    if (template === null) {
      continue;
    }

    candidates.push({
      urlPattern,
      urlPatternHash: getUrlPatternHash(urlPattern),
      path: artifactPath,
      template,
    });
  }

  return {
    candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)),
    warnings,
  };
}

export async function listSchemaPreviews(
  store: DomainStore,
): Promise<ReuseDiscoveryResult<SchemaPreview>> {
  const entries = await readDirectoryEntries(store.schemasPath);
  const candidates: SchemaPreview[] = [];
  const warnings: ReuseWarning[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const schemaPath = path.join(store.schemasPath, entry.name);
    let value: unknown;

    try {
      value = await readJsonFile<unknown>(schemaPath);
    } catch (error) {
      warnings.push({
        operation: "read-json",
        path: schemaPath,
        message: `Unable to read schema JSON at ${schemaPath}: ${getErrorMessage(error)}`,
        recoverable: true,
      });
      continue;
    }

    const schema = extractStoredSchema(value);

    if (schema === null) {
      warnings.push({
        operation: "schema-validation",
        path: schemaPath,
        message: "Schema artifact is not a valid non-empty extraction schema.",
        recoverable: true,
      });
      continue;
    }

    const createdAt = inferSchemaCreatedAt(entry.name);
    const fieldSummaries = Object.entries(schema)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, type]) => ({ name, type }));

    candidates.push({
      id: schemaPath,
      label: createdAt ?? entry.name.replace(/\.json$/i, ""),
      createdAt,
      path: schemaPath,
      fieldCount: fieldSummaries.length,
      fieldSummaries,
    });
  }

  return {
    candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)),
    warnings,
  };
}

export async function savePageArtifacts(
  store: DomainStore,
  artifacts: PageArtifacts,
): Promise<PagePacketFolder> {
  await ensureDomainStoreDirectories(store);

  const folder = getPagePacketFolder(
    store,
    artifacts.pagePacket.url,
    artifacts.pagePacket.finalUrl || artifacts.pagePacket.url,
  );

  await writeJsonFile(folder.packetPath, artifacts.pagePacket);

  if (artifacts.compactPacket !== undefined) {
    await writeJsonFile(folder.compactPacketPath, artifacts.compactPacket);
  }

  if (artifacts.llmResult !== undefined) {
    await writeJsonFile(folder.llmPath, artifacts.llmResult);
  }

  if (artifacts.result !== undefined) {
    await writeJsonFile(folder.resultPath, artifacts.result);
  }

  return folder;
}

export async function listResults(
  store: DomainStore,
  options: ResultListingOptions = {},
): Promise<FinalResultArtifact[]> {
  const packetEntries = await readPacketDirectoryEntries(store);
  const artifacts: FinalResultArtifact[] = [];

  for (const entry of packetEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const resultPath = path.join(store.packetsPath, entry.name, "result.json");

    if (!(await fileExists(resultPath))) {
      continue;
    }

    const result = await readResultJson(resultPath, options);

    if (result === null) {
      continue;
    }

    artifacts.push({
      payload: result.payload,
      fieldResults: result.fieldResults,
      confidence: result.confidence,
      templateId: result.templateId,
      sourceUrl: getStringProperty(result, "sourceUrl") ?? "",
      finalUrl: getStringProperty(result, "finalUrl") ?? "",
      path: resultPath,
    });
  }

  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

export async function getSchemaArtifactPath(
  store: DomainStore,
  createdAt: Date,
): Promise<string> {
  const timestamp = toUtcSecondTimestamp(createdAt);
  const basePath = path.join(store.schemasPath, `${timestamp}.json`);

  if (!(await fileExists(basePath))) {
    return basePath;
  }

  for (let index = 1; index < 1000; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const candidate = path.join(store.schemasPath, `${timestamp}-${suffix}.json`);

    if (!(await fileExists(candidate))) {
      return candidate;
    }
  }

  throw new Error(`Unable to allocate a schema artifact path for ${timestamp}.`);
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
  return filePath;
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, { encoding: "utf-8" })) as T;
}

async function readResultJson(
  resultPath: string,
  options: ResultListingOptions,
): Promise<TemplateExtractionResult | null> {
  try {
    return await readJsonFile<TemplateExtractionResult>(resultPath);
  } catch (error) {
    options.onWarning?.({
      operation: "read-json",
      path: resultPath,
      message: `Unable to read result JSON at ${resultPath}: ${getErrorMessage(error)}`,
      recoverable: true,
    });
    return null;
  }
}

async function readPacketDirectoryEntries(store: DomainStore) {
  return readDirectoryEntries(store.packetsPath);
}

async function readDirectoryEntries(directoryPath: string) {
  try {
    return await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }

    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

function getUrlPath(rawUrl: string): string {
  return new URL(rawUrl).pathname || "/";
}

function hashStorageKey(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, HASH_LENGTH);
}

function schemasMatch(
  templateSchema: Record<string, FieldType>,
  userSchema: UserSchema,
): boolean {
  const templateEntries = Object.entries(templateSchema).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const userEntries = Object.entries(userSchema).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  if (templateEntries.length !== userEntries.length) {
    return false;
  }

  return templateEntries.every(([templateFieldName, templateFieldType], index) => {
    const userEntry = userEntries[index];

    return (
      userEntry !== undefined &&
      templateFieldName === userEntry[0] &&
      templateFieldType === userEntry[1]
    );
  });
}

function validateTemplateArtifact(
  value: unknown,
  store: DomainStore,
  urlPattern: string,
  artifactPath: string,
  warnings: ReuseWarning[],
): ExtractionTemplate | null {
  if (!isRecord(value)) {
    pushTemplateValidationWarning(warnings, artifactPath, "Template artifact must be an object.");
    return null;
  }

  const schema = value.schema;

  if (
    typeof value.id !== "string" ||
    typeof value.domain !== "string" ||
    typeof value.urlPattern !== "string" ||
    typeof value.createdFromUrl !== "string" ||
    typeof value.createdAt !== "string" ||
    !isUserSchema(schema) ||
    !isRecord(value.fields)
  ) {
    pushTemplateValidationWarning(
      warnings,
      artifactPath,
      "Template artifact is missing required template fields.",
    );
    return null;
  }

  if (normalizeStoredDomain(value.domain) !== store.domain) {
    pushTemplateValidationWarning(
      warnings,
      artifactPath,
      `Template artifact does not match domain ${store.domain}.`,
    );
    return null;
  }

  if (value.urlPattern !== urlPattern) {
    return null;
  }

  return value as ExtractionTemplate;
}

function pushTemplateValidationWarning(
  warnings: ReuseWarning[],
  artifactPath: string,
  message: string,
): void {
  warnings.push({
    operation: "template-validation",
    path: artifactPath,
    message,
    recoverable: true,
  });
}

function isUserSchema(value: unknown): value is UserSchema {
  if (!isRecord(value)) {
    return false;
  }

  const entries = Object.entries(value);

  return (
    entries.length > 0 &&
    entries.every(
      ([fieldName, fieldType]) =>
        fieldName.trim().length > 0 && isFieldType(fieldType),
    )
  );
}

function extractStoredSchema(value: unknown): UserSchema | null {
  if (isUserSchema(value)) {
    return value;
  }

  if (isRecord(value) && isUserSchema(value.schema)) {
    return value.schema;
  }

  return null;
}

function inferSchemaCreatedAt(fileName: string): string | null {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:-\d{3})?\.json$/);
  return match?.[1] ?? null;
}

function isFieldType(value: unknown): value is FieldType {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "date" ||
    value === "url" ||
    value === "text"
  );
}

function normalizeStoredDomain(domain: string): string {
  const lower = domain.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStringProperty(value: unknown, key: string): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    key in value &&
    typeof value[key as keyof typeof value] === "string"
  ) {
    return value[key as keyof typeof value];
  }

  return null;
}
