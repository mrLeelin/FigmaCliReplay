import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

/** Describe the existing Zod input contract; runtime refinements remain authoritative. */
export function inputSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def;
  let result: JsonSchema;
  if (schema instanceof z.ZodEffects) {
    result = { ...inputSchema(schema.innerType()), "x-runtimeValidation": true };
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    result = inputSchema(def.innerType);
    if (schema instanceof z.ZodDefault) result = { ...result, default: def.defaultValue() };
  } else if (schema instanceof z.ZodNullable) {
    result = { anyOf: [inputSchema(schema.unwrap()), { type: "null" }] };
  } else if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    result = {
      type: "object",
      properties: Object.fromEntries(Object.entries(shape).map(([name, child]) => [name, inputSchema(child)])),
      required: Object.entries(shape).filter(([, child]) => !child.isOptional()).map(([name]) => name),
      additionalProperties: def.unknownKeys === "passthrough",
    };
  } else if (schema instanceof z.ZodArray) {
    result = { type: "array", items: inputSchema(schema.element) };
    if (def.minLength) result.minItems = def.minLength.value;
    if (def.maxLength) result.maxItems = def.maxLength.value;
  } else if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion) {
    result = { anyOf: schema.options.map((option: z.ZodTypeAny) => inputSchema(option)) };
  } else if (schema instanceof z.ZodRecord) {
    result = { type: "object", additionalProperties: inputSchema(schema.valueSchema) };
    if (!(schema.keySchema instanceof z.ZodString) || schema.keySchema._def.checks.length) {
      result.propertyNames = inputSchema(schema.keySchema);
    }
  } else if (schema instanceof z.ZodLiteral) {
    result = { const: schema.value, type: typeof schema.value };
  } else if (schema instanceof z.ZodEnum) {
    result = { type: "string", enum: schema.options };
  } else if (schema instanceof z.ZodString) {
    result = { type: "string" };
    for (const check of schema._def.checks) {
      if (check.kind === "min") result.minLength = check.value;
      if (check.kind === "max") result.maxLength = check.value;
      if (check.kind === "regex") result.pattern = check.regex.source;
      if (check.kind === "trim") result["x-trim"] = true;
    }
  } else if (schema instanceof z.ZodNumber) {
    result = { type: "number" };
    for (const check of schema._def.checks) {
      if (check.kind === "int") result.type = "integer";
      if (check.kind === "min") result[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
      if (check.kind === "max") result[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
    }
  } else if (schema instanceof z.ZodBoolean) {
    result = { type: "boolean" };
  } else if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) {
    result = {};
  } else {
    // Do not silently publish a fabricated contract if a new Zod kind is introduced.
    throw new Error(`Unsupported CLI discovery schema: ${def.typeName}`);
  }
  if (schema.description) result = { ...result, description: schema.description };
  return result;
}

/** The job type is passed through --job-type, outside --payload. */
export function jobPayloadSchema(schema: z.ZodTypeAny): JsonSchema {
  const result = inputSchema(schema);
  const properties = { ...(result.properties as Record<string, unknown>) };
  delete properties.type;
  return {
    ...result,
    properties,
    required: (result.required as string[]).filter((name) => name !== "type"),
  };
}
