import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  blocked,
  command,
  exists,
  powershell,
  psQuote,
  sleep,
} from "./common.js";
import { defaultProfileDirectory, layout } from "./inspect.js";

export function installRoot(scenario, work) {
  if (scenario.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? "", "Programs", "ente");
  if (scenario.platform === "darwin") return "/Applications/ente.app";
  return scenario.format === "AppImage"
    ? path.join(work, "appimage-mount")
    : "/opt/ente";
}
export async function preflight(scenario, work, disposable) {
  if (!disposable)
    throw blocked(
      "Installation requires --disposable on a fresh VM or snapshot; use inventory/inspect for read-only checks",
    );
  if (process.platform !== scenario.platform || process.arch !== scenario.arch)
    throw blocked(
      `Requires native ${scenario.platform}/${scenario.arch}, got ${process.platform}/${process.arch}`,
    );
  if (
    process.env.RUNNER_ENVIRONMENT === "self-hosted" &&
    process.env.ENTE_VALIDATOR_EPHEMERAL !== "1"
  )
    throw blocked(
      "Dedicated runners must be provisioned as disposable single-job machines",
    );
  if (scenario.platform === "linux") {
    const distro = await fs.readFile("/etc/os-release", "utf8");
    const id = /^ID=["']?([^\n"']+)/m.exec(distro)?.[1];
    if (id !== scenario.distro)
      throw blocked(`Requires ${scenario.distro}, found ${id}`);
    if (process.getuid() === 0 || !process.env.DISPLAY)
      throw blocked(
        "Run as a desktop user with DISPLAY and passwordless sudo, not as root",
      );
    await command("sudo", ["-n", "true"]);
    await command("nft", ["--version"]);
  }
  if (scenario.platform === "darwin") await command("sudo", ["-n", "true"]);
  if (scenario.platform === "win32")
    await powershell(
      "if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator session required for machine firewall rules' }",
    );
  const profile = defaultProfileDirectory(),
    root = installRoot(scenario, work);
  for (const location of [
    profile,
    root,
    ...(scenario.platform === "win32"
      ? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "ente")]
      : []),
  ]) {
    if (await exists(location))
      throw blocked(
        `Existing Ente installation/profile at ${location}; reset the machine first`,
      );
  }
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    profile,
    root,
  };
}

export async function install(scenario, assetPath, work, logs) {
  await fs.mkdir(logs, { recursive: true });
  const root = installRoot(scenario, work);
  const options = { timeout: 600_000, log: path.join(logs, "installer.json") };
  let mountProcess;
  if (scenario.platform === "win32") {
    // Start-Process -Wait also waits for installer descendants before inspection.
    await powershell(
      `$p=Start-Process -FilePath ${psQuote(assetPath)} -ArgumentList '/S','/currentuser' -Wait -PassThru; if ($p.ExitCode -ne 0) { throw "Installer exited $($p.ExitCode)" }`,
      options,
    );
  } else if (scenario.platform === "darwin") {
    if (await exists(root)) await command("sudo", ["rm", "-rf", root]);
    if (scenario.format === "zip") {
      const extract = path.join(work, "unzip");
      await fs.rm(extract, { recursive: true, force: true });
      await command("ditto", ["-x", "-k", assetPath, extract], options);
      await command(
        "sudo",
        ["ditto", path.join(extract, "ente.app"), root],
        options,
      );
    } else {
      const mount = path.join(work, "dmg-mount");
      await fs.mkdir(mount, { recursive: true });
      await command(
        "hdiutil",
        ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, assetPath],
        options,
      );
      try {
        await command(
          "sudo",
          ["ditto", path.join(mount, "ente.app"), root],
          options,
        );
      } finally {
        await command("hdiutil", ["detach", mount]);
      }
    }
  } else if (scenario.format === "AppImage") {
    const target = path.join(work, "ente.AppImage");
    await fs.copyFile(assetPath, target);
    await fs.chmod(target, 0o755);
    // Keep the real AppImage mounted for inspection, and launch its normal entrypoint.
    mountProcess = spawn(target, ["--appimage-mount"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      stderr = "";
    mountProcess.stdout.on("data", (chunk) => {
      output += chunk;
    });
    mountProcess.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let spawnError;
    mountProcess.on("error", (error) => {
      spawnError = error;
    });
    for (
      let n = 0;
      n < 100 &&
      !output.includes("\n") &&
      mountProcess.exitCode === null &&
      !spawnError;
      n++
    )
      await sleep(100);
    const mounted = output.trim().split("\n")[0];
    if (
      spawnError ||
      !mounted?.startsWith("/tmp/") ||
      !(await exists(path.join(mounted, "ente")))
    ) {
      mountProcess.kill();
      throw new Error(
        `AppImage mount failed: ${spawnError?.message ?? stderr}`,
      );
    }
    return {
      ...layout(mounted, scenario.platform),
      launchExecutable: target,
      dispose: async () => {
        mountProcess.kill();
        await sleep(300);
      },
    };
  } else {
    const commands = {
      deb: ["apt-get", ["install", "--no-download", "-y", assetPath]],
      rpm: ["dnf", ["--cacheonly", "install", "-y", assetPath]],
      pacman: ["pacman", ["-U", "--noconfirm", assetPath]],
    };
    const [file, args] = commands[scenario.format];
    await command("sudo", ["-n", file, ...args], options);
  }
  return {
    ...layout(root, scenario.platform),
    launchExecutable: layout(root, scenario.platform).executable,
    dispose: async () => {},
  };
}

export async function stopApp(app) {
  if (process.platform === "win32") {
    await powershell(
      `Get-Process -Name ente -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq ${psQuote(app.executable)} } | ForEach-Object { taskkill.exe /PID $_.Id /T /F | Out-Null }`,
    );
  } else {
    // Matches only the executable installed by this disposable scenario.
    const processes = await command("ps", ["-axo", "pid=,command="]);
    for (const line of processes.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (
        m &&
        (m[2] === app.executable ||
          m[2].startsWith(`${app.executable} `) ||
          m[2] === app.launchExecutable)
      ) {
        try {
          process.kill(Number(m[1]), "SIGTERM");
        } catch {}
      }
    }
  }
  await sleep(700);
}
