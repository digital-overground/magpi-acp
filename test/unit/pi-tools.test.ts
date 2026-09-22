import assert from "node:assert/strict";
import test from "node:test";

import { toolResultToText } from "../../src/acp/translate/pi-tools.js";

void test("toolResultToText: extracts text from content blocks", () => {
  const text = toolResultToText({
    content: [
      { text: "hello", type: "text" },
      { text: " world", type: "text" },
    ],
  });
  assert.equal(text, "hello world");
});

void test("toolResultToText: prefers details.diff when present", () => {
  const text = toolResultToText({
    content: [
      { text: "Successfully replaced 2 block(s) in a.txt.", type: "text" },
    ],
    details: { diff: "--- a\n+++ b\n" },
  });
  assert.equal(text, "--- a\n+++ b\n");
});

void test("toolResultToText: falls back to JSON", () => {
  const text = toolResultToText({ a: 1 });
  assert.match(text, /"a": 1/u);
});

void test("toolResultToText: extracts bash stdout/stderr from details", () => {
  const text = toolResultToText({
    details: {
      exitCode: 0,
      stderr: "warn\n",
      stdout: "ok\n",
    },
  });
  assert.match(text, /ok/u);
  assert.match(text, /stderr:/u);
  assert.match(text, /warn/u);
  assert.match(text, /exit code: 0/u);
});
