import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

for (const directory of ["src", "scripts", "test"]) {
  for (const file of await fs.readdir(directory))
    if (file.endsWith(".js"))
      execFileSync(process.execPath, ["--check", `${directory}/${file}`], {
        stdio: "inherit",
      });
}
for (const file of await fs.readdir(".github/workflows"))
  parse(await fs.readFile(`.github/workflows/${file}`, "utf8"));
console.log("JavaScript syntax and workflow YAML passed");
