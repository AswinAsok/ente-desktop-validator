# Ente desktop release validator

An independent Node.js CLI and GitHub Actions project that tests **the installed release binaries**, including their native ML workers. It does not change Ente's source, installers, repositories, or workflows, and cannot promote a release.

The first compatibility profile targets **v1.7.28**, pinned to Ente source commit `bfa1572cb7f400fb28209f40f34b3c8debb73ed3`. New versions need a reviewed profile before they can receive full validation.

## Quick start

Requires Node.js 24 or newer. GitHub CLI is needed only for dispatching and watching remote runs.

```sh
npm ci --ignore-scripts
npm test
npm run check

# Read-only: fetch release inventory and show the native test matrix.
node src/cli.js inventory --release https://github.com/ente/photos-desktop/releases/tag/v1.7.28
node src/cli.js matrix --release v1.7.28

# Run all 32 scenarios in YOUR separate GitHub repository.
node src/cli.js dispatch --host YOUR-OWNER/ente-desktop-validator --release v1.7.28 --watch
```

An inventory success only confirms package coverage. It is **not** an installation or runtime result.

To inspect an already extracted/installed bundle without executing it:

```sh
node src/cli.js inspect --release v1.7.28 --combination darwin-arm64-zip \
  --root /path/to/ente.app --out reports/static
```

The result is explicitly marked `static-inspection`, with `runtimeTested: false`.

## Standalone GitHub setup

1. Push this repository to your own GitHub repository and enable Actions. Keep it separate from `ente/ente` and `ente/photos-desktop`.
2. Use **Validate Ente desktop release → Run workflow**, or the CLI command above. `release` accepts a tag or an Ente release URL. An empty `baseline` selects the numerically preceding stable version.
3. Public release assets require no additional secret. To read drafts, set **`ENTE_RELEASE_READ_TOKEN`** to a credential with read access to `ente/photos-desktop`.
4. For Fedora and Arch coverage, provision disposable runners as described in [docs/runners.md](docs/runners.md). Set **`RUNNER_DISCOVERY_TOKEN`** with permission to list runners in the standalone repository. This token is used only by the preparation job.

When dedicated-runner discovery is unavailable, their scenarios run as bookkeeping jobs on Ubuntu and report **blocked**. They are not silently omitted. An available runner that later goes offline can leave its job queued; cancel that run if necessary. Missing/cancelled reports become blocked in aggregation.

Each native scenario gets its own fresh hosted VM or single-job dedicated VM. There is no Ente/model cache between jobs. The workflow keeps logs and reports for 14 days. It never uploads downloaded installers, model weights, firewall backups, or application profiles.

## Coverage

| System  | Packages                         | Native coverage                                               |
| ------- | -------------------------------- | ------------------------------------------------------------- |
| Windows | x64 EXE, ARM64 EXE, combined EXE | Each specific installer on its architecture; combined on both |
| macOS   | Universal DMG and ZIP            | Both on Intel and Apple Silicon                               |
| Linux   | DEB, RPM, Pacman, AppImage       | Each on x64 and ARM64                                         |

These are 13 packages, 16 package/architecture combinations, and **32 fresh-install/upgrade scenarios**. Windows uses the default per-user installation under `%LOCALAPPDATA%\Programs\ente`, not an assumed Program Files location. Linux packages use native package managers; AppImages use their actual FUSE runtime. macOS bundles are copied into `/Applications`.

Checks include:

- GitHub asset hashes, missing/unrecognized packages, and asset replacement during the run.
- Installed executable architecture, Electron/ASAR/renderer/worker resources, native addons, ONNX Runtime, FFmpeg and image conversion tools.
- Windows executable/installer signatures and shortcut targets; macOS code-signature and Gatekeeper assessment.
- An ordinary uninstrumented launch with a desktop screenshot, followed by renderer and preload inspection with Playwright.
- Production ML processing of pinned human-face and dog fixtures; image/text embeddings and valid face/pet outputs.
- Downloaded model sizes and SHA-256 hashes, followed by another application launch and inference with OS-level network isolation.
- Upgrade preservation of a test preference and an unrelated profile marker.
- An unchanged hash inventory of the installed application after testing.

The ML harness uses the app's existing `window.electron.triggerCreateUtilityProcess('ml')` bridge and Comlink worker methods. Test-side JavaScript connects to that bridge in memory. It does not alter application files, bypass download errors, inject models, or substitute inference implementations. No Ente account is used.

## Run a scenario locally

**Only on a fresh disposable native VM or snapshot.** Installation changes OS package state; the firewall tests temporarily restrict the whole machine's egress. The CLI refuses a pre-existing Ente installation/profile. Do not set `--disposable` on a personal workstation.

```sh
# Example: Ubuntu 24.04 x64 with the documented runner dependencies installed.
xvfb-run -a node src/cli.js run --release v1.7.28 \
  --scenario linux-x64-deb-fresh --disposable --out reports/deb-fresh

# On a separate, freshly reset machine:
xvfb-run -a node src/cli.js run --release v1.7.28 --baseline v1.7.27 \
  --scenario linux-x64-deb-upgrade --disposable --out reports/deb-upgrade
```

Every scenario needs a new report directory. Upgrades install the baseline, launch it, seed `themeMode: dark` and a marker in the default test profile, install the candidate, and check that both survived. They test installer replacement, not the automatic updater's handoff or account migration.

The controller first downloads installers/fixtures and caches package-manager dependencies. It then applies OS egress rules: online tests allow the resolved model CDN IPs on HTTPS plus DNS and loopback; offline tests allow only loopback. Native `curl` probes verify enforcement. GitHub connectivity resumes when the firewall is restored, so live job logs may pause during inference.

Firewall state is restored in `finally` and again in an unconditional workflow step. For an interrupted local run:

```sh
node src/cli.js network-restore --out reports/deb-fresh
```

Always discard the VM after a scenario, including a failed or interrupted one. A disposable VM is the cleanup boundary; uninstalling alone can leave registry entries, models, caches, and package state behind.

## Reports and exit status

`report.json` and `summary.md` are written for each scenario. `artifacts/` contains installer logs, screenshots, inference outputs, and the installed-file inventory. `progress.json` records completed checks if the process is interrupted.

| Status        | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `passed`      | All required checks for the stated scope completed successfully        |
| `failed`      | A check failed, data was corrupt, or the app/worker crashed            |
| `blocked`     | A prerequisite, runner, credential, or report was unavailable          |
| `unsupported` | No reviewed compatibility profile or usable external runtime interface |

Scenario commands exit nonzero unless every required check passes. Aggregation requires all 32 reports with matching release fingerprints, baseline, scenario, and validator revision. It rejects missing checks, duplicate reports, contradictions, stale hashes, and unknown statuses. A single passing scenario or static inspection is never a full release approval.

```sh
node src/cli.js prepare --release v1.7.28 --out reports/plan
node src/cli.js aggregate --plan reports/plan/plan.json \
  --reports reports/scenarios --out reports/final
```

The machine-readable contract is [schemas/report.schema.json](schemas/report.schema.json). Reports identify their schema version, source compatibility profile, release/asset identities, native OS/architecture, and validator revision. They are local/Actions evidence, not cryptographically signed attestations.

## Compatibility and future integration

See [docs/compatibility.md](docs/compatibility.md) for the pinned source contract and how to add a version. Playwright's Electron support is experimental: a release with disabled inspection, a changed bridge, or incompatible worker methods must not be called fully tested. Installation evidence is preserved if runtime instrumentation fails.

The CLI and versioned JSON can later be called from Ente's release pipeline to enforce promotion, or an app-owned diagnostic interface could replace the external bridge. Neither integration exists in this version.

The validator does not claim exhaustive OS-version, GPU, account-migration, or updater coverage. Native CPU fallback is acceptable and the provider used is recorded. Network/CDN failure is a failed validation run, not proof of a packaging bug; logs distinguish it from missing files and runtime errors.

## Development validation

`npm test` exercises package coverage, missing-executable/native-resource failures, download and model corruption, worker failure propagation, inference result validation, profile matching, stale-result rejection, and incomplete-report aggregation. `npm run check` checks JavaScript syntax and workflow YAML. These checks do not substitute for the 32 native runs.

Read-only inspection of the downloaded v1.7.28 macOS ZIP can validate its installed-file contract without claiming an actual install or ML run. See [docs/verification.md](docs/verification.md) for the evidence collected during implementation.
