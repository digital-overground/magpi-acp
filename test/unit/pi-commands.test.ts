import assert from "node:assert/strict";
import test from "node:test";

import {
  MAGPI_ACP_COMMAND_SOURCE_META,
  toAvailableCommandsFromPiGetCommands,
} from "../../src/acp/pi-commands.js";

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
        sourceInfo: { source: "git:github.com/example/foo" },
      },
      { location: "project", name: "y", source: "prompt" },
    ],
  };

  assert.deepEqual(toAvailableCommandsFromPiGetCommands(data), [
    { description: "X", name: "x" },
    {
      _meta: {
        [MAGPI_ACP_COMMAND_SOURCE_META]: "git:github.com/example/foo",
      },
      description: "Foo",
      name: "skill:foo",
    },
    { description: "(prompt:project)", name: "y" },
  ]);
});
