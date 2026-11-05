import crypto from "crypto";
import type { FieldType } from "../llm-extractor/types";

export function createTemplateId(
    domain: string,
    urlPattern: string,
    schema: Record<string, FieldType>
): string {
    return `template_${hashId(`${domain}:${urlPattern}:${Object.keys(schema).sort().join(",")}`)}`;
}

export function createListingTemplateId(domain: string, urlPattern: string): string {
    return `listing_${hashId(`listing:${domain}:${urlPattern}`)}`;
}

function hashId(raw: string): string {
    return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
