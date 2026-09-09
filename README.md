# Ente desktop release validator

An independent Node.js CLI and GitHub Actions project that tests **the installed release binaries**, including their native ML workers. It does not change Ente's source, installers, repositories, or workflows, and cannot promote a release.

The standalone project is available at [AswinAsok/ente-desktop-validator](https://github.com/AswinAsok/ente-desktop-validator). Native verification evidence and remaining coverage gaps are recorded in [docs/verification.md](docs/verification.md).

Reviewed profiles cover stable **v1.7.28** and nightly **photos-desktop-v1.7.29-beta**. Nightly reuse requires matching source contracts; a version label alone never grants compatibility. Unsupported targets stop during preparation with an explanatory report, before native jobs start. v1.7.27 remains supported only as an upgrade baseline.

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

For the nightly release (the pasted fragment URL also works):

```sh
node src/cli.js dispatch --host YOUR-OWNER/ente-desktop-validator \
  --release 'https://github.com/ente/nightly/releases#release-photos-desktop-v1.7.29-beta' --baseline v1.7.28 --watch
```

Future nightly upgrades default to the **2026-09-08 nightly snapshot** (`1.7.29-beta`, source `2ffa837d`). All 12 original installers are preserved in the private standalone repository, so an upstream tag replacement cannot change the baseline. The same build may be used as both candidate and baseline. In that case, upgrade scenarios test reinstalling that build and preserving its profile; fresh scenarios still test a clean installation. Use `--baseline v1.7.28` to test upgrading from the stable release instead. Preparation records the candidate source commit and successful publication evidence. Archived baselines preserve their original commit and validate the stored asset IDs, sizes and hashes. A partially published nightly, moving source tag, changed asset, unavailable build log, or unknown source contract cannot pass. No scheduled workflow is added.

For a targeted remote rerun, add `--scenario linux-x64-deb-fresh,linux-x64-deb-upgrade`. The manual workflow exposes the same `scenarios` input. Omitted scenarios remain missing in the channel-specific aggregate, so a targeted run cannot grant full release coverage.

An inventory success only confirms package coverage. It is **not** an installation or runtime result.

To inspect an already extracted/installed bundle without executing it:

```sh
node src/cli.js inspect --release v1.7.28 --combination darwin-arm64-zip \
  --root /path/to/ente.app --out reports/static
```

The result is explicitly marked `static-inspection`, with `runtimeTested: false`.

## Standalone GitHub setup

1. Push this repository to your own GitHub repository and enable Actions. Keep it separate from `ente/ente` and `ente/photos-desktop`.
2. Use **Validate Ente desktop release → Run workflow**, or the CLI command above. `release` accepts a tag or an Ente release URL. An empty `baseline` selects the archived 2026-09-08 snapshot for nightly candidates and the preceding stable version for stable candidates. An explicit baseline accepts either repository’s release URL.
3. Public release assets require no additional secret. To read drafts, set **`ENTE_RELEASE_READ_TOKEN`** to a credential with read access to `ente/photos-desktop`.
4. Fedora and Arch scenarios run automatically in disposable containers on native x64/ARM64 GitHub-hosted Ubuntu machines. No local machines or runner-discovery secret are needed. See [docs/runners.md](docs/runners.md) for setup, billing and coverage scope.

Container setup or isolation failures are reported as blocked/failed; they are never silently omitted. Missing/cancelled reports become blocked in aggregation. Containers validate Fedora/Arch userspace on Ubuntu kernels, not full distribution VMs.

Each scenario gets a fresh hosted VM, with its own disposable container for Fedora/Arch. There is no Ente/model cache between jobs. The workflow keeps logs and reports for 14 days. It never uploads downloaded installers, model weights, firewall backups, or application profiles.

## Coverage

| System  | Packages                         | Native coverage                                               |
| ------- | -------------------------------- | ------------------------------------------------------------- |
| Windows | x64 EXE, ARM64 EXE, combined EXE | Each specific installer on its architecture; combined on both |
| macOS   | Universal DMG and ZIP            | Both on Intel and Apple Silicon                               |
| Linux   | DEB, RPM, Pacman, AppImage       | Each on x64 and ARM64                                         |

Stable releases require 13 packages, 16 package/architecture combinations, and **32 fresh-install/upgrade scenarios**. The reviewed nightly publishing workflow intentionally omits macOS ZIP: nightly coverage is **12 packages, 14 combinations, and 28 scenarios**. Eight Fedora/Arch scenarios use disposable native-architecture containers on Ubuntu kernels. Reports explicitly distinguish this userspace coverage from direct-machine checks. Windows uses the default per-user installation under `%LOCALAPPDATA%\Programs\ente`, not an assumed Program Files location. Linux packages use native package managers; AppImages use their actual FUSE runtime. macOS bundles are copied into `/Applications`.

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

Every scenario needs a new report directory. Upgrades install the baseline, launch it, seed the supported native preference `hideDockIcon: false` and a marker in the default test profile, install the candidate, and check that both survived. They test installer replacement, not the automatic updater's handoff or account migration.

The controller first downloads installers/fixtures and caches package-manager dependencies. It then applies OS egress rules: online tests allow the resolved model CDN IPs on HTTPS plus DNS and loopback; offline tests allow only loopback. Native `curl` probes verify enforcement. On hosted Windows, only the running GitHub Actions control executables retain HTTPS access so isolation does not cancel the job; their paths are reported. Ente, its native workers, and the probe process receive no such exception. GitHub connectivity resumes when the firewall is restored, so live job logs may pause during inference.

Firewall state is restored in `finally` and again in an unconditional workflow step. For an interrupted local run:

```sh
node src/cli.js network-restore --out reports/deb-fresh
```

Always discard the VM after a scenario, including a failed or interrupted one. A disposable VM is the cleanup boundary; uninstalling alone can leave registry entries, models, caches, and package state behind.

## Reports and exit status

`report.json` and `summary.md` are written for each scenario. `artifacts/` contains installer and application logs, screenshots, inference outputs, and the installed-file inventory. `network/probes-*.json` records native firewall connectivity probes. `progress.json` records completed checks if the process is interrupted.

| Status        | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `passed`      | All required checks for the stated scope completed successfully        |
| `failed`      | A check failed, data was corrupt, or the app/worker crashed            |
| `blocked`     | A prerequisite, runner, credential, or report was unavailable          |
| `unsupported` | No reviewed compatibility profile or usable external runtime interface |

Scenario commands exit nonzero unless every required check passes. Aggregation requires all 32 stable or 28 nightly reports with matching release fingerprints, baseline, scenario, and validator revision. It rejects missing checks, duplicate reports, contradictions, stale hashes, and unknown statuses. A single passing scenario or static inspection is never a full release approval.

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

Plans and reports use schema **v2** with repository, channel, application version, source/profile identity and expected scenario count. Regenerate saved v1 plans; historical v1 reports remain readable as files but cannot be mixed into a v2 run.

The archived baseline is [baseline-photos-desktop-2026-09-08](https://github.com/AswinAsok/ente-desktop-validator/releases/tag/baseline-photos-desktop-2026-09-08), pinned by `baselines/nightly.json`. `BASELINE_READ_TOKEN` may be set for archive access; standalone Actions uses its own repository token independently of the Ente release-read credential. Same-version nightly rebuilds force DEB/RPM reinstallation so package managers cannot silently keep the baseline. Snapshot availability does not assert that the baseline is healthy.
