import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import registerMagPiAcpTree from "../../src/pi-extension/tree.js";
import { PiRpcProcess } from "../../src/pi-rpc/process.js";
import { MAGPI_ACP_NAVIGATE_TREE_COMMAND } from "../../src/pi-rpc/tree-command.js";
import type { TreeNavigationOptions } from "../../src/pi-rpc/tree-command.js";

interface TreeContext {
  navigateTree: (
    entryId: string,
    options: TreeNavigationOptions
  ) => Promise<{ cancelled: boolean }>;
  waitForIdle: () => Promise<void>;
}

interface TreeCommand {
  handler: (args: string, context: TreeContext) => Promise<void>;
}

const ignoreEvent = (_event: Record<string, unknown>): void => undefined;

const piProcessFrom = (instance: unknown): PiRpcProcess => {
  if (!(instance instanceof PiRpcProcess)) {
    throw new TypeError("Could not construct Pi RPC process");
  }
  return instance;
};

void test("Pi tree extension passes every summary choice to navigateTree", async () => {
  const commands = new Map<string, TreeCommand>();
  registerMagPiAcpTree({
    registerCommand(name, command) {
      commands.set(name, command);
    },
  });
  assert.deepEqual([...commands.keys()], [MAGPI_ACP_NAVIGATE_TREE_COMMAND]);

  const command = commands.get(MAGPI_ACP_NAVIGATE_TREE_COMMAND);
  assert.ok(command);
  const calls: unknown[] = [];
  const context: TreeContext = {
    navigateTree: async (entryId, options) => {
      await Promise.resolve();
      calls.push({ entryId, options });
      return { cancelled: false };
    },
    waitForIdle: async () => {
      await Promise.resolve();
      calls.push("idle");
    },
  };
  const customInstructions = 'Keep "quoted" details.\nFocus on paths.';

  await command.handler(
    JSON.stringify({ entryId: "pi-assistant-1", summarize: false }),
    context
  );
  await command.handler(
    JSON.stringify({ entryId: "pi-assistant-1", summarize: true }),
    context
  );
  await command.handler(
    JSON.stringify({
      customInstructions,
      entryId: "pi-assistant-1",
      summarize: true,
    }),
    context
  );

  assert.deepEqual(calls, [
    "idle",
    {
      entryId: "pi-assistant-1",
      options: { customInstructions: undefined, summarize: false },
    },
    "idle",
    {
      entryId: "pi-assistant-1",
      options: { customInstructions: undefined, summarize: true },
    },
    "idle",
    {
      entryId: "pi-assistant-1",
      options: { customInstructions, summarize: true },
    },
  ]);
});

void test("Pi tree extension reports native cancellation", async () => {
  let command: TreeCommand | undefined;
  registerMagPiAcpTree({
    registerCommand(_name, registered) {
      command = registered;
    },
  });

  assert.ok(command);
  await assert.rejects(
    command.handler(
      JSON.stringify({ entryId: "pi-user-1", summarize: false }),
      {
        navigateTree: async () => {
          await Promise.resolve();
          return { cancelled: true };
        },
        waitForIdle: async () => {
          await Promise.resolve();
        },
      }
    ),
    /cancelled tree navigation/iu
  );
});

void test("Pi tree extension surfaces a summary failure without retrying", async () => {
  let command: TreeCommand | undefined;
  registerMagPiAcpTree({
    registerCommand(_name, registered) {
      command = registered;
    },
  });

  assert.ok(command);
  let attempts = 0;
  await assert.rejects(
    command.handler(JSON.stringify({ entryId: "pi-user-1", summarize: true }), {
      navigateTree: async () => {
        attempts += 1;
        await Promise.resolve();
        throw new Error("summary failed");
      },
      waitForIdle: async () => {
        await Promise.resolve();
      },
    }),
    /summary failed/u
  );
  assert.equal(attempts, 1);
});

void test("Pi RPC tree navigation completes without an agent_settled event", async () => {
  let prompt = "";
  const instance: unknown = Object.create(PiRpcProcess.prototype);
  const proc = piProcessFrom(instance);
  proc.onEvent = () => () => {};
  proc.prompt = async (message: string) => {
    prompt = message;
    await Promise.resolve();
  };

  const customInstructions = "Preserve whitespace:\n  exact";
  await Promise.race([
    proc.navigateTree("pi-assistant-1", {
      customInstructions,
      summarize: true,
    }),
    delay(50).then(() => {
      throw new Error("Tree navigation stayed pending.");
    }),
  ]);

  assert.equal(
    prompt,
    `/${MAGPI_ACP_NAVIGATE_TREE_COMMAND} ${JSON.stringify({
      customInstructions,
      entryId: "pi-assistant-1",
      summarize: true,
    })}`
  );
});

void test("Pi RPC tree navigation surfaces extension errors without an agent_settled event", async () => {
  let emit: (event: Record<string, unknown>) => void = ignoreEvent;
  const instance: unknown = Object.create(PiRpcProcess.prototype);
  const proc = piProcessFrom(instance);
  proc.onEvent = (handler) => {
    emit = handler;
    return () => {};
  };
  proc.prompt = async () => {
    emit({ error: "summary failed", type: "extension_error" });
    await Promise.resolve();
  };

  await assert.rejects(
    proc.navigateTree("pi-assistant-1", { summarize: true }),
    /summary failed/u
  );
});

void test("Pi RPC rejects a closed stdin write without crashing MagPi", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "require('node:fs').closeSync(0); console.log('ready'); setTimeout(() => {}, 10_000)",
    ],
    { stdio: "pipe" }
  );
  const instance: unknown = Reflect.construct(PiRpcProcess, [child]);
  const proc = piProcessFrom(instance);

  try {
    await once(child.stdout, "data");
    await assert.rejects(proc.getState(), /EPIPE|closed|destroyed/iu);
  } finally {
    proc.dispose();
  }
});
