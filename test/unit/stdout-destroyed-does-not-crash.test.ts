import assert from "node:assert/strict";
import test from "node:test";

const write = (chunk: Uint8Array): Promise<void> => {
  if (process.stdout.destroyed || !process.stdout.writable) {
    return Promise.resolve();
  }
  process.stdout.write(chunk);
  return Promise.resolve();
};

test("stdout writer: resolves even if stdout is destroyed", async () => {
  const stdout = process.stdout as unknown as {
    destroyed: boolean;
    writable: boolean;
  };
  const prevDestroyed = stdout.destroyed;
  const prevWritable = stdout.writable;

  try {
    stdout.destroyed = true;
    stdout.writable = false;

    await write(new Uint8Array([1, 2, 3]));
    assert.ok(true);
  } finally {
    stdout.destroyed = prevDestroyed;
    stdout.writable = prevWritable;
  }
});
