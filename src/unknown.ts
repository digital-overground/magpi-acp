export type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const asRecord = (value: unknown): UnknownRecord | undefined =>
  isRecord(value) ? value : undefined;

export const stringValue = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  return fallback;
};

export const errorMessage = (value: unknown): string => {
  if (value instanceof Error) {
    return value.message;
  }
  const message = asRecord(value)?.message;
  if (typeof message === "string") {
    return message;
  }
  return stringValue(value, "Unknown error");
};
