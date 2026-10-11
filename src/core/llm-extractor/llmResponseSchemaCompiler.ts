import { EVIDENCE_REASON_VALUES } from "./types";
import type { UserSchema, FieldType } from "./types";

const MAX_PAYLOAD_STRING_LENGTH = 240;
const MAX_PAYLOAD_TEXT_LENGTH = 500;
const MAX_PAYLOAD_URL_LENGTH = 500;
const MAX_PAYLOAD_DATE_LENGTH = 80;
const MAX_SOURCE_NODE_ID_LENGTH = 120;
const MAX_QUOTED_TEXT_LENGTH = 180;

export function compileLLMResponseJsonSchema(userSchema: UserSchema) {
    const payloadProperties: Record<string, unknown> = {};
    const evidenceProperties: Record<string, unknown> = {};

    for (const [fieldName, fieldType] of Object.entries(userSchema)) {
        payloadProperties[fieldName] = jsonSchemaForFieldType(fieldType);

        evidenceProperties[fieldName] = {
            type: "object",
            properties: {
                sourceNodeId: {
                    anyOf: [
                        {
                            type: "string",
                            maxLength: MAX_SOURCE_NODE_ID_LENGTH,
                        },
                        { type: "null" },
                    ],
                },
                quotedText: {
                    anyOf: [
                        {
                            type: "string",
                            maxLength: MAX_QUOTED_TEXT_LENGTH,
                        },
                        { type: "null" },
                    ],
                },
                confidence: {
                    type: "number",
                    enum: [0, 0.25, 0.5, 0.75, 1],
                },
                reason: {
                    type: "string",
                    enum: [...EVIDENCE_REASON_VALUES],
                },
            },
            required: ["sourceNodeId", "quotedText", "confidence", "reason"],
            additionalProperties: false,
        };
    }

    return {
        type: "object",
        properties: {
            payload: {
                type: "object",
                properties: payloadProperties,
                required: Object.keys(userSchema),
                additionalProperties: false,
            },
            evidence: {
                type: "object",
                properties: evidenceProperties,
                required: Object.keys(userSchema),
                additionalProperties: false,
            },
        },
        required: ["payload", "evidence"],
        additionalProperties: false,
    };
}

function jsonSchemaForFieldType(type: FieldType) {
    switch (type) {
        case "string":
            return nullableJsonSchema({
                type: "string",
                maxLength: MAX_PAYLOAD_STRING_LENGTH,
            });

        case "text":
            return nullableJsonSchema({
                type: "string",
                maxLength: MAX_PAYLOAD_TEXT_LENGTH,
            });

        case "number":
            return nullableJsonSchema({
                type: "string",
                pattern: "^-?\\d+(?:[.,]\\d{1,4})?$",
                maxLength: 32,
            });

        case "boolean":
            return nullableJsonSchema({ type: "boolean" });

        case "date":
            return nullableJsonSchema({
                type: "string",
                maxLength: MAX_PAYLOAD_DATE_LENGTH,
            });

        case "url":
            return nullableJsonSchema({
                type: "string",
                maxLength: MAX_PAYLOAD_URL_LENGTH,
            });
    }
}

function nullableJsonSchema(schema: Record<string, unknown>) {
    const { type, ...rest } = schema;

    return {
        anyOf: [
            { type, ...rest },
            { type: "null" },
        ],
    };
}
