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
    ...(scenario.container ? ["container-isolation"] : []),
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
    schemaVersion: 2,
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
const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]#|]/g, (c) => `&#${c.charCodeAt(0)};`);

// Keep downstream skips in JSON, but explain their originating issue only once.
const rootIssues = (checks) =>
  checks.filter(
    (c) =>
      c.status !== "passed" &&
      !c.prerequisite &&
      !c.error?.startsWith("Blocked by "),
  );

function scenarioName(id) {
  const match = /^(win32|darwin|linux)-(x64|arm64)-(.+)-(fresh|upgrade)$/.exec(
    id,
  );
  if (!match) return id;
  const [, platform, arch, format, mode] = match;
  const host =
    platform === "darwin"
      ? `macOS ${arch === "x64" ? "Intel" : "Apple Silicon"}`
      : `${platform === "win32" ? "Windows" : "Linux"} ${arch === "arm64" ? "ARM64" : "x64"}`;
  const packageName =
    {
      nsis: "EXE",
      "nsis-combined": "combined EXE",
      pacman: "Arch package",
      rpm: "Fedora RPM",
      deb: "DEB",
      dmg: "DMG",
      zip: "ZIP",
    }[format] ?? format;
  return `${host} ${packageName} — ${mode === "fresh" ? "fresh install" : "upgrade"}`;
}

function scenarioList(rows) {
  const groups = new Map();
  for (const row of rows) {
    const [name, mode] = scenarioName(row.id).split(" — ");
    const modes = groups.get(name) ?? new Set();
    if (mode) modes.add(mode);
    groups.set(name, modes);
  }
  return [...groups]
    .map(
      ([name, modes]) =>
        `- ${escape(name)}${modes.size ? `: ${[...modes].join(" and ")}` : ""}`,
    )
    .join("\n");
}

function explainIssue(issue) {
  const error = issue.error ?? "No additional diagnostic was recorded.";
  const architecture = /ffmpeg[\s\S]*expected (\w+), found (\w+)/i.exec(error);
  if (architecture)
    return {
      title: "Bundled FFmpeg has the wrong architecture",
      text: `The installed FFmpeg helper is ${architecture[2]}, but these scenarios require ${architecture[1]}. The installed-file check stopped validation before ML testing. Review FFmpeg staging in the upstream package build, then test newly published installers.`,
      key: `ffmpeg:${architecture[1]}:${architecture[2]}`,
    };
  if (/cannot resolve "http-parser"/.test(error))
    return {
      title: "Arch cannot resolve an application dependency",
      text: "Ente declares http-parser as a dependency, but the configured Arch repositories could not provide it. Package preparation stopped before installation and ML testing. Check the package dependency declaration and repository availability before rerunning.",
      key: "http-parser",
    };
  if (/indexedDB\.open|IndexedDB.*LOCK/i.test(error))
    return {
      title: "App storage could not reopen after launch",
      text: "The renderer reported an IndexedDB backing-store error. This prevents a runtime pass. The message alone does not establish whether the cause is the app, filesystem permissions, or test-process cleanup; inspect the application logs and any database-lock errors before assigning a cause.",
      key: "indexeddb",
    };
  if (/ENOTFOUND|EAI_AGAIN/.test(error))
    return {
      title: "A network request could not resolve its host",
      text:
        issue.id === "release-unchanged"
          ? "The final GitHub identity check could not complete because DNS resolution failed. Earlier successful app checks are retained, but the scenario cannot pass until release identity is verified. Retry the affected scenario when connectivity is available."
          : "DNS resolution prevented this check from completing. Inspect the runner's network state and retry the affected scenario once the host can be resolved.",
      key: `dns:${issue.id}`,
    };
  return {
    title: `${issue.id.replaceAll("-", " ")}: ${issue.status}`,
    text:
      issue.status === "unsupported"
        ? "The validator cannot verify this compatibility contract or runtime interface. Review the reported source/profile or bridge mismatch before running the affected checks; unsupported coverage cannot count as a pass."
        : issue.status === "blocked"
          ? "This check could not complete. Resolve the prerequisite or runner availability described below, then rerun the affected coverage."
          : "This check did not meet its requirement. Inspect the diagnostic and saved evidence before deciding whether the correction belongs in the package or the validator.",
    key: `${issue.id}:${error}`,
    diagnostic: true,
  };
}

export function markdown(report) {
  const combined = report.kind === "aggregate";
  const rows = combined ? report.scenarios : (report.checks ?? []);
  const counts = Object.fromEntries(
    statuses.map((s) => [s, rows.filter((r) => r.status === s).length]),
  );
  const lines = [
    "# Ente desktop validation",
    `**${escape(report.status).toUpperCase()} — ${counts.passed} of ${combined ? report.expectedScenarios : rows.length} ${combined ? "required scenarios" : "checks"} passed.**`,
    `${counts.failed} failed · ${counts.blocked} blocked · ${counts.unsupported} unsupported.`,
    `Release: **${escape(report.release?.repository)} ${escape(report.release?.tag)}**.`,
  ];
  if (combined && rows.length !== report.expectedScenarios)
    lines.push(
      `This report contains ${rows.length} scenario entries for ${report.expectedScenarios} required scenarios. Missing or unexpected coverage prevents full approval.`,
    );
  lines.push(
    combined
      ? report.fullCoverage && report.status === "passed"
        ? "Every required scenario passed. The release meets this validator's configured coverage requirements."
        : "This run does not establish release readiness. Every required scenario and final release-identity check must pass."
      : report.kind === "preparation"
        ? "Preparation stopped before native validation began. No installation or ML success is claimed by this report."
        : report.kind === "static-inspection"
          ? "This report checks files only. It does not prove installation, launch, or ML inference."
          : `Scenario: **${escape(scenarioName(report.scenario.id))}**. A single scenario is not a full release approval.`,
  );
  const groups = new Map();
  for (const row of combined
    ? rows
    : [{ id: report.scenario?.id ?? report.kind, issues: rootIssues(rows) }]) {
    for (const issue of row.issues ??
      (row.status !== "passed"
        ? [{ id: "scenario", status: row.status, error: row.error }]
        : [])) {
      const explanation = explainIssue(issue);
      const key = `${issue.status}:${explanation.key}`;
      if (!groups.has(key))
        groups.set(key, { ...explanation, status: issue.status, entries: [] });
      groups.get(key).entries.push({ scenario: row.id, issue });
    }
  }
  if (report.releaseIdentityError)
    lines.push(
      "## Final release verification failed",
      "The final identity recheck failed. Earlier scenario passes cannot approve this run.",
      escape(report.releaseIdentityError),
    );
  if (groups.size) lines.push("## What needs attention");
  for (const group of [...groups.values()].sort(
    (a, b) =>
      statuses.indexOf(a.status) - statuses.indexOf(b.status) ||
      b.entries.length - a.entries.length,
  )) {
    const affected = [...new Set(group.entries.map((e) => e.scenario))];
    lines.push(
      `### ${escape(group.title)}`,
      `**${group.status}${combined ? ` · ${affected.length} affected scenario${affected.length === 1 ? "" : "s"}` : ""}.** ${escape(group.text)}`,
    );
    if (group.diagnostic)
      lines.push(
        `> ${escape(group.entries[0].issue.error ?? group.status)
          .slice(0, 1200)
          .replaceAll("\n", "\n> ")}`,
      );
    if (combined) lines.push(scenarioList(affected.map((id) => ({ id }))));
    const baseline = group.entries.filter((e) =>
      e.issue.id.startsWith("baseline-"),
    );
    if (baseline.length)
      lines.push(
        "**Baseline failure:** these upgrade checks stopped on the older baseline before the candidate was installed. This is not evidence that the candidate failed to launch.",
        ...(combined
          ? [scenarioList(baseline.map((e) => ({ id: e.scenario })))]
          : []),
      );
    lines.push(
      "<details>\n<summary>Check locations and technical diagnostics</summary>\n",
      ...group.entries.map(
        ({ scenario, issue }) =>
          `**${escape(combined ? scenarioName(scenario) : "Originating check")} — ${escape(issue.id)}**\n\n> ${escape(issue.error ?? issue.status).replaceAll("\n", "\n> ")}`,
      ),
      "</details>",
    );
  }
  const passed = rows.filter((r) => r.status === "passed");
  if (passed.length) {
    lines.push("## What passed");
    if (combined)
      lines.push(
        "These scenarios passed every required check, including installation and required files, launch, production ML inference, model hashes, and offline restart/reuse. Upgrade scenarios also preserved the seeded preference and profile marker. Platform-specific signature and shortcut checks apply where required.",
        scenarioList(passed),
      );
    else {
      for (const [ids, description] of [
        [
          ["install", "installed-files"],
          "The application installed successfully and its required executable and resources passed inspection.",
        ],
        [
          ["normal-launch", "renderer"],
          "The installed application launched normally and its renderer passed the startup checks.",
        ],
        [
          ["ml-online", "model-integrity"],
          "Production face, pet, image and text inference passed, and every required model matched its expected size and hash.",
        ],
        [
          ["ml-offline", "model-integrity-offline"],
          "Inference passed again after restarting with external networking blocked, and model integrity checks passed again.",
        ],
        [
          ["profile-preserved"],
          "The upgrade preserved the seeded preference and profile marker.",
        ],
      ])
        if (ids.every((id) => passed.some((c) => c.id === id)))
          lines.push(description);
      lines.push(
        "The following checks completed successfully. Success here does not imply that any blocked or unsupported inference checks ran.",
        "<details>\n<summary>Successful checks</summary>\n",
        passed.map((c) => `- ${escape(c.id.replaceAll("-", " "))}`).join("\n"),
        "</details>",
      );
    }
  }
  if (!combined) {
    const skipped = rows.filter(
      (c) => c.prerequisite || c.error?.startsWith("Blocked by "),
    );
    if (skipped.length)
      lines.push(
        "## What could not run",
        `${skipped.length} downstream checks were blocked by an earlier issue. They are not additional independent failures.`,
        "<details>\n<summary>Blocked checks and their prerequisites</summary>\n",
        skipped
          .map(
            (c) =>
              `- ${escape(c.id)} — prerequisite: ${escape(c.prerequisite ?? c.error)}`,
          )
          .join("\n"),
        "</details>",
      );
  }
  lines.push(
    "## Build and evidence",
    `Candidate: **${escape(report.release?.repository)} ${escape(report.release?.tag)}**${report.release?.source?.commit ? ` · source ${escape(report.release.source.commit)}` : ""}.`,
  );
  if (report.baseline)
    lines.push(
      `Upgrade baseline: **${escape(report.baseline.repository)} ${escape(report.baseline.tag)}**${report.baseline.archive ? ` · archived as ${escape(report.baseline.archive.tag)}` : ""}${report.baseline.source?.commit ? ` · source ${escape(report.baseline.source.commit)}` : ""}.`,
    );
  if (report.validatorRevision)
    lines.push(`Validator revision: ${escape(report.validatorRevision)}.`);
  if (report.scenario?.container || report.coverageScope?.containers)
    lines.push(
      "Fedora/Arch scenarios use native-architecture containers on Ubuntu kernels. This covers distribution userspace, not full distribution VMs.",
    );
  lines.push(
    "The downloadable report.json retains the full check results and failure details. Scenario artifacts contain the logs, screenshots, file inventories, and model evidence captured before each scenario ended. A failed check means a requirement was not met; blocked means it could not complete; unsupported means the validator could not verify the required interface or contract.",
  );
  return `${lines.join("\n\n")}\n`;
}
export async function saveReport(report, directory) {
  if (report.kind === "scenario") {
    const cause = report.checks.find((c) => c.status !== "passed");
    for (const id of requiredChecks(report.scenario))
      if (!report.checks.some((c) => c.id === id))
        report.checks.push({
          id,
          status: "blocked",
          error: cause
            ? `Blocked by ${cause.id}: ${cause.error ?? cause.status}`
            : "Required check was not executed",
          prerequisite: cause?.id,
        });
    report.status = overall(report.checks);
  }
  report.finishedAt = new Date().toISOString();
  await writeJSON(path.join(directory, "report.json"), report);
  await fs.writeFile(path.join(directory, "summary.md"), markdown(report));
  return report;
}

export function aggregate(plan, reports) {
  const expectedMatrix = matrix(plan.release);
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
      r.schemaVersion !== 2 ||
      r.kind !== "scenario" ||
      !Array.isArray(r.checks) ||
      r.checks.some((c) => !c || typeof c.id !== "string") ||
      r.releaseFingerprint !== plan.releaseFingerprint ||
      JSON.stringify(r.release) !== JSON.stringify(identity(plan.release)) ||
      r.validatorRevision !== plan.validatorRevision ||
      JSON.stringify(r.compatibilityProfile) !==
        JSON.stringify(plan.compatibilityProfile) ||
      r.expectedScenarios !== plan.expectedScenarios ||
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
      issues: rootIssues(r.checks).map(({ id, status, error }) => ({
        id,
        status,
        error,
      })),
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
    schemaVersion: 2,
    kind: "aggregate",
    release: identity(plan.release),
    releaseFingerprint: plan.releaseFingerprint,
    validatorRevision: plan.validatorRevision,
    baseline: plan.baseline ? identity(plan.baseline) : null,
    compatibilityProfile: plan.compatibilityProfile,
    expectedScenarios: expectedMatrix.length,
    coverageScope: {
      nativeMachines: expectedMatrix.filter((s) => !s.container).length,
      containers: expectedMatrix.filter((s) => s.container).length,
      description:
        "Container scenarios validate distribution userspace on Ubuntu host kernels; full distribution VM coverage is not claimed",
    },
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
