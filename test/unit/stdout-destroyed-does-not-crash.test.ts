import assert from "node:assert/strict";
import test from "node:test";

import { replaceProperty } from "../helpers/fakes.js";

const write = async (chunk: Uint8Array): Promise<void> => {
  await Promise.resolve();
  if (process.stdout.destroyed || !process.stdout.writable) {
    return;
  }
  process.stdout.write(chunk);
};

void test("stdout writer: resolves even if stdout is destroyed", async () => {
  const prevDestroyed = process.stdout.destroyed;
  const prevWritable = process.stdout.writable;

  try {
    replaceProperty(process.stdout, "destroyed", true);
    replaceProperty(process.stdout, "writable", false);

    await write(new Uint8Array([1, 2, 3]));
    assert.ok(true);
  } finally {
    replaceProperty(process.stdout, "destroyed", prevDestroyed);
    replaceProperty(process.stdout, "writable", prevWritable);
  }
});
