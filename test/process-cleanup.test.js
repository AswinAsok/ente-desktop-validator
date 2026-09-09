import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { command } from "../src/common.js";
import { stopApp } from "../src/install.js";

test("cleanup waits for a launch group, kills stubborn descendants, and leaves other groups alone", {
  skip: process.platform === "win32",
  timeout: 15_000,
}, async (t) => {
  const start = async (script) => {
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    t.after(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    });
    const [output] = await once(child.stdout, "data");
    return { child, pid: Number(output.toString().trim()) };
  };
  const stubborn = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);";
  const { child, pid: descendant } = await start(`
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(stubborn)}], {stdio: ['ignore', 'inherit', 'inherit']});
    setInterval(() => {}, 1000);
  `);
  const { pid: unrelated } = await start(stubborn);
  // Inspection and launch mount paths differ for real AppImages.
  const app = { executable: "/tmp/inspection-mount/ente", launchExecutable: "/tmp/test.AppImage" };
  await stopApp(app, child.pid);
  const { stdout } = await command("ps", ["-axo", "pid=,stat="]);
  const alive = stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    return m && !m[2].startsWith("Z") ? [Number(m[1])] : [];
  });
  assert.ok(!alive.includes(child.pid));
  assert.ok(!alive.includes(descendant));
  assert.ok(alive.includes(unrelated));
  await stopApp(app, child.pid); // Already-exited groups are harmless.
});
