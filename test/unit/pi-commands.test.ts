import assert from "node:assert/strict";
import test from "node:test";

import { toAvailableCommandsFromPiGetCommands } from "../../src/acp/pi-commands.js";

void test("toAvailableCommandsFromPiGetCommands: exposes Pi extension, skill, and prompt commands", () => {
  const data = {
    commands: [
      { description: "X", name: "x", source: "extension" },
      {
        description: "internal",
        name: "__magpi_acp_internal_navigate_tree",
        source: "extension",
      },
      {
        description: "Foo",
        location: "user",
        name: "skill:foo",
        source: "skill",
      },
      { location: "project", name: "y", source: "prompt" },
    ],
  };

  assert.deepEqual(toAvailableCommandsFromPiGetCommands(data), [
    { description: "X", name: "x" },
    { description: "Foo", name: "skill:foo" },
    { description: "(prompt:project)", name: "y" },
  ]);
});
