# Disposable test environments

All scenarios now use GitHub-hosted machines. Windows, macOS, DEB and AppImage jobs run directly on their hosted machines. Fedora RPM and Arch Pacman jobs run inside fresh native-architecture containers on hosted Ubuntu machines.

| Package | Container userspace | GitHub host |
| --- | --- | --- |
| RPM x64 | Fedora 44 | ubuntu-24.04 |
| RPM ARM64 | Fedora 44 | ubuntu-24.04-arm |
| Pacman x64 | Arch Linux | ubuntu-24.04 |
| Pacman ARM64 | Arch Linux ARM | ubuntu-24.04-arm |

Each row runs once fresh and once as an upgrade. No self-hosted runner fleet or `RUNNER_DISCOVERY_TOKEN` is needed. Dispatch the existing manual workflow; it selects containers automatically. Private repositories consume their included hosted-runner minutes and storage allowance. This is not an unlimited-free hosting service, and no repository visibility or billing settings are changed.

## Scope and isolation

These eight scenarios validate native RPM/Pacman installation, installed files and CPU architecture, normal Electron launch, existing ML interfaces, model downloads and offline inference in the distribution's userspace. They share the Ubuntu host kernel. They do **not** establish full Fedora/Arch VM, SELinux, systemd desktop-session, or distribution-kernel compatibility. JSON and Markdown reports identify this scope; `fullCoverage` means all scenarios in this mixed machine/container matrix passed.

`scripts/run-container.sh` builds and destroys one container per job. It uses a private bridge network and PID namespace, a non-root desktop user, Xvfb, and D-Bus. No host network, host PID namespace, Docker socket, or personal home directory is mounted. Only the standalone workspace is mounted. `NET_ADMIN` permits nftables inside the container network namespace. `SYS_ADMIN` and relaxed Docker seccomp/AppArmor profiles allow Chromium's normal namespace sandbox; no `--no-sandbox` flag is supplied, and application files are not patched.

Before installation, the required `container-isolation` check verifies user/PID namespaces and exercises online/offline kernel egress rules with external native curl processes. Online allows the model CDN and DNS only; offline allows only loopback. A literal external DNS server avoids Docker's loopback DNS proxy. All Ente utility/ML processes inherit the restricted network namespace. Actual offline model reuse remains a separate required runtime check.

The host Actions control connection is outside that namespace. Cleanup destroys the container after success, failure or cancellation. Setup failures produce blocked reports where the controller can still run; missing artifacts can never yield an overall pass. The host firewall restore step applies only to direct-machine jobs.

## Image provenance

Fedora uses `quay.io/fedora/fedora:44`; x64 Arch uses the official `archlinux:base` image. Arch ARM is imported from the project's generic AArch64 root filesystem at `https://de3.mirror.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz`. This named project mirror supports valid HTTPS; the generic `os.archlinuxarm.org` hostname currently does not have a matching TLS certificate. TLS verification is never disabled.

The image setup installs distribution dependencies through DNF/Pacman, retaining package-signature verification. Node 24 comes from the hosted job's `actions/setup-node` installation, copied into the image. The job artifacts record the base image digest or downloaded rootfs SHA-256/source, built image identity, installed OS package versions, setup log, and isolation probes. Distribution repositories and base tags can move between runs; use these artifacts to identify the exact environment used. The rootfs SHA-256 is an observed download identity, not a publisher signature.

A future need for full distribution-kernel coverage would require dedicated VMs. It must not be inferred from a container pass.
