import assert from "node:assert/strict";
import test from "node:test";

import registerMagPiAcpTree from "../../src/pi-extension/tree.js";
import { MAGPI_ACP_NAVIGATE_TREE_COMMAND } from "../../src/pi-rpc/tree-command.js";

interface TreeContext {
  navigateTree: (
    entryId: string,
    options: { summarize: false }
  ) => Promise<{ cancelled: boolean }>;
  waitForIdle: () => Promise<void>;
}

interface TreeCommand {
  handler: (args: string, context: TreeContext) => Promise<void>;
}

void test("Pi tree extension only bridges a native entry ID to navigateTree without summarizing", async () => {
  const commands = new Map<string, TreeCommand>();
  registerMagPiAcpTree({
    registerCommand(name, command) {
      commands.set(name, command);
    },
  });
  assert.deepEqual([...commands.keys()], [MAGPI_ACP_NAVIGATE_TREE_COMMAND]);

  const calls: unknown[] = [];
  await commands
    .get(MAGPI_ACP_NAVIGATE_TREE_COMMAND)
    ?.handler("pi-assistant-1", {
      navigateTree: async (entryId: string, options: unknown) => {
        await Promise.resolve();
        calls.push({ entryId, options });
        return { cancelled: false };
      },
      waitForIdle: async () => {
        await Promise.resolve();
        calls.push("idle");
      },
    });

  assert.deepEqual(calls, [
    "idle",
    { entryId: "pi-assistant-1", options: { summarize: false } },
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
    command.handler("pi-user-1", {
      navigateTree: async () => {
        await Promise.resolve();
        return { cancelled: true };
      },
      waitForIdle: async () => {
        await Promise.resolve();
      },
    }),
    /cancelled tree navigation/iu
  );
});
