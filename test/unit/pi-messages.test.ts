import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePiAssistantText,
  normalizePiMessageText,
} from "../../src/acp/translate/pi-messages.js";

test("normalizePiMessageText: supports string", () => {
  assert.equal(normalizePiMessageText("hello"), "hello");
});

test("normalizePiMessageText: joins text blocks", () => {
  assert.equal(
    normalizePiMessageText([
      { text: "a", type: "text" },
      { text: "b", type: "text" },
      { type: "not_text", x: 1 },
    ]),
    "ab"
  );
});

test("normalizePiAssistantText: joins only text blocks", () => {
  assert.equal(
    normalizePiAssistantText([
      { text: "hi", type: "text" },
      { text: "...", type: "thinking" },
      { text: "!", type: "text" },
    ]),
    "hi!"
  );
});
