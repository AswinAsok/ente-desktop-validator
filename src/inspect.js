import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { extractFile, listPackage, statFile } from "@electron/asar";
import {
  inside,
  json,
  hashFile,
  unsupported,
  command,
  powershell,
  psQuote,
} from "./common.js";
import { versionOf } from "./matrix.js";

export async function loadProfile(tag) {
  const version = versionOf(tag);
  try {
    return await json(new URL(`../profiles/${version}.json`, import.meta.url));
  } catch (error) {
    if (error.code === "ENOENT")
      throw unsupported(`No reviewed compatibility profile for ${version}`);
    throw error;
  }
}

export function layout(root, platform) {
  const resources = path.join(
    root,
    platform === "darwin" ? "Contents/Resources" : "resources",
  );
  return {
    root,
    resources,
    executable: path.join(
      root,
      platform === "darwin"
        ? "Contents/MacOS/ente"
        : platform === "win32"
          ? "ente.exe"
          : "ente",
    ),
    asar: path.join(resources, "app.asar"),
  };
}
export function defaultProfileDirectory() {
  return path.join(
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "ente",
  );
}
export async function fileInventory(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (entry.isSymbolicLink())
        files.push({ path: relative, symlink: await fs.readlink(file) });
      else if (entry.isDirectory()) await visit(file);
      else if (entry.isFile())
        files.push({
          path: relative,
          size: (await fs.stat(file)).size,
          sha256: await hashFile(file),
        });
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function binaryArchitectures(buffer) {
  const cpu = (value) =>
    ({
      0x8664: "x64",
      0xaa64: "arm64",
      62: "x64",
      183: "arm64",
      0x1000007: "x64",
      0x100000c: "arm64",
    })[value];
  if (buffer.length < 64) throw new Error("Executable is truncated");
  if (buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
    return [
      cpu(buffer[5] === 1 ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18)),
    ].filter(Boolean);
  if (buffer.toString("ascii", 0, 2) === "MZ") {
    const offset = buffer.readUInt32LE(0x3c);
    if (
      offset + 6 > buffer.length ||
      buffer.toString("ascii", offset, offset + 4) !== "PE\0\0"
    )
      throw new Error("Invalid PE header");
    return [cpu(buffer.readUInt16LE(offset + 4))].filter(Boolean);
  }
  const magic = buffer.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = buffer.readUInt32BE(4),
      stride = magic === 0xcafebabe ? 20 : 32;
    if (count > 20 || 8 + count * stride > buffer.length)
      throw new Error("Invalid universal Mach-O header");
    return Array.from({ length: count }, (_, i) =>
      cpu(buffer.readUInt32BE(8 + i * stride)),
    ).filter(Boolean);
  }
  if ([0xcffaedfe, 0xcefaedfe].includes(magic))
    return [cpu(buffer.readUInt32LE(4))].filter(Boolean);
  if ([0xfeedfacf, 0xfeedface].includes(magic))
    return [cpu(buffer.readUInt32BE(4))].filter(Boolean);
  throw new Error("Unrecognized executable format");
}
export async function assertBinary(file, arches) {
  const handle = await fs.open(file, "r");
  let actual;
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    actual = binaryArchitectures(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  if (arches.some((arch) => !actual.includes(arch)))
    throw new Error(`${file}: expected ${arches}, found ${actual}`);
  return { path: file, architectures: actual };
}
export async function inspectInstalled(root, scenario, profile, version) {
  const app = layout(root, scenario.platform),
    arches =
      scenario.platform === "darwin" ? ["x64", "arm64"] : [scenario.arch];
  const errors = [],
    binaries = [];
  async function required(file, binaryArches) {
    try {
      const resolved = await fs.realpath(file);
      const resolvedRoot = await fs.realpath(root);
      if (!resolved.startsWith(`${resolvedRoot}${path.sep}`))
        throw new Error(
          "Required packaged file resolves outside the application",
        );
      const info = await fs.stat(file);
      if (!info.isFile() || info.size === 0)
        throw new Error("Missing, empty or not a file");
      if (binaryArches) binaries.push(await assertBinary(file, binaryArches));
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }
  await required(app.executable, arches);
  await required(app.asar);
  for (const name of profile.asarFiles) {
    try {
      if (!(statFile(app.asar, path.normalize(name), false).size > 0))
        throw new Error("Empty ASAR member");
    } catch (error) {
      errors.push(`app.asar/${name}: ${error.message}`);
    }
  }
  try {
    const metadata = JSON.parse(
      extractFile(app.asar, "package.json").toString(),
    );
    if (metadata.version !== versionOf(version) || metadata.name !== "ente")
      throw new Error(
        `Unexpected installed package ${metadata.name}@${metadata.version}`,
      );
    const files = listPackage(app.asar).map((file) => file.replaceAll("\\", "/"));
    if (
      !files.some(
        (p) => p.startsWith("/out/_next/static/") && p.endsWith(".js"),
      )
    )
      throw new Error("Bundled renderer JavaScript missing");
  } catch (error) {
    errors.push(error.message);
  }
  const triple = (arch) =>
    scenario.platform === "win32"
      ? `win32-${arch}-msvc`
      : scenario.platform === "linux"
        ? `linux-${arch}-gnu`
        : `darwin-${arch}`;
  const library =
    scenario.platform === "win32"
      ? "onnxruntime.dll"
      : scenario.platform === "linux"
        ? `libonnxruntime.so.${profile.ortVersion}`
        : `libonnxruntime.${profile.ortVersion}.dylib`;
  for (const arch of arches) {
    await required(
      path.join(app.resources, "napi", `index.${triple(arch)}.node`),
      [arch],
    );
    await required(path.join(app.resources, "onnxruntime", arch, library), [
      arch,
    ]);
  }
  await required(
    path.join(
      app.resources,
      "app.asar.unpacked/node_modules/ffmpeg-static",
      scenario.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    ),
    arches,
  );
  if (scenario.platform !== "darwin") {
    await required(
      path.join(
        app.resources,
        scenario.platform === "win32" ? "vips.exe" : "vips",
      ),
      [scenario.arch],
    );
    for (const file of [
      "icudtl.dat",
      "resources.pak",
      "chrome_100_percent.pak",
      "chrome_200_percent.pak",
      ...(scenario.platform === "win32"
        ? ["ffmpeg.dll", "libEGL.dll", "libGLESv2.dll"]
        : ["libffmpeg.so", "libEGL.so", "libGLESv2.so", "chrome-sandbox"]),
    ])
      await required(path.join(root, file));
  } else {
    await required(
      path.join(
        root,
        "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      ),
      arches,
    );
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return { ...app, binaries, version: versionOf(version) };
}
export async function verifyModels(profileDirectory, models) {
  const results = [],
    errors = [];
  for (const model of models) {
    const file = inside(profileDirectory, model.path);
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size !== model.size)
        throw new Error(
          `Wrong size or file type: expected ${model.size}, got ${info.size}`,
        );
      const sha256 = await hashFile(file);
      if (sha256 !== model.sha256) throw new Error("SHA-256 mismatch");
      results.push({ path: model.path, size: info.size, sha256 });
    } catch (error) {
      errors.push(`${model.path}: ${error.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return results;
}
export async function signatures(app, asset, profile, logs) {
  if (process.platform === "darwin") {
    await command(
      "codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", app.root],
      { log: path.join(logs, "codesign.json") },
    );
    await command(
      "spctl",
      ["--assess", "--type", "execute", "--verbose=2", app.root],
      { log: path.join(logs, "gatekeeper.json") },
    );
    return { signature: "valid", gatekeeper: "accepted" };
  }
  const result = await powershell(
    `$results = @(${[asset, app.executable].map(psQuote).join(",")}) | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notlike '*${profile.windowsPublisher}*') { throw "Invalid Ente signature: $_ ($($s.Status))" }; @{path=$_; subject=$s.SignerCertificate.Subject; status=[string]$s.Status} }; ConvertTo-Json -InputObject @($results)`,
    { log: path.join(logs, "authenticode.json") },
  );
  return JSON.parse(result.stdout);
}
export async function shortcuts(executable) {
  const result = await powershell(`$shell=New-Object -ComObject WScript.Shell
$links=@(Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('Desktop')),([Environment]::GetFolderPath('StartMenu')) -Filter '*ente*.lnk' -Recurse -ErrorAction SilentlyContinue)
if ($links.Count -eq 0) { throw 'No Ente desktop or Start Menu shortcut found' }
$targets=@($links | ForEach-Object { $s=$shell.CreateShortcut($_.FullName); if ($s.TargetPath -ine ${psQuote(executable)} -or !(Test-Path -LiteralPath $s.TargetPath)) { throw "Invalid shortcut target $($s.TargetPath)" }; @{path=$_.FullName;target=$s.TargetPath} })
ConvertTo-Json -InputObject $targets`);
  return JSON.parse(result.stdout);
}
