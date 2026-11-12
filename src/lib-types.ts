// The public types of the library. This file is published as dist/lib.d.ts, so it
// must not import anything.

/** A `pairs` field reads every label/value row of one container, e.g. a spec table, as `{ label: value }`. */
export type FieldType = "string" | "number" | "boolean" | "date" | "url" | "text" | "pairs";

export type CrawlerOptions = {
  /**
   * Root folder of the saved templates, e.g. a folder committed to your repository.
   * Required unless you give `store`. With `store`, it holds only the artifacts of `writeArtifacts`.
   */
  dataDir?: string;
  /** Sent on every request and matched against robots.txt. There is no default. */
  userAgent: string;
  /** "never" uses saved templates only and never starts an agent. */
  authoring: "never" | "allowed";
  /** Default true. */
  respectRobots?: boolean;
  /** Default false. When true, page packets and agent transcripts are saved under dataDir. */
  writeArtifacts?: boolean;
  /** Default 30000. */
  navigationTimeoutMs?: number;
  /** Default 10000. */
  settleTimeoutMs?: number;
  /** Default 4. Further calls wait in first-in-first-out order. */
  maxConcurrentPages?: number;
  /** Your own model client. turbo-crawl then uses it for every agent call and never starts `claude`, `codex` or LM Studio. */
  provider?: LLMProvider;
  /** The model id that turbo-crawl sends to `provider` in each request. */
  model?: string;
  /** Your own template storage, e.g. a database table. The default is the files under `dataDir`. */
  store?: TemplateStore;
};

/** A template as JSON. turbo-crawl owns the other properties; keep them as they are. */
export type TemplateJson = {
  id: string;
  domain: string;
  urlPatterns: string[];
  [property: string]: unknown;
};

export type StoredTemplate = {
  /** Your id for the template. turbo-crawl gives it back in updates and as `templateFit.templatePath`. */
  ref: string;
  /** turbo-crawl validates it, and ignores it with a warning when it is not a valid template. */
  template: unknown;
};

export type TemplateStore = {
  /** The field templates of a domain, e.g. "shop.example" (lower case, no "www."). */
  listTemplates(domain: string): Promise<StoredTemplate[]>;
  listListingTemplates(domain: string): Promise<StoredTemplate[]>;
  /** Saves the template and resolves to its ref. A template with the same `id` replaces the old one. */
  saveTemplate(template: TemplateJson): Promise<string>;
  saveListingTemplate(template: TemplateJson): Promise<string>;
  /**
   * Reads the template, calls `update`, and saves what it returns, as one operation:
   * two updates of one template at the same time must not lose a change.
   */
  updateTemplate(ref: string, update: (template: TemplateJson) => TemplateJson): Promise<void>;
  updateListingTemplate(ref: string, update: (template: TemplateJson) => TemplateJson): Promise<void>;
};

export type LLMMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LLMRequest = {
  /** The `model` option of createCrawler, or null. */
  model: string | null;
  messages: LLMMessage[];
  /** The JSON Schema of the answer. */
  jsonSchema: unknown;
  temperature?: number;
  maxTokens?: number;
  /** From TURBO_CRAWL_LLM_TIMEOUT_MS. The default is 600000. */
  timeoutMs: number;
  /** Aborted when timeoutMs passes. Pass it to your client to stop the request. */
  signal: AbortSignal;
};

export type LLMResponse = {
  /** The answer as a JSON value. turbo-crawl checks it against the schema of the call. */
  parsed: unknown;
  /** Saved in the agent transcript when writeArtifacts is true. */
  raw: unknown;
};

export type LLMProvider = {
  /** Shown in progress messages. The default is "custom". */
  name?: string;
  completeStructured(request: LLMRequest): Promise<LLMResponse>;
};

export type ExtractOptions = {
  /** Only templates with exactly these fields are used. Omit to use any saved template. */
  fields?: Record<string, FieldType>;
  /** Fields that must have a value for a template to fit. Default: all of the template's fields. */
  require?: string[];
};

export type ExtractHtmlInput = ExtractOptions & {
  /** The absolute http or https URL where you rendered the page. Relative links resolve against it. */
  url: string;
  /** The rendered HTML of the page, at most 10 MB. */
  html: string;
};

export type PolicyInfo = {
  robots: "allowed" | "disallowed" | "unknown";
  tdmReservation: boolean | null;
  tdmPolicyUrl: string | null;
  xRobotsTag: string | null;
  metaRobots: string | null;
  httpStatus: number | null;
};

export type TemplateFit = {
  templateId: string;
  templatePath: string;
  /** False when the template fitted by content on a URL that none of its URL patterns matched yet. */
  matchedPattern: boolean;
};

type PageResult = {
  ok: true;
  schemaVersion: 1;
  url: string;
  finalUrl: string;
  canonicalUrl: string | null;
  fetchedAt: string;
  /** The saved URL pattern of the domain that matches this page, else one inferred from the URL alone. */
  urlPattern: string;
  policy: PolicyInfo;
  warnings: string[];
  templateFit: TemplateFit;
};

export type ExtractSuccess = PageResult & {
  data: Record<string, unknown>;
  missing: string[];
  stale: boolean;
};

export type LinkItem = {
  url: string;
  text: string;
  /** The listing's item pattern that matches this URL, else one inferred from the URL alone. */
  urlPattern: string;
  cssPath: string;
};

export type LinkPattern = {
  urlPattern: string;
  count: number;
  samples: string[];
};

export type LinksSuccess = PageResult & {
  itemUrls: LinkItem[];
  paginationUrls: string[];
  patterns: LinkPattern[];
};

export type CrawlErrorCode =
  | "TEMPLATE_MISSING"
  | "ROBOTS_DISALLOWED"
  | "BLOCKED"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "AMBIGUOUS_TEMPLATE";

export type CrawlError = {
  ok: false;
  schemaVersion: 1;
  url: string;
  code: CrawlErrorCode;
  message: string;
  /** Null when the page was not rendered. */
  policy: PolicyInfo | null;
  /** Only on BLOCKED. */
  retryAfterSeconds?: number | null;
  /** Only on AMBIGUOUS_TEMPLATE. */
  templatePaths?: string[];
};

export type ExtractResult = ExtractSuccess | CrawlError;
export type LinksResult = LinksSuccess | CrawlError;

/**
 * `extract` and `links` resolve to a `CrawlError` for every page and template failure.
 * They reject only for invalid arguments, a missing Chromium, a `store` that fails or breaks
 * its contract, or, when authoring is "allowed", an agent that is not installed or fails to write a template.
 */
export type Crawler = {
  extract(url: string, options?: ExtractOptions): Promise<ExtractResult>;
  /**
   * Reads HTML that you rendered, as a detail page. It runs no page scripts, sends no
   * request and does not read robots.txt: you fetched the page, so its robots policy is yours.
   */
  extractHtml(input: ExtractHtmlInput): Promise<ExtractResult>;
  links(url: string): Promise<LinksResult>;
  /** Waits for the running calls, then closes the browser. Later calls reject. */
  close(): Promise<void>;
};
