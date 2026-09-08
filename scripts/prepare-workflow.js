import fs from "node:fs/promises";
import { prepareReport } from "../src/run.js";
import { writeJSON } from "../src/common.js";
import { api } from "../src/github.js";

if (/^(ente|ente-io)\//i.test(process.env.GITHUB_REPOSITORY ?? ""))
  throw new Error(
    "Run this workflow only in the standalone validator repository",
  );
const plan = await prepareReport(
  process.env.RELEASE,
  process.env.BASELINE || undefined,
  "reports/plan",
);
const selected = process.env.SCENARIOS?.split(",")
  .map((id) => id.trim())
  .filter(Boolean);
if (selected?.some((id) => !plan.scenarios.some((s) => s.id === id)))
  throw new Error(
    "Unknown selected scenario; use the CLI matrix command to list IDs",
  );
plan.selectedScenarios = selected?.length
  ? [...new Set(selected)]
  : plan.scenarios.map((s) => s.id);
await writeJSON("reports/plan/plan.json", plan);
let runners, runnerError;
if (process.env.RUNNER_ADMIN_TOKEN) {
  try {
    runners = [];
    for (let page = 1; ; page++) {
      const batch = await api(
        `repos/${process.env.GITHUB_REPOSITORY}/actions/runners?per_page=100&page=${page}`,
        { token: process.env.RUNNER_ADMIN_TOKEN },
      );
      runners.push(...batch.runners);
      if (batch.runners.length < 100) break;
    }
  } catch (error) {
    runnerError = error.message;
  }
}
const include = plan.scenarios
  .filter((s) => plan.selectedScenarios.includes(s.id))
  .map((s) => {
    let reason = "";
    if (s.runner.includes("self-hosted")) {
      if (!runners)
        reason =
          runnerError ??
          "No runner-discovery credential configured; dedicated runner availability is unknown";
      else if (
        !runners.some(
          (r) =>
            r.status === "online" &&
            s.runner.every((label) =>
              r.labels.some(
                (l) => l.name.toLowerCase() === label.toLowerCase(),
              ),
            ),
        )
      )
        reason =
          "No online disposable runner matches this package and architecture";
    }
    return {
      id: s.id,
      runner: reason ? ["ubuntu-24.04"] : s.runner,
      unavailable: reason,
    };
  });
await fs.appendFile(
  process.env.GITHUB_OUTPUT,
  `matrix=${JSON.stringify({ include })}\n`,
);
