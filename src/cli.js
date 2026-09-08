#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  matrix,
  combinations,
  releaseRef,
  releaseDescriptor,
  inventory,
} from "./matrix.js";
import { getRelease } from "./github.js";
import { prepareReport, runScenario, assertPlan } from "./run.js";
import {
  aggregate,
  collectReports,
  saveReport,
  markdown,
  check,
  overall,
} from "./report.js";
import { loadProfile, inspectInstalled, fileInventory } from "./inspect.js";
import { writeJSON, json, command, sleep } from "./common.js";
import {
  recheckRelease,
  captureSource,
  reviewedProfile,
} from "./compatibility.js";
import { NetworkPolicy } from "./network.js";

const help = `Ente desktop validator (Node 24+)

  inventory --release <URL|tag> [--out reports/inventory]
  matrix [--release v1.7.28]
  prepare --release <URL|tag> [--baseline v1.7.27] [--out reports/plan]
  run --release <URL|tag> --scenario <id> --disposable [--baseline <tag>] [--out <dir>]
  run --plan <plan.json> --scenario <id> --disposable [--unavailable <reason>] [--out <dir>]
  inspect --release <tag> --combination <platform-arch-format> --root <installed-root> [--out <dir>]
  aggregate --plan <plan.json> --reports <directory> [--out <dir>]
  dispatch --host <owner/repo> --release <URL|tag> [--baseline <tag>] [--scenario <id,id,...>] [--watch]
  watch --host <owner/repo> --run-id <id>
  network-restore --out <scenario-directory>

All installation and firewall operations require a fresh disposable native machine.
inventory, matrix and inspect do not install or launch Ente. No command publishes Ente releases.
Nightly defaults use the archived 2026-09-08 nightly; stable defaults use the preceding stable.
Use GH_TOKEN for draft-release reads; BASELINE_READ_TOKEN optionally reads the private baseline archive.
Dispatch/watch use the authenticated gh CLI.
`;

async function runCLI(argv) {
  const { positionals, values: opts } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: Object.fromEntries([
      ...[
        "release",
        "baseline",
        "scenario",
        "combination",
        "root",
        "out",
        "plan",
        "reports",
        "host",
        "run-id",
        "unavailable",
      ].map((name) => [name, { type: "string" }]),
      ...["help", "disposable", "watch"].map((name) => [
        name,
        { type: "boolean", default: false },
      ]),
    ]),
  });
  const action = positionals[0];
  if (opts.help || !action) {
    console.log(help);
    return 0;
  }
  if (positionals.length > 1)
    throw new Error("Unexpected positional arguments");
  const directory = path.resolve(opts.out ?? `reports/${Date.now()}`);
  if (action === "matrix") {
    console.log(
      JSON.stringify(matrix(releaseRef(opts.release ?? "v1.7.28")), null, 2),
    );
    return 0;
  }
  if (action === "network-restore") {
    console.log(
      await new NetworkPolicy(path.join(directory, "network")).restore(),
    );
    return 0;
  }
  if (action === "inventory") {
    const release = await getRelease(releaseRef(opts.release));
    const result = {
      schemaVersion: 2,
      kind: "inventory",
      tag: release.tag_name,
      release,
      ...inventory(release),
      runtimeTested: false,
    };
    await writeJSON(path.join(directory, "inventory.json"), result);
    console.log(
      `${result.packages} packages, ${result.combinations} combinations, ${result.scenarios} scenarios; runtime not tested.\n${directory}`,
    );
    return 0;
  }
  if (action === "prepare") {
    const plan = await prepareReport(
      releaseRef(opts.release),
      opts.baseline,
      directory,
    );
    await writeJSON(path.join(directory, "plan.json"), plan);
    console.log(path.join(directory, "plan.json"));
    return 0;
  }
  if (action === "inspect") {
    if (!opts.root || !opts.combination)
      throw new Error("--root and --combination are required");
    const tag = releaseRef(opts.release),
      scenario = combinations(tag).find((s) => s.key === opts.combination);
    if (!scenario) throw new Error("Unknown combination");
    const report = {
      schemaVersion: 2,
      kind: "static-inspection",
      release: releaseDescriptor(tag),
      checks: [],
      runtimeTested: false,
    };
    await check(report, "installed-files", async () => {
      const root = path.resolve(opts.root),
        profile = await loadProfile(tag);
      if (releaseDescriptor(tag).channel === "nightly") {
        const release = await getRelease(tag);
        release.source = await captureSource(release);
        Object.assign(profile, await reviewedProfile(release));
        report.release = release;
      }
      await writeJSON(
        path.join(directory, "installed-files.json"),
        await fileInventory(root),
      );
      return inspectInstalled(root, scenario, profile, tag);
    });
    report.status = overall(report.checks);
    await saveReport(report, directory);
    console.log(
      `${report.status}: static inspection only; installation and runtime not tested.\n${directory}`,
    );
    return report.status === "passed" ? 0 : 1;
  }
  if (action === "run") {
    if (!opts.scenario)
      throw new Error("--scenario is required; use matrix to list IDs");
    const plan = opts.plan
      ? await json(opts.plan)
      : await prepareReport(releaseRef(opts.release), opts.baseline, directory);
    const report = await runScenario(plan, opts.scenario, directory, {
      disposable: opts.disposable,
      unavailable: opts.unavailable,
    });
    console.log(`${report.status}: ${report.scenario.id}\n${directory}`);
    return report.status === "passed" ? 0 : 1;
  }
  if (action === "aggregate") {
    if (!opts.plan || !opts.reports)
      throw new Error("--plan and --reports are required");
    const plan = await json(opts.plan);
    assertPlan(plan);
    const report = aggregate(plan, await collectReports(opts.reports));
    try {
      await recheckRelease(plan.release);
      await recheckRelease(plan.baseline);
    } catch (error) {
      report.status = "failed";
      report.fullCoverage = false;
      report.releaseIdentityError = error.message;
    }
    await saveReport(report, directory);
    if (process.env.GITHUB_STEP_SUMMARY)
      await fs.appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `${markdown(report)}\n${report.releaseIdentityError ?? ""}\n`,
      );
    console.log(
      `${report.status}: ${report.scenarios.filter((s) => s.status === "passed").length}/${report.expectedScenarios} passed\n${directory}`,
    );
    return report.status === "passed" ? 0 : 1;
  }
  if (["dispatch", "watch"].includes(action)) {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(opts.host ?? "") ||
      /^(ente|ente-io)\//i.test(opts.host)
    )
      throw new Error(
        "--host must be the separate validator repository, not an Ente repository",
      );
    let id = opts["run-id"];
    if (action === "dispatch") {
      const request = randomUUID();
      const args = [
        "workflow",
        "run",
        "validate.yml",
        "--repo",
        opts.host,
        "-f",
        `release=${releaseRef(opts.release)}`,
        "-f",
        `request_id=${request}`,
      ];
      if (opts.baseline)
        args.push("-f", `baseline=${releaseRef(opts.baseline)}`);
      if (opts.scenario) args.push("-f", `scenarios=${opts.scenario}`);
      await command("gh", args);
      for (let n = 0; n < 24 && !id; n++) {
        await sleep(2500);
        const response = await command("gh", [
          "run",
          "list",
          "--repo",
          opts.host,
          "--workflow",
          "validate.yml",
          "--limit",
          "30",
          "--json",
          "databaseId,displayTitle",
        ]);
        id = JSON.parse(response.stdout).find((run) =>
          run.displayTitle.includes(request),
        )?.databaseId;
      }
      if (!id)
        throw new Error(
          `Dispatched request ${request}, but could not resolve its run ID; inspect the standalone repository's Actions page`,
        );
      console.log(`https://github.com/${opts.host}/actions/runs/${id}`);
      if (!opts.watch) return 0;
    }
    if (!/^\d+$/.test(String(id ?? "")))
      throw new Error("--run-id is required");
    const child = await import("node:child_process");
    return new Promise((resolve) => {
      const process = child.spawn(
        "gh",
        [
          "run",
          "watch",
          String(id),
          "--repo",
          opts.host,
          "--exit-status",
          "--interval",
          "15",
        ],
        { stdio: "inherit" },
      );
      process.on("close", (code) => resolve(code ?? 1));
      process.on("error", () => resolve(1));
    });
  }
  throw new Error(`Unknown command ${action}\n${help}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCLI(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
export { runCLI };
