# Implementation verification

Verified on 2026-09-08. These results distinguish validator tests and archive inspection from native installation/runtime coverage.

## Completed

- **18 cross-platform regression tests passed**, with an additional Windows-native cleanup regression run on Windows using Node's test runner. These include synthetic successful installations with a missing executable, missing ONNX Runtime, corrupted downloads/models, invalid inference, worker failure propagation, stale reports, unavailable runners, and incomplete coverage.
- [Hosted regression CI](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34250504076) passed on Windows, macOS, and Linux. JavaScript syntax and workflow YAML checks passed.
- **actionlint v1.7.12 passed** on both standalone workflows (shellcheck integration disabled because shellcheck was not installed).
- The live GitHub inventory command found **13 packages, 16 combinations, 32 scenarios** for v1.7.28. Automatic baseline selection resolved **v1.7.27**.
- A deliberately unavailable Windows ARM64 scenario returned **blocked** and exit code 1 without installing anything. Aggregation with no native reports returned **blocked: 0/32 passed**, also with exit code 1.
- The v1.7.28 macOS universal ZIP passed the static required-file contract, including both CPU architectures, native addons, ONNX Runtime, renderer/worker files, and FFmpeg. This was read-only inspection of an extracted archive, not an installation.

## Real mismatch detected in Linux ARM64 packaging

The v1.7.28 ARM64 DEB **failed** static validation because its bundled FFmpeg is x86-64:

```text
opt/ente/ente
  ELF 64-bit, ARM aarch64

opt/ente/resources/vips
  ELF 64-bit, ARM aarch64

opt/ente/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg
  ELF 64-bit, x86-64

Validator: expected arm64, found x64
```

The validator's binary-header parser and the host `file` utility independently identified that mismatch. That initial archive inspection did not execute Linux binaries. Subsequent native results are recorded below. No Ente files were repaired or changed.

The downloaded archives were verified against GitHub's release-asset SHA-256 digests:

| Release asset               | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `ente-1.7.28-arm64.deb`     | `7d3d01a4459a2aecbed624c46053820605019a813057e7cce69a5b974da22b46` |
| `ente-1.7.28-universal.zip` | `18bbae631ad83303d7b559be8520d700924328c01f3fde2cbdc9186560c8ebc7` |

Source: [v1.7.28 release](https://github.com/ente/photos-desktop/releases/tag/v1.7.28).

## Hosted native evidence

The standalone private repository is [AswinAsok/ente-desktop-validator](https://github.com/AswinAsok/ente-desktop-validator). All workflow dispatches and code changes belong to that repository. Ente repositories remained unchanged.

The [full native run](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34248380709) completed all 32 scenario jobs. Its aggregate correctly reported **failed**, with 9 passed, 15 failed, and 8 blocked scenarios. Some failures were validator defects corrected in subsequent commits; this run is development evidence, not a release-readiness endorsement.

- **All 8 macOS scenarios passed**: universal DMG and ZIP, fresh and upgrade, on Intel and Apple Silicon. Checks included signatures/Gatekeeper, normal launch/screenshots, installed-file hashes, external preload/worker instrumentation, production ML downloads/inference, model integrity, and offline reuse.
- **Linux x64 AppImage fresh install passed** the same applicable runtime and ML checks.
- The [targeted Debian rerun](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34248824827) confirmed **x64 DEB fresh and upgrade both passed**, after correcting APT's handling of a local package under network isolation.
- The native ARM64 DEB fresh and upgrade scenarios, and ARM64 AppImage fresh scenario, reproduced the **x86-64 FFmpeg mismatch** described above.
- Both AppImage upgrade scenarios failed to launch the **v1.7.27 baseline** on hosted Ubuntu 24.04: Chromium reported an unusable SUID sandbox helper. The validator did not disable the sandbox or patch the AppImage. This is a baseline/OS compatibility failure; it is not evidence that v1.7.28 itself fails to start.
- **8 Fedora/Arch scenarios were blocked** because no dedicated runner-discovery credential/fleet was provided. Leaving these blocked with setup instructions was explicitly accepted for this version. They could not produce an overall pass.

Passing ML evidence includes one human face from `astronaut.png`, one pet face and one pet body from `dog.jpg`, finite embeddings with the required dimensions, a 512-element text embedding, and correct sizes/SHA-256 hashes for all 11 model files. The repeated inference ran after restarting the installed application with machine-level external traffic blocked. macOS used CoreML; Linux x64 used CPU. Upgrade reports confirmed the seeded dark preference and profile marker survived.

The [Windows rerun](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34249196856) reproduced an actual ARM64 installer defect: installation returned success, but `ente.exe`, `resources/onnxruntime/arm64/onnxruntime.dll`, `resources/vips.exe`, and Electron DLLs were absent. The installed-file inventory is preserved in that scenario artifact. This directly demonstrates that a successful installer exit cannot pass a broken installation.

The final [full-matrix run](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34249820246) tested validator revision `eda2556`, including the Windows firewall/control-connection fixes. Its aggregate is **failed: 13 passed, 10 failed, 9 blocked**; `fullCoverage` is false.

| Outcome                                  | Scenarios                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passed                                   | 7 macOS scenarios; Windows x64 standalone fresh/upgrade and combined upgrade; Linux x64 DEB fresh/upgrade and AppImage fresh                               |
| Failed: missing installed files          | All 4 Windows ARM64 scenarios, including combined installer and upgrades                                                                                   |
| Failed: wrong FFmpeg architecture        | Linux ARM64 DEB fresh/upgrade and AppImage fresh                                                                                                           |
| Failed: baseline startup                 | Both AppImage upgrade scenarios on Ubuntu 24.04                                                                                                            |
| Failed: incomplete identity verification | macOS Intel ZIP upgrade finished its app/ML checks but the final GitHub request failed                                                                     |
| Blocked: unavailable machines            | 8 Fedora/Arch scenarios, as explicitly accepted for this version                                                                                           |
| Blocked: missing uploaded report         | Windows x64 combined fresh completed online/offline inference, but GitHub rejected artifact finalization with HTTP 403; no complete report was retrievable |

The latest code adds bounded retries for transient read-only GitHub transport failures and writes per-scenario job summaries before artifact upload. HTTP permission errors are not retried. The [targeted combined-installer rerun](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34250504523) passed both Windows x64 combined fresh and upgrade scenarios using revision `060bd78`. Its aggregate remains blocked because the other 30 scenarios were deliberately not selected. These passing results are preserved separately from the older full-matrix report. Earlier iterations also caught validator-specific ASAR path, Schannel probe, local APT acquisition, and already-stopped process handling issues; those were corrected before the full run.

## Acceptance limits

A **healthy release passing all 32 scenarios has not been demonstrated**. v1.7.28 has verified Windows ARM64 missing executable/resources and Linux ARM64 FFmpeg defects, its chosen AppImage baseline has an observed startup incompatibility on the test OS, and dedicated Fedora/Arch runners are unavailable.

Missing executable/native resource, blocked download, corrupted model, worker crash, and invalid inference regressions are exercised with synthetic fixtures in the unit suite. These tests validate failure detection and propagation; they are not claims of six destructive fault-injection runs against the real installed Ente application. The synthetic all-32-pass case tests aggregation only.

Different validator revisions are not merged into a fabricated passing aggregate. A complete release assessment requires a new full-matrix run with one revision and all required runners. Native artifacts remain downloadable from the linked Actions runs for their configured retention period.

## Nightly support: v1.7.29-beta

The [completed nightly run](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34255409857) tested validator revision `4d497b8`, source commit `2ffa837dab0540fd46c8863714ef944498e3b1d5`, and stable upgrade baseline v1.7.28. It completed all 20 hosted scenarios and recorded the eight unavailable dedicated-runner scenarios. The aggregate is **failed: 12 passed, 7 failed, 9 blocked**, with `fullCoverage: false`. Candidate and baseline asset/source identity rechecks passed.

| Outcome | Evidence |
| --- | --- |
| 12 passed | All four Windows fresh cases; both Windows x64 upgrades; all four macOS DMG cases; Linux x64 DEB fresh and upgrade |
| 4 failed: candidate files | Linux ARM64 DEB and AppImage, fresh and upgrade, package x64 FFmpeg instead of ARM64 |
| 2 failed: baseline | Windows ARM64 upgrade cases cannot launch v1.7.28 because its installed `ente.exe` is missing |
| 1 failed: baseline runtime | Linux x64 AppImage upgrade encountered IndexedDB backing-store errors while launching v1.7.28 |
| 1 blocked: instrumentation | Linux x64 AppImage fresh passed normal launch/files, but the external Electron launch lost its X display connection and timed out; ML is unsupported in that scenario |
| 8 blocked: machines | Fedora/Arch runners are unavailable, as agreed |

Every passing scenario includes production online inference, all 11 model sizes/SHA-256 hashes, restart plus offline inference, and installed-file/asset identity checks. Passing upgrades also preserve the seeded native preference and marker. The downloaded 28 scenario reports independently reproduce the hosted aggregate. AppImage display/IndexedDB errors are observed runtime or test-environment failures; they are not established package defects. An earlier fresh AppImage pass is retained only as diagnostic evidence, not substituted into this final run.

The [initial nightly run](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34254860675), revision `6cb80ff`, reported 8 passed, 12 failed and 8 blocked. It exposed a validator fixture defect: `themeMode` was not a supported native preference in the baseline, and the nightly overwrote it with the renderer theme. Revision `4d497b8` uses the real `hideDockIcon: false` preference and verifies its stored value before and after upgrading. No application files or inference functions were modified.

The [native stable upgrade regression](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34255485628) passed Linux x64 DEB v1.7.27 → v1.7.28 using the corrected fixture. Its aggregate is intentionally blocked because the other 31 stable scenarios were not selected.

The [unsupported v1.7.27 target check](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34254909415) uploaded one explanatory preparation report and skipped all native jobs. The [cross-platform validator CI](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34255409105) passed on Windows, macOS and Linux: 30 portable tests plus the Windows-only cleanup check. JavaScript/workflow syntax and actionlint v1.7.12 also passed. Synthetic failure tests are isolated from the real Actions job summary.

No healthy full nightly release approval is claimed. No Ente source, repository, packaged application or workflow was changed, and no scheduled workflow was added.

## Preserved baseline requested on 2026-09-08

All 12 installers from today’s v1.7.29-beta build (2,154,095,035 bytes total) were downloaded and SHA-256 verified, then archived unchanged in the private standalone repository’s [dated baseline release](https://github.com/AswinAsok/ente-desktop-validator/releases/tag/baseline-photos-desktop-2026-09-08). GitHub’s archived asset sizes and SHA-256 digests exactly match the original release. `baselines/nightly.json` records both original and archive asset identities plus the original source commit.

Future nightly runs use this fixed baseline by default; explicit baselines override it, and stable defaults remain preceding stable. Same-build comparisons are blocked; rebuilt rolling tags with the same version are supported, with explicit Linux package reinstallation. A moved upstream tag no longer changes or invalidates the archived baseline; changing/deleting archive assets blocks validation. The 35 passing local regressions include pin selection, archive integrity, archive downloads, build distinction and native package-manager argument checks (one Windows-only check is skipped locally). These checks do not claim a native upgrade to a future build that has not been published yet.
