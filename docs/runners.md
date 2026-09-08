# Disposable test machines

Use GitHub-hosted machines for Windows x64/ARM64, macOS Intel/Apple Silicon, and Ubuntu x64/ARM64. Their exact labels are maintained in `src/matrix.js`.

The remaining jobs require these dedicated runner labels:

| Image                      | Architecture | Custom label            |
| -------------------------- | ------------ | ----------------------- |
| Fedora (supported release) | x64          | `ente-validator-fedora` |
| Fedora (supported release) | ARM64        | `ente-validator-fedora` |
| Arch Linux                 | x64          | `ente-validator-arch`   |
| Arch Linux ARM             | ARM64        | `ente-validator-arch`   |

Retain GitHub's default `self-hosted`, `Linux`, and `X64`/`ARM64` labels. The native architecture is checked at runtime; emulation is not accepted as native coverage.

## Image preparation

Create dedicated VM images with an ordinary login user, passwordless sudo, Git, curl, Node.js 24+, a current GitHub Actions runner, and a display usable by Xvfb. There must be no Ente installation or application profile. Pin the image/snapshot revision in your VM infrastructure.

Example package preparation **inside the disposable image**:

```sh
# Fedora
sudo dnf install -y git curl tar gzip xorg-x11-server-Xvfb xorg-x11-xauth \
  ImageMagick nftables fuse-libs nss atk at-spi2-atk gtk3 alsa-lib mesa-libgbm

# Arch Linux / Arch Linux ARM
sudo pacman -Syu --noconfirm
sudo pacman -S --needed --noconfirm git curl tar gzip xorg-server-xvfb xorg-xauth \
  imagemagick nftables fuse2 nss at-spi2-core gtk3 alsa-lib mesa
```

Install any remaining **declared package dependencies** through the native package manager; the validator caches them before enforcing model-only network access. Do not repair the candidate's missing packaged files. Run under a non-root user with `xvfb-run`, as the workflow does.

## Registration and lifecycle

Create a short-lived registration token for the **standalone validator repository**. In the prepared runner directory, register one job per VM:

```sh
./config.sh --url https://github.com/YOUR-OWNER/ente-desktop-validator \
  --token "$RUNNER_REGISTRATION_TOKEN" --ephemeral --unattended \
  --labels ente-validator-fedora
ENTE_VALIDATOR_EPHEMERAL=1 ./run.sh
```

Use `ente-validator-arch` for Arch images. Provision new VMs or revert a clean snapshot for subsequent jobs. `--ephemeral` unregisters the runner; **your VM supervisor must destroy/reset the machine after it exits**. Do not run a persistent VM repeatedly with a new runner registration and call it clean.

The preparation job uses `RUNNER_DISCOVERY_TOKEN` to verify that matching runners are online. It needs repository runner-list access (fine-grained repository Administration read permission). Without discovery access, dedicated scenarios are explicitly blocked. Start enough ephemeral runners for the desired concurrency, or let your infrastructure replenish them as jobs finish. Availability can change after discovery; queued jobs can be cancelled and their missing reports will not pass aggregation.

## Network and desktop requirements

- Linux needs `sudo nft`, a usable X server, and permission to run Chromium's normal sandbox. AppImage jobs require functional FUSE.
- macOS needs a GUI login session and stock `/etc/pf.conf` on a disposable host. The validator temporarily replaces PF rules and restores that stock configuration and the prior enabled state. Do not use a host with unrelated dynamic PF state.
- Windows needs an administrator desktop session and permission to export/import Defender Firewall policy. The harness temporarily disables existing outbound allow rules and allows only the specified test traffic. Normal user/UAC installation behavior is not covered by an administrator-hosted test.
- Linux/macOS runners share machine-wide egress restrictions and logging can pause temporarily. Hosted Windows keeps explicit HTTPS rules for the running `Runner.Listener`, `Runner.Worker`, and `Runner.PluginHost` executables because losing their control connection can cancel jobs. No exception is granted to Ente or its utility processes. The report records these control-program paths. Artifact upload happens after restoration.

No cloud account, VM subscription, or hardware fleet is provisioned by this repository. Those machine resources must be supplied before native coverage can complete.
