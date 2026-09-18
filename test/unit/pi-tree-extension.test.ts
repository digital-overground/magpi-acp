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

test("Pi tree extension only bridges a native entry ID to navigateTree without summarizing", async () => {
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
      navigateTree: (entryId: string, options: unknown) => {
        calls.push({ entryId, options });
        return Promise.resolve({ cancelled: false });
      },
      waitForIdle: () => {
        calls.push("idle");
        return Promise.resolve();
      },
    });

  assert.deepEqual(calls, [
    "idle",
    { entryId: "pi-assistant-1", options: { summarize: false } },
  ]);
});

test("Pi tree extension reports native cancellation", async () => {
  let command: TreeCommand | undefined;
  registerMagPiAcpTree({
    registerCommand(_name, registered) {
      command = registered;
    },
  });

  assert.ok(command);
  await assert.rejects(
    command.handler("pi-user-1", {
      navigateTree: () => Promise.resolve({ cancelled: true }),
      waitForIdle: () => Promise.resolve(),
    }),
    /cancelled tree navigation/iu
  );
});
