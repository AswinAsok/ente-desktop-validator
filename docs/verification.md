# Implementation verification

Verified on 2026-09-08. These results distinguish validator tests and archive inspection from native installation/runtime coverage.

## Completed

- **17 cross-platform regression tests passed**, with an additional Windows-native cleanup regression run on Windows using Node's test runner. These include synthetic successful installations with a missing executable, missing ONNX Runtime, corrupted downloads/models, invalid inference, worker failure propagation, stale reports, unavailable runners, and incomplete coverage.
- JavaScript syntax and workflow YAML checks passed.
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

The validator's binary-header parser and the host `file` utility independently identified that mismatch. No Linux execution was performed, and no Ente files were repaired or changed.

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
- **8 Fedora/Arch scenarios were blocked** because no dedicated runner-discovery credential/fleet was provided. They could not produce an overall pass.

Passing ML evidence includes one human face from `astronaut.png`, one pet face and one pet body from `dog.jpg`, finite embeddings with the required dimensions, a 512-element text embedding, and correct sizes/SHA-256 hashes for all 11 model files. The repeated inference ran after restarting the installed application with machine-level external traffic blocked. macOS used CoreML; Linux x64 used CPU. Upgrade reports confirmed the seeded dark preference and profile marker survived.

Windows verification is being completed in the [Windows rerun](https://github.com/AswinAsok/ente-desktop-validator/actions/runs/34249196856). Earlier iterations caught validator-specific ASAR path, Schannel probe, and already-stopped process handling issues; those have been corrected. The final Windows outcome must be read from its report, not inferred from those earlier harness failures.

## Acceptance limits

A **healthy release passing all 32 scenarios has not been demonstrated**. v1.7.28 has a verified ARM64 resource mismatch, its chosen AppImage baseline has an observed startup incompatibility on the test OS, and dedicated Fedora/Arch runners are unavailable.

Missing executable/native resource, blocked download, corrupted model, worker crash, and invalid inference regressions are exercised with synthetic fixtures in the unit suite. These tests validate failure detection and propagation; they are not claims of six destructive fault-injection runs against the real installed Ente application. The synthetic all-32-pass case tests aggregation only.

Different validator revisions are not merged into a fabricated passing aggregate. A complete release assessment requires a new full-matrix run with one revision and all required runners. Native artifacts remain downloadable from the linked Actions runs for their configured retention period.
