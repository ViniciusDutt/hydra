import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNmcliRows, parseWindowsNetworks } from "./network.ts";

test("nmcli preserves escaped colons and backslashes in SSIDs", () => {
  assert.deepEqual(
    parseNmcliRows("*:Home\\:Office\\\\Wifi:WPA2:85\n:Guest::40\n"),
    [
      ["*", "Home:Office\\Wifi", "WPA2", "85"],
      ["", "Guest", "", "40"],
    ]
  );
});

test("netsh reads Portuguese security, strongest BSSID and active network", () => {
  const output =
    "SSID 1 : Casa\r\n Autenticação : WPA2-Personal\r\n Sinal : 40%\r\n Sinal : 90%\r\nSSID 2 : Guest\r\n Autenticação : Aberta\r\n Sinal : 25%\r\nSSID 3 : \r\n";
  assert.deepEqual(parseWindowsNetworks(output, "Casa"), [
    { ssid: "Casa", security: "WPA2-Personal", signal: 90, connected: true },
    { ssid: "Guest", security: "", signal: 25, connected: false },
  ]);
});
