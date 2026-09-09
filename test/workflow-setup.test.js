import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

const unix = { skip: process.platform === "win32" };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ente-workflow-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("Arch bootstrap retries transient failures, retains mirror fallback, and fails after three attempts", unix, async (t) => {
  const directory = await fixture(t);
  const mirrorlist = path.join(directory, "mirrorlist");
  const bootstrap = (await fs.readFile(new URL("../containers/bootstrap.sh", import.meta.url), "utf8"))
    .split("# Minimal Fedora")[0]
    .replace("source /etc/os-release", "ID=archarm")
    .replaceAll("/etc/pacman.d/mirrorlist", '"$TEST_MIRRORLIST"');
  const mocks = `
    pacman-key() { :; }
    sleep() { :; }
    pacman() {
      echo "$1" >> "$TEST_CALLS"
      if [[ "$1" == -Syu ]]; then
        attempts=$((attempts + 1))
        [[ "$attempts" -gt "$TEST_FAILURES" ]]
      fi
    }
    attempts=0
  `;
  for (const failures of [2, 3]) {
    const calls = path.join(directory, `calls-${failures}`);
    await fs.writeFile(mirrorlist, "Server = https://mirror.archlinuxarm.org/$arch/$repo\n");
    const run = () => execFileSync("bash", ["-c", mocks + bootstrap], {
      env: { ...process.env, TEST_MIRRORLIST: mirrorlist, TEST_CALLS: calls, TEST_FAILURES: String(failures) },
    });
    if (failures === 2) run();
    else assert.throws(run, (error) => error.status === 1);
    assert.deepEqual((await fs.readFile(calls, "utf8")).trim().split("\n"),
      failures === 2 ? ["-Syu", "-Syu", "-Syu", "-S"] : ["-Syu", "-Syu", "-Syu"]);
    assert.match(await fs.readFile(mirrorlist, "utf8"), /mirror\.archlinuxarm\.org\/\$arch\/\$repo[\s\S]*de3\.mirror\.archlinuxarm\.org\/\$arch\/\$repo/);
  }
});

test("hosted Ubuntu restores its original namespace policy even when the sandbox probe fails", unix, async (t) => {
  const directory = await fixture(t);
  const workflow = parse(await fs.readFile(new URL("../.github/workflows/validate.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs.validate.steps;
  const enable = steps.find((step) => step.name?.startsWith("Enable Chromium"));
  const restore = steps.find((step) => step.name?.startsWith("Restore Ubuntu"));
  assert.equal(enable.if, "runner.os == 'Linux' && runner.environment == 'github-hosted' && matrix.container == ''");
  assert.equal(restore.if, `always() && ${enable.if}`);
  const mocks = `
    sysctl() {
      if [[ "$1" == -n ]]; then cat "$TEST_POLICY";
      else printf '%s\\n' "\${2##*=}" > "$TEST_POLICY"; fi
    }
    sudo() { "$@"; }
    unshare() { return "$TEST_PROBE_EXIT"; }
  `;
  const policy = path.join(directory, "policy");
  for (const original of ["0", "1"]) {
    for (const probeExit of ["0", "1"]) {
      await fs.writeFile(policy, original);
      const run = (script) => execFileSync("bash", ["-ec", mocks + script], {
        cwd: directory,
        env: { ...process.env, SCENARIO: "test", TEST_POLICY: policy, TEST_PROBE_EXIT: probeExit },
      });
      if (probeExit === "0") run(enable.run);
      else assert.throws(() => run(enable.run), (error) => error.status === 1);
      assert.equal((await fs.readFile(policy, "utf8")).trim(), "0");
      run(restore.run);
      assert.equal((await fs.readFile(policy, "utf8")).trim(), original);
    }
  }
});
