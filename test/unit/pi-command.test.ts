import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  defaultPiCommand,
  resolvePiLaunch,
  shouldUseShellForPiCommand,
} from "../../src/pi-rpc/command.js";

void test("resolvePiLaunch uses packaged Pi unless overridden", () => {
  const packaged = resolvePiLaunch();
  assert.equal(packaged.command, process.execPath);
  assert.equal(packaged.shell, false);
  assert.ok(packaged.args[0]?.endsWith(path.join("dist", "bundle", "cli.js")));
  assert.deepEqual(resolvePiLaunch("custom-pi"), {
    args: [],
    command: "custom-pi",
    shell: false,
  });
});

void test("defaultPiCommand: uses pi.cmd on Windows and pi elsewhere", () => {
  const originalPlatform = process.platform;

  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    assert.equal(defaultPiCommand(), "pi.cmd");

    Object.defineProperty(process, "platform", { value: "darwin" });
    assert.equal(defaultPiCommand(), "pi");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

void test("shouldUseShellForPiCommand: enables shell for Windows cmd launchers only", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });

  try {
    assert.equal(shouldUseShellForPiCommand("pi.cmd"), true);
    assert.equal(
      shouldUseShellForPiCommand(
        "C:\\Users\\me\\AppData\\Roaming\\npm\\pi.CMD"
      ),
      true
    );
    assert.equal(shouldUseShellForPiCommand("pi.bat"), true);
    assert.deepEqual(resolvePiLaunch("C:\\Program Files\\Pi Agent\\pi.cmd"), {
      args: [],
      command: "C:\\Program Files\\Pi Agent\\pi.cmd",
      shell: true,
    });
    assert.equal(resolvePiLaunch().shell, false);
    assert.equal(shouldUseShellForPiCommand("pi"), false);
    assert.equal(shouldUseShellForPiCommand("C:\\tools\\pi.exe"), false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

void test("shouldUseShellForPiCommand: keeps shell disabled on non-Windows", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });

  try {
    assert.equal(shouldUseShellForPiCommand("pi.cmd"), false);
    assert.equal(shouldUseShellForPiCommand("pi"), false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});
