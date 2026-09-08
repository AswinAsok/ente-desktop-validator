import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { hashFile, inside, blocked, sleep } from "./common.js";
import { REPOSITORY, releaseDescriptor, versionOf } from "./matrix.js";

export async function api(
  endpoint,
  {
    token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    responseType,
    ...options
  } = {},
) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`https://api.github.com/${endpoint}`, {
        ...options,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ente-desktop-validator",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        },
        signal: AbortSignal.timeout(60_000),
      });
      break;
    } catch (error) {
      // Isolation can leave a pooled connection stale. Retry read-only API
      // transport failures; never retry permission errors or mutate releases.
      if (attempt === 2 || (options.method && options.method !== "GET"))
        throw blocked(
          `GitHub request unavailable: ${error.message} (${error.cause?.code ?? "transport failure"})`,
        );
      await sleep(1000 * (attempt + 1));
    }
  }
  if (!res.ok) throw blocked(`GitHub ${endpoint}: HTTP ${res.status}`);
  return res.status === 204
    ? undefined
    : responseType === "text"
      ? res.text()
      : res.json();
}
export async function getRelease(input) {
  const ref = releaseDescriptor(input);
  const release = await api(
    `repos/${ref.repository}/releases/tags/${encodeURIComponent(ref.tag)}`,
  );
  if (release.tag_name !== ref.tag)
    throw new Error("GitHub returned a different release tag");
  return { ...release, ...ref };
}

export async function baselineRelease(tag) {
  const target = versionOf(tag).split("-")[0].split(".").map(Number);
  const older = (version) => {
    const parts = versionOf(version).split("-")[0].split(".").map(Number);
    for (let i = 0; i < 3; i++)
      if (parts[i] !== target[i]) return parts[i] < target[i];
    return false;
  };
  const candidates = [];
  for (let page = 1; ; page++) {
    const releases = await api(
      `repos/${REPOSITORY}/releases?per_page=100&page=${page}`,
    );
    candidates.push(
      ...releases.filter(
        (r) =>
          !r.draft &&
          !r.prerelease &&
          /^v\d+\.\d+\.\d+$/.test(r.tag_name) &&
          older(r.tag_name),
      ),
    );
    if (releases.length < 100) break;
  }
  candidates.sort((a, b) => {
    const av = versionOf(a.tag_name).split(".").map(Number),
      bv = versionOf(b.tag_name).split(".").map(Number);
    return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
  });
  if (!candidates[0])
    throw blocked("No preceding stable release; supply --baseline");
  return { ...candidates[0], ...releaseDescriptor(candidates[0]) };
}

export function identity(release) {
  return {
    ...releaseDescriptor(release),
    id: release.id,
    source: release.source ?? null,
    assets: release.assets
      .map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size,
        digest: a.digest,
        updatedAt: a.updated_at,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
export const fingerprint = (release) =>
  createHash("sha256")
    .update(JSON.stringify(identity(release)))
    .digest("hex");
export function assertUnchanged(before, after) {
  if (fingerprint(before) !== fingerprint(after))
    throw new Error(
      "Release assets changed during validation; all previous results are invalid",
    );
}

export async function download(url, target, { sha256, size, token } = {}) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    ![
      "api.github.com",
      "github.com",
      "raw.githubusercontent.com",
      "models.ente.com",
    ].includes(parsed.hostname)
  )
    throw new Error("Unapproved download origin");
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? ""))
    throw blocked(`Missing trusted SHA-256 for ${target}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream",
      ...(token && parsed.hostname === "api.github.com"
        ? { Authorization: `Bearer ${token}` }
        : {}),
    },
    signal: AbortSignal.timeout(900_000),
  });
  if (!response.ok)
    throw new Error(
      `Download failed: HTTP ${response.status} (${parsed.hostname})`,
    );
  const temporary = `${target}.partial`;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary),
    );
    const actualSize = (await fs.stat(temporary)).size;
    const actualHash = await hashFile(temporary);
    if ((size !== undefined && size !== actualSize) || actualHash !== sha256)
      throw new Error(`Download integrity mismatch: ${target}`);
    await fs.rename(temporary, target);
    return { path: target, size: actualSize, sha256: actualHash };
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
export async function downloadAsset(asset, directory, release) {
  await fs.mkdir(directory, { recursive: true });
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ""))
    throw blocked("Release asset has no GitHub SHA-256 digest");
  if (asset.name !== asset.name.replaceAll("/", "").replaceAll("\\", ""))
    throw new Error("Unsafe asset name");
  return download(
    `https://api.github.com/repos/${releaseDescriptor(release).repository}/releases/assets/${asset.id}`,
    inside(directory, asset.name),
    {
      sha256: asset.digest.slice(7),
      size: asset.size,
      token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    },
  );
}
