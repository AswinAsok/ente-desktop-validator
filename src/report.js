import path from "node:path";
import { writeJSON, json, validatorRevision } from "./common.js";
import fs from "node:fs/promises";
import os from "node:os";
import { fingerprint, identity } from "./github.js";
import { matrix } from "./matrix.js";

export const statuses = ["passed", "failed", "blocked", "unsupported"];
export function overall(checks) {
  if (!checks.length) return "blocked";
  if (checks.some((c) => !statuses.includes(c.status))) return "failed";
  for (const status of ["failed", "blocked", "unsupported"])
    if (checks.some((c) => c.status === status)) return status;
  return "passed";
}
export function requiredChecks(scenario) {
  return [
    "environment",
    "release-inventory",
    "compatibility",
    "download",
    "network-online",
    ...(scenario.mode === "upgrade"
      ? ["baseline-install", "baseline-launch", "profile-seed"]
      : []),
    "install",
    "installed-files",
    ...(scenario.platform === "linux" ? [] : ["signatures"]),
    ...(scenario.platform === "win32" ? ["shortcuts"] : []),
    "normal-launch",
    "renderer",
    "media-tools",
    ...(scenario.mode === "upgrade" ? ["profile-preserved"] : []),
    "ml-online",
    "model-integrity",
    "network-offline",
    "ml-offline",
    "model-integrity-offline",
    "package-unchanged",
    "network-restored",
    "release-unchanged",
  ];
}
export async function newReport(scenario, release, baseline) {
  const revision = await validatorRevision();
  return {
    schemaVersion: 1,
    kind: "scenario",
    scenario,
    release: identity(release),
    releaseFingerprint: fingerprint(release),
    baseline: baseline ? identity(baseline) : null,
    validatorRevision: revision,
    host: { platform: process.platform, arch: process.arch, os: os.release() },
    startedAt: new Date().toISOString(),
    status: "blocked",
    checks: [],
  };
}
export async function check(report, id, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    report.checks.push({
      id,
      status: "passed",
      durationMs: Date.now() - started,
      detail,
    });
    return { ok: true, value: detail };
  } catch (error) {
    report.checks.push({
      id,
      status: statuses.includes(error.status) ? error.status : "failed",
      durationMs: Date.now() - started,
      error: error.message,
    });
    return { ok: false };
  }
}
const cell = (value) =>
  String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .replaceAll("<", "&lt;");
export function markdown(report) {
  const rows =
    report.kind === "aggregate"
      ? report.scenarios.map((r) => [r.id, r.status, r.error ?? ""])
      : report.checks.map((c) => [c.id, c.status, c.error ?? ""]);
  return `# Ente desktop validation: ${cell(report.status)}\n\nRelease: ${cell(report.release?.tag)}\n\n${report.kind === "aggregate" ? "Full coverage requires every planned scenario to pass." : "A single scenario is not a full release approval."}\n\n| Check | Result | Detail |\n|---|---|---|\n${rows.map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n")}\n`;
}
export async function saveReport(report, directory) {
  if (report.kind === "scenario") {
    for (const id of requiredChecks(report.scenario))
      if (!report.checks.some((c) => c.id === id))
        report.checks.push({
          id,
          status: "blocked",
          error: "Prerequisite did not complete",
        });
    report.status = overall(report.checks);
  }
  report.finishedAt = new Date().toISOString();
  await writeJSON(path.join(directory, "report.json"), report);
  await fs.writeFile(path.join(directory, "summary.md"), markdown(report));
  return report;
}

export function aggregate(plan, reports) {
  const expectedMatrix = matrix(plan.release.tag_name);
  const completePlan =
    JSON.stringify(plan.scenarios) === JSON.stringify(expectedMatrix);
  const scenarios = plan.scenarios.map((scenario) => {
    const matches = reports.filter((r) => r?.scenario?.id === scenario.id);
    if (matches.length !== 1)
      return {
        id: scenario.id,
        status: "blocked",
        error: matches.length
          ? "Duplicate reports"
          : "Runner unavailable, cancelled, or no report uploaded",
      };
    const r = matches[0];
    if (
      r.schemaVersion !== 1 ||
      r.kind !== "scenario" ||
      !Array.isArray(r.checks) ||
      r.checks.some((c) => !c || typeof c.id !== "string") ||
      r.releaseFingerprint !== plan.releaseFingerprint ||
      JSON.stringify(r.release) !== JSON.stringify(identity(plan.release)) ||
      r.validatorRevision !== plan.validatorRevision ||
      JSON.stringify(r.scenario) !== JSON.stringify(scenario) ||
      JSON.stringify(r.baseline) !==
        JSON.stringify(plan.baseline ? identity(plan.baseline) : null)
    )
      return {
        id: scenario.id,
        status: "failed",
        error: "Report provenance or structure does not match this run",
      };
    const ids = r.checks.map((c) => c.id);
    if (
      new Set(ids).size !== ids.length ||
      requiredChecks(scenario).some((id) => !ids.includes(id))
    )
      return {
        id: scenario.id,
        status: "failed",
        error: "Missing or duplicate required check",
      };
    const status = overall(r.checks);
    if (r.status !== status)
      return {
        id: scenario.id,
        status: "failed",
        error: "Reported status contradicts checks",
      };
    return {
      id: scenario.id,
      status,
      error: r.checks
        .filter((c) => c.status !== "passed")
        .map((c) => `${c.id}: ${c.error ?? c.status}`)
        .join("; "),
    };
  });
  for (const r of reports)
    if (!plan.scenarios.some((s) => s.id === r?.scenario?.id))
      scenarios.push({
        id: r?.scenario?.id ?? "unknown",
        status: "failed",
        error: "Unexpected scenario report",
      });
  return {
    schemaVersion: 1,
    kind: "aggregate",
    release: identity(plan.release),
    releaseFingerprint: plan.releaseFingerprint,
    validatorRevision: plan.validatorRevision,
    expectedScenarios: expectedMatrix.length,
    fullCoverage: completePlan && scenarios.every((s) => s.status === "passed"),
    scenarios,
    status: completePlan ? overall(scenarios) : "blocked",
    startedAt: plan.createdAt,
  };
}
export async function collectReports(directory) {
  const results = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await collectReports(file)));
    else if (entry.name === "report.json") {
      try {
        results.push(await json(file));
      } catch (error) {
        results.push({
          schemaVersion: 0,
          scenario: { id: `invalid-report:${path.basename(directory)}` },
          status: "failed",
          error: error.message,
        });
      }
    }
  }
  return results;
}
