import type { Page } from "playwright";

export interface JsonLdBlock {
    nodeId: string;
    type: string | null;
    data: unknown;
    raw: string;
}

const PADDING = 3;

export async function extractJsonLd(page: Page): Promise<JsonLdBlock[]> {
  const rawBlocks = await page.$$eval(
    'script[type="application/ld+json"]',
    nodes =>
      nodes
        .map(node => node.textContent || "")
        .map(text => text.trim())
        .filter(Boolean)
  );

  const blocks: JsonLdBlock[] = [];

  rawBlocks.forEach((raw, index) => {
    const parsed = parsePossiblyBrokenJson(raw);

    if (!parsed) {
      blocks.push({
        nodeId: `jsonld_${String(index + 1).padStart(PADDING, "0")}`,
        type: null,
        data: null,
        raw,
      });
      return;
    }

    const flattened = flattenJsonLd(parsed);

    flattened.forEach((item, subIndex) => {
      blocks.push({
        nodeId: `jsonld_${String(index + 1).padStart(PADDING, "0")}_${subIndex + 1}`,
        type: getJsonLdType(item),
        data: item,
        raw,
      });
    });
  });

  return blocks;
}

export function parsePossiblyBrokenJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function flattenJsonLd(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input.flatMap(flattenJsonLd);
  }

  if (isRecord(input) && Array.isArray(input["@graph"])) {
    return input["@graph"];
  }

  return [input];
}

export function getJsonLdType(input: unknown): string | null {
  if (!isRecord(input)) return null;

  const type = input["@type"];

  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.filter(Boolean).join(",");

  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
