# Implementation verification

Verified on 2026-09-08. These results distinguish validator tests and archive inspection from native installation/runtime coverage.

## Completed

- **16 regression tests passed** using Node's test runner. These include synthetic successful installations with a missing executable, missing ONNX Runtime, corrupted downloads/models, invalid inference, worker failure propagation, stale reports, unavailable runners, and incomplete coverage.
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

## Not completed on native machines

The repository has not yet been pushed to a chosen GitHub destination, and disposable Windows/Linux/macOS test machines were not attached to this local workspace. Therefore these remain **unverified**:

- Actual installer execution, native OS signature/Gatekeeper checks, and desktop screenshots.
- External Playwright attachment to the signed release applications on each platform.
- Live model downloads and inference through the installed worker, including the positive dog-fixture assertion.
- Actual OS firewall enforcement/restoration, offline native inference, and fresh/upgrade profile behavior.
- A healthy release passing all 32 native scenarios.

The unit suite's synthetic all-32-pass aggregation case only verifies the report logic. It is not a claim that 32 installations ran. Native runner setup and execution are required before relying on this tool as a release gate.
