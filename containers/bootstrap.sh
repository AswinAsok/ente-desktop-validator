#!/usr/bin/env bash
set -euo pipefail
source /etc/os-release
if [[ "$ID" == fedora ]]; then
  dnf install -y sudo git curl tar gzip procps-ng util-linux shadow-utils \
    xorg-x11-server-Xvfb xorg-x11-xauth ImageMagick nftables nss atk \
    at-spi2-atk gtk3 alsa-lib mesa-libgbm dbus-x11
else
  pacman-key --init
  if [[ "$ID" == archarm ]]; then pacman-key --populate archlinuxarm; else pacman-key --populate archlinux; fi
  pacman -Syu --noconfirm --disable-sandbox
  pacman -S --needed --noconfirm --disable-sandbox sudo git curl tar gzip procps-ng util-linux shadow \
    xorg-server-xvfb xorg-xauth imagemagick nftables nss at-spi2-core gtk3 alsa-lib mesa dbus
fi
# Minimal Fedora images can omit shadow accounts; create them before adding the test user.
pwconv
useradd --create-home --uid 1001 --comment 'Ente validator' --password '*' validator
printf 'Defaults secure_path="/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\nvalidator ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/validator
if [[ "$ID" == fedora ]]; then
  # This single-use local account has NOPASSWD access; container PAM account
  # validation fails on Ubuntu hosts even when the same image passes at build time.
  printf 'Defaults:validator !pam_acct_mgmt\n' >> /etc/sudoers.d/validator
fi
chmod 440 /etc/sudoers.d/validator
visudo -cf /etc/sudoers.d/validator
su -s /bin/bash validator -c 'sudo -n true && node --version'
