// The public types of the library. This file is published as dist/lib.d.ts, so it
// must not import anything.

export type FieldType = "string" | "number" | "boolean" | "date" | "url" | "text";

export type CrawlerOptions = {
  /** Root folder of the saved templates, e.g. a folder committed to your repository. */
  dataDir: string;
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
};

export type ExtractOptions = {
  /** Only templates with exactly these fields are used. Omit to use any saved template. */
  fields?: Record<string, FieldType>;
  /** Fields that must have a value for a template to fit. Default: all of the template's fields. */
  require?: string[];
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
  /** False when the template fitted by content on a URL pattern it did not know yet. */
  matchedPattern: boolean;
};

type PageResult = {
  ok: true;
  schemaVersion: 1;
  url: string;
  finalUrl: string;
  canonicalUrl: string | null;
  fetchedAt: string;
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
 * They reject only for invalid arguments, a missing Chromium, or, when authoring is
 * "allowed", an agent that is not installed or fails to write a template.
 */
export type Crawler = {
  extract(url: string, options?: ExtractOptions): Promise<ExtractResult>;
  links(url: string): Promise<LinksResult>;
  /** Waits for the running calls, then closes the browser. Later calls reject. */
  close(): Promise<void>;
};
