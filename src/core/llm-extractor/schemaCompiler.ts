import { z } from "zod";
import { EVIDENCE_REASON_VALUES } from "./types";
import type { FieldType, UserSchema } from "./types";

const MAX_PAYLOAD_STRING_LENGTH = 240;
const MAX_PAYLOAD_TEXT_LENGTH = 500;
const MAX_PAYLOAD_URL_LENGTH = 500;
const MAX_PAYLOAD_DATE_LENGTH = 80;
const MAX_SOURCE_NODE_ID_LENGTH = 120;
const MAX_QUOTED_TEXT_LENGTH = 180;

export function compilePayloadZodSchema(userSchema: UserSchema) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [fieldName, fieldType] of Object.entries(userSchema)) {
    shape[fieldName] = zodForFieldType(fieldType);
  }

  return z.object(shape).strict();
}

export function compileLLMResponseZodSchema(userSchema: UserSchema) {
  const payloadSchema = compilePayloadZodSchema(userSchema);

  const evidenceShape: Record<string, z.ZodTypeAny> = {};

  for (const fieldName of Object.keys(userSchema)) {
    evidenceShape[fieldName] = z
      .object({
        sourceNodeId: z.string().max(MAX_SOURCE_NODE_ID_LENGTH).nullable(),
        quotedText: z.string().max(MAX_QUOTED_TEXT_LENGTH).nullable(),
        confidence: z.union([
          z.literal(0),
          z.literal(0.25),
          z.literal(0.5),
          z.literal(0.75),
          z.literal(1),
        ]),
        reason: z.enum(EVIDENCE_REASON_VALUES),
      })
      .strict();
  }

  return z
    .object({
      payload: payloadSchema,
      evidence: z.object(evidenceShape).strict(),
    })
    .strict();
}

function zodForFieldType(type: FieldType): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string().max(MAX_PAYLOAD_STRING_LENGTH).nullable();

    case "text":
      return z.string().max(MAX_PAYLOAD_TEXT_LENGTH).nullable();

    case "number":
      return z.string().max(32).regex(/^-?\d+(?:[.,]\d{1,4})?$/).nullable();

    case "boolean":
      return z.boolean().nullable();

    case "date":
      /**
       * Keep date as string for now.
       * You will normalize to ISO later.
       */
      return z.string().max(MAX_PAYLOAD_DATE_LENGTH).nullable();

    case "url":
      /**
       * Be careful here.
       * Local LLMs sometimes output relative URLs.
       * Accept string now, normalize later.
       */
      return z.string().max(MAX_PAYLOAD_URL_LENGTH).nullable();

    default:
      return z.null();
  }
}
