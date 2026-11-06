import assert from "node:assert/strict";
import test from "node:test";

import type { Download, Game } from "@types";
import {
  getGameInstallationPath,
  resolveGameInstallerProfile,
} from "./game-installer-profiles.js";

const download = (overrides: Partial<Download> = {}) =>
  ({
    downloadPath: "D:\\Games",
    folderName: "payload",
    ...overrides,
  }) as Download;

test("selects the FitGirl silent profile from persisted source metadata", async () => {
  const profile = await resolveGameInstallerProfile(
    download({ downloadSourceName: "FitGirl Repacks" })
  );

  assert.equal(profile.id, "fitgirl-inno");
  assert.equal(profile.requiresElevation, true);
  assert.ok(profile.replaceInstallerTempFiles["music.mp3"]);
  assert.ok(profile.replaceInstallerTempFiles["host.cmd"]);
  assert.ok(profile.buildArguments("C:\\Games\\Test").includes("/VERYSILENT"));
  assert.deepEqual(profile.buildArguments("D:\\Games\\Control"), [
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/SP-",
    "/LANG=english",
    "/DIR=D:\\Games\\Control",
    "/TASKS=",
    "/COMPONENTS=",
  ]);
});

test("uses a stable game subdirectory as the installation target", () => {
  const game = {
    title: "NieR:Automata™ ",
    objectId: "524220",
  } as Game;

  assert.equal(
    getGameInstallationPath(download(), game),
    "D:\\Games\\NieRAutomata"
  );
});
