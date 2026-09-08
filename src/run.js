import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { matrix, inventory, versionOf } from "./matrix.js";
import {
  getRelease,
  baselineRelease,
  downloadAsset,
  download,
  fingerprint,
  assertUnchanged,
} from "./github.js";
import {
  command,
  writeJSON,
  blocked,
  json,
  exists,
  validatorRevision,
} from "./common.js";
import { newReport, check, saveReport } from "./report.js";
import {
  loadProfile,
  inspectInstalled,
  fileInventory,
  verifyModels,
  signatures,
  shortcuts,
  defaultProfileDirectory,
} from "./inspect.js";
import { preflight, install, stopApp } from "./install.js";
import { NetworkPolicy } from "./network.js";
import {
  instrument,
  normalLaunch,
  runML,
  copyApplicationLogs,
} from "./runtime.js";

export async function preparePlan(tag, baselineTag) {
  const release = await getRelease(tag);
  const baseline = baselineTag
    ? await getRelease(baselineTag)
    : await baselineRelease(tag);
  if (baseline.id === release.id)
    throw new Error("Upgrade baseline must differ from the candidate");
  const revision = await validatorRevision();
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    release,
    releaseFingerprint: fingerprint(release),
    baseline,
    validatorRevision: revision,
    scenarios: matrix(tag),
  };
}

async function mediaTools(app) {
  const ffmpeg = path.join(
    app.resources,
    "app.asar.unpacked/node_modules/ffmpeg-static",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  await command(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=size=16x16:rate=1",
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ]);
  if (process.platform !== "darwin")
    await command(
      path.join(
        app.resources,
        process.platform === "win32" ? "vips.exe" : "vips",
      ),
      ["--version"],
    );
  else await command("sips", ["--version"]);
  return { ffmpeg: "executed synthetic-frame decode", imageTool: "available" };
}
async function cachePackageDependencies(scenario, files) {
  // Fetch OS dependencies before isolating the machine; the installers themselves
  // run under the restricted policy and must use this package-manager cache.
  if (scenario.platform !== "linux" || scenario.format === "AppImage") return;
  for (const file of files) {
    if (scenario.format === "deb")
      await command(
        "sudo",
        ["apt-get", "install", "--download-only", "-y", file],
        { timeout: 600_000 },
      );
    if (scenario.format === "rpm")
      await command("sudo", ["dnf", "install", "--downloadonly", "-y", file], {
        timeout: 600_000,
      });
    if (scenario.format === "pacman")
      await command("sudo", ["pacman", "-Uw", "--noconfirm", file], {
        timeout: 600_000,
      });
  }
}

export async function runScenario(
  plan,
  id,
  directory,
  { disposable = false, unavailable } = {},
) {
  const scenario = plan.scenarios.find((s) => s.id === id);
  if (!scenario) throw new Error(`Unknown scenario ${id}`);
  directory = path.resolve(directory);
  if (await exists(path.join(directory, "report.json")))
    throw new Error(
      "Report directory already contains a run; use a new directory",
    );
  await fs.mkdir(directory, { recursive: true });
  const work = path.join(directory, "work"),
    artifacts = path.join(directory, "artifacts");
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(artifacts, { recursive: true });
  const report = await newReport(scenario, plan.release, plan.baseline);
  report.compatibilityProfile = null;
  const policy = new NetworkPolicy(path.join(directory, "network"));
  let app, session, snapshot;
  class Stop extends Error {}
  const requireCheck = async (id, fn) => {
    console.log(`[${scenario.id}] ${id}`);
    const result = await check(report, id, fn);
    await writeJSON(path.join(directory, "progress.json"), report);
    if (!result.ok) throw new Stop();
    return result.value;
  };
  try {
    await requireCheck("environment", async () => {
      if (unavailable) throw blocked(unavailable);
      return preflight(scenario, work, disposable);
    });
    await requireCheck("release-inventory", () => inventory(plan.release));
    const profile = await requireCheck("compatibility", () =>
      loadProfile(plan.release.tag_name),
    );
    report.compatibilityProfile = {
      version: profile.version,
      source: profile.source,
      runtimeAdapter: profile.runtimeAdapter,
    };
    const profileDirectory = defaultProfileDirectory();
    const files = await requireCheck("download", async () => {
      const candidate = await downloadAsset(
        plan.release.assets.find((a) => a.name === scenario.asset),
        path.join(work, "candidate"),
      );
      let baseline;
      if (scenario.mode === "upgrade") {
        const baseScenario = matrix(plan.baseline.tag_name).find(
          (s) => s.id === id,
        );
        baseline = await downloadAsset(
          plan.baseline.assets.find((a) => a.name === baseScenario.asset),
          path.join(work, "baseline"),
        );
      }
      const fixtures = path.join(work, "fixtures");
      for (const fixture of profile.fixtures)
        await download(fixture.url, path.join(fixtures, fixture.name), fixture);
      await cachePackageDependencies(scenario, [
        candidate.path,
        ...(baseline ? [baseline.path] : []),
      ]);
      return { candidate, baseline, fixtures };
    });
    await requireCheck("network-online", async () => {
      await policy.apply("online", profile.modelHosts);
      return policy.verify("online");
    });
    let marker;
    if (scenario.mode === "upgrade") {
      app = await requireCheck("baseline-install", () =>
        install(
          scenario,
          files.baseline.path,
          work,
          path.join(artifacts, "baseline"),
        ),
      );
      await fs.mkdir(path.join(artifacts, "baseline"), { recursive: true });
      await requireCheck("baseline-launch", async () => {
        await normalLaunch(app, path.join(artifacts, "baseline"));
        const baselineSession = await instrument(
          app,
          versionOf(plan.baseline.tag_name),
          scenario,
          profileDirectory,
          path.join(artifacts, "baseline"),
        );
        try {
          baselineSession.assertAlive();
          return baselineSession.state;
        } finally {
          await baselineSession.close();
        }
      });
      await requireCheck("profile-seed", async () => {
        await fs.mkdir(profileDirectory, { recursive: true });
        marker = randomUUID();
        await fs.writeFile(
          path.join(profileDirectory, "validator-marker.txt"),
          marker,
        );
        const preferencesFile = path.join(
          profileDirectory,
          "userPreferences.json",
        );
        const preferences = await json(preferencesFile).catch(() => ({}));
        await writeJSON(preferencesFile, { ...preferences, themeMode: "dark" });
        return { marker, themeMode: "dark" };
      });
      await app.dispose();
      app = undefined;
    }
    app = await requireCheck("install", () =>
      install(
        scenario,
        files.candidate.path,
        work,
        path.join(artifacts, "candidate"),
      ),
    );
    // An NSIS installer may launch the app when completing. Stop it before the
    // separately measured normal launch and inspect only the installed files.
    await stopApp(app);
    await requireCheck("installed-files", async () => {
      const contents = await fileInventory(app.root);
      await writeJSON(path.join(artifacts, "installed-files.json"), contents);
      snapshot = JSON.stringify(contents);
      return inspectInstalled(
        app.root,
        scenario,
        profile,
        plan.release.tag_name,
      );
    });
    if (scenario.platform !== "linux")
      await requireCheck("signatures", async () => {
        // Gatekeeper and Authenticode may need their certificate services. The
        // application is stopped while the OS performs this online assessment.
        await policy.restore();
        try {
          return await signatures(
            app,
            files.candidate.path,
            profile,
            artifacts,
          );
        } finally {
          await policy.apply("online", profile.modelHosts);
          await policy.verify("online");
        }
      });
    if (scenario.platform === "win32")
      await requireCheck("shortcuts", () => shortcuts(app.executable));
    await requireCheck("normal-launch", () => normalLaunch(app, artifacts));
    const online = path.join(artifacts, "online");
    await fs.mkdir(online, { recursive: true });
    await requireCheck("renderer", async () => {
      session = await instrument(
        app,
        versionOf(plan.release.tag_name),
        scenario,
        profileDirectory,
        online,
      );
      session.assertAlive();
      return session.state;
    });
    await requireCheck("media-tools", () => mediaTools(app));
    if (scenario.mode === "upgrade")
      await requireCheck("profile-preserved", async () => {
        const actual = await fs.readFile(
          path.join(profileDirectory, "validator-marker.txt"),
          "utf8",
        );
        const preferences = await json(
          path.join(profileDirectory, "userPreferences.json"),
        );
        if (actual !== marker || preferences.themeMode !== "dark")
          throw new Error(
            "Upgrade lost the seeded profile marker or preference",
          );
        return { markerPreserved: true, themeMode: preferences.themeMode };
      });
    await requireCheck("ml-online", () =>
      runML(session, profile, files.fixtures, online),
    );
    await requireCheck("model-integrity", () =>
      verifyModels(profileDirectory, profile.models),
    );
    await session.close();
    session = undefined;
    await requireCheck("network-offline", async () => {
      await policy.apply("offline");
      return policy.verify("offline");
    });
    const offline = path.join(artifacts, "offline");
    await fs.mkdir(offline, { recursive: true });
    await requireCheck("ml-offline", async () => {
      session = await instrument(
        app,
        versionOf(plan.release.tag_name),
        scenario,
        profileDirectory,
        offline,
      );
      return runML(session, profile, files.fixtures, offline);
    });
    await requireCheck("model-integrity-offline", () =>
      verifyModels(profileDirectory, profile.models),
    );
  } catch (error) {
    if (!(error instanceof Stop))
      report.checks.push({
        id: "harness",
        status: error.status ?? "failed",
        error: error.message,
      });
  } finally {
    if (session)
      await session.close().catch((error) =>
        report.checks.push({
          id: "shutdown",
          status: "failed",
          error: error.message,
        }),
      );
    if (app) {
      await stopApp(app).catch(() => {});
      if (snapshot)
        await check(report, "package-unchanged", async () => {
          if (snapshot !== JSON.stringify(await fileInventory(app.root)))
            throw new Error(
              "Installed application files changed during testing",
            );
          return { unchanged: true };
        });
      await app.dispose().catch(() => {});
    }
    await check(report, "network-restored", () => policy.restore());
    if (app)
      await check(report, "application-logs", () =>
        copyApplicationLogs(
          defaultProfileDirectory(),
          path.join(artifacts, "application-logs"),
        ),
      );
    await check(report, "release-unchanged", async () => {
      assertUnchanged(plan.release, await getRelease(plan.release.tag_name));
      if (scenario.mode === "upgrade")
        assertUnchanged(
          plan.baseline,
          await getRelease(plan.baseline.tag_name),
        );
      return { unchanged: true };
    });
    await saveReport(report, directory);
  }
  return report;
}
