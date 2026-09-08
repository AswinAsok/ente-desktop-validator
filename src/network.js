import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import {
  command,
  powershell,
  psQuote,
  json,
  writeJSON,
  exists,
} from "./common.js";

export function linuxRules(ips, mode) {
  return [
    "table inet ente_validator { chain output { type filter hook output priority -300; policy drop;",
    'oifname "lo" accept;',
    ...ips.map(
      (ip) =>
        `${isIP(ip) === 4 ? "ip" : "ip6"} daddr ${ip} tcp dport 443 accept;`,
    ),
    ...(mode === "online"
      ? ["udp dport 53 accept;", "tcp dport 53 accept;"]
      : []),
    "}",
    "}",
    "",
  ].join("\n");
}
export function macRules(ips, mode) {
  return [
    "set skip on lo0",
    ...ips.map(
      (ip) =>
        `pass out quick inet${isIP(ip) === 6 ? "6" : ""} proto tcp to ${ip} port 443`,
    ),
    ...(mode === "online"
      ? ["pass out quick proto { tcp udp } to any port 53"]
      : []),
    "block drop out quick all",
    "",
  ].join("\n");
}

// The controller and the installed app share these OS rules. Restore before any
// GitHub API/upload operation. Browser offline emulation cannot constrain Rust.
export class NetworkPolicy {
  constructor(directory) {
    this.directory = directory;
    this.stateFile = path.join(directory, "network-state.json");
  }
  async apply(mode, hosts = ["models.ente.com"]) {
    if (!["online", "offline"].includes(mode))
      throw new Error("Unknown network mode");
    await fs.mkdir(this.directory, { recursive: true });
    if (!(await exists(this.stateFile))) {
      const ips = [
        ...new Set(
          (await Promise.all(hosts.map((h) => dns.lookup(h, { all: true }))))
            .flat()
            .map((a) => a.address),
        ),
      ];
      if (!ips.length || ips.some((ip) => !isIP(ip)))
        throw new Error("Could not resolve model CDN addresses");
      const state = { platform: process.platform, hosts, ips };
      if (process.platform === "win32") {
        state.backup = path.join(this.directory, "firewall.wfw");
        await command("netsh", ["advfirewall", "export", state.backup]);
      } else if (process.platform === "darwin") {
        state.enabled = (
          await command("sudo", ["pfctl", "-s", "info"])
        ).stdout.includes("Status: Enabled");
        state.backup = path.join(this.directory, "pf.conf");
        await fs.copyFile("/etc/pf.conf", state.backup);
      }
      await writeJSON(this.stateFile, state);
    }
    const state = await json(this.stateFile),
      ips = mode === "online" ? state.ips : [];
    if (process.platform === "linux") {
      await command("sudo", [
        "nft",
        "delete",
        "table",
        "inet",
        "ente_validator",
      ]).catch(() => {});
      const file = path.join(this.directory, "network.nft");
      await fs.writeFile(file, linuxRules(ips, mode));
      await command("sudo", ["nft", "-f", file]);
    } else if (process.platform === "darwin") {
      const file = path.join(this.directory, "network.pf");
      await fs.writeFile(file, macRules(ips, mode));
      await command("sudo", ["pfctl", "-f", file]);
      await command("sudo", ["pfctl", "-F", "states"]);
      if (!state.enabled && mode === "online")
        await command("sudo", ["pfctl", "-e"]);
    } else {
      await powershell(`Get-NetFirewallRule -Direction Outbound -Enabled True | Disable-NetFirewallRule
Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True -DefaultOutboundAction Block
Get-NetFirewallRule -Group 'EnteValidator' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Ente validator loopback' -Group 'EnteValidator' -Direction Outbound -Action Allow -RemoteAddress '127.0.0.1' | Out-Null
${ips.length ? `New-NetFirewallRule -DisplayName 'Ente validator models' -Group 'EnteValidator' -Direction Outbound -Action Allow -Protocol TCP -RemotePort 443 -RemoteAddress @(${ips.map(psQuote).join(",")}) | Out-Null` : ""}
${mode === "online" ? "foreach ($p in @('TCP','UDP')) { New-NetFirewallRule -DisplayName ('Ente validator DNS '+$p) -Group 'EnteValidator' -Direction Outbound -Action Allow -Protocol $p -RemotePort 53 | Out-Null }" : ""}`);
    }
    return { mode, allowedModelAddresses: ips };
  }
  async verify(mode) {
    const state = await json(this.stateFile);
    const ip = state.ips.find((ip) => isIP(ip) === 4) ?? state.ips[0];
    const curl = process.platform === "win32" ? "curl.exe" : "curl";
    const canReach = async (args) =>
      command(
        curl,
        [
          "--noproxy",
          "*",
          "--head",
          "--silent",
          "--show-error",
          "--connect-timeout",
          "5",
          "--max-time",
          "8",
          ...args,
        ],
        { timeout: 10_000 },
      ).then(
        () => true,
        () => false,
      );
    // Literal addresses prevent DNS failure alone from masquerading as isolation.
    const modelsReachable = await canReach([
      "--resolve",
      `${state.hosts[0]}:443:${isIP(ip) === 6 ? `[${ip}]` : ip}`,
      `https://${state.hosts[0]}/`,
    ]);
    const unrelatedReachable = await canReach(["https://1.1.1.1/"]);
    if (unrelatedReachable || modelsReachable !== (mode === "online"))
      throw new Error(
        `OS egress policy failed: mode=${mode}, modelCDN=${modelsReachable}, unrelated=${unrelatedReachable}`,
      );
    return {
      mode,
      modelsReachable,
      unrelatedReachable,
      enforcement: "operating-system",
    };
  }
  async restore() {
    if (!(await exists(this.stateFile)))
      return { restored: true, applied: false };
    const state = await json(this.stateFile);
    if (state.platform !== process.platform)
      throw new Error("Firewall backup belongs to another operating system");
    if (process.platform === "linux")
      await command("sudo", [
        "nft",
        "delete",
        "table",
        "inet",
        "ente_validator",
      ]).catch((error) => {
        if (!error.result?.stderr.includes("No such file or directory"))
          throw error;
      });
    else if (process.platform === "win32")
      await command("netsh", ["advfirewall", "import", state.backup]);
    else {
      await command("sudo", ["pfctl", "-f", state.backup]);
      await command("sudo", ["pfctl", "-F", "states"]);
      if (!state.enabled) await command("sudo", ["pfctl", "-d"]);
    }
    await fs.rm(this.stateFile);
    return { restored: true };
  }
}
