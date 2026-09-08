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
