import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  archiveIdentity,
  assertArchiveUnchanged,
  baselineRelease,
  downloadAsset,
  sameBuild,
} from "../src/github.js";
import { recheckRelease } from "../src/compatibility.js";
const archiveResponse = (b) => ({
  id: b.archive.id,
  tag_name: b.archive.tag,
  assets: b.archive.assets.map((a) => ({ ...a, updated_at: a.updatedAt })),
});
const example = () => {
  const digest = `sha256:${createHash("sha256").update("installer").digest("hex")}`;
  const asset = {
    id: 10,
    name: "ente-1.7.29-beta-x64.exe",
    size: 9,
    digest,
    updated_at: "2026-09-08T08:22:00Z",
  };
  return {
    id: 1,
    tag_name: "photos-desktop-v1.7.29-beta",
    source: { tag: "photos-desktop-v1.7.29-beta", commit: "a".repeat(40) },
    assets: [asset],
    archive: archiveIdentity(
      {
        id: 20,
        tag_name: "baseline-photos-desktop-2026-09-08",
        assets: [{ ...asset, id: 30 }],
      },
      "AswinAsok/ente-desktop-validator",
    ),
  };
};
test("future nightly defaults retain the dated archive, not the moving upstream tag", async (t) => {
  const baseline = JSON.parse(
    await fs.readFile(
      new URL("../baselines/nightly.json", import.meta.url),
      "utf8",
    ),
  );
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    return Response.json(archiveResponse(baseline));
  });
  const selected = await baselineRelease("photos-desktop-v1.7.30-beta");
  assert.equal(
    selected.source.commit,
    "2ffa837dab0540fd46c8863714ef944498e3b1d5",
  );
  assert.equal(selected.archive.tag, "baseline-photos-desktop-2026-09-08");
  assert.equal(selected.assets.length, 12);
  await recheckRelease(selected);
  assert.equal(urls.length, 2);
  assert.ok(
    urls.every((u) =>
      u.includes("repos/AswinAsok/ente-desktop-validator/releases/"),
    ),
  );
});
test("archive deletion, replacement and disagreement with original hashes block validation", async (t) => {
  const b = example();
  let response = archiveResponse(b);
  t.mock.method(globalThis, "fetch", async () => Response.json(response));
  await assertArchiveUnchanged(b);
  response.assets[0].id++;
  await assert.rejects(
    assertArchiveUnchanged(b),
    (e) => e.status === "blocked" && /archive changed/.test(e.message),
  );
  response = archiveResponse(b);
  response.assets = [];
  await assert.rejects(assertArchiveUnchanged(b), /archive changed/);
  response = archiveResponse(b);
  b.assets[0].digest = `sha256:${"b".repeat(64)}`;
  await assert.rejects(assertArchiveUnchanged(b), /hashes differ/);
});
test("archived installers download from the private snapshot using original sizes and hashes", async (t) => {
  const b = example(),
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ente-baseline-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let endpoint;
  t.mock.method(globalThis, "fetch", async (url) => {
    endpoint = String(url);
    return new Response("installer");
  });
  const result = await downloadAsset(b.assets[0], dir, b);
  assert.equal(
    endpoint,
    "https://api.github.com/repos/AswinAsok/ente-desktop-validator/releases/assets/30",
  );
  assert.equal(result.size, 9);
  b.archive.assets[0].digest = `sha256:${"c".repeat(64)}`;
  await assert.rejects(downloadAsset(b.assets[0], dir, b), /does not match/);
});
test("a rebuilt rolling tag differs from its archived baseline, but copying the same build does not", () => {
  const b = example(),
    candidate = structuredClone(b);
  delete candidate.archive;
  assert.equal(sameBuild(candidate, b), true);
  candidate.assets[0].id++;
  assert.equal(sameBuild(candidate, b), true);
  candidate.assets[0].digest = `sha256:${"d".repeat(64)}`;
  assert.equal(sameBuild(candidate, b), false);
});

test(
  "same-version Linux packages explicitly request native reinstallation",
  { skip: process.platform === "win32" },
  async (t) => {
    const { install } = await import("../src/install.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ente-reinstall-"));
    const oldPath = process.env.PATH,
      oldCapture = process.env.ENTE_TEST_INSTALL_ARGS;
    t.after(async () => {
      process.env.PATH = oldPath;
      if (oldCapture === undefined) delete process.env.ENTE_TEST_INSTALL_ARGS;
      else process.env.ENTE_TEST_INSTALL_ARGS = oldCapture;
      await fs.rm(dir, { recursive: true, force: true });
    });
    await fs.writeFile(
      path.join(dir, "sudo"),
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ENTE_TEST_INSTALL_ARGS,JSON.stringify(process.argv.slice(2)));\n',
      { mode: 0o755 },
    );
    process.env.PATH = dir + path.delimiter + oldPath;
    process.env.ENTE_TEST_INSTALL_ARGS = path.join(dir, "args.json");
    for (const format of ["deb", "rpm"]) {
      await install(
        { platform: "linux", format },
        "/candidate/package",
        dir,
        path.join(dir, "logs"),
        { reinstall: true },
      );
      const args = JSON.parse(
        await fs.readFile(process.env.ENTE_TEST_INSTALL_ARGS, "utf8"),
      );
      assert.ok(args.includes(format === "deb" ? "--reinstall" : "reinstall"));
      assert.equal(args.at(-1), "/candidate/package");
    }
  },
);
