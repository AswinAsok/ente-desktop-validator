import fs from "node:fs/promises";
import { prepareReport } from "../src/run.js";
import { writeJSON } from "../src/common.js";

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
const include = plan.scenarios
  .filter((s) => plan.selectedScenarios.includes(s.id))
  .map((s) => ({ id: s.id, runner: s.runner, container: s.container ?? "" }));
await fs.appendFile(
  process.env.GITHUB_OUTPUT,
  `matrix=${JSON.stringify({ include })}\n`,
);
