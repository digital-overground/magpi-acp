import assert from "node:assert/strict";
import test from "node:test";

import registerMagPiAcpAskUser from "../../src/pi-extension/ask-user.js";
import type { AskTool } from "../../src/pi-extension/ask-user.js";

const noInput = async (): Promise<string> => {
  await Promise.resolve();
  return "";
};

const loadAskUserTool = (): AskTool => {
  let sessionStart: (() => void) | undefined;
  let tool: AskTool | undefined;
  registerMagPiAcpAskUser({
    getAllTools: () => [],
    on: (_event, handler) => {
      sessionStart = handler;
    },
    registerTool: (registered) => {
      tool = registered;
    },
  });
  assert.ok(sessionStart);
  sessionStart();
  assert.ok(tool);
  return tool;
};

void test("Pi ask_user extension returns the selected answer", async () => {
  const tool = loadAskUserTool();

  assert.equal(tool.name, "ask_user");
  assert.equal(tool.executionMode, "sequential");

  const prompts: unknown[] = [];
  const result = await tool.execute(
    "ask-1",
    {
      context: "Choose the safer default.",
      options: [
        { description: "First option", title: "Alpha" },
        { description: "Second option", title: "Beta" },
      ],
      question: "Which option?",
    },
    undefined,
    undefined,
    {
      hasUI: true,
      ui: {
        input: noInput,
        select: async (title: string, options: string[]) => {
          await Promise.resolve();
          prompts.push({ options, title });
          return "Beta";
        },
      },
    }
  );

  assert.deepEqual(prompts, [
    {
      options: ["Alpha", "Beta", "✏️ Type custom response..."],
      title: "Which option?\n\nContext:\nChoose the safer default.",
    },
  ]);
  assert.deepEqual(result, {
    content: [{ text: "User answered: Beta", type: "text" }],
    details: {
      cancelled: false,
      context: "Choose the safer default.",
      options: [
        { description: "First option", title: "Alpha" },
        { description: "Second option", title: "Beta" },
      ],
      question: "Which option?",
      response: { kind: "selection", selections: ["Beta"] },
    },
  });
});

void test("Pi ask_user extension does not conflict with an installed ask_user tool", () => {
  const registered: unknown[] = [];
  let sessionStart: (() => void) | undefined;

  registerMagPiAcpAskUser({
    getAllTools: () => [{ name: "ask_user" }],
    on: (_event, handler) => {
      sessionStart = handler;
    },
    registerTool: (tool) => {
      registered.push(tool);
    },
  });

  assert.deepEqual(registered, []);
  assert.ok(sessionStart);
  sessionStart();
  assert.deepEqual(registered, []);
});

void test("Pi ask_user extension treats an empty response as cancellation", async () => {
  const tool = loadAskUserTool();

  const result = await tool.execute(
    "ask-2",
    { options: [{ title: "Yes" }], question: "Continue?" },
    undefined,
    undefined,
    {
      hasUI: true,
      ui: {
        input: noInput,
        select: async () => {
          await Promise.resolve();
          return "   ";
        },
      },
    }
  );

  assert.deepEqual(result, {
    content: [{ text: "User cancelled the question", type: "text" }],
    details: {
      cancelled: true,
      options: [{ title: "Yes" }],
      question: "Continue?",
      response: null,
    },
  });
});
