/* oxlint-disable curly, require-await, no-plusplus, no-promise-executor-return, promise/avoid-new, sort-keys, no-await-in-loop, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/strict-void-return, @typescript-eslint/no-unsafe-return, @typescript-eslint/return-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/promise-function-async */
// @ts-nocheck
// Run with: node scripts/check-message-entry-correlation.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const dir = mkdtempSync(path.join(tmpdir(), "magpi-identity-"));
const child = spawn(
  "pi",
  [
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-themes",
    "--no-skills",
    "--no-prompt-templates",
    "--session",
    path.join(dir, "session.jsonl"),
  ],
  { stdio: ["pipe", "pipe", "inherit"] }
);
const pending = new Map();
const events = [];
let nextId = 0;
let failure;
const fail = (error) => {
  failure = error;
  for (const reject of pending.values()) reject(error);
  pending.clear();
};
child.on("error", fail);
child.on("exit", (code) => fail(new Error(`pi exited: ${code}`)));
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (value.type === "response" && pending.has(value.id)) {
    pending.get(value.id)(value);
    pending.delete(value.id);
  } else if (value.type !== "response") events.push(value);
});
const rpc = async (type, args = {}) => {
  if (failure) throw failure;
  const id = String(++nextId);
  const response = new Promise((resolve, reject) =>
    pending.set(id, (value) =>
      value.success
        ? resolve(value.data)
        : reject(new Error(`${type}: ${value.error}`))
    )
  );
  child.stdin.write(`${JSON.stringify({ type, id, ...args })}\n`);
  return response;
};
const role = (entry) =>
  entry.type === "message" &&
  ["user", "assistant"].includes(entry.message?.role)
    ? entry.message.role
    : undefined;
const snapshot = () => rpc("get_entries");
const turn = async (label, message, images, cancel = false) => {
  const before = await snapshot();
  const cursor = before.entries.at(-1)?.id;
  const start = events.length;
  await rpc("prompt", { message, ...(images ? { images } : {}) });
  // prompt ACK precedes completion; poll the event stream without assuming agent_end is final.
  const deadline = Date.now() + 120_000;
  let aborted = false;
  while (!events.slice(start).some((event) => event.type === "agent_settled")) {
    if (
      cancel &&
      !aborted &&
      events
        .slice(start)
        .some(
          (event) =>
            event.type === "message_start" &&
            event.message?.role === "assistant"
        )
    ) {
      aborted = true;
      await rpc("abort");
    }
    if (failure) throw failure;
    if (Date.now() > deadline)
      throw new Error(`${label}: timed out awaiting agent_settled`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const after = await snapshot();
  const appended = cursor
    ? after.entries.slice(
        after.entries.findIndex((entry) => entry.id === cursor) + 1
      )
    : after.entries;
  const ended = events
    .slice(start)
    .filter(
      (event) =>
        event.type === "message_end" &&
        ["user", "assistant"].includes(event.message?.role)
    );
  const persisted = appended.filter(role);
  assert.ok(
    ended.some((event) => event.message.role === "user"),
    `${label}: no user message_end`
  );
  if (cancel) assert.ok(aborted, `${label}: abort was not sent`);
  assert.notEqual(
    cursor && after.entries.findIndex((entry) => entry.id === cursor),
    -1,
    `${label}: cursor disappeared`
  );
  assert.deepEqual(
    persisted.map(role),
    ended.map((event) => event.message.role),
    `${label}: event/entry roles differ`
  );
  assert.equal(
    new Set(persisted.map((entry) => entry.id)).size,
    persisted.length,
    `${label}: duplicate native IDs`
  );
  for (const event of events
    .slice(start)
    .filter((item) =>
      ["message_start", "message_update", "message_end"].includes(item.type)
    )) {
    assert.equal(
      "entryId" in event,
      false,
      `${label}: Pi event unexpectedly has a native entry ID; inspect it instead of relying on order`
    );
  }
  console.log(
    `${label}: ${ended.map((event, i) => `${event.message.role} -> ${persisted[i].id}`).join(", ")}`
  );
  return persisted;
};
try {
  const first = await turn("first duplicate", "Reply with exactly OK.");
  const second = await turn("second duplicate", "Reply with exactly OK.");
  assert.notEqual(first[0]?.id, second[0]?.id);
  const tool = await turn(
    "tool reply",
    "Use a tool to run pwd, then report the result."
  );
  assert.ok(
    tool.filter((entry) => role(entry) === "assistant").length >= 2,
    "tool reply did not produce multiple assistant messages"
  );
  // Fork to an older user entry: get_entries is append order, not active-path order.
  await rpc("fork", { entryId: first[0].id });
  await turn("branch", "Reply with exactly BRANCH.");
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=";
  await turn("image-only", "", [
    { type: "image", data: png, mimeType: "image/png" },
  ]);
  await turn(
    "cancelled",
    "Write a very long essay with at least 100 paragraphs.",
    undefined,
    true
  );
  console.log(
    "PASS: ordered message_end roles match appended native entries after agent_settled"
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}
