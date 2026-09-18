import type { ToolCallContent } from "@agentclientprotocol/sdk";

interface BashCommandRecord {
  command?: unknown;
  cmd?: unknown;
  args?: BashCommandRecord;
  input?: BashCommandRecord;
  rawInput?: BashCommandRecord;
  toolInput?: BashCommandRecord;
  details?: BashCommandRecord;
}

interface BashResultRecord {
  content?: unknown;
  details?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  output?: unknown;
  exitCode?: unknown;
  code?: unknown;
}

const firstString = (...values: unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === "string");

export const isBashTool = (toolName: string): boolean =>
  toolName.toLowerCase() === "bash";

export const bashCommand = (value: unknown): string | undefined => {
  const record = value as BashCommandRecord | null | undefined;
  const nested = [
    record,
    record?.args,
    record?.input,
    record?.rawInput,
    record?.toolInput,
    record?.details,
  ];
  for (const candidate of nested) {
    const command = firstString(candidate?.command, candidate?.cmd);
    if (command?.trim()) {
      return command;
    }
  }
  return undefined;
};

export const bashResultText = (result: unknown): string => {
  const record = result as BashResultRecord | null | undefined;
  const content = record?.content;
  if (Array.isArray(content)) {
    const texts = content
      .map((item) => {
        const block = item as { type?: unknown; text?: unknown };
        return block.type === "text" && typeof block.text === "string"
          ? block.text
          : "";
      })
      .filter(Boolean);
    if (texts.length) {
      return texts.join("");
    }
  }

  const details = record?.details as BashResultRecord | null | undefined;
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
  const record = result as BashResultRecord | null | undefined;
  const details = record?.details as BashResultRecord | null | undefined;
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
