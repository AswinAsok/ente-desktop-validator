// Synthetic failure cases must not append to the real workflow job summary.
delete process.env.GITHUB_STEP_SUMMARY;

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createPackage } from "@electron/asar";
import { combinations, matrix, inventory, releaseRef } from "../src/matrix.js";
import {
  identity,
  fingerprint,
  assertUnchanged,
  download,
  baselineRelease,
  api,
} from "../src/github.js";
import { overall, aggregate, requiredChecks, check } from "../src/report.js";
import {
  loadProfile,
  inspectInstalled,
  verifyModels,
  binaryArchitectures,
} from "../src/inspect.js";
import { validateInference, assertEmbedding, runML } from "../src/runtime.js";
import { inside, deadline } from "../src/common.js";
import { parse } from "yaml";
import { linuxRules, macRules } from "../src/network.js";
import { runCLI } from "../src/cli.js";
import { stopApp } from "../src/install.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const release = (tag = "v1.7.28") => ({
  id: tag === "v1.7.28" ? 28 : 27,
  tag_name: tag,
  assets: [...new Set(combinations(tag).map((c) => c.asset))].map(
    (name, i) => ({
      id: i,
      name,
      size: 10,
      digest: `sha256:${"a".repeat(64)}`,
      updated_at: "2026-01-01",
    }),
  ),
});
import { profileIdentity } from "../src/compatibility.js";
const profile = JSON.parse(
  await fs.readFile(
    new URL("../profiles/1.7.28.json", import.meta.url),
    "utf8",
  ),
);
const plan = () => {
  const r = release();
  return {
    schemaVersion: 2,
    profile,
    compatibilityProfile: profileIdentity(profile),
    expectedScenarios: 32,
    release: r,
    baseline: release("v1.7.27"),
    releaseFingerprint: fingerprint(r),
    validatorRevision: "abc",
    scenarios: matrix(r.tag_name),
  };
};
const passing = (plan, s) => ({
  schemaVersion: 2,
  kind: "scenario",
  compatibilityProfile: plan.compatibilityProfile,
  expectedScenarios: plan.expectedScenarios,
  scenario: s,
  release: identity(plan.release),
  releaseFingerprint: plan.releaseFingerprint,
  baseline: identity(plan.baseline),
  validatorRevision: "abc",
  status: "passed",
  checks: requiredChecks(s).map((id) => ({ id, status: "passed" })),
});
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ente-validator-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("exactly 13 assets, 16 combinations and 32 fresh/upgrade scenarios", () => {
  const m = matrix("v1.7.28");
  assert.equal(m.length, 32);
  assert.equal(new Set(m.map((s) => s.id)).size, 32);
  assert.equal(new Set(m.map((s) => s.asset)).size, 13);
  assert.equal(m.filter((s) => s.format === "nsis-combined").length, 4);
  assert.equal(m.filter((s) => s.platform === "darwin").length, 8);
  assert.equal(inventory(release()).packages, 13);
});
test("strict release input and filesystem containment", () => {
  assert.equal(
    releaseRef("https://github.com/ente/photos-desktop/releases/tag/v1.7.28"),
    "v1.7.28",
  );
  for (const bad of [
    "../../x",
    "v1.7.28;echo x",
    "https://github.com/other/repo/releases/tag/v1.7.28",
  ])
    assert.throws(() => releaseRef(bad));
  assert.throws(() => inside("/tmp/a", "../b"));
  assert.throws(() => inside("/tmp/a", "/tmp/x"));
});
test("missing, unexpected, duplicate packages cannot be ignored", () => {
  for (const alter of [
    (r) => r.assets.pop(),
    (r) => r.assets.push({ name: "ente-new.msi" }),
    (r) => r.assets.push(r.assets[0]),
  ]) {
    const r = release();
    alter(r);
    assert.throws(() => inventory(r));
  }
});
test("asset reordering is harmless; replacement or deletion invalidates results", () => {
  const r = release(),
    reordered = structuredClone(r);
  reordered.assets.reverse();
  assertUnchanged(r, reordered);
  const edited = structuredClone(r);
  edited.assets[0].id++;
  assert.throws(() => assertUnchanged(r, edited));
  edited.assets = edited.assets.slice(1);
  assert.throws(() => assertUnchanged(r, edited));
});
test("final identity replacement revokes both pass status and full coverage", async (t) => {
  const dir = await temporary(t),
    p = plan();
  await fs.writeFile(path.join(dir, "plan.json"), JSON.stringify(p));
  for (const scenario of p.scenarios) {
    const destination = path.join(dir, "reports", scenario.id);
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(
      path.join(destination, "report.json"),
      JSON.stringify(passing(p, scenario)),
    );
  }
  const replaced = release();
  replaced.assets[0].id++;
  t.mock.method(globalThis, "fetch", async () => Response.json(replaced));
  const out = path.join(dir, "final");
  assert.equal(
    await runCLI([
      "aggregate",
      "--plan",
      path.join(dir, "plan.json"),
      "--reports",
      path.join(dir, "reports"),
      "--out",
      out,
    ]),
    1,
  );
  const report = JSON.parse(
    await fs.readFile(path.join(out, "report.json"), "utf8"),
  );
  assert.equal(report.status, "failed");
  assert.equal(report.fullCoverage, false);
  assert.match(report.releaseIdentityError, /changed/);
});
test("all 32 complete reports pass; missing runners and incomplete reports do not", () => {
  const p = plan(),
    reports = p.scenarios.map((s) => passing(p, s));
  assert.equal(aggregate(p, reports).status, "passed");
  assert.equal(aggregate(p, reports.slice(1)).status, "blocked");
  const bad = structuredClone(reports);
  bad[0].checks.pop();
  assert.equal(aggregate(p, bad).status, "failed");
  assert.equal(aggregate(p, [...reports, reports[0]]).status, "blocked");
  assert.equal(aggregate(p, [...reports, null]).status, "failed");
  assert.equal(
    aggregate({ ...p, scenarios: p.scenarios.slice(1) }, reports.slice(1))
      .status,
    "blocked",
  );
});
test("unsupported, forged pass and stale provenance cannot pass aggregation", () => {
  const p = plan();
  for (const alter of [
    (r) => {
      r.checks[0].status = "unsupported";
      r.status = "unsupported";
    },
    (r) => {
      r.checks[0].status = "failed";
    },
    (r) => {
      r.validatorRevision = "stale";
    },
    (r) => {
      r.baseline.id++;
    },
    (r) => {
      r.scenario.arch = "other";
    },
  ]) {
    const reports = p.scenarios.map((s) => passing(p, structuredClone(s)));
    alter(reports[0]);
    assert.notEqual(aggregate(p, reports).status, "passed");
  }
  assert.equal(overall([]), "blocked");
  assert.equal(overall([{ status: "invented" }]), "failed");
});
test("preceding stable uses numeric versions and excludes drafts/prereleases", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json([
      { tag_name: "v1.7.9" },
      { tag_name: "v1.7.27" },
      { tag_name: "v1.7.28" },
      { tag_name: "v1.7.26", draft: true },
      { tag_name: "v1.7.29", prerelease: true },
    ]),
  );
  assert.equal((await baselineRelease("v1.7.28")).tag_name, "v1.7.27");
});
test("GitHub reads retry transport loss but never bypass HTTP permission failures", async (t) => {
  let calls = 0;
  const mock = t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) throw new TypeError("stale pooled connection");
    return Response.json({ ok: true });
  });
  assert.deepEqual(await api("test"), { ok: true });
  assert.equal(calls, 2);
  calls = 0;
  mock.mock.mockImplementation(async () => {
    calls++;
    return new Response("denied", { status: 403 });
  });
  await assert.rejects(
    api("test"),
    (error) => error.status === "blocked" && /HTTP 403/.test(error.message),
  );
  assert.equal(calls, 1);
});
test("downloads reject HTTP failure, size/hash corruption, and clear partial files", async (t) => {
  const dir = await temporary(t),
    file = path.join(dir, "file");
  const mock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("forbidden", { status: 403 }),
  );
  await assert.rejects(
    download("https://models.ente.com/model", file, { sha256: sha("good") }),
    /HTTP 403/,
  );
  mock.mock.mockImplementation(async () => new Response("bad"));
  await assert.rejects(
    download("https://models.ente.com/model", file, { sha256: sha("good") }),
    /integrity/,
  );
  await assert.rejects(fs.stat(`${file}.partial`), /ENOENT/);
  mock.mock.mockImplementation(async () => new Response("good"));
  assert.equal(
    (
      await download("https://models.ente.com/model", file, {
        sha256: sha("good"),
        size: 4,
      })
    ).sha256,
    sha("good"),
  );
});
test("model verification fails even for same-size corruption", async (t) => {
  const dir = await temporary(t),
    file = path.join(dir, "model");
  await fs.writeFile(file, "good");
  const spec = [{ path: "model", size: 4, sha256: sha("good") }];
  assert.equal((await verifyModels(dir, spec)).length, 1);
  await fs.writeFile(file, "evil");
  await assert.rejects(verifyModels(dir, spec), /SHA-256/);
  await fs.rm(file);
  await assert.rejects(verifyModels(dir, spec), /ENOENT/);
});
test("PE and ELF architecture checks reject malformed and mismatched binaries", () => {
  const pe = Buffer.alloc(512);
  pe.write("MZ");
  pe.writeUInt32LE(128, 0x3c);
  pe.write("PE\0\0", 128);
  pe.writeUInt16LE(0xaa64, 132);
  assert.deepEqual(binaryArchitectures(pe), ["arm64"]);
  const elf = Buffer.alloc(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elf.writeUInt16LE(62, 18);
  assert.deepEqual(binaryArchitectures(elf), ["x64"]);
  assert.throws(() => binaryArchitectures(Buffer.alloc(2)));
  pe.writeUInt32LE(65500, 0x3c);
  assert.throws(() => binaryArchitectures(pe));
});
test("installer exit success cannot hide a missing executable or native resource", async (t) => {
  const dir = await temporary(t),
    source = path.join(dir, "source"),
    root = path.join(dir, "installed");
  const profile = await loadProfile("v1.7.28"),
    scenario = combinations("v1.7.28").find(
      (s) => s.key === "win32-arm64-nsis",
    );
  for (const file of [...profile.asarFiles, "out/_next/static/test.js"]) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(
      path.join(source, file),
      file === "package.json"
        ? JSON.stringify({ name: "ente", version: "1.7.28" })
        : "synthetic fixture",
    );
  }
  await fs.mkdir(path.join(root, "resources"), { recursive: true });
  await createPackage(source, path.join(root, "resources/app.asar"));
  const pe = Buffer.alloc(512);
  pe.write("MZ");
  pe.writeUInt32LE(128, 0x3c);
  pe.write("PE\0\0", 128);
  pe.writeUInt16LE(0xaa64, 132);
  const files = [
    "ente.exe",
    "resources/napi/index.win32-arm64-msvc.node",
    "resources/onnxruntime/arm64/onnxruntime.dll",
    "resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe",
    "resources/vips.exe",
    "icudtl.dat",
    "resources.pak",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "ffmpeg.dll",
    "libEGL.dll",
    "libGLESv2.dll",
  ];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    const binary = Buffer.from(pe);
    if (file.endsWith("ffmpeg-static/ffmpeg.exe"))
      binary.writeUInt16LE(0x8664, 132);
    await fs.writeFile(path.join(root, file), binary);
  }
  await inspectInstalled(root, scenario, profile, "v1.7.28");
  await fs.rm(path.join(root, "ente.exe"));
  const report = { checks: [] };
  await check(report, "install", async () => ({ exitCode: 0 }));
  await check(report, "installed-files", () =>
    inspectInstalled(root, scenario, profile, "v1.7.28"),
  );
  assert.equal(overall(report.checks), "failed");
  assert.match(report.checks[1].error, /ente\.exe/);
  await fs.writeFile(path.join(root, "ente.exe"), pe);
  await fs.rm(path.join(root, "resources/onnxruntime/arm64/onnxruntime.dll"));
  await assert.rejects(
    inspectInstalled(root, scenario, profile, "v1.7.28"),
    /onnxruntime\.dll/,
  );
});
const embedding = (n) => Array(n).fill(1 / Math.sqrt(n));
const inference = () => ({
  decodedImageSize: { width: 100, height: 100 },
  clip: { embedding: embedding(512) },
  faces: [{ embedding: embedding(192) }],
  petFaces: [{ faceEmbedding: embedding(128) }],
  petBodies: [{ bodyEmbedding: embedding(192) }],
  usedCoreml: false,
  usedWebgpu: false,
});
test("inference must actually exercise faces and pets with valid finite embeddings", () => {
  const spec = { expectFaces: true, expectPets: true };
  assert.equal(validateInference(inference(), spec).provider, "CPU");
  for (const alter of [
    (r) => {
      r.faces = [];
    },
    (r) => {
      r.petFaces = [];
      r.petBodies = [];
    },
    (r) => {
      r.clip.embedding[0] = NaN;
    },
    (r) => {
      delete r.petBodies;
    },
    (r) => {
      r.clip.embedding = embedding(3);
    },
  ]) {
    const r = inference();
    alter(r);
    assert.throws(() => validateInference(r, spec));
  }
  assert.throws(() => assertEmbedding(Array(512).fill(0), 512, "zero"));
});
test("ML worker crash/download failure propagates; unavailable bridge is unsupported", async (t) => {
  const dir = await temporary(t);
  await fs.writeFile(path.join(dir, "image"), "fixture");
  for (const error of ["ML download HTTP 403", "ML utility process exited"]) {
    let calls = 0;
    const session = {
      bridge: { hasWorker: true },
      page: {
        addScriptTag: async () => {},
        evaluate: async () => {
          if (++calls > 1) throw new Error(error);
        },
      },
    };
    await assert.rejects(
      runML(
        session,
        { runtimeAdapter: "comlink-ml-v1", fixtures: [{ name: "image" }] },
        dir,
        dir,
      ),
      new RegExp(error),
    );
  }
  await assert.rejects(
    runML(
      { bridge: { hasWorker: false } },
      { runtimeAdapter: "comlink-ml-v1" },
      dir,
      dir,
    ),
    (e) => e.status === "unsupported",
  );
  await assert.rejects(
    deadline(new Promise(() => {}), 5, "worker"),
    /timed out/,
  );
});
test("compatibility is exact-version and model catalog contains every required file", async () => {
  const profile = await loadProfile("v1.7.28");
  assert.equal(profile.models.length, 11);
  assert.equal(new Set(profile.models.map((m) => m.path)).size, 11);
  assert.equal(profile.fixtures.length, 2);
  for (const m of profile.models) {
    assert.match(m.sha256, /^[a-f0-9]{64}$/);
    assert.ok(m.size > 0);
  }
  await assert.rejects(
    loadProfile("v1.7.99"),
    (e) => e.status === "unsupported",
  );
});
test("standalone workflow keeps all scenarios and always restores networking", async () => {
  const yaml = parse(
    await fs.readFile(
      new URL("../.github/workflows/validate.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(yaml.on.workflow_dispatch);
  assert.equal(yaml.jobs.validate.strategy["fail-fast"], false);
  assert.ok(
    yaml.jobs.validate.steps.some(
      (s) => s.if?.includes("always()") && s.run?.includes("network-restore"),
    ),
  );
  assert.equal(yaml.permissions.contents, "read");
  assert.ok(!JSON.stringify(yaml).includes("gh release edit"));
});

test("OS firewall rules close both IP families and offline permits only loopback", () => {
  for (const rules of [linuxRules([], "offline"), macRules([], "offline")]) {
    assert.doesNotMatch(rules, /port 443|port 53/);
    assert.match(rules, /policy drop|block drop out quick all/);
  }
  const linux = linuxRules(["192.0.2.1", "2001:db8::1"], "online");
  assert.match(linux, /ip daddr 192.0.2.1 tcp dport 443/);
  assert.match(linux, /ip6 daddr 2001:db8::1 tcp dport 443/);
  assert.doesNotMatch(linux, /ct state established/);
  const mac = macRules(["192.0.2.1", "2001:db8::1"], "online");
  assert.match(mac, /inet6 proto tcp to 2001:db8::1 port 443/);
  assert.ok(
    mac.indexOf("pass out quick") < mac.indexOf("block drop out quick all"),
  );
});

test(
  "Windows cleanup succeeds when the application is already stopped",
  { skip: process.platform !== "win32" },
  async () => {
    await stopApp({
      executable: path.join(
        os.tmpdir(),
        "nonexistent-ente-validator-app",
        "ente.exe",
      ),
    });
  },
);
