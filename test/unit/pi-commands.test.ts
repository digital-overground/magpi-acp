import assert from "node:assert/strict";
import test from "node:test";

import { toAvailableCommandsFromPiGetCommands } from "../../src/acp/pi-commands.js";

test("toAvailableCommandsFromPiGetCommands: hides extension commands by default and filters skill commands", () => {
  const data = {
    commands: [
      { description: "X", name: "x", source: "extension" },
      {
        description: "Foo",
        location: "user",
        name: "skill:foo",
        source: "skill",
      },
      { location: "project", name: "y", source: "prompt" },
    ],
  };

  const all = toAvailableCommandsFromPiGetCommands(data, {
    enableSkillCommands: true,
  }).commands;
  assert.deepEqual(all, [
    { description: "Foo", name: "skill:foo" },
    { description: "(prompt:project)", name: "y" },
  ]);

  const includeExt = toAvailableCommandsFromPiGetCommands(data, {
    enableSkillCommands: true,
    includeExtensionCommands: true,
  }).commands;
  assert.deepEqual(includeExt, [
    { description: "X", name: "x" },
    { description: "Foo", name: "skill:foo" },
    { description: "(prompt:project)", name: "y" },
  ]);

  const noSkills = toAvailableCommandsFromPiGetCommands(data, {
    enableSkillCommands: false,
  }).commands;
  assert.deepEqual(noSkills, [{ description: "(prompt:project)", name: "y" }]);
});
