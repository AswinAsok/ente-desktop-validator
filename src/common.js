import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export class OutcomeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const blocked = (message) => new OutcomeError("blocked", message);
export const unsupported = (message) =>
  new OutcomeError("unsupported", message);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
export async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
export async function exists(file) {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}
export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export function inside(root, relative) {
  const target = path.resolve(root, relative);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    !target.startsWith(`${path.resolve(root)}${path.sep}`)
  )
    throw new Error(`Unsafe relative path: ${relative}`);
  return target;
}
export function deadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export function command(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeout ?? 120_000);
    child.stdout.on("data", (data) => {
      stdout = (stdout + data).slice(-4_000_000);
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-4_000_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      const result = { file, args, code, timedOut, stdout, stderr };
      if (options.log) await writeJSON(options.log, result).catch(() => {});
      if (code === 0 && !timedOut) resolve(result);
      else
        reject(
          Object.assign(
            new Error(
              `${file} ${timedOut ? "timed out" : `exited ${code}`}: ${stderr || stdout}`,
            ),
            { result },
          ),
        );
    });
  });
}

export function powershell(script, options) {
  const encoded = Buffer.from(
    `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n${script}`,
    "utf16le",
  ).toString("base64");
  return command(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      encoded,
    ],
    options,
  );
}
export const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export async function validatorRevision() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const revision = await command("git", ["rev-parse", "HEAD"], {
    cwd: root,
  }).then(
    (r) => r.stdout.trim(),
    () => "uncommitted",
  );
  const hash = createHash("sha256");
  const files = ["package.json", "package-lock.json"];
  for (const directory of [
    "src",
    "scripts",
    "containers",
    "profiles",
    ".github/workflows",
  ]) {
    for (const name of await fs.readdir(path.join(root, directory)))
      files.push(`${directory}/${name}`);
  }
  for (const file of files.sort()) {
    hash.update(file);
    hash.update(await fs.readFile(path.join(root, file)));
  }
  return `${revision}:${hash.digest("hex")}`;
}
