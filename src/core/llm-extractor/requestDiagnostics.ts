import type { ChatMessage } from "./providers/LLMProvider";

export type ContentCategoryCounts = {
  jsonLd: number;
  visibleBlocks: number;
  links: number;
  images: number;
  tables: number;
};

export type RequestFootprintComponent = {
  name: string;
  bytes: number;
  chars: number;
};

export type RequestFootprintDiagnostics = {
  systemPromptBytes: number;
  systemPromptChars: number;
  userPromptBytes: number;
  userPromptChars: number;
  compactPacketBytes: number;
  compactPacketChars: number;
  userSchemaBytes: number;
  userSchemaChars: number;
  responseSchemaBytes: number;
  responseSchemaChars: number;
  totalRequestBytes: number;
  totalRequestChars: number;
  retainedCounts?: ContentCategoryCounts;
  omittedCounts?: ContentCategoryCounts;
  dominantComponents: RequestFootprintComponent[];
};

export function measureStructuredRequestFootprint(input: {
  model: string;
  messages: ChatMessage[];
  jsonSchema: unknown;
  temperature?: number;
  maxTokens?: number;
  pagePacket?: unknown;
  userSchema?: unknown;
  retainedCounts?: ContentCategoryCounts;
  omittedCounts?: ContentCategoryCounts;
}): RequestFootprintDiagnostics {
  const systemPrompt = input.messages
    .filter(message => message.role === "system")
    .map(message => message.content)
    .join("\n");
  const userPrompt = input.messages
    .filter(message => message.role === "user")
    .map(message => message.content)
    .join("\n");
  const compactPacketJson = stableJson(input.pagePacket ?? null);
  const userSchemaJson = stableJson(input.userSchema ?? null);
  const responseSchemaJson = stableJson(input.jsonSchema);
  const totalRequestJson = stableJson({
    model: input.model,
    messages: input.messages,
    temperature: input.temperature ?? 0,
    max_tokens: input.maxTokens,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "webpage_extraction_result",
        strict: true,
        schema: input.jsonSchema,
      },
    },
  });

  const system = measureText(systemPrompt);
  const user = measureText(userPrompt);
  const packet = measureText(compactPacketJson);
  const schema = measureText(userSchemaJson);
  const responseSchema = measureText(responseSchemaJson);
  const total = measureText(totalRequestJson);

  const components: RequestFootprintComponent[] = [
    { name: "totalRequest", bytes: total.bytes, chars: total.chars },
    { name: "userPrompt", bytes: user.bytes, chars: user.chars },
    { name: "compactPacket", bytes: packet.bytes, chars: packet.chars },
    { name: "responseSchema", bytes: responseSchema.bytes, chars: responseSchema.chars },
    { name: "systemPrompt", bytes: system.bytes, chars: system.chars },
    { name: "userSchema", bytes: schema.bytes, chars: schema.chars },
  ].sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));

  return {
    systemPromptBytes: system.bytes,
    systemPromptChars: system.chars,
    userPromptBytes: user.bytes,
    userPromptChars: user.chars,
    compactPacketBytes: packet.bytes,
    compactPacketChars: packet.chars,
    userSchemaBytes: schema.bytes,
    userSchemaChars: schema.chars,
    responseSchemaBytes: responseSchema.bytes,
    responseSchemaChars: responseSchema.chars,
    totalRequestBytes: total.bytes,
    totalRequestChars: total.chars,
    retainedCounts: input.retainedCounts,
    omittedCounts: input.omittedCounts,
    dominantComponents: components,
  };
}

function measureText(value: string): { bytes: number; chars: number } {
  return {
    bytes: Buffer.byteLength(value, "utf8"),
    chars: value.length,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonValue(value[key]);
  }
  return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
