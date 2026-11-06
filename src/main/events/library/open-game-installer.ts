import { shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { registerEvent } from "../register-event";
import { downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import type { Download, GameShop } from "@types";
import {
  GameFilesManager,
  logger,
  Umu,
  Wine,
  WindowManager,
} from "@main/services";
import { UmuEarlyExitError } from "@main/services/umu-launch-monitor";
import {
  findDownloadInstaller,
  getDownloadFolderPath,
} from "@main/helpers/find-game-installer";
import {
  getGameInstallationPath,
  resolveGameInstallerProfile,
} from "@main/helpers/game-installer-profiles";
import {
  endInstallerRun,
  markInstallerRunLive,
  startInstalledExecutablePolling,
  stopInstalledExecutablePolling,
} from "@main/helpers/installed-executable-poller";

interface InstallerLaunchOptions {
  args: string[];
  forceElevation: boolean;
  installationPath: string;
  replaceInstallerTempFiles: Record<string, string>;
  gameId?: string;
  winePrefixPath?: string | null;
  protonPath?: string | null;
  onExit: (exitCode: number | null) => void;
  onProgress: (progress: number) => void;
  onCancel: () => void;
  onUntrackedLaunch: () => void;
}

interface InstallerLaunchResult {
  launched: boolean;
  tracked: boolean;
}

const UAC_DECLINED_EXIT_CODE = 1223;
const SUCCESS_EXIT_CODES = new Set([0, 1641, 3010]);
const INSTALLER_STARTED_MARKER = "HYDRA_INSTALLER_STARTED";
const INSTALLER_EXIT_MARKER = "HYDRA_INSTALLER_EXIT=";

const QUICK_INSTALLER_EXIT_MS = 15_000;
const MAX_INSTALLER_TRACKING_MS = 2 * 60 * 60_000;
const ELEVATION_ERROR_CODES = new Set(["EACCES", "UNKNOWN"]);

const runningInstallers = new Map<string, number>();

const releaseRunningInstaller = (
  gameKey: string,
  installerStartedAt: number
) => {
  if (runningInstallers.get(gameKey) === installerStartedAt) {
    runningInstallers.delete(gameKey);
  }
};

const isSuccessfulExit = (exitCode: number | null) =>
  exitCode !== null && SUCCESS_EXIT_CODES.has(exitCode);

const ELEVATED_INSTALLER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$configuration = Get-Content -LiteralPath $args[0] -Raw | ConvertFrom-Json; foreach ($property in $configuration.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process') }",
  "function Write-HydraStatus([string]$message) { Add-Content -LiteralPath $env:HYDRA_INSTALLER_STATUS_PATH -Value $message -Encoding UTF8 }",
  "try {",
  "$replacementParts = $env:HYDRA_REPLACE_TEMP_FILES -split ';' | Where-Object { $_ }",
  "$replacementFiles = @{}; foreach ($part in $replacementParts) { $separator = $part.IndexOf('='); if ($separator -gt 0) { $replacementFiles[$part.Substring(0, $separator).ToLowerInvariant()] = [Convert]::FromBase64String($part.Substring($separator + 1)) } }",
  "$tempWatcher = New-Object System.IO.FileSystemWatcher $env:TEMP",
  "$tempWatcher.IncludeSubdirectories = $true",
  "$tempWatcher.EnableRaisingEvents = $true",
  "$tempActionData = @{ Replace = $replacementFiles }",
  "$removeTempAction = { $candidate = $Event.SourceEventArgs.FullPath; if ($candidate -notmatch '[\\/]is-[^\\/]+\\.tmp[\\/]') { return }; $leaf = [System.IO.Path]::GetFileName($candidate).ToLowerInvariant(); if ($Event.MessageData.Replace.ContainsKey($leaf)) { $silentBytes = $Event.MessageData.Replace[$leaf]; for ($attempt = 0; $attempt -lt 20; $attempt++) { try { if ((Get-Item -LiteralPath $candidate -ErrorAction Stop).Length -ne $silentBytes.Length) { [System.IO.File]::WriteAllBytes($candidate, $silentBytes) }; break } catch { Start-Sleep -Milliseconds 2 } } } }",
  'Add-Type -TypeDefinition \'using System; using System.ComponentModel; using System.Runtime.InteropServices; using System.Text; public static class HydraDesktop { [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; } [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; } [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr attributes); [DllImport("user32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetThreadDesktop(IntPtr desktop); [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation); [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle); public static int StartProcess(string desktop, string application, string arguments, string currentDirectory) { var startup = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = desktop }; var command = new StringBuilder("\\"" + application + "\\" " + arguments); PROCESS_INFORMATION process; if (!CreateProcess(application, command, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, currentDirectory, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error()); CloseHandle(process.hThread); CloseHandle(process.hProcess); return process.dwProcessId; } }\'',
  "$desktopName = 'HydraInstaller-' + [Guid]::NewGuid().ToString('N')",
  "$desktopHandle = [HydraDesktop]::CreateDesktop($desktopName, [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero); if ($desktopHandle -eq [IntPtr]::Zero) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }",
  "$createdSubscription = Register-ObjectEvent $tempWatcher Created -MessageData $tempActionData -Action $removeTempAction",
  "$changedSubscription = Register-ObjectEvent $tempWatcher Changed -MessageData $tempActionData -Action $removeTempAction",
  "$installerId = [HydraDesktop]::StartProcess($desktopName, $env:HYDRA_INSTALLER_PATH, $env:HYDRA_INSTALLER_ARGUMENTS, [System.IO.Path]::GetDirectoryName($env:HYDRA_INSTALLER_PATH))",
  "$installer = [System.Diagnostics.Process]::GetProcessById($installerId)",
  `Write-HydraStatus '${INSTALLER_STARTED_MARKER}'`,
  "if ($installer) {",
  "Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes",
  "Add-Type -TypeDefinition 'using System; using System.Collections.Generic; using System.Runtime.InteropServices; public static class HydraDesktopWindows { public delegate bool EnumDesktopWindowsProc(IntPtr window, IntPtr parameter); [DllImport(\"user32.dll\", SetLastError=true)] static extern bool EnumDesktopWindows(IntPtr desktop, EnumDesktopWindowsProc callback, IntPtr parameter); public static IntPtr[] GetWindows(IntPtr desktop) { var windows = new List<IntPtr>(); EnumDesktopWindows(desktop, delegate(IntPtr window, IntPtr parameter) { windows.Add(window); return true; }, IntPtr.Zero); return windows.ToArray(); } }'",
  'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; using System.Text; public static class HydraWindow { [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder className, int length); [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hDlg, int nIDDlgItem); [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam); public static bool HasClass(IntPtr window, string expected) { var name = new StringBuilder(256); GetClassName(window, name, name.Capacity); return string.Equals(name.ToString(), expected, StringComparison.Ordinal); } }\'',
  "$lastProgress = -1",
  "while (-not $installer.HasExited) {",
  "$desktopHandles = @([HydraDesktopWindows]::GetWindows($desktopHandle))",
  "$quickSfvHandle = $desktopHandles | Where-Object { [HydraWindow]::HasClass($_, 'QSFV_MAIN') } | Select-Object -First 1",
  "if ($quickSfvHandle) { [HydraWindow]::SendMessage($quickSfvHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }",
  "$languageHandle = $desktopHandles | Where-Object { [HydraWindow]::HasClass($_, 'TSelectLanguageForm') } | Select-Object -First 1",
  "if ($languageHandle) { [HydraWindow]::SendMessage($languageHandle, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null }",
  "$desktopWindows = @($desktopHandles | ForEach-Object { try { [System.Windows.Automation.AutomationElement]::FromHandle($_) } catch {} } | Where-Object { $_ })",
  "$wizardHandle = $desktopHandles | Where-Object { [HydraWindow]::HasClass($_, 'TWizardForm') } | Select-Object -First 1",
  "$window = if ($wizardHandle) { try { [System.Windows.Automation.AutomationElement]::FromHandle($wizardHandle) } catch { $null } } else { $null }",
  "if ($window) { $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition); $finish = $null; $install = $null; $next = $null; for ($index = 0; $index -lt $elements.Count; $index++) { $element = $elements.Item($index); if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::ProgressBar) { try { $range = $element.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern); $span = $range.Current.Maximum - $range.Current.Minimum; if ($span -gt 0) { $progress = [Math]::Round((($range.Current.Value - $range.Current.Minimum) / $span) * 100); if ($progress -ne $lastProgress) { Write-HydraStatus ('HYDRA_INSTALLER_PROGRESS=' + $progress); $lastProgress = $progress } } } catch {} }; if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $element.Current.IsEnabled) { if ($element.Current.Name -match '^(Finish|Concluir)$') { $finish = $element } elseif ($element.Current.Name -match '^(Install|Instalar)$') { $install = $element } elseif ($element.Current.Name -match '^(Next|Avan.ar).*$') { $next = $element } } }; if ($finish) { for ($index = 0; $index -lt $elements.Count; $index++) { $element = $elements.Item($index); if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::CheckBox) { try { $toggle = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { $toggle.Toggle() } } catch {} } }; ($finish.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() } elseif ($install) { ($install.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() } elseif ($next) { ($next.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() } }",
  "Start-Sleep -Milliseconds 250",
  "}",
  `Write-HydraStatus ('${INSTALLER_EXIT_MARKER}' + $installer.ExitCode)`,
  "}",
  "Get-EventSubscriber -ErrorAction SilentlyContinue | Where-Object { $_.SourceObject -eq $tempWatcher } | Unregister-Event -ErrorAction SilentlyContinue",
  "Get-Job -ErrorAction SilentlyContinue | Where-Object { $_.Id -in @($createdSubscription.Id, $changedSubscription.Id) } | Remove-Job -Force -ErrorAction SilentlyContinue",
  "$tempWatcher.Dispose()",
  "} catch {",
  "$failure = $_.Exception.GetBaseException()",
  `if ($failure.NativeErrorCode -eq ${UAC_DECLINED_EXIT_CODE}) { Write-HydraStatus '${INSTALLER_EXIT_MARKER}${UAC_DECLINED_EXIT_CODE}' } else { Write-HydraStatus $failure.Message }`,
  "}",
].join("\r\n");

interface SpawnInstallerResult {
  spawned: boolean;
  errorCode: string | null;
}

interface SpawnInstallerConfig {
  command: string;
  args: string[];
  failureMessage: string;
  onExit: (code: number | null, output: string) => void;
  onOutput?: (output: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  captureOutput?: boolean;
}

const spawnInstaller = async ({
  command,
  args,
  failureMessage,
  onExit,
  env,
  cwd,
  captureOutput = false,
  onOutput,
}: SpawnInstallerConfig): Promise<SpawnInstallerResult> => {
  return await new Promise<SpawnInstallerResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    let output = "";

    try {
      child = spawn(command, args, {
        detached: !captureOutput,
        stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "ignore",
        shell: false,
        windowsHide: captureOutput,
        env: env ?? process.env,
        cwd,
      });
    } catch (error) {
      logger.error(failureMessage, error);
      resolve({
        spawned: false,
        errorCode: (error as NodeJS.ErrnoException).code ?? null,
      });
      return;
    }

    const appendOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      onOutput?.(text);
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    child.once("spawn", () => {
      child.once("close", (code) => onExit(code, output.trim()));
      if (!captureOutput) child.unref();
      resolve({ spawned: true, errorCode: null });
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      logger.error(failureMessage, error);
      resolve({ spawned: false, errorCode: error.code ?? null });
    });
  });
};

const openPathAndCheck = async (filePath: string): Promise<boolean> => {
  const openError = await shell.openPath(filePath);
  return openError.length === 0;
};

const readOutputLines = (output: string) => output.split(/\r?\n/);

const readInstallerExitCode = (output: string) => {
  const markerLine = readOutputLines(output).find((line) =>
    line.startsWith(INSTALLER_EXIT_MARKER)
  );

  return markerLine
    ? Number(markerLine.slice(INSTALLER_EXIT_MARKER.length))
    : null;
};

const handleElevatedInstallerExit = async (
  code: number | null,
  output: string,
  filePath: string,
  options: InstallerLaunchOptions
) => {
  logger.info(
    `[GameInstaller] PowerShell exited with code ${code}: ${output || "no output"}`
  );

  const installerExitCode = readInstallerExitCode(output);
  if (installerExitCode !== null) return options.onExit(installerExitCode);

  if (readOutputLines(output).includes(INSTALLER_STARTED_MARKER)) {
    logger.info(
      `[GameInstaller] Started ${filePath} with elevation but could not wait for it`
    );
    return options.onUntrackedLaunch();
  }

  logger.error("Failed to launch game installer with elevation");
  options.onCancel();
};

const launchInstallerElevated = async (
  filePath: string,
  options: InstallerLaunchOptions
) => {
  const helperDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hydra-installer-")
  );
  const scriptPath = path.join(helperDirectory, "install.ps1");
  const statusPath = path.join(helperDirectory, "status.log");
  const configurationPath = path.join(helperDirectory, "configuration.json");

  const elevatedConfiguration = {
    HYDRA_INSTALLER_PATH: filePath,
    HYDRA_INSTALLER_ARGUMENTS: options.args
      .map((argument) => `"${argument.replaceAll('"', '\\"')}"`)
      .join(" "),
    HYDRA_INSTALLATION_PATH: options.installationPath,
    HYDRA_REPLACE_TEMP_FILES: Object.entries(options.replaceInstallerTempFiles)
      .map(([fileName, contents]) => `${fileName}=${contents}`)
      .join(";"),
    HYDRA_INSTALLER_STATUS_PATH: statusPath,
  };

  await Promise.all([
    fs.promises.writeFile(scriptPath, ELEVATED_INSTALLER_SCRIPT, "utf8"),
    fs.promises.writeFile(
      configurationPath,
      JSON.stringify(elevatedConfiguration),
      "utf8"
    ),
  ]);

  return spawnInstaller({
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$ErrorActionPreference = 'Stop'; try { $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + [char]34 + $env:HYDRA_ELEVATED_SCRIPT_PATH + [char]34 + ' ' + [char]34 + $env:HYDRA_ELEVATED_CONFIGURATION_PATH + [char]34; $elevated = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -WindowStyle Hidden -PassThru; $seen = 0; while (-not $elevated.HasExited) { if (Test-Path -LiteralPath $env:HYDRA_INSTALLER_STATUS_PATH) { $lines = @(Get-Content -LiteralPath $env:HYDRA_INSTALLER_STATUS_PATH); $lines | Select-Object -Skip $seen | Write-Output; $seen = $lines.Count }; Start-Sleep -Milliseconds 200; $elevated.Refresh() }; if (Test-Path -LiteralPath $env:HYDRA_INSTALLER_STATUS_PATH) { $lines = @(Get-Content -LiteralPath $env:HYDRA_INSTALLER_STATUS_PATH); $lines | Select-Object -Skip $seen | Write-Output }; exit $elevated.ExitCode } catch { $failure = $_.Exception.GetBaseException(); if ($failure.NativeErrorCode -eq 1223) { Write-Output 'HYDRA_INSTALLER_EXIT=1223'; exit 0 }; Write-Error $failure.Message; exit 1 }",
    ],
    failureMessage: "Failed to execute game installer with elevation",
    onOutput: (output) => {
      for (const match of output.matchAll(/HYDRA_INSTALLER_PROGRESS=(\d+)/g)) {
        options.onProgress(Math.min(100, Math.max(0, Number(match[1]))));
      }
    },
    onExit: (code, output) => {
      void fs.promises.rm(helperDirectory, { recursive: true, force: true });
      void handleElevatedInstallerExit(code, output, filePath, options).catch(
        (error) => {
          logger.error("Failed to handle the elevated installer exit", error);
        }
      );
    },
    env: {
      ...process.env,
      HYDRA_ELEVATED_SCRIPT_PATH: scriptPath,
      HYDRA_ELEVATED_CONFIGURATION_PATH: configurationPath,
      ...elevatedConfiguration,
    },
    captureOutput: true,
  });
};

const launchInstallerWithUmu = async (
  filePath: string,
  options: InstallerLaunchOptions
) => {
  let launched = false;

  try {
    await Umu.launchExecutable(filePath, options.args, {
      gameId: options.gameId,
      winePrefixPath: options.winePrefixPath,
      protonPath: options.protonPath,
      onExit: (exitCode) => {
        if (launched) options.onExit(exitCode);
      },
    });
  } catch (error) {
    if (!(error instanceof UmuEarlyExitError) || error.failureMessage) {
      throw error;
    }

    logger.info(
      `[GameInstaller] Installer exited early under umu-run: ${error.message}`
    );
    options.onExit(error.code);
    return;
  }

  launched = true;
};

const trackedLaunch = (
  filePath: string,
  method: string
): InstallerLaunchResult => {
  logger.info(`[GameInstaller] Launched ${filePath} ${method}`);
  return { launched: true, tracked: true };
};

const openUntracked = async (
  filePath: string
): Promise<InstallerLaunchResult> => {
  const launched = await openPathAndCheck(filePath);

  if (launched) logger.info(`[GameInstaller] Opened ${filePath} untracked`);
  else logger.error(`[GameInstaller] Could not open ${filePath}`);

  return { launched, tracked: false };
};

const executeWindowsInstaller = async (
  filePath: string,
  options: InstallerLaunchOptions
): Promise<InstallerLaunchResult> => {
  if (options.forceElevation) {
    const elevated = await launchInstallerElevated(filePath, options);
    if (elevated.spawned) return trackedLaunch(filePath, "with elevation");

    options.onCancel();
    return { launched: false, tracked: false };
  }

  const direct = await spawnInstaller({
    command: filePath,
    args: options.args,
    cwd: path.dirname(filePath),
    failureMessage: "Failed to execute game installer directly",
    onExit: options.onExit,
  });
  if (direct.spawned) return trackedLaunch(filePath, "directly");

  if (direct.errorCode && ELEVATION_ERROR_CODES.has(direct.errorCode)) {
    const elevated = await launchInstallerElevated(filePath, options);
    if (elevated.spawned) return trackedLaunch(filePath, "with elevation");
  }

  return await openUntracked(filePath);
};

const executeLinuxInstaller = async (
  filePath: string,
  options: InstallerLaunchOptions
): Promise<InstallerLaunchResult> => {
  try {
    await launchInstallerWithUmu(filePath, options);
    return trackedLaunch(filePath, "with umu-run");
  } catch (error) {
    logger.error("Failed to execute game installer with umu-run", error);
  }

  const wine = await spawnInstaller({
    command: "wine",
    args: [filePath, ...options.args],
    cwd: path.dirname(filePath),
    env: options.winePrefixPath
      ? { ...process.env, WINEPREFIX: options.winePrefixPath }
      : undefined,
    failureMessage: "Failed to execute game installer with wine",
    onExit: options.onExit,
  });
  if (wine.spawned) return trackedLaunch(filePath, "with wine");

  return await openUntracked(filePath);
};

const executeGameInstaller = async (
  filePath: string,
  options: InstallerLaunchOptions
): Promise<InstallerLaunchResult> => {
  if (process.platform === "win32") {
    return await executeWindowsInstaller(filePath, options);
  }

  if (process.platform === "linux") {
    return await executeLinuxInstaller(filePath, options);
  }

  return await openUntracked(filePath);
};

const describeInstallerExit = (exitCode: number | null) => {
  if (exitCode === 0) return "completed";
  if (isSuccessfulExit(exitCode)) {
    return `completed and asked for a restart (exit code ${exitCode})`;
  }
  if (exitCode === UAC_DECLINED_EXIT_CODE) return "UAC prompt declined";
  if (exitCode === null) return "terminated without an exit code";
  return `cancelled or failed with exit code ${exitCode}`;
};

const updateInstallerState = async (
  gameKey: string,
  state: Pick<
    Download,
    | "installerLaunched"
    | "installerRunning"
    | "installerStartedAt"
    | "installerPath"
    | "installerProfile"
    | "installationPath"
  >
) => {
  const download = await downloadsSublevel.get(gameKey);
  if (!download) return;

  await downloadsSublevel.put(gameKey, { ...download, ...state });
  WindowManager.sendDownloadsUpdated();
};

const handleInstallerExit = async (
  shop: GameShop,
  objectId: string,
  installerStartedAt: number,
  winePrefixPath: string | null,
  exitCode: number | null
) => {
  logger.info(
    `[GameInstaller] Installer for ${objectId} ${describeInstallerExit(exitCode)}`
  );

  const gameKey = levelKeys.game(shop, objectId);
  const download = await downloadsSublevel.get(gameKey);

  if (download?.installerStartedAt !== installerStartedAt) {
    logger.info(
      `[GameInstaller] Ignoring the exit of an older installer run for ${objectId}`
    );
    return;
  }

  stopInstalledExecutablePolling(gameKey);

  if (!isSuccessfulExit(exitCode)) {
    logger.info(`[GameInstaller] Reset ${objectId} back to Install`);
    await updateInstallerState(gameKey, {
      installerRunning: false,
      installerLaunched: false,
    });
    return;
  }

  const executableFound = await new GameFilesManager(
    shop,
    objectId
  ).searchAndBindInstalledExecutable(installerStartedAt, winePrefixPath);

  if (
    executableFound &&
    download.installerProfile === "fitgirl-inno" &&
    download.folderName &&
    download.installationPath
  ) {
    const downloadRoot = path.resolve(download.downloadPath);
    const sourcePath = path.resolve(downloadRoot, download.folderName);
    const installationPath = path.resolve(download.installationPath);
    const relativeSourcePath = path.relative(downloadRoot, sourcePath);
    const sourceIsInsideDownloadRoot =
      relativeSourcePath.length > 0 &&
      !relativeSourcePath.startsWith(`..${path.sep}`) &&
      relativeSourcePath !== ".." &&
      !path.isAbsolute(relativeSourcePath);

    if (
      sourceIsInsideDownloadRoot &&
      sourcePath.toLowerCase() !== installationPath.toLowerCase()
    ) {
      try {
        await fs.promises.rm(sourcePath, { recursive: true, force: true });
        logger.info(
          `[GameInstaller] Removed FitGirl source folder ${sourcePath}`
        );
      } catch (error) {
        logger.error(
          `[GameInstaller] Failed to remove FitGirl source folder ${sourcePath}`,
          error
        );
      }
    }
  }

  const exitedQuickly =
    Date.now() - installerStartedAt < QUICK_INSTALLER_EXIT_MS;

  logger.info(
    executableFound
      ? `[GameInstaller] Found the installed executable for ${objectId}`
      : `[GameInstaller] No installed executable found for ${objectId} yet, polling for it`
  );

  await updateInstallerState(gameKey, { installerRunning: false });

  if (!executableFound) {
    startInstalledExecutablePolling(
      shop,
      objectId,
      installerStartedAt,
      winePrefixPath
    );
  }

  WindowManager.sendToAppWindows("on-library-batch-complete");

  if (!executableFound && exitedQuickly) return;

  WindowManager.sendToAppWindows(
    "on-game-installer-closed",
    shop,
    objectId,
    executableFound
  );
};

const openGameInstaller = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  const gameKey = levelKeys.game(shop, objectId);
  const download = await downloadsSublevel.get(gameKey);
  const game = await gamesSublevel.get(gameKey).catch(() => null);
  const winePrefixPath = Wine.getEffectivePrefixPath(
    game?.winePrefixPath,
    objectId
  );

  if (!download) return false;

  const gamePath = await getDownloadFolderPath(download);

  if (!gamePath || !fs.existsSync(gamePath)) {
    return true;
  }

  if (fs.lstatSync(gamePath).isFile()) {
    shell.showItemInFolder(gamePath);
    return true;
  }

  if (runningInstallers.has(gameKey) || download?.installerRunning) {
    logger.info(`[GameInstaller] Installer for ${objectId} is already running`);
    return true;
  }

  const installerStartedAt = Date.now();
  runningInstallers.set(gameKey, installerStartedAt);
  stopInstalledExecutablePolling(gameKey);

  const installerPath = await findDownloadInstaller(download).catch(() => null);

  if (!installerPath) {
    releaseRunningInstaller(gameKey, installerStartedAt);
    shell.openPath(gamePath);
    return true;
  }

  if (!game) {
    releaseRunningInstaller(gameKey, installerStartedAt);
    return false;
  }

  const installerProfile = await resolveGameInstallerProfile(download);
  const installationPath = getGameInstallationPath(download, game);
  const installerArguments = installerProfile.buildArguments(installationPath);

  logger.info(
    `[GameInstaller] Using ${installerProfile.id} profile for ${objectId}`
  );

  let installerFinished = false;
  let trackingTimeout: NodeJS.Timeout | null = null;
  let markLaunchRecorded = () => {};
  const launchRecorded = new Promise<void>((resolve) => {
    markLaunchRecorded = resolve;
  });

  const afterLaunchRecorded = (callback: () => Promise<void>) => {
    if (installerFinished) return;
    installerFinished = true;
    if (trackingTimeout) clearTimeout(trackingTimeout);
    releaseRunningInstaller(gameKey, installerStartedAt);
    endInstallerRun(gameKey, installerStartedAt);
    void launchRecorded.then(callback).catch((error) => {
      logger.error("Failed to update the installer state", error);
    });
  };

  const launchResult = await executeGameInstaller(installerPath, {
    args: installerArguments,
    forceElevation: installerProfile.requiresElevation,
    installationPath,
    replaceInstallerTempFiles: installerProfile.replaceInstallerTempFiles,
    gameId: objectId,
    winePrefixPath,
    protonPath: game?.protonPath,
    onExit: (exitCode) =>
      afterLaunchRecorded(() =>
        handleInstallerExit(
          shop,
          objectId,
          installerStartedAt,
          winePrefixPath,
          exitCode
        )
      ),
    onProgress: (progress) =>
      WindowManager.sendToAppWindows(
        "on-game-installation-progress",
        shop,
        objectId,
        progress
      ),
    onCancel: () =>
      afterLaunchRecorded(() =>
        updateInstallerState(gameKey, {
          installerLaunched: false,
          installerRunning: false,
        })
      ),
    onUntrackedLaunch: () =>
      afterLaunchRecorded(() =>
        updateInstallerState(gameKey, {
          installerLaunched: true,
          installerRunning: false,
        })
      ),
  }).catch((error) => {
    releaseRunningInstaller(gameKey, installerStartedAt);
    markLaunchRecorded();
    throw error;
  });
  const { launched, tracked } = launchResult;

  if (!launched || !tracked)
    releaseRunningInstaller(gameKey, installerStartedAt);

  if (launched && tracked && !installerFinished) {
    markInstallerRunLive(gameKey, installerStartedAt);
    trackingTimeout = setTimeout(() => {
      if (installerFinished) return;

      logger.info(
        `[GameInstaller] Installer for ${objectId} is still open after two hours, allowing it to be relaunched`
      );
      releaseRunningInstaller(gameKey, installerStartedAt);
      void launchRecorded
        .then(() => updateInstallerState(gameKey, { installerRunning: false }))
        .catch((error) => {
          logger.error("Failed to update the installer state", error);
        });
    }, MAX_INSTALLER_TRACKING_MS);
    trackingTimeout.unref();
  }

  try {
    if (launched) {
      await updateInstallerState(gameKey, {
        installerLaunched: true,
        installerRunning: tracked && !installerFinished,
        installerStartedAt,
        installerPath,
        installerProfile: installerProfile.id,
        installationPath,
      });
    }
  } finally {
    markLaunchRecorded();
  }

  return launched;
};

registerEvent("openGameInstaller", openGameInstaller);
