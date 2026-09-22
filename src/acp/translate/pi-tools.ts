import type { PlanEntry } from "@agentclientprotocol/sdk";

import { asRecord } from "../../unknown.js";

const firstString = (...values: unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === "string");

const firstNumber = (...values: unknown[]): number | undefined =>
  values.find((value): value is number => typeof value === "number");

const contentText = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((item) => {
      const block = asRecord(item);
      return block?.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .filter((part) => part.length > 0)
    .join("");
  return text.length > 0 ? text : undefined;
};

const processOutputText = (
  record: Record<string, unknown> | undefined,
  details: Record<string, unknown> | undefined
): string | undefined => {
  const stdout = firstString(
    details?.stdout,
    record?.stdout,
    details?.output,
    record?.output
  );
  const stderr = firstString(details?.stderr, record?.stderr);
  if (
    (stdout === undefined || stdout.trim().length === 0) &&
    (stderr === undefined || stderr.trim().length === 0)
  ) {
    return undefined;
  }

  const parts: string[] = [];
  if (stdout !== undefined && stdout.trim().length > 0) {
    parts.push(stdout);
  }
  if (stderr !== undefined && stderr.trim().length > 0) {
    parts.push(`stderr:\n${stderr}`);
  }

  const exitCode = firstNumber(
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
  const details = asRecord(asRecord(result)?.details);

  if (Array.isArray(details?.tasks)) {
    const entries: PlanEntry[] = [];
    for (const task of details.tasks) {
      const item = asRecord(task);
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
    const item = asRecord(todo);
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
  if (result === null || result === undefined) {
    return "";
  }

  const record = asRecord(result);
  const details = asRecord(record?.details);
  if (typeof details?.diff === "string" && details.diff.trim().length > 0) {
    return details.diff;
  }

  const text = contentText(record?.content);
  if (text !== undefined) {
    return text;
  }

  const processOutput = processOutputText(record, details);
  if (processOutput !== undefined) {
    return processOutput;
  }

  try {
    return JSON.stringify(result, null, 2) ?? "";
  } catch {
    return "";
  }
};
