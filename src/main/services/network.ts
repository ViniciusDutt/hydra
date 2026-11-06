import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NetworkStatus, WifiNetwork } from "@types";

const execute = promisify(execFile);

async function run(command: string, args: string[]) {
  const { stdout } = await execute(command, args, {
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

export function parseNmcliRows(output: string): string[][] {
  return output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields: string[] = [];
      let field = "";
      let escaped = false;
      for (const character of line) {
        if (escaped) {
          field += character;
          escaped = false;
        } else if (character === "\\") escaped = true;
        else if (character === ":") {
          fields.push(field);
          field = "";
        } else field += character;
      }
      fields.push(field);
      return fields;
    });
}

export function parseWindowsNetworks(
  output: string,
  connectedSsid: string
): WifiNetwork[] {
  return output
    .split(/(?:^|\r?\n)[ \t]*SSID[ \t]+\d+[ \t]*:[ \t]*/)
    .slice(1)
    .flatMap((block) => {
      const ssid = block.split(/\r?\n/)[0].trim();
      if (!ssid) return [];
      const security =
        block.match(/WPA[^\r\n]*/i)?.[0].trim() ??
        (/\bWEP\b/i.test(block) ? "WEP" : "");
      const signals = [...block.matchAll(/:\s*(\d+)\s*%/g)].map((match) =>
        Number(match[1])
      );
      return [
        {
          ssid,
          security,
          signal: Math.max(0, ...signals),
          connected: ssid === connectedSsid,
        },
      ];
    });
}

export async function getNetworkStatus(): Promise<NetworkStatus> {
  if (process.platform === "win32") {
    const adapters = JSON.parse(
      (await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ConvertTo-Json -Compress -InputObject @(Get-NetAdapter -Physical | Select-Object Name, Status, NdisPhysicalMedium)",
      ])) || "[]"
    ) as { Name: string; Status: string; NdisPhysicalMedium: number }[];
    const hasWifi = adapters.some((adapter) =>
      [1, 9].includes(adapter.NdisPhysicalMedium)
    );
    const ethernet = adapters
      .filter(
        (adapter) =>
          ![1, 9].includes(adapter.NdisPhysicalMedium) &&
          adapter.Status === "Up"
      )
      .map((adapter) => adapter.Name);
    if (!hasWifi) return { supported: true, hasWifi, ethernet, networks: [] };
    const interfaces = await run("netsh", ["wlan", "show", "interfaces"]);
    const connectedSsid =
      interfaces.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1].trim() ?? "";
    const networks = parseWindowsNetworks(
      await run("netsh", ["wlan", "show", "networks", "mode=bssid"]),
      connectedSsid
    );
    return { supported: true, hasWifi, ethernet, networks };
  }
  if (process.platform === "linux") {
    const devices = parseNmcliRows(
      await run("nmcli", ["-t", "-f", "DEVICE,TYPE,STATE", "device", "status"])
    );
    const hasWifi = devices.some((device) => device[1] === "wifi");
    const ethernet = devices
      .filter((device) => device[1] === "ethernet" && device[2] === "connected")
      .map((device) => device[0]);
    const rows = hasWifi
      ? parseNmcliRows(
          await run("nmcli", [
            "-t",
            "-f",
            "IN-USE,SSID,SECURITY,SIGNAL",
            "device",
            "wifi",
            "list",
            "--rescan",
            "yes",
          ])
        )
      : [];
    const networks = rows
      .filter((row) => row[1])
      .map(([active, ssid, security, signal]) => ({
        ssid,
        security: security === "--" ? "" : security,
        signal: Number(signal),
        connected: active === "*",
      }));
    return { supported: true, hasWifi, ethernet, networks };
  }
  return { supported: false, hasWifi: false, ethernet: [], networks: [] };
}

function xml(value: string) {
  return value.replace(
    /[<>&"']/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!
  );
}

export async function connectWifi(
  ssid: string,
  password: string
): Promise<void> {
  if (
    typeof ssid !== "string" ||
    !ssid ||
    Buffer.byteLength(ssid) > 32 ||
    typeof password !== "string" ||
    password.length > 64
  )
    throw new Error("Invalid network credentials");
  const status = await getNetworkStatus();
  const network = status.networks.find((item) => item.ssid === ssid);
  if (!network) throw new Error("Network is no longer available");
  if (/EAP|Enterprise|802\.1x|WEP/i.test(network.security))
    throw new Error(
      "This network requires configuration in the system settings"
    );
  if (process.platform === "linux") {
    if (password.includes("\n") || password.includes("\r"))
      throw new Error("Invalid password");
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "nmcli",
        ["--ask", "--wait", "25", "device", "wifi", "connect", ssid],
        {
          timeout: 30000,
          env: { ...process.env, LC_ALL: "C" },
        },
        (error) => {
          if (error) reject(new Error("Could not connect to Wi-Fi"));
          else resolve();
        }
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(password + "\n");
    });
    return;
  }
  if (process.platform !== "win32")
    throw new Error("Network configuration is not supported on this system");
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-wifi-"));
  try {
    const file = path.join(directory, "profile.xml");
    const secured = Boolean(network.security);
    if (secured && !password) throw new Error("Enter the Wi-Fi password");
    const authentication = /WPA3/i.test(network.security)
      ? "WPA3SAE"
      : /WPA2/i.test(network.security)
        ? "WPA2PSK"
        : "WPAPSK";
    await writeFile(
      file,
      `<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>${xml(ssid)}</name><SSIDConfig><SSID><hex>${Buffer.from(ssid).toString("hex")}</hex></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>auto</connectionMode><MSM><security><authEncryption><authentication>${secured ? authentication : "open"}</authentication><encryption>${secured ? "AES" : "none"}</encryption><useOneX>false</useOneX></authEncryption>${secured ? `<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xml(password)}</keyMaterial></sharedKey>` : ""}</security></MSM></WLANProfile>`,
      { mode: 0o600 }
    );
    await run("netsh", [
      "wlan",
      "add",
      "profile",
      `filename=${file}`,
      "user=current",
    ]);
    await run("netsh", ["wlan", "connect", `name=${ssid}`, `ssid=${ssid}`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
