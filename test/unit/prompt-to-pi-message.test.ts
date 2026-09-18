import assert from "node:assert/strict";
import test from "node:test";

import { promptToPiMessage } from "../../src/acp/translate/prompt.js";

void test("promptToPiMessage: concatenates text and resource links", () => {
  const { message, images } = promptToPiMessage([
    { text: "Hello", type: "text" },
    { name: "foo", type: "resource_link", uri: "file:///tmp/foo.txt" },
    { text: " world", type: "text" },
  ]);

  assert.equal(message, "Hello\n[Context] file:///tmp/foo.txt world");
  assert.deepEqual(images, []);
});

void test("promptToPiMessage: includes embedded resource text as marker", () => {
  const { message, images } = promptToPiMessage([
    {
      resource: {
        mimeType: "text/plain",
        text: "hi",
        uri: "file:///tmp/a.txt",
      },
      type: "resource",
    },
  ]);

  assert.equal(
    message,
    "\n[Embedded Context] file:///tmp/a.txt (text/plain)\nhi"
  );
  assert.deepEqual(images, []);
});

void test("promptToPiMessage: includes embedded resource blob as marker", () => {
  const blob = Buffer.from("xyz", "utf-8").toString("base64");

  const { message, images } = promptToPiMessage([
    {
      resource: {
        blob,
        mimeType: "application/octet-stream",
        uri: "file:///tmp/a.bin",
      },
      type: "resource",
    },
  ]);

  assert.equal(
    message,
    "\n[Embedded Context] file:///tmp/a.bin (application/octet-stream, 3 bytes)"
  );
  assert.deepEqual(images, []);
});

void test("promptToPiMessage: includes audio as marker", () => {
  const data = Buffer.from("abc", "utf-8").toString("base64");

  const { message, images } = promptToPiMessage([
    { data, mimeType: "audio/wav", type: "audio" },
  ]);

  assert.equal(
    message,
    "\n[Audio] (audio/wav, 3 bytes) not supported by magpi-acp"
  );
  assert.deepEqual(images, []);
});

void test("promptToPiMessage: maps image to pi image content", () => {
  const base64 = Buffer.from("abc", "utf-8").toString("base64");

  const { message, images } = promptToPiMessage([
    { text: "see", type: "text" },
    { data: base64, mimeType: "image/png", type: "image", uri: "img-1" },
  ]);

  assert.equal(message, "see");
  assert.equal(images.length, 1);
  assert.deepEqual(images[0], {
    data: base64,
    mimeType: "image/png",
    type: "image",
  });
});
