interface AskOption {
  title: string;
  description?: string;
}
type AskResponse =
  | { kind: "selection"; selections: string[]; comment?: string }
  | { kind: "freeform"; text: string };
interface AskParams {
  question: string;
  context?: string;
  options?: AskOption[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  allowComment?: boolean;
  timeout?: number;
}
interface DialogOptions {
  timeout?: number;
  signal?: AbortSignal;
}
interface AskContext {
  hasUI: boolean;
  ui: {
    select: (
      title: string,
      options: string[],
      settings?: DialogOptions
    ) => Promise<string | undefined>;
    input: (
      title: string,
      placeholder?: string,
      settings?: DialogOptions
    ) => Promise<string | undefined>;
  };
}
export interface AskResult {
  content: { type: "text"; text: string }[];
  details: {
    question: string;
    context?: string;
    options: AskOption[];
    response: AskResponse | null;
    cancelled: boolean;
  };
}
export interface AskTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  executionMode: "sequential";
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: AskParams,
    signal: AbortSignal | undefined,
    onUpdate: ((result: AskResult) => void) | undefined,
    context: AskContext
  ) => Promise<AskResult>;
}
interface PiExtensionApi {
  getAllTools: () => { name: string }[];
  on: (event: "session_start", handler: () => void) => void;
  registerTool: (tool: AskTool) => void;
}

const FREEFORM_OPTION = "✏️ Type custom response...";

const trimmed = (value: string | undefined): string | undefined => {
  const result = value?.trim();
  return result === undefined || result.length === 0 ? undefined : result;
};

const result = (params: AskParams, response: AskResponse | null): AskResult => {
  const context = trimmed(params.context);
  const options = params.options ?? [];
  let answer = "User cancelled the question";
  if (response?.kind === "freeform") {
    answer = response.text;
  } else if (response?.kind === "selection") {
    answer = `${response.selections.join(", ")}${response.comment === undefined ? "" : ` — ${response.comment}`}`;
  }
  return {
    content: [
      {
        text: response === null ? answer : `User answered: ${answer}`,
        type: "text",
      },
    ],
    details: {
      cancelled: response === null,
      ...(context === undefined ? {} : { context }),
      options,
      question: params.question,
      response,
    },
  };
};

const commentFor = async (
  params: AskParams,
  context: AskContext,
  prompt: string,
  dialogOptions: DialogOptions | undefined
): Promise<string | undefined> => {
  if (params.allowComment !== true) {
    return undefined;
  }
  const answer = await context.ui.input(
    prompt,
    "Optional comment (press Enter to skip)...",
    dialogOptions
  );
  return trimmed(answer);
};

const askFreeform = async (
  params: AskParams,
  context: AskContext,
  prompt: string,
  dialogOptions: DialogOptions | undefined
): Promise<AskResult> => {
  const answer = await context.ui.input(
    prompt,
    "Type your answer...",
    dialogOptions
  );
  const text = trimmed(answer);
  return result(params, text === undefined ? null : { kind: "freeform", text });
};

const askMultiple = async (
  params: AskParams,
  context: AskContext,
  prompt: string,
  dialogOptions: DialogOptions | undefined
): Promise<AskResult> => {
  const choices = (params.options ?? [])
    .map(
      (option, index) =>
        `${index + 1}. ${option.title}${option.description === undefined ? "" : ` — ${option.description}`}`
    )
    .join("\n");
  const answer = await context.ui.input(
    `${prompt}\n\nOptions (select one or more):\n${choices}`,
    "Type your selection(s)...",
    dialogOptions
  );
  const selections = answer
    ?.split(",")
    .map((selection) => selection.trim())
    .filter((selection) => selection.length > 0);
  if (selections === undefined || selections.length === 0) {
    return result(params, null);
  }

  const comment = await commentFor(params, context, prompt, dialogOptions);
  return result(params, {
    ...(comment === undefined ? {} : { comment }),
    kind: "selection",
    selections,
  });
};

const askSingle = async (
  params: AskParams,
  context: AskContext,
  prompt: string,
  dialogOptions: DialogOptions | undefined
): Promise<AskResult> => {
  const choices = (params.options ?? []).map((option) => option.title);
  if (params.allowFreeform !== false) {
    choices.push(FREEFORM_OPTION);
  }
  const answer = await context.ui.select(prompt, choices, dialogOptions);
  const selected = trimmed(answer);
  if (selected === undefined) {
    return result(params, null);
  }
  if (selected === FREEFORM_OPTION) {
    return await askFreeform(params, context, prompt, dialogOptions);
  }

  const comment = await commentFor(params, context, prompt, dialogOptions);
  return result(params, {
    ...(comment === undefined ? {} : { comment }),
    kind: "selection",
    selections: [selected],
  });
};

export default function registerMagPiAcpAskUser(pi: PiExtensionApi): void {
  const tool: AskTool = {
    description:
      "Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Ask exactly one focused question per call.",
    execute: async (_toolCallId, params, signal, _onUpdate, context) => {
      if (signal?.aborted === true || !context.hasUI) {
        return result(params, null);
      }

      const promptContext = trimmed(params.context);
      const prompt =
        promptContext === undefined
          ? params.question
          : `${params.question}\n\nContext:\n${promptContext}`;
      const dialogOptions =
        params.timeout === undefined && signal === undefined
          ? undefined
          : {
              ...(signal === undefined ? {} : { signal }),
              ...(params.timeout === undefined
                ? {}
                : { timeout: params.timeout }),
            };
      const options = params.options ?? [];
      if (options.length === 0) {
        return await askFreeform(params, context, prompt, dialogOptions);
      }
      return params.allowMultiple === true
        ? await askMultiple(params, context, prompt, dialogOptions)
        : await askSingle(params, context, prompt, dialogOptions);
    },
    executionMode: "sequential",
    label: "Ask User",
    name: "ask_user",
    parameters: {
      properties: {
        allowComment: {
          description:
            "Collect an optional comment after selection. Default: false",
          type: "boolean",
        },
        allowFreeform: {
          description: "Add a freeform text option. Default: true",
          type: "boolean",
        },
        allowMultiple: {
          description: "Allow selecting multiple options. Default: false",
          type: "boolean",
        },
        context: {
          description: "Relevant context to show before the question",
          type: "string",
        },
        options: {
          description: "List of options for the user to choose from",
          items: {
            properties: {
              description: {
                description: "Longer description explaining this option",
                type: "string",
              },
              title: {
                description: "Short title for this option",
                minLength: 1,
                type: "string",
              },
            },
            required: ["title"],
            type: "object",
          },
          type: "array",
        },
        question: {
          description: "The question to ask the user",
          minLength: 1,
          type: "string",
        },
        timeout: {
          description: "Auto-cancel after this many milliseconds",
          minimum: 1,
          type: "number",
        },
      },
      required: ["question"],
      type: "object",
    },
    promptGuidelines: [
      "Use ask_user when the user's intent is ambiguous, a decision requires explicit input, or multiple valid options exist.",
      "Ask exactly one focused question per ask_user call.",
    ],
    promptSnippet:
      "Ask the user one focused question with optional multiple-choice answers",
  };

  // Let an existing ask_user package win instead of failing Pi startup on a duplicate tool name.
  pi.on("session_start", () => {
    if (!pi.getAllTools().some((candidate) => candidate.name === tool.name)) {
      pi.registerTool(tool);
    }
  });
}
