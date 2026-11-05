import { createHash } from "crypto";
import { access, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import type { CompactPagePacket } from "./compactPagePacket.ts";
import { FIELD_TYPES, type FieldType, type LLMExtractionResult, type UserSchema } from "./llm-extractor/types.ts";
import type { TemplateExtractionResult } from "./template-extractor/types.ts";
import type { ExtractionTemplate } from "./templating/types.ts";
import type { PagePacket } from "./types.ts";

export type DomainStore = {
  rootPath: string;
  domain: string;
  domainPath: string;
  templatesPath: string;
  packetsPath: string;
};

export type TemplateArtifact = {
  path: string;
  template: ExtractionTemplate;
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

export function getTemplateArtifactPath(store: DomainStore, templateId: string): string {
  return path.join(store.templatesPath, `${templateId.replace(/^template_/, "")}.json`);
}

export async function ensureDomainStoreDirectories(store: DomainStore): Promise<void> {
  await Promise.all([
    mkdir(store.templatesPath, { recursive: true }),
    mkdir(store.packetsPath, { recursive: true }),
  ]);
}

export async function saveTemplate(
  store: DomainStore,
  template: ExtractionTemplate,
): Promise<TemplateArtifact> {
  await ensureDomainStoreDirectories(store);

  const artifactPath = getTemplateArtifactPath(store, template.id);
  await writeJsonFile(artifactPath, template);
  await removeOtherFilesWithId(store, template.id, artifactPath);

  return { path: artifactPath, template };
}

export async function listTemplatesForDomain(
  store: DomainStore,
  options: { fields?: UserSchema } = {},
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

    const template = validateTemplateArtifact(value, store, artifactPath, warnings);

    if (template === null || (options.fields && !schemasMatch(template.schema, options.fields))) {
      continue;
    }

    candidates.push({ path: artifactPath, template });
  }

  return {
    candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)),
    warnings,
  };
}

const patternWrites = new Map<string, Promise<void>>();

export function addPatternToTemplate(templatePath: string, urlPattern: string): Promise<void> {
  const previous = patternWrites.get(templatePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const template = await readJsonFile<Record<string, unknown>>(templatePath);
    const { urlPattern: legacy, ...rest } = template;
    const patterns = Array.isArray(rest.urlPatterns)
      ? (rest.urlPatterns as string[])
      : typeof legacy === "string" ? [legacy] : [];
    if (!patterns.includes(urlPattern)) {
      await writeJsonFile(templatePath, { ...rest, urlPatterns: [...patterns, urlPattern] });
    }
  });
  patternWrites.set(templatePath, next);
  return next.finally(() => {
    if (patternWrites.get(templatePath) === next) patternWrites.delete(templatePath);
  });
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

// A file named by the pre-0.2.0 scheme can hold the same id, e.g. when one field
// changes type; leaving it would make two files match the same pages.
async function removeOtherFilesWithId(store: DomainStore, id: string, keep: string): Promise<void> {
  for (const entry of await readDirectoryEntries(store.templatesPath)) {
    const filePath = path.join(store.templatesPath, entry.name);
    if (!entry.isFile() || !entry.name.endsWith(".json") || filePath === keep) continue;

    const value = await readJsonFile<unknown>(filePath).catch(() => null);
    if (isRecord(value) && value.id === id) {
      await rm(filePath, { force: true });
    }
  }
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
  artifactPath: string,
  warnings: ReuseWarning[],
): ExtractionTemplate | null {
  if (!isRecord(value)) {
    pushTemplateValidationWarning(warnings, artifactPath, "Template artifact must be an object.");
    return null;
  }

  const schema = value.schema;
  const urlPatterns = readUrlPatterns(value);

  if (
    typeof value.id !== "string" ||
    typeof value.domain !== "string" ||
    urlPatterns === null ||
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

  const { urlPattern: _legacyPattern, ...template } = value;
  return { ...template, urlPatterns } as ExtractionTemplate;
}

// Templates written before 0.2.0 store a single `urlPattern`.
function readUrlPatterns(value: Record<string, unknown>): string[] | null {
  if (Array.isArray(value.urlPatterns)) {
    const patterns = value.urlPatterns.filter((pattern): pattern is string => typeof pattern === "string");
    return patterns.length > 0 && patterns.length === value.urlPatterns.length ? patterns : null;
  }
  return typeof value.urlPattern === "string" ? [value.urlPattern] : null;
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

function isFieldType(value: unknown): value is FieldType {
  return (FIELD_TYPES as readonly unknown[]).includes(value);
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
