import type { ToolCallContent } from "@agentclientprotocol/sdk";

import { asRecord } from "../../unknown.js";

const firstString = (...values: unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === "string");

export const isBashTool = (toolName: string): boolean =>
  toolName.toLowerCase() === "bash";

export const bashCommand = (value: unknown): string | undefined => {
  const record = asRecord(value);
  const nested = [
    record,
    asRecord(record?.args),
    asRecord(record?.input),
    asRecord(record?.rawInput),
    asRecord(record?.toolInput),
    asRecord(record?.details),
  ];
  for (const candidate of nested) {
    const command = firstString(candidate?.command, candidate?.cmd);
    if (command !== undefined && command.trim().length > 0) {
      return command;
    }
  }
  return undefined;
};

export const bashResultText = (result: unknown): string => {
  const record = asRecord(result);
  const content = record?.content;
  if (Array.isArray(content)) {
    const texts = content
      .map((item) => {
        const block = asRecord(item);
        return block?.type === "text" && typeof block.text === "string"
          ? block.text
          : "";
      })
      .filter((text) => text.length > 0);
    if (texts.length > 0) {
      return texts.join("");
    }
  }

  const details = asRecord(record?.details);
  const stdout = firstString(
    details?.stdout,
    record?.stdout,
    details?.output,
    record?.output
  );
  const stderr = firstString(details?.stderr, record?.stderr);

  return [stdout, stderr]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0
    )
    .join("\n");
};

export const bashExitCode = (result: unknown, isError: boolean): number => {
  const record = asRecord(result);
  const details = asRecord(record?.details);
  const exitCode = [
    details?.exitCode,
    record?.exitCode,
    details?.code,
    record?.code,
  ].find((value): value is number => typeof value === "number");
  if (exitCode !== undefined) {
    return exitCode;
  }
  return isError ? 1 : 0;
};

export const bashOutputDelta = (previous: string, next: string): string =>
  next.startsWith(previous) ? next.slice(previous.length) : next;

export const bashTerminalContent = (toolCallId: string): ToolCallContent[] =>
  [{ terminalId: toolCallId, type: "terminal" }] satisfies ToolCallContent[];

export const bashTerminalInfoMeta = (toolCallId: string, cwd: string) =>
  // ACP clients can render `execute` tools as terminals when paired with
  // terminal content and metadata. See the execute tool schema:
  // https://agentclientprotocol.com/protocol/schema#param-execute
  ({ terminal_info: { cwd, terminal_id: toolCallId } });

export const bashTerminalOutputMeta = (toolCallId: string, data: string) => ({
  terminal_output: { data, terminal_id: toolCallId },
});

export const bashTerminalExitMeta = (toolCallId: string, exitCode: number) => ({
  terminal_exit: {
    exit_code: exitCode,
    signal: null,
    terminal_id: toolCallId,
  },
});
