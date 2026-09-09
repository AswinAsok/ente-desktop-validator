# Compatibility profile v1

`profiles/1.7.28.json` records the required models and external ML worker adapter for the v1.7.28 release. Its source contract is pinned to:

https://github.com/ente/ente/tree/bfa1572cb7f400fb28209f40f34b3c8debb73ed3

- `desktop/electron-builder.yml`: package matrix, native-resource staging and universal macOS packaging.
- `desktop/src/main/services/ml-native.ts`: platform-specific native addon and ONNX Runtime paths.
- `desktop/src/main/services/ml-worker.ts`: the existing Comlink methods, initialization and model downloads.
- `rust/crates/ml/src/assets.rs`: 11 model/vocabulary files, storage keys, sizes and SHA-256 hashes.
- `rust/bindings/napi/photos/src/lib.rs`: inference result fields and execution-provider reporting.

The installed macOS ZIP was also inspected to verify the actual ASAR and resource paths. Required platform paths remain independent of the observed file inventory so an omitted executable cannot disappear from the expectations.

## Test inputs

Fixtures are downloaded before network isolation, with pinned URLs, hashes and sizes:

- Human face: `astronaut.png` from `ente/test-fixtures` commit `13c7cf83717140be20b32e6fbb178d5f15ea09ea`. This is the NASA astronaut image used by Ente's indexing fixture set.
- Pet: `images/dog.jpg` from `pytorch/hub` commit `c7895df70c7767403e36f82786d6b611b7984557`, used by its image-classification example.

Image files are fetched from their original repositories and are not redistributed here. The profile pins are independent of Ente's model downloads. Only the installed Ente worker downloads the ML models.

## External runtime contract

The harness loads the installed executable with Playwright, observes the main process's version/architecture/profile path, then connects through the existing preload method `triggerCreateUtilityProcess('ml')`. It receives `utilityProcessPort/ml` and uses Comlink 4.4.2, matching the released dependency.

It calls `analyzeImage` with faces, CLIP and pets enabled, and `computeCLIPTextEmbeddingIfAvailable` until the text model is ready. It checks known-face/known-pet detection, finite nonzero embeddings, expected dimensions, and provider fields. Empty detections on the positive fixtures are failures; empty pet detections on the astronaut image are permitted. CPU fallback is recorded rather than rejected.

Playwright's experimental Electron API needs a usable inspection interface. Launch incompatibility or a missing bridge is `unsupported`; an inference exception, download failure, or a worker that never responds is `failed`. The harness never rewrites Electron fuses or application files to enable instrumentation.

## Adding a release

1. Resolve the exact Ente source commit associated with the release, independently of the release-only repository's `main` commit.
2. Review build configuration, model catalog, binary paths, worker protocol, native result types, and fixture expectations.
3. Add an exact-version profile with verified pins. Do not copy a profile to a new version without reviewing these contracts.
4. If the bridge changed, implement the smallest corresponding adapter in this repository. Unsupported versions/interfaces must not fall through to the old adapter.
5. Run the validator's regression tests and the full native matrix against a known-good candidate. Record any platform limitations.

The profile's version match prevents a newer release from receiving a misleading pass using stale expectations. Future Ente-owned diagnostics could replace the external adapter while preserving the scenario/report contracts.

## Windows ARM64 helper architecture

The 1.7.28 profile expects the separately executed FFmpeg helper to be x64 on Windows ARM64. The shipped file is x64, [ffmpeg-static publishes Windows x86/x64 binaries](https://github.com/eugeneware/ffmpeg-static), and [Windows 11 supports x64 application emulation](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation). The helper must still execute successfully in `media-tools`; presence alone cannot pass it. The Ente executable, native addon, ONNX Runtime, and VIPS still require native ARM64. Linux ARM64 has no such exception.

## Nightly profile and source reuse

`1.7.29-beta.json` was reviewed against `ente/ente` commit `2ffa837dab0540fd46c8863714ef944498e3b1d5`. The worker/preload interface, packaged native paths, ORT version and all 11 model sizes/hashes match the existing harness. The Rust model download now also checks sizes, and face/pet detection implementation changed; this is a separately reviewed profile, not an automatic copy justified by its version.

The contract hashes Git tree entries under `desktop/`, `web/` and `rust/`, plus the desktop publishing workflow and version/release-note scripts. It includes dependency locks, build scripts, native resources and worker contracts, including additions/removals and file modes. Markdown and desktop changes/docs are excluded. Only the root application version in desktop package.json and package-lock.json (including its root package entry) is normalized. This conservative scope can require review for unrelated web/Rust changes; it cannot silently skip changed dependencies. A truncated tree is blocked.

Nightly preparation resolves the Ente source tag, finds exactly one successful publishing attempt covering every asset's creation/update times, requires all three platform builds and finish-build to succeed, and reads the actual checkout hash in finish-build logs. It does not trust the workflow event head or the release repository's `main`. Any active desktop publishing run causes preparation to block. The search is limited to the latest 100 upstream workflow runs; missing historical evidence is blocked. A future changed upstream workflow requires a review of this evidence contract.

Candidate and baseline assets and source tags are rechecked after execution. Saved plans carry the reviewed profile and its digest, preventing a changed local profile from silently altering a planned run. New report schema v2 includes those identities. Missing credentials or expired upstream logs produce blocked results, never a pass.

A runtime interface mismatch discovered after installation retains installation evidence and marks ML unsupported. A profile unsupported during preparation produces one preparation report and skips native jobs. Failed baseline installation/launch is explicitly attributed to baseline checks; fresh candidate scenarios continue independently.

The upgrade fixture uses `hideDockIcon: false`, a native user preference present in v1.7.27, v1.7.28 and the reviewed nightly, plus an independent profile marker. It reads back the seed and reports expected/actual values after upgrading. The former native `themeMode` fixture was invalid for v1.7.28: that version did not declare it, and the nightly correctly synchronizes the native value from the renderer's theme.

## Default nightly baseline: 2026-09-08

`baselines/nightly.json` pins all 12 installers from source `2ffa837dab0540fd46c8863714ef944498e3b1d5`. They are stored unchanged in the standalone repository’s dated baseline release. Downloads still verify the original Ente SHA-256 and size. Preparation and finalization verify the archive IDs and hashes; moving the original upstream nightly tag is expected and does not invalidate this frozen baseline. A deleted or changed archive blocks the run. Explicit baseline inputs continue to resolve the requested live release.

The identical build can be selected as both candidate and baseline to test reinstallation and profile preservation. A later build under the same rolling tag/version can also be tested against this snapshot; Linux DEB/RPM installations explicitly reinstall same-version candidates. Stable candidates retain their preceding-stable default. Historical validation reports continue to describe the baselines actually used in those runs.

## September 9 nightly review

`profiles/1.7.29-beta-2026-09-09.json` reviews source commit
`af9ac44f3bd6e1e33af385d0347661c648fd6337`, with contract SHA-256
`7c08001aec563066175aad3c00099f9502d838870ceb4e9da89a2df892a78a02`.
The original September 8 profile remains available, and the default archived
baseline still points to that September 8 build.

The [source comparison](https://github.com/ente/ente/compare/2ffa837dab0540fd46c8863714ef944498e3b1d5...af9ac44f3bd6e1e33af385d0347661c648fd6337)
contains 72 commits and 238 changed files. The conservative fingerprint changed
because it covers web and Rust changes as well as desktop contracts. Review found:

- The entire `desktop/` tree is identical (`e72d5cb79242c2ddcd50080a59cca556d1ff0fe5`), including package locks, Electron Builder configuration, resource staging, preload, workers and ORT download configuration. The desktop publishing workflow is also identical (`3269ff8597a2de8a33d8b262fcbc740024ac019a`).
- The renderer ML service tree is identical (`5c2705581f43683429b131100bd291db45047fc5`). The NAPI implementation is identical (`87bdec5d29ecf8b04a1a16ad4785f2ae75968a59`), so the existing Comlink adapter and output contracts remain applicable.
- The model catalog is identical (`faf35f4c7dd1ae1ac75b6e74f0eb53dc3b7c2038`). All 11 model sizes/hashes and fixture expectations remain unchanged. The asset downloader source is unchanged; its Cargo manifest now inherits workspace edition/lint settings.
- Rust ML changes make OCR CPU-only, remove its unused accelerated execution mode, and adjust lint attributes and conditional mutability. The face, pet and CLIP processing contracts and their platform-default provider selection remain unchanged. OCR is outside the current inference coverage.
- Rust workspace/lock changes include new Photos SQLite database modules, rusqlite 0.40.2/libsqlite3-sys 0.38.2, and Locker/workspace refactoring. The Photos NAPI library depends on `ente-ml` and `ente-assets`, not the `ente-photos` database crate; its dependency declarations otherwise remain unchanged. SQLite uses the bundled workspace feature. These changes do not introduce a new required desktop model or resource path.
- Shared HTTP changes require successful responses before reading bodies; other web changes include authentication, gallery/album handling and unrelated app UI. These do not change the external ML bridge. Account migration remains outside this validator's coverage.

This is a separate reviewed contract, not an exception to fingerprint checking.
Unknown future digests still stop preparation. Source review permits testing the
installed binaries; it does not grant a runtime pass. The full matrix must still
check actual installation, resources, inference, model integrity, offline reuse
and upgrade preservation, and report any failures without weakening expectations.
