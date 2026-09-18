import assert from "node:assert/strict";
import test from "node:test";

import {
  expandSlashCommand,
  parseCommandArgs,
  substituteArgs,
  toAvailableCommands,
} from "../../src/acp/slash-commands.js";

test("parseCommandArgs: handles quotes", () => {
  assert.deepEqual(parseCommandArgs("a b"), ["a", "b"]);
  assert.deepEqual(parseCommandArgs("'a b' c"), ["a b", "c"]);
  assert.deepEqual(parseCommandArgs('"a b" c'), ["a b", "c"]);
});

test("substituteArgs: replaces $1.. and $@", () => {
  assert.equal(
    substituteArgs("x=$1 y=$2 all=$@", ["one", "two"]).trim(),
    "x=one y=two all=one two"
  );
  assert.equal(substituteArgs("$3", ["one"]).trim(), "");
});

test("expandSlashCommand: expands known command", () => {
  const cmds = [
    {
      content: "Say hi to $1",
      description: "(user)",
      name: "hello",
      source: "(user)",
    },
  ];

  assert.equal(
    expandSlashCommand("/hello world", cmds as never),
    "Say hi to world"
  );
  assert.equal(
    expandSlashCommand("/unknown world", cmds as never),
    "/unknown world"
  );
  assert.equal(
    expandSlashCommand("not a command", cmds as never),
    "not a command"
  );
});

test("toAvailableCommands: de-dupes by name (first wins)", () => {
  const cmds = [
    { content: "1", description: "first", name: "x", source: "(user)" },
    { content: "2", description: "second", name: "x", source: "(project)" },
  ];

  assert.deepEqual(toAvailableCommands(cmds as never), [
    { description: "first", name: "x" },
  ]);
});
