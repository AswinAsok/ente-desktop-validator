import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parse } from "yaml";
import { matrix } from "../src/matrix.js";
import { requiredChecks } from "../src/report.js";

test("all Fedora/Arch scenarios use matching native hosted architecture and require isolation proof", async () => {
  for (const tag of ["v1.7.28", "photos-desktop-v1.7.29-beta"]) {
    const scenarios = matrix(tag).filter((s) => s.container);
    assert.equal(scenarios.length, 8);
    for (const s of scenarios) {
      assert.deepEqual(s.runner, [
        s.arch === "arm64" ? "ubuntu-24.04-arm" : "ubuntu-24.04",
      ]);
      assert.equal(s.container, s.distro);
      assert.ok(requiredChecks(s).includes("container-isolation"));
    }
  }
  const workflow = parse(
    await fs.readFile(
      new URL("../.github/workflows/validate.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(!JSON.stringify(workflow).includes("RUNNER_DISCOVERY_TOKEN"));
  const steps = workflow.jobs.validate.steps;
  assert.ok(steps.some((s) => s.run === "bash scripts/run-container.sh"));
  assert.ok(
    steps.some(
      (s) => s.if?.includes("always()") && s.run?.includes("docker rm -f"),
    ),
  );
  const script = await fs.readFile(
    new URL("../scripts/run-container.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /--network bridge --dns 1\.1\.1\.1/);
  assert.doesNotMatch(
    script,
    /--network[= ]host|--pid[= ]host|--privileged|docker\.sock|--no-sandbox/,
  );
  assert.match(script, /--cap-add NET_ADMIN/);
  assert.match(script, /--reuid validator --regid validator --init-groups dbus-run-session -- xvfb-run/);
});
