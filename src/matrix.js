export const REPOSITORY = "ente/photos-desktop";

export function versionOf(tag) {
  if (typeof tag === "object") tag = tag.tag_name ?? tag.tag;
  tag = tag?.replace(/^photos-desktop-/, "");
  if (!/^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag))
    throw new Error("Expected a version tag such as v1.7.28");
  return tag.replace(/^v/, "");
}

export function releaseRef(input) {
  if (typeof input === "object") input = input.tag_name ?? input.tag;
  if (!input) throw new Error("--release is required");
  if (input.startsWith("https:")) {
    const url = new URL(input);
    const match =
      /^\/ente\/(photos-desktop|nightly)\/releases\/tag\/([^/]+)$/.exec(
        url.pathname,
      );
    const fragment =
      url.pathname === "/ente/nightly/releases" &&
      /^#release-(photos-desktop-v[^/]+)$/.exec(url.hash);
    if (
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      (!fragment && (!match || url.hash))
    )
      throw new Error("Expected an Ente stable or nightly GitHub release URL");
    input = decodeURIComponent(fragment ? fragment[1] : match[2]);
    if (
      !!(fragment || match[1] === "nightly") !==
      input.startsWith("photos-desktop-")
    )
      throw new Error("Release tag does not match its repository");
  }
  return `${input.startsWith("photos-desktop-") ? "photos-desktop-" : ""}v${versionOf(input)}`;
}

export function releaseDescriptor(input) {
  const tag = releaseRef(input);
  const nightly = tag.startsWith("photos-desktop-");
  const repository = nightly ? "ente/nightly" : REPOSITORY;
  if (input?.repository && input.repository !== repository)
    throw new Error("Release repository does not match its tag");
  return {
    repository,
    tag,
    version: versionOf(tag),
    channel: nightly ? "nightly" : "stable",
  };
}

export function combinations(version) {
  const ref = releaseDescriptor(version);
  const { channel } = ref;
  version = ref.version;
  const rows = [];
  const add = (platform, arch, format, suffix, runner, distro) =>
    rows.push({
      key: `${platform}-${arch}-${format}`,
      platform,
      arch,
      format,
      distro,
      asset: `ente-${version}${suffix}`,
      runner,
    });
  for (const arch of ["x64", "arm64"]) {
    const win = [arch === "x64" ? "windows-2025" : "windows-11-arm"];
    add("win32", arch, "nsis", `-${arch}.exe`, win);
    add("win32", arch, "nsis-combined", ".exe", win);
    const mac = [arch === "x64" ? "macos-15-intel" : "macos-15"];
    add("darwin", arch, "dmg", "-universal.dmg", mac);
    if (channel === "stable") add("darwin", arch, "zip", "-universal.zip", mac);
    const linux = [arch === "x64" ? "ubuntu-24.04" : "ubuntu-24.04-arm"];
    add(
      "linux",
      arch,
      "deb",
      `-${arch === "x64" ? "amd64" : arch}.deb`,
      linux,
      "ubuntu",
    );
    add(
      "linux",
      arch,
      "AppImage",
      `-${arch === "x64" ? "x86_64" : arch}.AppImage`,
      linux,
      "ubuntu",
    );
    add(
      "linux",
      arch,
      "rpm",
      `-${arch === "x64" ? "x86_64" : "aarch64"}.rpm`,
      [
        "self-hosted",
        "Linux",
        arch === "x64" ? "X64" : "ARM64",
        "ente-validator-fedora",
      ],
      "fedora",
    );
    add(
      "linux",
      arch,
      "pacman",
      `-${arch === "x64" ? arch : "aarch64"}.pacman`,
      [
        "self-hosted",
        "Linux",
        arch === "x64" ? "X64" : "ARM64",
        "ente-validator-arch",
      ],
      arch === "x64" ? "arch" : "archarm",
    );
  }
  return rows;
}

export function matrix(tag) {
  return combinations(tag).flatMap((row) =>
    ["fresh", "upgrade"].map((mode) => ({
      ...row,
      mode,
      id: `${row.key}-${mode}`,
    })),
  );
}

export function inventory(release) {
  const expected = [
    ...new Set(combinations(release).map((row) => row.asset)),
  ].sort();
  const names = release.assets.map((a) => a.name);
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter(
    (name) =>
      !expected.includes(name) &&
      !/^(?:latest(?:-linux(?:-arm64)?|-mac)?\.yml|ente-[\w.-]+\.blockmap)$/.test(
        name,
      ),
  );
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (missing.length || unexpected.length || duplicates.length) {
    throw new Error(JSON.stringify({ missing, unexpected, duplicates }));
  }
  return {
    packages: expected.length,
    combinations: combinations(release).length,
    scenarios: matrix(release).length,
    assets: names.length,
  };
}
