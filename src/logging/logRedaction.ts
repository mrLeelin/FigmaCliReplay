import type { LogEvent } from "./logEvent.js";

export const MAX_LOG_EVENT_BYTES = 64 * 1024;
export const MAX_INLINE_TEXT_CHARS = 4_096;

const SensitiveKeyPattern = /password|token|authorization|cookie|api[_-]?key|secret|client[_-]?secret|access[_-]?token/i;
const LargePayloadKeyPattern = /base64|bytes|image|png|psd|payload|body/i;

export function redactLogData(value: unknown): unknown {
  return redactValue(value, "", new WeakSet<object>());
}

export function fitLogEventToSize(event: LogEvent): LogEvent {
  const redacted = {
    ...event,
    data: event.data ? asRecord(redactLogData(event.data)) : undefined,
  };
  const serialized = JSON.stringify(redacted);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= MAX_LOG_EVENT_BYTES) {
    return redacted;
  }
  return {
    ...redacted,
    data: {
      truncated: true,
      originalBytes,
    },
  };
}

function redactValue(value: unknown, key: string, seen: WeakSet<object>): unknown {
  if (SensitiveKeyPattern.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    if (value.length > MAX_INLINE_TEXT_CHARS && LargePayloadKeyPattern.test(key)) {
      return {
        kind: "large-payload",
        chars: value.length,
        truncated: true,
      };
    }
    return value.length > MAX_INLINE_TEXT_CHARS
      ? `${value.slice(0, MAX_INLINE_TEXT_CHARS)}…[truncated ${value.length - MAX_INLINE_TEXT_CHARS} chars]`
      : value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, key, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = redactValue(childValue, childKey, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}
