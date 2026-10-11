import crypto from "crypto";
import type { FieldType } from "../llm-extractor/types";

export function createTemplateId(
    domain: string,
    urlPattern: string,
    schema: Record<string, FieldType>
): string {
    const raw = `${domain}:${urlPattern}:${Object.keys(schema).sort().join(",")}`;
    return `template_${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}
