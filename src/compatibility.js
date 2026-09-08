import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { api, getRelease, assertUnchanged } from "./github.js";
import { releaseDescriptor } from "./matrix.js";
import { json, blocked, unsupported } from "./common.js";

const sourceRepository = "ente/ente";
const workflow = "photos-desktop-build.yml";
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

// Conservative scope: changes anywhere in desktop, web or Rust require review.
// Only documentation and the two desktop application-version fields are ignored.
export function contractPath(path) {
  return (
    (/^(desktop|web|rust)\//.test(path) &&
      !/\.md$/.test(path) &&
      !/^desktop\/(changes|docs)\//.test(path)) ||
    path === `.github/workflows/${workflow}` ||
    /^\.github\/scripts\/(photos-desktop-version|release-notes)\.mjs$/.test(
      path,
    )
  );
}
export function normalizedPackage(text, lock = false) {
  const value = JSON.parse(text);
  delete value.version;
  if (lock && value.packages?.[""]) delete value.packages[""].version;
  return JSON.stringify(value);
}
export function contractDigest(tree, packages) {
  if (tree.truncated)
    throw blocked("Source tree truncated; compatibility cannot be verified");
  const entries = tree.tree
    .filter((e) => e.type !== "tree" && contractPath(e.path))
    .map((e) => [e.path, e.mode, packages[e.path] ?? e.sha])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!entries.length) throw blocked("Source compatibility contract is empty");
  return sha256(JSON.stringify(entries));
}
async function sourceFile(commit, path) {
  const file = await api(
    `repos/${sourceRepository}/contents/${path}?ref=${commit}`,
  );
  if (file.encoding !== "base64")
    throw blocked(`Cannot read source file ${path}`);
  return Buffer.from(file.content, "base64").toString("utf8");
}
export async function sourceContract(commit, version) {
  const [tree, pkg, lock] = await Promise.all([
    api(`repos/${sourceRepository}/git/trees/${commit}?recursive=1`),
    sourceFile(commit, "desktop/package.json"),
    sourceFile(commit, "desktop/package-lock.json"),
  ]);
  if (
    JSON.parse(pkg).version !== version ||
    JSON.parse(lock).version !== version
  )
    throw blocked("Source application version does not match the release");
  return contractDigest(tree, {
    "desktop/package.json": sha256(normalizedPackage(pkg)),
    "desktop/package-lock.json": sha256(normalizedPackage(lock, true)),
  });
}
export async function sourceCommit(tag) {
  let object = (
    await api(
      `repos/${sourceRepository}/git/ref/tags/${encodeURIComponent(tag)}`,
    )
  ).object;
  for (let n = 0; object.type === "tag" && n < 5; n++)
    object = (await api(`repos/${sourceRepository}/git/tags/${object.sha}`))
      .object;
  if (object.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha))
    throw blocked("Source tag does not resolve to a commit");
  return object.sha;
}
export function matchingPublication(release, runs) {
  if (runs.some((r) => r.status !== "completed"))
    throw blocked(
      "An upstream desktop build is still running; retry after publication completes",
    );
  const times = release.assets.flatMap((a) => [
    Date.parse(a.created_at),
    Date.parse(a.updated_at),
  ]);
  if (!times.length || times.some((t) => !Number.isFinite(t)))
    throw blocked("Missing asset publication timestamps");
  const matches = runs.filter(
    (r) =>
      r.conclusion === "success" &&
      Date.parse(r.run_started_at) <= Math.min(...times) &&
      Date.parse(r.updated_at) >= Math.max(...times),
  );
  if (matches.length !== 1)
    throw blocked(
      "Assets do not belong to one completed successful desktop publication (partial, mixed or unavailable evidence)",
    );
  return matches[0];
}
export async function captureSource(release) {
  const ref = releaseDescriptor(release);
  const tag = ref.channel === "nightly" ? ref.tag : `photos-desktop-${ref.tag}`;
  const commit = await sourceCommit(tag);
  const source = { repository: sourceRepository, tag, commit };
  if (ref.channel === "nightly") {
    const { workflow_runs: runs } = await api(
      `repos/${sourceRepository}/actions/workflows/${workflow}/runs?per_page=100`,
    );
    const run = matchingPublication(release, runs);
    const { jobs } = await api(
      `repos/${sourceRepository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    );
    for (const name of [
      "build (ubuntu-latest)",
      "build (macos-latest)",
      "build (windows-latest)",
      "finish-build",
    ])
      if (!jobs.some((j) => j.name === name && j.conclusion === "success"))
        throw blocked(`Publication is incomplete: ${name}`);
    const finish = jobs.find((j) => j.name === "finish-build");
    const log = await api(
      `repos/${sourceRepository}/actions/jobs/${finish.id}/logs`,
      { responseType: "text" },
    );
    // The event head can differ from the actual checkout of a mutable branch.
    // Read checkout evidence in the successful job that moves the source tag.
    if (
      !log.includes(`git log -1 --format=%H\n`) ||
      !new RegExp(
        `git log -1 --format=%H\\r?\\n[^\\n]*${commit}(?:\\r?\\n|$)`,
      ).test(log) ||
      !log.includes(`RELEASE_TAG: ${tag}`)
    )
      throw blocked("Publishing log does not prove the tagged source checkout");
    source.publication = {
      runId: run.id,
      attempt: run.run_attempt,
      url: run.html_url,
      startedAt: run.run_started_at,
      completedAt: run.updated_at,
      finishJobId: finish.id,
      finishLogSha256: sha256(log),
    };
  }
  return source;
}
export async function reviewedProfile(release) {
  const ref = releaseDescriptor(release);
  if (ref.channel === "stable") {
    let profile;
    try {
      profile = await json(
        new URL(`../profiles/${ref.version}.json`, import.meta.url),
      );
    } catch (error) {
      if (error.code === "ENOENT")
        throw unsupported(
          `No reviewed compatibility profile for ${ref.version}; v1.7.27 is supported only as an upgrade baseline`,
        );
      throw error;
    }
    if (profile.source.commit !== release.source.commit)
      throw unsupported(
        "Stable source tag differs from the reviewed compatibility profile",
      );
    return profile;
  }
  const digest = await sourceContract(release.source.commit, ref.version);
  for (const file of (
    await fs.readdir(new URL("../profiles/", import.meta.url))
  ).sort()) {
    if (!file.endsWith(".json")) continue;
    const profile = await json(new URL(`../profiles/${file}`, import.meta.url));
    if (profile.channel === "nightly" && profile.contractSha256 === digest)
      return {
        ...profile,
        version: ref.version,
        reviewedVersion: profile.version,
        source: { ...profile.source, commit: release.source.commit },
        reviewedSourceCommit: profile.source.commit,
      };
  }
  throw unsupported(
    `No reviewed nightly compatibility contract for ${ref.version} at ${release.source.commit} (${digest}); review changed source contracts before running installers`,
  );
}
export function profileIdentity(profile) {
  return {
    version: profile.version,
    reviewedVersion: profile.reviewedVersion ?? profile.version,
    source: profile.source,
    runtimeAdapter: profile.runtimeAdapter,
    contractSha256: profile.contractSha256 ?? null,
    sha256: sha256(JSON.stringify(profile)),
  };
}
export async function recheckRelease(before) {
  const after = await getRelease(before);
  if (before.source) {
    const commit = await sourceCommit(before.source.tag);
    if (commit !== before.source.commit)
      throw new Error("Source tag changed during validation; run invalidated");
    after.source = before.source;
  }
  assertUnchanged(before, after);
}
