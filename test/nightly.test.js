import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  matrix,
  combinations,
  inventory,
  releaseRef,
  releaseDescriptor,
  versionOf,
} from "../src/matrix.js";
import {
  getRelease,
  baselineRelease,
  downloadAsset,
  identity,
  fingerprint,
  assertUnchanged,
} from "../src/github.js";
import {
  normalizedPackage,
  contractDigest,
  contractPath,
  matchingPublication,
  recheckRelease,
  captureSource,
  reviewedProfile,
  profileIdentity,
} from "../src/compatibility.js";
import { prepareReport, assertPlan } from "../src/run.js";
import { aggregate, requiredChecks, saveReport } from "../src/report.js";
const tag = "photos-desktop-v1.7.29-beta";
const release = () => ({
  ...releaseDescriptor(tag),
  id: 29,
  tag_name: tag,
  assets: [...new Set(combinations(tag).map((c) => c.asset))].map(
    (name, id) => ({
      name,
      id,
      size: 1,
      digest: `sha256:${"a".repeat(64)}`,
      created_at: "2026-09-08T08:15:00Z",
      updated_at: "2026-09-08T08:20:00Z",
    }),
  ),
});
const run = () => ({
  id: 123,
  run_attempt: 1,
  status: "completed",
  conclusion: "success",
  run_started_at: "2026-09-08T08:00:00Z",
  updated_at: "2026-09-08T08:30:00Z",
});
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ente-nightly-test-"));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  return dir;
}

test("nightly inputs select a repository independently of application version", () => {
  for (const input of [
    tag,
    `https://github.com/ente/nightly/releases/tag/${tag}`,
    `https://github.com/ente/nightly/releases#release-${tag}`,
  ]) {
    assert.equal(releaseRef(input), tag);
    assert.deepEqual(releaseDescriptor(input), {
      repository: "ente/nightly",
      tag,
      version: "1.7.29-beta",
      channel: "nightly",
    });
  }
  assert.equal(versionOf(tag), "1.7.29-beta");
  assert.equal(releaseDescriptor("v1.7.28").repository, "ente/photos-desktop");
  for (const bad of [
    `https://github.com/ente/photos-desktop/releases/tag/${tag}`,
    "https://github.com/ente/nightly/releases/tag/v1.7.29-beta",
    `https://github.com/ente/nightly/releases#release-${tag}/x`,
    { tag, repository: "other/repo" },
  ])
    assert.throws(() => releaseDescriptor(bad));
});
test("nightly explicitly requires 12 packages and 28 scenarios including 8 dedicated-runner cases", () => {
  const r = release(),
    m = matrix(r);
  assert.equal(m.length, 28);
  assert.equal(inventory(r).packages, 12);
  assert.equal(m.filter((s) => s.runner.includes("self-hosted")).length, 8);
  assert.equal(m.filter((s) => s.platform === "darwin").length, 4);
  assert.equal(
    m.some((s) => s.format === "zip"),
    false,
  );
  for (const alter of [
    (r) => r.assets.pop(),
    (r) => r.assets.push(r.assets[0]),
    (r) => r.assets.push({ name: "ente-1.7.29-beta-universal.zip" }),
  ]) {
    const r = release();
    alter(r);
    assert.throws(() => inventory(r));
  }
});
test("API reads and downloads use the candidate repository, stable baseline remains separate", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    if (String(url).includes("/assets/"))
      return new Response("denied", { status: 403 });
    if (String(url).endsWith("per_page=100&page=1"))
      return Response.json([
        { id: 28, tag_name: "v1.7.28" },
        { id: 30, tag_name: "v1.7.30" },
      ]);
    return Response.json(release());
  });
  assert.equal((await getRelease(tag)).repository, "ente/nightly");
  assert.equal((await baselineRelease(tag)).tag, "v1.7.28");
  await assert.rejects(
    downloadAsset(release().assets[0], await temporary(t), release()),
    /HTTP 403/,
  );
  assert.ok(urls[0].includes("repos/ente/nightly/releases/tags/"));
  assert.ok(urls[1].includes("repos/ente/photos-desktop/releases?"));
  assert.ok(urls[2].includes("repos/ente/nightly/releases/assets/"));
});
test("source contract ignores only app versions and documentation, not lock dependencies or new files", () => {
  assert.equal(
    normalizedPackage('{"version":"1","dependencies":{"x":"2"}}'),
    normalizedPackage('{"version":"2","dependencies":{"x":"2"}}'),
  );
  assert.notEqual(
    normalizedPackage('{"version":"1","dependencies":{"x":"2"}}'),
    normalizedPackage('{"version":"1","dependencies":{"x":"3"}}'),
  );
  assert.equal(
    normalizedPackage(
      '{"version":"1","packages":{"":{"version":"1"},"dep":{"version":"4"}}}',
      true,
    ),
    normalizedPackage(
      '{"version":"2","packages":{"":{"version":"2"},"dep":{"version":"4"}}}',
      true,
    ),
  );
  for (const name of [
    "desktop/new.js",
    "rust/Cargo.lock",
    "web/package-lock.json",
    ".github/workflows/photos-desktop-build.yml",
  ])
    assert.ok(contractPath(name));
  const tree = {
    tree: [{ path: "desktop/a.js", mode: "100644", type: "blob", sha: "a" }],
  };
  const a = contractDigest(tree, {});
  tree.tree.push({
    path: "desktop/README.md",
    mode: "100644",
    type: "blob",
    sha: "b",
  });
  assert.equal(contractDigest(tree, {}), a);
  tree.tree.push({
    path: "desktop/new.js",
    mode: "100644",
    type: "blob",
    sha: "b",
  });
  assert.notEqual(contractDigest(tree, {}), a);
  assert.throws(
    () => contractDigest({ ...tree, truncated: true }, {}),
    /truncated/,
  );
});
test("in-progress, failed, mixed and ambiguous publications are blocked", () => {
  assert.equal(matchingPublication(release(), [run()]).id, 123);
  for (const runs of [
    [{ ...run(), status: "in_progress" }],
    [{ ...run(), conclusion: "failure" }],
    [run(), run()],
    [],
  ])
    assert.throws(
      () => matchingPublication(release(), runs),
      (e) => e.status === "blocked",
    );
  const r = release();
  r.assets[0].created_at = "2026-09-07T08:15:00Z";
  assert.throws(() => matchingPublication(r, [run()]), /partial, mixed/);
});
test("publication requires all build jobs and actual checkout evidence, not the event head", async (t) => {
  const commit = "b".repeat(40),
    r = release();
  let omit = false,
    wrong = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    url = String(url);
    if (url.includes("/git/ref/"))
      return Response.json({ object: { type: "commit", sha: commit } });
    if (url.includes("/workflows/"))
      return Response.json({
        workflow_runs: [{ ...run(), head_sha: "c".repeat(40) }],
      });
    if (url.includes("/attempts/"))
      return Response.json({
        jobs: (omit
          ? ["finish-build"]
          : [
              "build (ubuntu-latest)",
              "build (macos-latest)",
              "build (windows-latest)",
              "finish-build",
            ]
        ).map((name) => ({ id: 1, name, conclusion: "success" })),
      });
    return new Response(
      `time [command]/usr/bin/git log -1 --format=%H\ntime ${wrong ? "d".repeat(40) : commit}\ntime RELEASE_TAG: ${tag}\n`,
    );
  });
  assert.equal((await captureSource(r)).commit, commit);
  wrong = true;
  await assert.rejects(captureSource(r), /does not prove/);
  wrong = false;
  omit = true;
  await assert.rejects(captureSource(r), /incomplete/);
});
test("source movement invalidates an otherwise unchanged release", async (t) => {
  const before = { ...release(), source: { tag, commit: "a".repeat(40) } };
  const after = structuredClone(before);
  after.source.commit = "b".repeat(40);
  assert.throws(() => assertUnchanged(before, after), /changed/);
  t.mock.method(globalThis, "fetch", async (url) =>
    Response.json(
      String(url).includes("/git/ref/")
        ? { object: { type: "commit", sha: "b".repeat(40) } }
        : release(),
    ),
  );
  await assert.rejects(recheckRelease(before), /Source tag changed/);
});
test("unsupported preparation writes one explanatory report before fetching baselines or running jobs", async (t) => {
  const dir = await temporary(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({
      ...release(),
      tag_name: "v1.7.27",
      assets: [...new Set(combinations("v1.7.27").map((s) => s.asset))].map(
        (name) => ({ name }),
      ),
    });
  });
  await assert.rejects(
    prepareReport("v1.7.27", undefined, dir),
    (e) => e.status === "unsupported",
  );
  assert.equal(calls, 1);
  const report = JSON.parse(
    await fs.readFile(path.join(dir, "report.json"), "utf8"),
  );
  assert.equal(report.kind, "preparation");
  assert.equal(report.status, "unsupported");
  assert.equal(report.checks.length, 1);
  await assert.rejects(fs.stat(path.join(dir, "plan.json")), /ENOENT/);
  assert.throws(() => assertPlan({ schemaVersion: 1 }), /regenerate/);
});
test("nightly aggregation cannot grant a pass with absent or unsupported scenarios", async () => {
  const profile = JSON.parse(
    await fs.readFile(
      new URL("../profiles/1.7.29-beta.json", import.meta.url),
      "utf8",
    ),
  );
  const r = release(),
    p = {
      schemaVersion: 2,
      release: r,
      baseline: null,
      profile,
      compatibilityProfile: profileIdentity(profile),
      expectedScenarios: 28,
      releaseFingerprint: fingerprint(r),
      validatorRevision: "test",
      scenarios: matrix(r),
    };
  const reports = p.scenarios.map((s) => ({
    schemaVersion: 2,
    kind: "scenario",
    scenario: s,
    release: identity(r),
    baseline: null,
    compatibilityProfile: p.compatibilityProfile,
    expectedScenarios: 28,
    releaseFingerprint: p.releaseFingerprint,
    validatorRevision: "test",
    status: "passed",
    checks: requiredChecks(s).map((id) => ({ id, status: "passed" })),
  }));
  assert.equal(aggregate(p, reports).fullCoverage, true);
  assert.equal(aggregate(p, reports.slice(8)).status, "blocked");
  reports[0].checks[0].status = "unsupported";
  reports[0].status = "unsupported";
  assert.equal(aggregate(p, reports).fullCoverage, false);
});
test("downstream checks identify the originating prerequisite", async (t) => {
  const report = {
    schemaVersion: 2,
    kind: "scenario",
    release: identity(release()),
    scenario: matrix(tag)[0],
    checks: [
      { id: "installed-files", status: "failed", error: "Missing ente.exe" },
    ],
  };
  await saveReport(report, await temporary(t));
  assert.match(
    report.checks.find((c) => c.id === "ml-online").error,
    /Blocked by installed-files: Missing ente.exe/,
  );
});
