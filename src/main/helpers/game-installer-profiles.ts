import fs from "node:fs";
import path from "node:path";

import type { Download, Game } from "@types";

export interface GameInstallerProfile {
  id: string;
  displayName: string;
  requiresElevation: boolean;
  replaceInstallerTempFiles: Record<string, string>;
  buildArguments: (installationPath: string) => string[];
}

const fitGirlProfile: GameInstallerProfile = {
  id: "fitgirl-inno",
  displayName: "FitGirl",
  requiresElevation: true,
  replaceInstallerTempFiles: {
    "host.cmd": "QGV4aXQgL2IgMA0K",
    "music.mp3":
      "//MQxAAAAANIAAAAAExBTUUzLjEwMFVVVVX/8xLEDQAAA0gAAAAAVVVVVVVVVVVVVVVVVVX/8xDEGwAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMQoAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxDUAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDEQgAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMRPAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxFwAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDEaQAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEsR2AAADSAAAAABVVVVVVVVVVVVVVVVVVf/zEMSEAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxJEAAANIAAAAAFVVVVVVVVVVVVVVVVU=",
  },
  buildArguments: (installationPath) => [
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/SP-",
    "/LANG=english",
    `/DIR=${installationPath}`,
    "/TASKS=",
    // FitGirl prerequisites and verification tools are optional Inno
    // components. The game payload itself is installed independently.
    "/COMPONENTS=",
  ],
};

const manualProfile: GameInstallerProfile = {
  id: "manual",
  displayName: "Manual",
  requiresElevation: false,
  replaceInstallerTempFiles: {},
  buildArguments: () => [],
};

const hasFitGirlMetadata = (download: Download) =>
  /fit[ ._-]?girl/i.test(
    `${download.downloadSourceName ?? ""} ${download.repackTitle ?? ""} ${download.folderName ?? ""}`
  );

const hasFitGirlPayload = async (download: Download) => {
  if (!download.folderName) return false;
  const folderPath = path.join(download.downloadPath, download.folderName);

  const entries = await fs.promises.readdir(folderPath).catch(() => []);
  return entries.some((entry) => /^fg-[\w.-]+\.bin$/i.test(entry));
};

export const resolveGameInstallerProfile = async (download: Download) => {
  if (hasFitGirlMetadata(download) || (await hasFitGirlPayload(download))) {
    return fitGirlProfile;
  }

  return manualProfile;
};

const sanitizeInstallationFolderName = (game: Game) => {
  const cleanTitle = game.title
    .replace(/[^A-Za-z 0-9]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return cleanTitle || game.objectId;
};

export const getGameInstallationPath = (download: Download, game: Game) =>
  path.join(download.downloadPath, sanitizeInstallationFolderName(game));
