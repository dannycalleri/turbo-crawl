import type { UserSchema } from "./types";
import { EVIDENCE_REASON_VALUES } from "./types";
import type { PagePacket } from "../types";
import type { CompactPagePacket } from "../compactPagePacket";

export function buildExtractionPrompt(input: {
  userSchema: UserSchema;
  pagePacket: PagePacket | CompactPagePacket;
}) {
  const { userSchema, pagePacket } = input;

  return [
    {
      role: "system" as const,
      content: [
        "Precise webpage data extractor.",
        "Use only supplied packet facts; do not invent values.",
        "Return only JSON.",
        "The response schema is enforced separately from this prompt.",
      ].join(" "),
    },
    {
      role: "user" as const,
      content: [
        "Extract the main page entity.",
        `Schema=${JSON.stringify(userSchema)}`,
        [
          "Rules:",
          "ignore navigation/footer/cookies/ads/related items;",
          "prefer JSON-LD/metadata when clearly about the main entity, otherwise visible content;",
          "use null for missing/uncertain fields;",
          "provide evidence for every field;",
          "sourceNodeId must be a packet nodeId or null for metadata/current URL;",
          "quotedText is the shortest exact supporting value, max 180 chars;",
          "confidence must be exactly one of 0,0.25,0.5,0.75,1; never long decimals.",
          `reason must be exactly one of ${EVIDENCE_REASON_VALUES.join(",")}; no prose.`,
          "Emit number fields as compact numeric strings like \"39\" or \"39.5\"; never JSON number literals.",
        ].join(" "),
        `Packet=${JSON.stringify(toPromptPacket(pagePacket))}`,
      ].join("\n"),
    },
  ];
}

function toPromptPacket(pagePacket: PagePacket | CompactPagePacket): unknown {
  return {
    url: pagePacket.url,
    finalUrl: pagePacket.finalUrl,
    title: pagePacket.title,
    metadata: {
      canonicalUrl: pagePacket.metadata.canonicalUrl,
      description: pagePacket.metadata.description,
      openGraph: pagePacket.metadata.openGraph,
      twitter: pagePacket.metadata.twitter,
      other: pagePacket.metadata.other,
    },
    jsonLd: pagePacket.jsonLd.slice(0, 8).map(block => ({
      nodeId: block.nodeId,
      type: block.type,
      data: "data" in block ? block.data : undefined,
      raw: "raw" in block && typeof block.raw === "string" ? trimPromptText(block.raw, 240) : undefined,
    })),
    visibleBlocks: pagePacket.visibleBlocks.slice(0, 56).map(block => ({
      nodeId: block.nodeId,
      tag: block.tag,
      text: trimPromptText(readVisibleBlockText(block), 240),
      attributes: block.attributes,
    })),
    links: pagePacket.links.slice(0, 16).map(link => ({
      nodeId: link.nodeId,
      text: trimPromptText(link.text, 100),
      href: trimPromptText(link.href, 180),
    })),
    images: pagePacket.images.slice(0, 12).map(image => ({
      nodeId: image.nodeId,
      src: trimPromptText(image.src, 180),
      alt: trimPromptText(image.alt, 120),
    })),
    tables: pagePacket.tables.slice(0, 8).map(table => ({
      nodeId: table.nodeId,
      headers: table.headers.map(header => trimPromptText(header, 80) ?? ""),
      rows: table.rows.slice(0, 10).map(row => row.map(cell => trimPromptText(cell, 120) ?? "")),
    })),
  };
}

function trimPromptText(value: string | null | undefined, maxLength: number): string | null | undefined {
  if (value === null || value === undefined) return value;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function readVisibleBlockText(block: PagePacket["visibleBlocks"][number] | CompactPagePacket["visibleBlocks"][number]): string {
  if ("normalizedText" in block && typeof block.normalizedText === "string") {
    return block.normalizedText;
  }

  return block.text;
}
