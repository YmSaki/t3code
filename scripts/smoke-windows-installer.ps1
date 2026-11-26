#Requires -Version 7.0
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)][string]$TestRoot,
    [Parameter(Mandatory)][string]$BaselineInstaller,
    [Parameter(Mandatory)][string]$CandidateInstaller,
    [Parameter(Mandatory)][string]$RuntimeVerifier,
    [Parameter(Mandatory)][version]$BaselineVersion,
    [Parameter(Mandatory)][version]$CandidateVersion,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$LinuxCliSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows -or -not [Environment]::Is64BitProcess -or $env:RUNNER_ARCH -cne 'X64' -or
    $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'Installer smoke tests require an x64 GitHub-hosted Windows Actions runner.'
}
if ($BaselineVersion.Build -lt 0 -or $BaselineVersion.Revision -ge 0 -or
    $CandidateVersion.Build -lt 0 -or $CandidateVersion.Revision -ge 0 -or
    $CandidateVersion -le $BaselineVersion) {
    throw 'Provide three-part Windows build versions in ascending order.'
}
if (-not [IO.Path]::IsPathFullyQualified($TestRoot)) {
    throw 'TestRoot must be an absolute path.'
}
$runnerTemp = Get-Item -LiteralPath $env:RUNNER_TEMP
$TestRoot = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($TestRoot))
if (-not $runnerTemp.PSIsContainer -or [IO.Path]::GetDirectoryName($TestRoot) -ne $runnerTemp.FullName -or
    (Test-Path -LiteralPath $TestRoot)) {
    throw 'TestRoot must be a new direct child of RUNNER_TEMP.'
}

function Assert-NoReparsePoint($Item) {
    for ($item = $Item; $null -ne $item; $item = $item.Parent) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "The installer test path crosses a reparse point at $($item.FullName)."
        }
    }
}

function Get-TestFile([string]$Path, [string]$Extension) {
    $file = Get-Item -LiteralPath $Path
    if ($file.PSIsContainer -or $file.Extension -ne $Extension -or
        -not $file.FullName.StartsWith("$($runnerTemp.FullName)\", [StringComparison]::OrdinalIgnoreCase) -or
        ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected a $Extension file under RUNNER_TEMP, got $Path."
    }
    Assert-NoReparsePoint $file.Directory
    return $file.FullName
}

Assert-NoReparsePoint $runnerTemp
$BaselineInstaller = Get-TestFile $BaselineInstaller '.exe'
$CandidateInstaller = Get-TestFile $CandidateInstaller '.exe'
$RuntimeVerifier = Get-TestFile $RuntimeVerifier '.mjs'
if ($BaselineInstaller -eq $CandidateInstaller) { throw 'Provide two distinct fork installers.' }
$null = New-Item -ItemType Directory -Path $TestRoot
$officialInstall = Join-Path $TestRoot 'Official T3 Code'
$forkInstall = Join-Path $TestRoot 'T3CodeJP'

function Invoke-Nsis([string]$Path, [string]$Arguments) {
    $startInfo = [Diagnostics.ProcessStartInfo]::new($Path, $Arguments)
    $startInfo.WorkingDirectory = $TestRoot
    $startInfo.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($startInfo)
    try {
        Write-Host "Running $([IO.Path]::GetFileName($Path)) as PID $($process.Id)."
        if (-not $process.WaitForExit(240000)) {
            if (-not $process.HasExited) { $process.Kill() }
            throw "NSIS process $($process.Id) timed out."
        }
        if ($process.ExitCode -ne 0) {
            throw "$Path exited with code $($process.ExitCode)."
        }
    } finally {
        $process.Dispose()
    }
}

function Get-NsisKeys([string]$Hive, [string]$Id) {
    "$Hive\Software\$Id"
    "$Hive\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Id"
}

function Assert-NoRegistration([string]$Id) {
    foreach ($key in (Get-NsisKeys 'HKCU:' $Id) + (Get-NsisKeys 'HKLM:' $Id)) {
        if (Test-Path -LiteralPath $key) { throw "Unexpected NSIS registration at $key." }
    }
}

function Assert-Installation([string]$Id, [string]$InstallDir, [string]$Product, [version]$Version) {
    $installKey, $uninstallKey = Get-NsisKeys 'HKCU:' $Id
    $location = Get-ItemPropertyValue -LiteralPath $installKey -Name InstallLocation
    if ($location -ne $InstallDir) { throw "$Product registered at '$location', expected '$InstallDir'." }

    $uninstall = Get-ItemProperty -LiteralPath $uninstallKey
    $uninstaller = Join-Path $InstallDir "Uninstall $Product.exe"
    if ($uninstall.DisplayVersion -ne $Version.ToString() -or
        $uninstall.UninstallString -ne ('"{0}" /currentuser' -f $uninstaller) -or
        -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        throw "Unexpected $Product uninstall registration at $uninstallKey."
    }

    $exe = Join-Path $InstallDir "$Product.exe"
    $file = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
    $actual = [version]::new($file.FileMajorPart, $file.FileMinorPart, $file.FileBuildPart, $file.FilePrivatePart)
    if ($actual -ne [version]"$Version.0") {
        throw "$exe has PE FileVersion $actual, expected $Version.0."
    }
    Write-Host "$Product registered version $Version and installed PE FileVersion $actual at $location."
}

function Get-OfficialSnapshot {
    $snapshot = [ordered]@{}
    foreach ($path in (Get-NsisKeys 'HKCU:' $officialId)) {
        $key = Get-Item -LiteralPath $path
        $values = [ordered]@{}
        foreach ($name in ($key.GetValueNames() | Sort-Object)) {
            $values[$name] = $key.GetValue($name)
        }
        $snapshot[$path] = $values
    }
    foreach ($file in "$officialProduct.exe", "Uninstall $officialProduct.exe") {
        $snapshot[$file] = (Get-FileHash -LiteralPath (Join-Path $officialInstall $file)).Hash
    }
    return ($snapshot | ConvertTo-Json -Depth 4 -Compress)
}

function Assert-Preserved {
    if ((Get-OfficialSnapshot) -cne $officialSnapshot) {
        throw 'The official installation files or NSIS registrations changed.'
    }
    foreach ($path in $fixtures.Keys) {
        if ((Get-Content -LiteralPath $path -Raw) -cne $fixtures[$path]) {
            throw "User data fixture changed at $path."
        }
    }
}

function Assert-CandidatePayload {
    $archive = Join-Path $forkInstall 'resources/wsl-runtime.tar.gz'
    $sidecar = (Get-Content -LiteralPath "$archive.sha256" -Raw).Trim()
    if ($sidecar -ne $LinuxCliSha256 -or (Get-FileHash -LiteralPath $archive).Hash -ne $LinuxCliSha256) {
        throw 'Installed WSL archive or its sidecar differs from the CLI archive built in this run.'
    }
    $updateConfig = Get-Content -LiteralPath (Join-Path $forkInstall 'resources/app-update.yml') -Raw
    if ($updateConfig -cnotmatch '(?m)^provider: github\r?$' -or
        $updateConfig -cnotmatch '(?m)^owner: YmSaki\r?$' -or
        $updateConfig -cnotmatch '(?m)^repo: t3code\r?$') {
        throw 'Installed updater configuration does not point to YmSaki/t3codeJP.'
    }
}

function Uninstall-Fork {
    # _?= keeps NSIS in the process we started. The copy lets it remove the installed uninstaller.
    $copy = Join-Path $TestRoot 'fork-uninstaller.exe'
    Copy-Item -LiteralPath (Join-Path $forkInstall 'Uninstall T3CodeJP.exe') -Destination $copy -Force
    Invoke-Nsis $copy "/currentuser /S _?=$forkInstall"
    if (Test-Path -LiteralPath $forkInstall) { throw "Fork install directory remains at $forkInstall." }
    Assert-NoRegistration $forkId
    Assert-Preserved
}

function Assert-InstalledRuntime {
    @'
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [installDir, expectedVersion] = process.argv.slice(2);
const resources = join(installDir, "resources");
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "", NO_COLOR: "1" };
delete env.ELECTRON_NO_ASAR;
delete env.FORCE_COLOR;
delete env.NODE_OPTIONS;
const version = execFileSync(
  join(installDir, "T3CodeJP.exe"),
  ["--no-global-search-paths", join(resources, "server.asar", "apps", "server", "dist", "bin.mjs"), "--version"],
  { cwd: installDir, env, encoding: "utf8", timeout: 30_000, windowsHide: true },
).trim();
if (version !== `t3 v${expectedVersion}`) {
  throw new Error(`Installed server reported ${JSON.stringify(version)}, expected t3 v${expectedVersion}.`);
}
console.log(`Installed server reported ${version}.`);

const monitor = spawn(join(resources, "resource-monitor", "t3-resource-monitor.exe"), {
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});
const timeout = setTimeout(() => monitor.kill(), 30_000);
try {
  await once(monitor, "spawn");
  const exited = once(monitor, "close");
  let hello;
  let sample;
  for await (const line of createInterface({ input: monitor.stdout })) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!hello) {
      if (message.type !== "hello" || message.arch !== "x86_64") {
        throw new Error(`Unexpected installed resource monitor hello: ${line}`);
      }
      hello = message;
      const configure = JSON.stringify({ version: hello.version, type: "configure", rootPid: process.pid, sampleIntervalMs: 1000 });
      const sampleNow = JSON.stringify({ version: hello.version, type: "sampleNow", requestId: "verify" });
      monitor.stdin.end(`${configure}\n${sampleNow}\n`);
    } else if (message.requestId === "verify") {
      sample = message;
    }
  }
  const [exitCode, signal] = await exited;
  if (exitCode !== 0 || sample?.type !== "snapshot" || !sample.processes.some((p) => p.pid === process.pid)) {
    throw new Error(`Installed resource monitor exited ${exitCode ?? signal}. Hello: ${JSON.stringify(hello)}. Sample: ${JSON.stringify(sample)}`);
  }
  console.log(`Installed resource monitor sampled ${sample.scannedProcessCount} processes.`);
} finally {
  clearTimeout(timeout);
  if (monitor.pid && monitor.exitCode === null && monitor.signalCode === null) monitor.kill();
}
'@ | & node --input-type=module - $forkInstall $CandidateVersion.ToString()
    if ($LASTEXITCODE -ne 0) { throw "Installed server or resource monitor probe exited $LASTEXITCODE." }
}

# electron-builder derives these NSIS keys from the app IDs using UUID v5.
$officialId = 'e9197887-efb3-55e0-985e-d6d3b5dd594a' # com.t3tools.t3code
$forkId = '2db643f7-e04f-59bd-a107-ca00c06d9a58' # io.github.ymsaki.t3codejp
$officialProduct = 'T3 Code (Beta)'
Assert-NoRegistration $officialId
Assert-NoRegistration $forkId

$appData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
if ([string]::IsNullOrWhiteSpace($appData)) { throw 'The runner has no roaming AppData directory.' }
$forkHome = Join-Path $HOME '.t3codejp'
$officialHome = Join-Path $HOME '.t3'
Assert-NoReparsePoint (Get-Item -LiteralPath $appData)
Assert-NoReparsePoint (Get-Item -LiteralPath $HOME)
$fixtureDirectories = @(
    (Join-Path $appData 't3codejp')
    (Join-Path $appData 't3code-v2')
    (Join-Path $forkHome 'userdata')
    (Join-Path $officialHome 'userdata')
)
foreach ($directory in $fixtureDirectories + $forkHome + $officialHome) {
    if (Test-Path -LiteralPath $directory) { throw "Expected a clean runner profile at $directory." }
}

$officialInstaller = Join-Path $TestRoot 'T3-Code-0.1.12-x64.exe'
$download = @{
    Uri = 'https://github.com/pingdotgg/t3code/releases/download/v0.1.12/T3-Code-0.1.12-x64.exe'
    OutFile = $officialInstaller
    TimeoutSec = 240
    MaximumRetryCount = 1
}
Invoke-WebRequest @download
if ((Get-Item -LiteralPath $officialInstaller).Length -ne 396823760 -or
    (Get-FileHash -LiteralPath $officialInstaller).Hash -ne 'de16cc1dde8de5af5cbd1613f8e3d5f28ce8c6c402fd27ea8de82aa1df8d6bcc') {
    throw 'Official v0.1.12 installer size or SHA-256 does not match the pinned asset.'
}

# Both installers use the pinned NSIS template, where /S skips launch unless --force-run is supplied.
# NSIS takes /D= and _?= as raw, final arguments, even with spaces in their paths.
Invoke-Nsis $officialInstaller "/currentuser /S /D=$officialInstall"
Assert-Installation $officialId $officialInstall $officialProduct ([version]'0.1.12')
$officialSnapshot = Get-OfficialSnapshot

$fixtures = [ordered]@{}
foreach ($directory in $fixtureDirectories) {
    $null = New-Item -ItemType Directory -Path $directory
    $path = Join-Path $directory 'installer-smoke-fixture.txt'
    $fixtures[$path] = [guid]::NewGuid().ToString()
    Set-Content -LiteralPath $path -Value $fixtures[$path] -NoNewline
}

Write-Host 'Testing a fresh candidate installation alongside the official installation.'
Assert-NoRegistration $forkId
Invoke-Nsis $CandidateInstaller "/currentuser /S /D=$forkInstall"
Assert-Installation $forkId $forkInstall 'T3CodeJP' $CandidateVersion
Assert-CandidatePayload
Assert-Preserved
Uninstall-Fork

Write-Host 'Testing an in-place upgrade from the older fork build.'
Invoke-Nsis $BaselineInstaller "/currentuser /S /D=$forkInstall"
Assert-Installation $forkId $forkInstall 'T3CodeJP' $BaselineVersion
Assert-Preserved
Invoke-Nsis $CandidateInstaller '/currentuser /S'
Assert-Installation $forkId $forkInstall 'T3CodeJP' $CandidateVersion
Assert-CandidatePayload
& node $RuntimeVerifier --app-dir $forkInstall --arch x64 --build-version $CandidateVersion.ToString() --verbose
if ($LASTEXITCODE -ne 0) { throw "Installed Windows runtime verifier exited $LASTEXITCODE." }
Assert-InstalledRuntime
Assert-Preserved
Uninstall-Fork
Write-Host 'Fork install, upgrade, and uninstall preserved fixture data and the installed official baseline.'
