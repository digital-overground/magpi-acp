import type { PlanEntry } from "@agentclientprotocol/sdk";

interface ToolResultRecord {
  content?: unknown;
  details?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  output?: unknown;
  exitCode?: unknown;
  code?: unknown;
  diff?: unknown;
}

const asToolResult = (value: unknown): ToolResultRecord | null | undefined =>
  value as ToolResultRecord | null | undefined;

const firstValueOfType = <T>(
  type: "string" | "number",
  ...values: unknown[]
): T | undefined => values.find((value) => typeof value === type) as T;

const contentText = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((item) => {
      const block = item as { type?: unknown; text?: unknown } | null;
      return block?.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .filter(Boolean)
    .join("");
  return text || undefined;
};

const processOutputText = (
  record: ToolResultRecord | null | undefined,
  details: ToolResultRecord | null | undefined
): string | undefined => {
  const stdout = firstValueOfType<string>(
    "string",
    details?.stdout,
    record?.stdout,
    details?.output,
    record?.output
  );
  const stderr = firstValueOfType<string>(
    "string",
    details?.stderr,
    record?.stderr
  );
  if (!stdout?.trim() && !stderr?.trim()) {
    return undefined;
  }

  const parts: string[] = [];
  if (stdout?.trim()) {
    parts.push(stdout);
  }
  if (stderr?.trim()) {
    parts.push(`stderr:\n${stderr}`);
  }

  const exitCode = firstValueOfType<number>(
    "number",
    details?.exitCode,
    record?.exitCode,
    details?.code,
    record?.code
  );
  if (exitCode !== undefined) {
    parts.push(`exit code: ${exitCode}`);
  }
  return parts.join("\n\n").trimEnd();
};

export const todoResultToPlanEntries = (
  result: unknown
): PlanEntry[] | undefined => {
  const details = (
    result as { details?: { tasks?: unknown; todos?: unknown } } | null
  )?.details;

  if (Array.isArray(details?.tasks)) {
    const entries: PlanEntry[] = [];
    for (const task of details.tasks) {
      const item = task as { subject?: unknown; status?: unknown } | null;
      if (typeof item?.subject !== "string") {
        return undefined;
      }
      if (item.status === "deleted") {
        continue;
      }
      if (
        item.status !== "pending" &&
        item.status !== "in_progress" &&
        item.status !== "completed"
      ) {
        return undefined;
      }
      entries.push({
        content: item.subject,
        priority: "medium",
        status: item.status,
      });
    }
    return entries;
  }

  if (!Array.isArray(details?.todos)) {
    return undefined;
  }

  let hasActiveTodo = false;
  const entries: PlanEntry[] = [];
  for (const todo of details.todos) {
    const item = todo as { text?: unknown; done?: unknown } | null;
    if (typeof item?.text !== "string" || typeof item.done !== "boolean") {
      return undefined;
    }

    let status: PlanEntry["status"] = "in_progress";
    if (item.done) {
      status = "completed";
    } else if (hasActiveTodo) {
      status = "pending";
    }
    if (!item.done) {
      hasActiveTodo = true;
    }
    entries.push({ content: item.text, priority: "medium", status });
  }
  return entries;
};

export const toolResultToText = (result: unknown): string => {
  if (!result) {
    return "";
  }

  const record = asToolResult(result);
  const details = asToolResult(record?.details);
  if (typeof details?.diff === "string" && details.diff.trim()) {
    return details.diff;
  }

  const text = contentText(record?.content);
  if (text) {
    return text;
  }

  const processOutput = processOutputText(record, details);
  if (processOutput !== undefined) {
    return processOutput;
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
};
