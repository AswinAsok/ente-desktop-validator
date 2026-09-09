import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { _electron } from "playwright";
import {
  command,
  powershell,
  sleep,
  deadline,
  unsupported,
  writeJSON,
} from "./common.js";
import { stopApp } from "./install.js";
import { versionOf } from "./matrix.js";
const require = createRequire(import.meta.url);

export async function copyApplicationLogs(profileDirectory, directory) {
  const source =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Logs", "ente")
      : path.join(profileDirectory, "logs");
  await fs.mkdir(directory, { recursive: true });
  const copied = [];
  for (const name of ["ente.log", "ente.old.log"]) {
    try {
      await fs.copyFile(path.join(source, name), path.join(directory, name));
      copied.push(name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { source, copied };
}

export function assertEmbedding(value, size, label) {
  if (
    !Array.isArray(value) ||
    value.length !== size ||
    value.some((x) => typeof x !== "number" || !Number.isFinite(x)) ||
    !value.some((x) => x !== 0)
  )
    throw new Error(`${label}: invalid ${size}-element embedding`);
}
export function validateInference(result, fixture) {
  if (
    !result ||
    !(result.decodedImageSize?.width > 0) ||
    !(result.decodedImageSize?.height > 0)
  )
    throw new Error("Invalid decoded image dimensions");
  assertEmbedding(result.clip?.embedding, 512, "CLIP image");
  for (const field of ["faces", "petFaces", "petBodies"])
    if (!Array.isArray(result[field]))
      throw new Error(`Missing ${field} result`);
  if (fixture.expectFaces && !result.faces.length)
    throw new Error("Known face fixture produced no faces");
  if (
    fixture.expectPets &&
    !(result.petFaces.length || result.petBodies.length)
  )
    throw new Error("Known pet fixture produced no pets");
  for (const face of result.faces) assertEmbedding(face.embedding, 192, "Face");
  for (const pet of result.petFaces)
    assertEmbedding(pet.faceEmbedding, 128, "Pet face");
  for (const pet of result.petBodies)
    assertEmbedding(pet.bodyEmbedding, 192, "Pet body");
  const finite = (object) => {
    if (typeof object === "number" && !Number.isFinite(object))
      throw new Error("Non-finite inference value");
    if (object && typeof object === "object")
      Object.values(object).forEach(finite);
  };
  finite(result);
  if (
    typeof result.usedCoreml !== "boolean" ||
    typeof result.usedWebgpu !== "boolean"
  )
    throw new Error("Missing execution-provider evidence");
  return {
    width: result.decodedImageSize.width,
    height: result.decodedImageSize.height,
    faces: result.faces.length,
    petFaces: result.petFaces.length,
    petBodies: result.petBodies.length,
    provider: result.usedCoreml
      ? "CoreML"
      : result.usedWebgpu
        ? "WebGPU"
        : "CPU",
  };
}

function childEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (
      /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|LD_PRELOAD|DYLD_|^LD_LIBRARY_PATH$/i.test(
        name,
      )
    )
      delete env[name];
  return env;
}
async function screenshot(file) {
  if (process.platform === "darwin")
    await command("screencapture", ["-x", file]);
  else if (process.platform === "linux")
    await command("import", ["-window", "root", file]);
  else
    await powershell(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing
$bounds=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap=New-Object System.Drawing.Bitmap($bounds.Width,$bounds.Height)
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
try { $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bitmap.Size); $bitmap.Save('${file.replaceAll("'", "''")}',[System.Drawing.Imaging.ImageFormat]::Png) } finally { $graphics.Dispose(); $bitmap.Dispose() }`);
}

export async function normalLaunch(app, directory) {
  await stopApp(app);
  const child = spawn(app.launchExecutable, [], {
    cwd: directory,
    env: childEnvironment(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    error;
  child.on("error", (e) => {
    error = e;
  });
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  try {
    await sleep(10_000);
    if (error) throw error;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Installed application exited during startup: ${stderr}`);
    await screenshot(path.join(directory, "normal-launch.png"));
    return {
      pid: child.pid,
      aliveAfterMs: 10_000,
      screenshot: "normal-launch.png",
      instrumentation: false,
    };
  } finally {
    await writeJSON(path.join(directory, "normal-launch-log.json"), {
      stdout,
      stderr,
      exitCode: child.exitCode,
      signal: child.signalCode,
    });
    if (child.pid && process.platform === "win32")
      await command("taskkill", [
        "/PID",
        String(child.pid),
        "/T",
        "/F",
      ]).catch(() => {});
    await stopApp(app, child.pid);
  }
}

export async function instrument(
  app,
  expectedVersion,
  scenario,
  profileDirectory,
  directory,
) {
  let electron;
  try {
    electron = await _electron.launch({
      executablePath: app.launchExecutable,
      cwd: directory,
      timeout: 60_000,
      env: childEnvironment(),
      chromiumSandbox: true,
      locale: "en-US",
    });
  } catch (error) {
    await stopApp(app);
    throw unsupported(
      `Cannot externally instrument this packaged Electron build: ${error.message}`,
    );
  }
  const errors = [],
    consoleLog = [];
  const process = electron.process();
  process.stdout?.on("data", (value) => consoleLog.push(String(value)));
  process.stderr?.on("data", (value) => consoleLog.push(String(value)));
  const close = async () => {
    try {
      await deadline(electron.close(), 10_000, "Electron close");
    } catch {
      await stopApp(app);
    }
    await writeJSON(path.join(directory, "instrumented-log.json"), {
      consoleLog,
      errors,
    });
  };
  try {
    const page = await electron.firstWindow({ timeout: 60_000 });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("crash", () => errors.push("Renderer crashed"));
    page.on("console", (message) =>
      consoleLog.push(`[renderer ${message.type()}] ${message.text()}`),
    );
    await page.waitForFunction(
      () =>
        location.protocol === "ente:" &&
        location.hostname === "app" &&
        document.readyState === "complete" &&
        document.querySelector("#__next") &&
        [...document.querySelectorAll("button,a")].some((el) =>
          /log\s*in|sign\s*(up|in)/i.test(el.textContent),
        ),
      undefined,
      { timeout: 60_000 },
    );
    const state = await electron.evaluate(({ app }) => ({
      version: app.getVersion(),
      profile: app.getPath("userData"),
      logs: app.getPath("logs"),
      arch: globalThis.process.arch,
      appPath: app.getAppPath(),
    }));
    if (
      state.version !== expectedVersion ||
      state.arch !== scenario.arch ||
      path.resolve(state.profile) !== path.resolve(profileDirectory)
    )
      throw new Error(
        `Unexpected running application: ${JSON.stringify(state)}`,
      );
    if (path.resolve(state.appPath) !== path.resolve(app.asar)) {
      // An AppImage launches into a second transient FUSE mount.
      if (
        scenario.format !== "AppImage" ||
        !state.appPath.startsWith("/tmp/.mount_") ||
        !state.appPath.endsWith("/resources/app.asar")
      )
        throw new Error(
          `Application loaded from unexpected path: ${state.appPath}`,
        );
    }
    const bridge = await page.evaluate(async () => ({
      hasWorker:
        typeof window.electron?.triggerCreateUtilityProcess === "function",
      version:
        typeof window.electron?.appVersion === "function"
          ? await window.electron.appVersion()
          : null,
    }));
    await writeJSON(path.join(directory, "runtime-state.json"), {
      state,
      bridge,
    });
    if (
      typeof bridge.version !== "string" ||
      versionOf(bridge.version) !== expectedVersion
    )
      throw new Error(
        `Preload bridge missing or reports wrong version: ${JSON.stringify(bridge)}`,
      );
    await page.screenshot({ path: path.join(directory, "renderer.png") });
    return {
      electron,
      page,
      state,
      bridge,
      errors,
      consoleLog,
      close,
      assertAlive: () => {
        if (
          process.exitCode !== null ||
          process.signalCode !== null ||
          errors.length
        )
          throw new Error(
            `Runtime failure: ${errors.join("; ") || "main process exited"}`,
          );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function runML(
  session,
  profile,
  fixturesDirectory,
  outputDirectory,
) {
  if (profile.runtimeAdapter !== "comlink-ml-v1" || !session.bridge.hasWorker)
    throw unsupported("This release does not expose the supported ML bridge");
  const { page } = session;
  const comlink = await fs.readFile(
    require.resolve("comlink/dist/umd/comlink.js"),
    "utf8",
  );
  await page.addScriptTag({ content: comlink });
  await deadline(
    page.evaluate(async () => {
      const port = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          window.removeEventListener("message", listener);
          reject(new Error("ML worker port timed out"));
        }, 30_000);
        const listener = (event) => {
          if (
            event.source === window &&
            event.data === "utilityProcessPort/ml" &&
            event.ports[0]
          ) {
            clearTimeout(timer);
            window.removeEventListener("message", listener);
            resolve(event.ports[0]);
          }
        };
        window.addEventListener("message", listener);
      });
      window.electron.triggerCreateUtilityProcess("ml");
      window.__enteValidatorML = window.Comlink.wrap(await port);
    }),
    35_000,
    "ML worker connection",
  );
  const results = [];
  for (const [index, fixture] of profile.fixtures.entries()) {
    const base64 = (
      await fs.readFile(path.join(fixturesDirectory, fixture.name))
    ).toString("base64");
    const result = await deadline(
      page.evaluate(
        async ({ base64, id }) => {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const result = await window.__enteValidatorML.analyzeImage({
            fileID: id,
            bytes,
            runFaces: true,
            runClip: true,
            runPets: true,
            generateFaceCrops: false,
          });
          const plain = (value) =>
            ArrayBuffer.isView(value)
              ? Array.from(value)
              : Array.isArray(value)
                ? value.map(plain)
                : value && typeof value === "object"
                  ? Object.fromEntries(
                      Object.entries(value).map(([key, v]) => [key, plain(v)]),
                    )
                  : value;
          return plain(result);
        },
        { base64, id: index + 1 },
      ),
      900_000,
      `ML inference for ${fixture.name}`,
    );
    session.assertAlive();
    results.push({
      fixture: fixture.name,
      ...validateInference(result, fixture),
    });
    await writeJSON(
      path.join(outputDirectory, `${fixture.name}-inference.json`),
      result,
    );
  }
  const text = await deadline(
    page.evaluate(async () => {
      const end = Date.now() + 180_000;
      while (Date.now() < end) {
        const embedding =
          await window.__enteValidatorML.computeCLIPTextEmbeddingIfAvailable(
            "A dog and a person",
          );
        if (embedding) return Array.from(embedding);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("CLIP text model never became available");
    }),
    190_000,
    "CLIP text inference",
  );
  assertEmbedding(text, 512, "CLIP text");
  session.assertAlive();
  await writeJSON(path.join(outputDirectory, "text-inference.json"), text);
  return {
    images: results,
    textEmbeddingLength: text.length,
    downloads: "production worker; no injected model files",
  };
}
