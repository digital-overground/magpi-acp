import assert from "node:assert/strict";
import test from "node:test";

import { parseCommandArgs } from "../../src/acp/slash-commands.js";

test("parseCommandArgs: handles quotes", () => {
  assert.deepEqual(parseCommandArgs("a b"), ["a", "b"]);
  assert.deepEqual(parseCommandArgs("'a b' c"), ["a b", "c"]);
  assert.deepEqual(parseCommandArgs('"a b" c'), ["a b", "c"]);
});
