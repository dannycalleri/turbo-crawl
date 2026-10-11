import type { DomBlock } from "./extraction/dom";
import type { ImageBlock } from "./extraction/images";
import type { JsonLdBlock } from "./extraction/jsonld";
import type { LinkBlock } from "./extraction/links";
import type { TableBlock } from "./extraction/tables";
import type { UserSchema } from "./llm-extractor/types";
import type { PagePacket } from "./types";

type CompactJsonLdBlock = {
  nodeId: string;
  type: string | null;
  data: unknown;
  raw?: string;
  score: number;
};

type CompactDomBlock = {
  nodeId: string;
  tag: string;
  text: string;
  cssPath: string;
  attributes: Record<string, string>;
  score: number;
};

type CompactLinkBlock = {
  nodeId: string;
  text: string;
  href: string;
  score: number;
};

type CompactImageBlock = {
  nodeId: string;
  src: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  score: number;
};

type CompactTableBlock = {
  nodeId: string;
  headers: string[];
  rows: string[][];
  score: number;
};

export type CompactPagePacket = {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  title: string | null;
  metadata: {
    canonicalUrl: string | null;
    description: string | null;
    robots: string | null;
    openGraph: Record<string, string>;
    twitter: Record<string, string>;
    other: Record<string, string>;
  };
  jsonLd: CompactJsonLdBlock[];
  visibleBlocks: CompactDomBlock[];
  links: CompactLinkBlock[];
  images: CompactImageBlock[];
  tables: CompactTableBlock[];
  stats: PagePacket["stats"];
  compaction: {
    structuredDataScore: number;
    signals: string[];
    retainedCounts: {
      jsonLd: number;
      visibleBlocks: number;
      links: number;
      images: number;
      tables: number;
    };
    omittedCounts: {
      jsonLd: number;
      visibleBlocks: number;
      links: number;
      images: number;
      tables: number;
    };
    footprint?: {
      compactPacketBytes: number;
      compactPacketChars: number;
    };
  };
};

const IMPORTANT_META_KEYS = [
  "og:title",
  "og:description",
  "og:url",
  "og:image",
  "twitter:title",
  "twitter:description",
  "twitter:image",
];

const IMPORTANT_OTHER_META_PATTERNS = [
  /product/i,
  /identifier/i,
  /\bid\b/i,
  /title/i,
  /name/i,
  /description/i,
  /brand/i,
  /model/i,
  /manufacturer/i,
  /reference/i,
  /sku/i,
  /mpn/i,
  /gtin/i,
  /isbn/i,
  /ean/i,
  /upc/i,
  /price/i,
  /currency/i,
  /availability/i,
  /color/i,
  /size/i,
  /material/i,
  /category/i,
  /condition/i,
  /date/i,
];

const HIGH_SIGNAL_JSONLD_TYPES = new Set([
  "product",
  "offer",
  "brand",
  "breadcrumblist",
  "article",
  "newsarticle",
  "review",
  "webpage",
  "organization",
]);

const IMPORTANT_JSONLD_KEYS = [
  "@context",
  "@type",
  "name",
  "alternateName",
  "brand",
  "manufacturer",
  "model",
  "mpn",
  "sku",
  "productID",
  "gtin",
  "identifier",
  "reference",
  "referenceNumber",
  "description",
  "color",
  "material",
  "size",
  "width",
  "height",
  "depth",
  "diameter",
  "movement",
  "caseMaterial",
  "offers",
  "price",
  "priceCurrency",
  "availability",
  "url",
  "image",
  "category",
  "itemCondition",
  "releaseDate",
  "datePublished",
  "dateModified",
];

export function compactForLLM(packet: PagePacket, userSchema: UserSchema = {}): CompactPagePacket {
  const fieldSignals = buildFieldSignals(userSchema);
  const structuredDataScore = getStructuredDataScore(packet);
  const signals = getDominantSignals(packet, structuredDataScore);
  const jsonLdLimit = clamp(Math.round(4 + structuredDataScore * 4), 4, 8);
  const tableLimit = clamp(Math.round(3 + getTableSignalScore(packet.tables) * 5), 3, 8);
  const visibleBlockLimit = clamp(
    Math.round(56 - structuredDataScore * 30 - getTableSignalScore(packet.tables) * 10),
    18,
    56,
  );
  const linkLimit = clamp(Math.round(14 - structuredDataScore * 6), 6, 14);
  const imageLimit = clamp(Math.round(10 - structuredDataScore * 4), 4, 10);
  const domTextLimit = structuredDataScore >= 0.7 ? 180 : structuredDataScore >= 0.45 ? 220 : 320;

  const compactJsonLd = selectJsonLdBlocks(packet.jsonLd, jsonLdLimit, structuredDataScore, fieldSignals);
  const compactVisibleBlocks = selectVisibleBlocks(packet.visibleBlocks, visibleBlockLimit, domTextLimit, fieldSignals);
  const compactLinks = selectLinks(packet.links, linkLimit, fieldSignals);
  const compactImages = selectImages(packet.images, imageLimit, fieldSignals);
  const compactTables = selectTables(
    packet.tables,
    tableLimit,
    structuredDataScore >= 0.65 ? 6 : 10,
    fieldSignals,
  );

  const compacted: CompactPagePacket = {
    url: packet.url,
    finalUrl: packet.finalUrl,
    fetchedAt: packet.fetchedAt,
    title: packet.title,
    metadata: {
      canonicalUrl: packet.metadata.canonicalUrl,
      description: trimText(packet.metadata.description, 280),
      robots: packet.metadata.robots,
      openGraph: pickImportantMeta(packet.metadata.openGraph),
      twitter: pickImportantMeta(packet.metadata.twitter),
      other: pickImportantOtherMeta(packet.metadata.other, fieldSignals),
    },
    jsonLd: compactJsonLd,
    visibleBlocks: compactVisibleBlocks,
    links: compactLinks,
    images: compactImages,
    tables: compactTables,
    stats: packet.stats,
    compaction: {
      structuredDataScore,
      signals,
      retainedCounts: {
        jsonLd: compactJsonLd.length,
        visibleBlocks: compactVisibleBlocks.length,
        links: compactLinks.length,
        images: compactImages.length,
        tables: compactTables.length,
      },
      omittedCounts: {
        jsonLd: Math.max(0, packet.jsonLd.length - compactJsonLd.length),
        visibleBlocks: Math.max(0, packet.visibleBlocks.length - compactVisibleBlocks.length),
        links: Math.max(0, packet.links.length - compactLinks.length),
        images: Math.max(0, packet.images.length - compactImages.length),
        tables: Math.max(0, packet.tables.length - compactTables.length),
      },
    },
  };

  const serialized = JSON.stringify(compacted);
  compacted.compaction.footprint = {
    compactPacketBytes: Buffer.byteLength(serialized, "utf8"),
    compactPacketChars: serialized.length,
  };

  return compacted;
}

function selectJsonLdBlocks(
  blocks: JsonLdBlock[],
  limit: number,
  structuredDataScore: number,
  fieldSignals: FieldSignals,
): CompactJsonLdBlock[] {
  const ranked = dedupeBy(blocks, block => block.nodeId).map(block => ({
    block,
    score: scoreJsonLdBlock(block, fieldSignals),
  }));

  return ranked
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ block, score }) => {
      const compactBlock: CompactJsonLdBlock = {
        nodeId: block.nodeId,
        type: block.type,
        data: summarizeJsonLdData(block.data, {
          maxDepth: structuredDataScore >= 0.6 ? 3 : 4,
          maxArrayItems: structuredDataScore >= 0.6 ? 5 : 8,
          maxObjectKeys: structuredDataScore >= 0.6 ? 10 : 14,
        }),
        score: roundScore(score),
      };

      if (block.data === null) {
        compactBlock.raw = trimText(block.raw, 600) ?? undefined;
      }

      return compactBlock;
    });
}

function selectVisibleBlocks(
  blocks: DomBlock[],
  limit: number,
  maxTextLength: number,
  fieldSignals: FieldSignals,
): CompactDomBlock[] {
  const deduped = dedupeBy(
    blocks
      .filter(block => block.score >= 0.2)
      .filter(block => !isConsentOrPrivacyNoise(`${block.normalizedText} ${Object.values(block.attributes).join(" ")}`))
      .sort((left, right) => scoreVisibleBlock(right, fieldSignals) - scoreVisibleBlock(left, fieldSignals)),
    block => `${block.tag}:${normalizeForDedup(block.normalizedText)}`,
  );

  const headings = takeByCategory(deduped, "heading", 3, maxTextLength, fieldSignals);
  const specs = takeByCategory(deduped, "spec", Math.max(6, Math.floor(limit * 0.3)), maxTextLength, fieldSignals);
  const descriptive = takeByCategory(
    deduped,
    "descriptive",
    Math.max(4, Math.floor(limit * 0.35)),
    maxTextLength,
    fieldSignals,
  );
  const remaining = fillRemainingBlocks(
    deduped,
    [...headings, ...specs, ...descriptive].map(block => block.nodeId),
    limit,
    maxTextLength,
    fieldSignals,
  );

  return [...headings, ...specs, ...descriptive, ...remaining]
    .slice(0, limit)
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));
}

function selectLinks(links: LinkBlock[], limit: number, fieldSignals: FieldSignals): CompactLinkBlock[] {
  return dedupeBy(
    links
      .filter(link => link.score >= 0.2 || looksLikeHighSignalText(link.text) || looksLikeHighSignalHref(link.href))
      .sort((left, right) =>
        (right.score + scoreTextAgainstFields(`${right.text} ${right.href}`, fieldSignals)) -
        (left.score + scoreTextAgainstFields(`${left.text} ${left.href}`, fieldSignals)),
      ),
    link => link.href,
  )
    .slice(0, limit)
    .map(link => ({
      nodeId: link.nodeId,
      text: trimText(link.text, 100) ?? "",
      href: link.href,
      score: roundScore(link.score),
    }));
}

function selectImages(images: ImageBlock[], limit: number, fieldSignals: FieldSignals): CompactImageBlock[] {
  return dedupeBy(
    images
      .filter(image => image.score >= 0.2 || Boolean(image.alt))
      .sort((left, right) =>
        (right.score + scoreTextAgainstFields(`${right.alt ?? ""} ${right.src}`, fieldSignals)) -
        (left.score + scoreTextAgainstFields(`${left.alt ?? ""} ${left.src}`, fieldSignals)),
      ),
    image => image.src,
  )
    .slice(0, limit)
    .map(image => ({
      nodeId: image.nodeId,
      src: image.src,
      alt: trimText(image.alt, 140),
      width: image.width,
      height: image.height,
      score: roundScore(image.score),
    }));
}

function selectTables(
  tables: TableBlock[],
  limit: number,
  maxRowsPerTable: number,
  fieldSignals: FieldSignals,
): CompactTableBlock[] {
  return dedupeBy(
    tables
      .filter(table => !isCookieConsentTable(table))
      .sort((left, right) => scoreTableBlock(right, fieldSignals) - scoreTableBlock(left, fieldSignals))
      .map(table => ({
        nodeId: table.nodeId,
        headers: table.headers.map(header => trimText(header, 80) ?? "").filter(Boolean),
        rows: summarizeTableRows(table.rows, maxRowsPerTable),
        score: roundScore(table.score),
      }))
      .filter(table => table.rows.length > 0),
    table => `${table.headers.join("|")}:${table.rows[0]?.join("|") ?? table.nodeId}`,
  ).slice(0, limit);
}

function fillRemainingBlocks(
  blocks: DomBlock[],
  selectedNodeIds: string[],
  limit: number,
  maxTextLength: number,
  fieldSignals: FieldSignals,
): CompactDomBlock[] {
  const selected = new Set(selectedNodeIds);
  const remaining: CompactDomBlock[] = [];

  for (const block of blocks) {
    if (selected.has(block.nodeId)) continue;
    remaining.push(toCompactDomBlock(block, maxTextLength, fieldSignals));
    selected.add(block.nodeId);

    if (selected.size >= limit) {
      break;
    }
  }

  return remaining;
}

function takeByCategory(
  blocks: DomBlock[],
  category: VisibleBlockCategory,
  limit: number,
  maxTextLength: number,
  fieldSignals: FieldSignals,
): CompactDomBlock[] {
  return blocks
    .filter(block => categorizeVisibleBlock(block) === category)
    .slice(0, limit)
    .map(block => toCompactDomBlock(block, maxTextLength, fieldSignals));
}

function toCompactDomBlock(block: DomBlock, maxTextLength: number, fieldSignals: FieldSignals): CompactDomBlock {
  return {
    nodeId: block.nodeId,
    tag: block.tag,
    text: trimText(block.normalizedText, maxTextLength) ?? "",
    cssPath: block.cssPath,
    attributes: pickUsefulDomAttributes(block.attributes),
    score: roundScore(scoreVisibleBlock(block, fieldSignals)),
  };
}

type VisibleBlockCategory = "heading" | "spec" | "descriptive" | "other";

function categorizeVisibleBlock(block: DomBlock): VisibleBlockCategory {
  const text = `${block.normalizedText} ${Object.values(block.attributes).join(" ")}`.toLowerCase();

  if (["h1", "h2", "h3"].includes(block.tag)) {
    return "heading";
  }

  if (looksLikeSpecText(text)) {
    return "spec";
  }

  if (block.tag === "p" || block.tag === "li" || block.normalizedText.length >= 80) {
    return "descriptive";
  }

  return "other";
}

function scoreVisibleBlock(block: DomBlock, fieldSignals: FieldSignals = EMPTY_FIELD_SIGNALS): number {
  let score = block.score;
  const text = `${block.normalizedText} ${Object.values(block.attributes).join(" ")}`.toLowerCase();

  if (["h1", "h2", "h3"].includes(block.tag)) score += 0.2;
  if (looksLikeSpecText(text)) score += 0.25;
  score += scoreTextAgainstFields(text, fieldSignals);
  if (block.isInMainContent) score += 0.1;
  if (block.normalizedText.length >= 40 && block.normalizedText.length <= 240) score += 0.1;
  if (block.isLikelyNoise) score -= 0.25;

  return score;
}

function scoreJsonLdBlock(block: JsonLdBlock, fieldSignals: FieldSignals = EMPTY_FIELD_SIGNALS): number {
  let score = 0;

  if (block.type && HIGH_SIGNAL_JSONLD_TYPES.has(block.type.toLowerCase())) {
    score += 0.4;
  }

  if (isRecord(block.data)) {
    const keys = Object.keys(block.data);
    score += Math.min(0.4, keys.length * 0.04);

    const importantKeyMatches = keys.filter(key =>
      IMPORTANT_JSONLD_KEYS.some(importantKey => importantKey === key),
    ).length;
    score += Math.min(0.2, importantKeyMatches * 0.03);
    score += scoreTextAgainstFields(keys.join(" "), fieldSignals);
  }

  if (typeof block.data === "string" && block.data.length > 0) {
    score += 0.1;
  }

  if (block.data === null) {
    score -= 0.2;
  }

  return score;
}

function scoreTableBlock(table: TableBlock, fieldSignals: FieldSignals = EMPTY_FIELD_SIGNALS): number {
  if (isCookieConsentTable(table)) {
    return -1;
  }

  const joined = `${table.headers.join(" ")} ${table.rows.flat().join(" ")}`.toLowerCase();
  let score = table.score;

  if (looksLikeSpecText(joined)) score += 0.2;
  score += scoreTextAgainstFields(joined, fieldSignals);
  if (table.rows.length >= 3) score += 0.1;

  return score;
}

function getStructuredDataScore(packet: PagePacket): number {
  const jsonLdScore = Math.min(1, packet.jsonLd.reduce((sum, block) => sum + Math.max(0, scoreJsonLdBlock(block)), 0) / 3);
  const metadataScore = getMetadataSignalScore(packet);
  const tableScore = getTableSignalScore(packet.tables);

  return roundScore(
    clamp(jsonLdScore * 0.6 + metadataScore * 0.25 + tableScore * 0.15, 0, 1),
  );
}

function getMetadataSignalScore(packet: PagePacket): number {
  let score = 0;

  if (packet.title) score += 0.15;
  if (packet.metadata.description) score += 0.2;
  if (packet.metadata.canonicalUrl) score += 0.05;
  if (Object.keys(pickImportantMeta(packet.metadata.openGraph)).length > 0) score += 0.25;
  if (Object.keys(pickImportantMeta(packet.metadata.twitter)).length > 0) score += 0.15;
  if (Object.keys(pickImportantOtherMeta(packet.metadata.other)).length > 0) score += 0.2;

  return clamp(score, 0, 1);
}

function getTableSignalScore(tables: TableBlock[]): number {
  if (tables.length === 0) return 0;

  const relevantTables = tables.filter(table => !isCookieConsentTable(table));
  if (relevantTables.length === 0) return 0;

  const total = relevantTables.reduce((sum, table) => sum + Math.max(0, scoreTableBlock(table)), 0);
  return clamp(total / Math.max(1, relevantTables.length), 0, 1);
}

function getDominantSignals(packet: PagePacket, structuredDataScore: number): string[] {
  const signals: string[] = [];

  if (structuredDataScore >= 0.65) {
    signals.push("structured-data-rich");
  }

  if (packet.jsonLd.some(block => block.type && HIGH_SIGNAL_JSONLD_TYPES.has(block.type.toLowerCase()))) {
    signals.push("jsonld-primary");
  }

  if (packet.tables.some(table => !isCookieConsentTable(table) && looksLikeSpecText(`${table.headers.join(" ")} ${table.rows.flat().join(" ")}`))) {
    signals.push("spec-tables");
  }

  if (packet.visibleBlocks.some(block =>
    !isConsentOrPrivacyNoise(`${block.normalizedText} ${Object.values(block.attributes).join(" ")}`) &&
    categorizeVisibleBlock(block) === "spec"
  )) {
    signals.push("spec-dom");
  }

  if (signals.length === 0) {
    signals.push("dom-primary");
  }

  return signals;
}

function summarizeJsonLdData(
  value: unknown,
  options: {
    maxDepth: number;
    maxArrayItems: number;
    maxObjectKeys: number;
  },
  depth = 0,
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return trimText(value, depth === 0 ? 220 : 140);
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, options.maxArrayItems)
      .map(item => summarizeJsonLdData(item, options, depth + 1));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (depth >= options.maxDepth) {
    const name = typeof value.name === "string" ? trimText(value.name, 120) : null;
    const type = typeof value["@type"] === "string" ? value["@type"] : null;
    return {
      ...(type ? { "@type": type } : {}),
      ...(name ? { name } : {}),
    };
  }

  const prioritizedKeys = [
    ...IMPORTANT_JSONLD_KEYS.filter(key => key in value),
    ...Object.keys(value).filter(key => !IMPORTANT_JSONLD_KEYS.includes(key)),
  ].slice(0, options.maxObjectKeys);

  const output: Record<string, unknown> = {};

  for (const key of prioritizedKeys) {
    output[key] = summarizeJsonLdData(value[key], options, depth + 1);
  }

  return output;
}

function summarizeTableRows(rows: string[][], maxRows: number): string[][] {
  return rows
    .map(row => row.map(cell => trimText(cell, 120) ?? "").filter(Boolean))
    .filter(row => row.length > 0)
    .slice(0, maxRows);
}

function pickImportantMeta(input: Record<string, string>) {
  const output: Record<string, string> = {};

  for (const key of IMPORTANT_META_KEYS) {
    if (input[key]) {
      output[key] = trimText(input[key], 220) ?? input[key];
    }
  }

  return output;
}

function pickImportantOtherMeta(input: Record<string, string>, fieldSignals: FieldSignals = EMPTY_FIELD_SIGNALS) {
  const output: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    if (
      !IMPORTANT_OTHER_META_PATTERNS.some(pattern => pattern.test(key)) &&
      scoreTextAgainstFields(key, fieldSignals) <= 0
    ) {
      continue;
    }

    output[key] = trimText(value, 180) ?? value;
  }

  return output;
}

function pickUsefulDomAttributes(attributes: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (
      key === "itemprop" ||
      key === "property" ||
      key === "content" ||
      key === "aria-label" ||
      key === "role" ||
      key === "title" ||
      key === "alt" ||
      key === "name" ||
      key === "data-testid"
    ) {
      output[key] = trimText(value, 120) ?? value;
      continue;
    }

    if ((key === "id" || key === "class") && looksLikeHighSignalText(value)) {
      output[key] = trimText(value, 120) ?? value;
    }
  }

  return output;
}

function looksLikeSpecText(text: string): boolean {
  return /\b(identifier|id|reference|model|brand|manufacturer|sku|mpn|gtin|isbn|ean|upc|price|currency|availability|color|colour|dial|diameter|width|height|depth|dimension|size|material|category|condition|date)\b/i.test(text);
}

function looksLikeHighSignalText(text: string): boolean {
  return /\b(product|item|entity|brand|model|reference|identifier|sku|mpn|gtin|isbn|ean|upc|price|category)\b/i.test(text);
}

function looksLikeHighSignalHref(href: string): boolean {
  return /product|item|listing|article|collection|brand|reference|identifier|sku|model|catalog/i.test(href);
}

function isCookieConsentTable(table: TableBlock): boolean {
  const cells = [table.headers, ...table.rows].flat();
  const joined = cells.join(" ").toLowerCase();
  const domainCellCount = cells.filter(cell => /^\.?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(cell.trim())).length;
  const hasCookieColumn = /\b(cookie|cookies|dominio|domain|durata|duration|scadenza|expiry|fornitore|vendor|consenso|consent|privacy)\b/i.test(joined);
  const hasConsentVendor = /\b(cmp|cmps|iab|onetrust|cookiebot|didomi|casalemedia|doubleclick|googlesyndication|googleadservices|adsrvr|criteo)\b/i.test(joined);

  return (hasCookieColumn && domainCellCount >= 2) || (hasConsentVendor && domainCellCount >= 1);
}

function isConsentOrPrivacyNoise(text: string): boolean {
  const normalized = text.toLowerCase();
  const consentTerms = /\b(cookie|cookies|consenso|consent|privacy|gdpr|preferenze|legittimo interesse|tracciamento|profilazione|cmp|iab|onetrust|cookiebot|didomi)\b/i;
  const productTerms = /\b(reference|ref\.?|model|brand|diameter|dial|color|colour|sku|mpn|price|availability)\b/i;

  return consentTerms.test(normalized) && !productTerms.test(normalized);
}

function trimText(value: string | null, maxLength: number): string | null {
  if (value === null) return null;

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeForDedup(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function dedupeBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type FieldSignals = {
  terms: Set<string>;
};

const EMPTY_FIELD_SIGNALS: FieldSignals = {
  terms: new Set(),
};

const FIELD_SYNONYMS: Record<string, string[]> = {
  reference: ["reference", "ref", "identifier", "id", "sku", "mpn", "productid"],
  ref: ["reference", "identifier", "sku", "mpn"],
  model: ["model", "name", "series"],
  brand: ["brand", "manufacturer", "maker"],
  color: ["color", "colour"],
  colour: ["color", "colour"],
  dial: ["dial", "face"],
  dialcolor: ["dial", "color", "colour", "face"],
  diameter: ["diameter", "case", "width", "size", "mm"],
  width: ["width", "diameter", "size"],
  height: ["height", "dimension", "size"],
  depth: ["depth", "thickness", "dimension"],
  price: ["price", "currency", "amount"],
  availability: ["availability", "stock", "available"],
};

function buildFieldSignals(userSchema: UserSchema): FieldSignals {
  const terms = new Set<string>();

  for (const fieldName of Object.keys(userSchema)) {
    for (const token of tokenizeFieldName(fieldName)) {
      terms.add(token);
      for (const synonym of FIELD_SYNONYMS[token] ?? []) {
        terms.add(synonym);
      }
    }
  }

  return { terms };
}

function tokenizeFieldName(fieldName: string): string[] {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
}

function scoreTextAgainstFields(text: string, fieldSignals: FieldSignals): number {
  if (fieldSignals.terms.size === 0) {
    return 0;
  }

  const normalized = text.toLowerCase();
  let matches = 0;

  for (const term of fieldSignals.terms) {
    if (normalized.includes(term)) {
      matches += 1;
    }
  }

  return Math.min(1, matches * 0.3);
}
