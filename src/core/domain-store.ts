import { createHash } from "crypto";
import { access, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import type { CompactPagePacket } from "./compactPagePacket.ts";
import { isFieldType, type FieldType, type LLMExtractionResult, type UserSchema } from "./llm-extractor/types.ts";
import type { TemplateExtractionResult } from "./template-extractor/types.ts";
import { inferUrlPattern } from "./templating/inferUrlPattern.ts";
import { normalizePatterns, urlMatchesPattern } from "./templating/urlPatterns.ts";
import type { ExtractionTemplate, ListingTemplate } from "./templating/types.ts";
import type { PagePacket } from "./types.ts";

export type DomainStore = {
  rootPath: string;
  domain: string;
  domainPath: string;
  templatesPath: string;
  listingsPath: string;
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
    listingsPath: path.join(domainPath, "listings"),
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

export type ListingTemplateArtifact = {
  path: string;
  template: ListingTemplate;
};

export async function saveListingTemplate(
  store: DomainStore,
  template: ListingTemplate,
): Promise<ListingTemplateArtifact> {
  const artifactPath = path.join(store.listingsPath, `${template.id.replace(/^listing_/, "")}.json`);
  // 0.3.0 reads only itemUrlPattern; keep writing it until 1.0.
  await writeJsonFile(artifactPath, { ...template, itemUrlPattern: template.itemUrlPatterns[0] });
  return { path: artifactPath, template };
}

export async function listListingTemplates(
  store: DomainStore,
): Promise<ReuseDiscoveryResult<ListingTemplateArtifact>> {
  return readTemplateArtifacts(store.listingsPath, "listing template", (value, artifactPath, warnings) =>
    validateListingTemplate(value, store.domain, artifactPath, warnings));
}

export function validateListingTemplate(
  value: unknown,
  domain: string,
  ref: string,
  warnings: ReuseWarning[],
): ListingTemplate | null {
  const itemUrlPatterns = isRecord(value) ? readPatternList(value, "itemUrlPatterns", "itemUrlPattern") : null;
  if (itemUrlPatterns && isListingTemplate(value) && normalizeStoredDomain(value.domain) === domain) {
    const { itemUrlPattern: _legacy, ...template } = value as ListingTemplate & { itemUrlPattern?: string };
    return { ...template, urlPatterns: normalizePatterns(value.urlPatterns), itemUrlPatterns };
  }
  pushTemplateValidationWarning(warnings, ref, `Listing template is invalid or does not match domain ${domain}.`);
  return null;
}

function isListingTemplate(value: unknown): value is Omit<ListingTemplate, "itemUrlPatterns"> {
  const isStrings = (list: unknown) => Array.isArray(list) && list.every(item => typeof item === "string");
  return (
    isRecord(value) &&
    value.kind === "listing" &&
    typeof value.id === "string" &&
    typeof value.domain === "string" &&
    isStrings(value.urlPatterns) &&
    isStrings(value.itemLinks) &&
    (value.itemLinks as string[]).length > 0 &&
    isStrings(value.nextPage) &&
    isStrings(value.pageLinks) &&
    typeof value.createdFromUrl === "string" &&
    typeof value.createdAt === "string"
  );
}

export async function listTemplatesForDomain(store: DomainStore): Promise<ReuseDiscoveryResult<TemplateMatchCandidate>> {
  return readTemplateArtifacts(store.templatesPath, "template", (value, artifactPath, warnings) =>
    validateFieldTemplate(value, store.domain, artifactPath, warnings));
}

async function readTemplateArtifacts<T>(
  directoryPath: string,
  label: string,
  validate: (value: unknown, artifactPath: string, warnings: ReuseWarning[]) => T | null,
): Promise<ReuseDiscoveryResult<{ path: string; template: T }>> {
  const paths = (await readDirectoryEntries(directoryPath))
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => path.join(directoryPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const values = await Promise.all(paths.map(artifactPath =>
    readJsonFile<unknown>(artifactPath).then(value => ({ value }), (error: unknown) => ({ error }))));

  const warnings: ReuseWarning[] = [];
  const candidates: Array<{ path: string; template: T }> = [];
  paths.forEach((artifactPath, index) => {
    const read = values[index]!;
    if ("error" in read) {
      warnings.push({
        operation: "read-json",
        path: artifactPath,
        message: `Unable to read ${label} JSON at ${artifactPath}: ${getErrorMessage(read.error)}`,
        recoverable: true,
      });
      return;
    }
    const template = validate(read.value, artifactPath, warnings);
    if (template !== null) candidates.push({ path: artifactPath, template });
  });

  return { candidates, warnings };
}

const patternWrites = new Map<string, Promise<void>>();

export function addPatternToTemplate(templatePath: string, url: string): Promise<void> {
  const previous = patternWrites.get(templatePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const updated = withUrlPattern(await readJsonFile<unknown>(templatePath), url);
    if (updated !== null) await writeJsonFile(templatePath, updated);
  });
  patternWrites.set(templatePath, next);
  return next.finally(() => {
    if (patternWrites.get(templatePath) === next) patternWrites.delete(templatePath);
  });
}

/** The template JSON with a pattern for `url` added, or null when a pattern already matches `url`. */
export function withUrlPattern(template: unknown, url: string): Record<string, unknown> | null {
  if (!isRecord(template)) return null;
  const { urlPattern: _legacy, ...rest } = template;
  const patterns = readUrlPatterns(template) ?? [];
  if (urlMatchesPattern(url, patterns)) return null;
  return { ...rest, urlPatterns: normalizePatterns([...patterns, inferUrlPattern(url)]) };
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

export function schemasMatch(
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

export function validateFieldTemplate(
  value: unknown,
  domain: string,
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

  if (normalizeStoredDomain(value.domain) !== domain) {
    pushTemplateValidationWarning(
      warnings,
      artifactPath,
      `Template artifact does not match domain ${domain}.`,
    );
    return null;
  }

  const { urlPattern: _legacyPattern, ...template } = value;
  return { ...template, urlPatterns } as ExtractionTemplate;
}

// Templates written before 0.2.0 store a single `urlPattern`.
function readUrlPatterns(value: Record<string, unknown>): string[] | null {
  const patterns = readPatternList(value, "urlPatterns", "urlPattern");
  return patterns && normalizePatterns(patterns);
}

function readPatternList(value: Record<string, unknown>, listKey: string, legacyKey: string): string[] | null {
  const list = value[listKey];
  if (Array.isArray(list)) return list.length > 0 && list.every(item => typeof item === "string") ? list : null;
  const legacy = value[legacyKey];
  return typeof legacy === "string" ? [legacy] : null;
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
