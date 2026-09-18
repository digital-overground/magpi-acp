import assert from "node:assert/strict";
import test from "node:test";

import { getAuthMethods, PI_SETUP_METHOD_ID } from "../../src/acp/auth.js";
import { asRecord } from "../helpers/fakes.js";

void test("getAuthMethods: includes integrated terminal-auth metadata when enabled", () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: true });
  assert.equal(methods.length, 1);
  const [method] = methods;
  assert.notEqual(method, undefined);
  const metadata = asRecord(method._meta);
  const terminalAuth = asRecord(metadata["terminal-auth"]);

  assert.equal(method.id, PI_SETUP_METHOD_ID);
  assert.ok(typeof terminalAuth.command === "string");
  assert.deepEqual(terminalAuth.args, ["--terminal-login"]);
  assert.equal(terminalAuth.label, "Launch pi");
});

void test("getAuthMethods: omits integrated terminal-auth metadata when disabled", () => {
  const [method] = getAuthMethods({ supportsTerminalAuthMeta: false });
  assert.notEqual(method, undefined);
  assert.ok(
    method._meta === undefined ||
      asRecord(method._meta)["terminal-auth"] === undefined
  );
});
