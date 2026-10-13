[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$ReleasePath,
	[Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$release = (Resolve-Path $ReleasePath).Path
$evidence = Join-Path (Get-Location) 'installer-test-results'
New-Item -ItemType Directory -Force $evidence | Out-Null
$publisher = 'Espri.ai'
$subject = 'CN=Espri.ai Inc., O=Espri.ai Inc., L=Ottawa, S=Ontario, C=CA'
$observations = [System.Collections.Generic.List[object]]::new()

function Get-BackboardRegistration {
	foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
		Get-ItemProperty "$root\*" -ErrorAction SilentlyContinue |
			Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'Backboard Studio*' }
	}
}

function Invoke-Setup([string]$File, [string]$Label, [switch]$Uninstall) {
	$arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/LOG=`"$(Join-Path $evidence "$Label.log")`"")
	if (-not $Uninstall) { $arguments += '/MERGETASKS="!runcode"' }
	$process = Start-Process -FilePath $File -ArgumentList $arguments -Wait -PassThru
	if ($process.ExitCode -ne 0) { throw "$Label exited with $($process.ExitCode)" }
}

# Mirrors the in-app updater (backboard/extensions/backboard/src/updates.ts): with the
# app's mutex held, setup stages the update in "_" and writes the ready marker; once
# the mutex is gone, inno_updater swaps the staged files into place.
function Test-BackgroundUpdate([string]$File, [string]$AppFolder, [string]$Label) {
	$product = Get-Content -Raw (Join-Path $AppFolder 'resources\app\product.json') | ConvertFrom-Json
	$flag = Join-Path $evidence "$Label.flag"
	$ready = Join-Path $AppFolder 'updating_version'
	$staged = Join-Path $AppFolder '_'
	Set-Content -LiteralPath $flag -Value 'flag'
	$appMutex = [System.Threading.Mutex]::new($false, $product.win32MutexName)
	try {
		$arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$(Join-Path $evidence "$Label.log")`"", "/update=`"$flag`"", "/progress=`"$(Join-Path $evidence "$Label.progress")`"", '/nocloseapplications', '/MERGETASKS="!runcode,!desktopicon,!quicklaunchicon"')
		$process = Start-Process -FilePath $File -ArgumentList $arguments -PassThru
		$null = $process.Handle
		$deadline = (Get-Date).AddMinutes(15)
		while (-not (Test-Path -LiteralPath $ready)) {
			if ($process.HasExited) { throw "$Label exited with $($process.ExitCode) before staging the update" }
			if ((Get-Date) -gt $deadline) { throw "$Label did not finish staging the update" }
			Start-Sleep -Milliseconds 250
		}
		if (-not (Test-Path -LiteralPath (Join-Path $staged 'resources\app\product.json'))) { throw "$Label did not stage the update beside the running app" }
		if ($process.HasExited) { throw "$Label did not wait for the running app to exit" }
	} finally {
		$appMutex.Dispose()
	}
	if (-not $process.WaitForExit(600000)) { throw "$Label did not apply the update after the app exited" }
	if ($process.ExitCode -ne 0) { throw "$Label exited with $($process.ExitCode)" }
	if (Test-Path -LiteralPath $staged) { throw "$Label left the staged update folder behind" }
	if (Test-Path -LiteralPath $ready) { throw "$Label left the ready marker behind" }
	if (-not (Test-Path -LiteralPath (Join-Path $AppFolder "$($product.nameShort).exe"))) { throw "$Label removed the application executable" }
}

function Assert-Registration([string]$Label) {
	$entries = @(Get-BackboardRegistration)
	if ($entries.Count -ne 1) { throw "${Label}: expected one uninstall registration, got $($entries.Count)" }
	$entry = $entries[0]
	if ($entry.DisplayName -notin @('Backboard Studio', 'Backboard Studio (User)')) { throw "Unexpected DisplayName: $($entry.DisplayName)" }
	if ($entry.Publisher -ne $publisher) { throw "Unexpected Publisher: $($entry.Publisher)" }
	if ($entry.DisplayVersion -ne $Version) { throw "Unexpected DisplayVersion: $($entry.DisplayVersion)" }
	$uninstaller = $entry.UninstallString.Trim('"')
	if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Registered uninstaller does not exist' }
	$appFolder = Split-Path $uninstaller
	$product = Get-Content -Raw (Join-Path $appFolder 'resources\app\product.json') | ConvertFrom-Json
	if ($product.backboardVersion -ne $Version -or $product.companyName -ne $publisher) { throw 'Installed product metadata is incorrect' }
	$observations.Add([pscustomobject]@{ scenario = $Label; name = $entry.DisplayName; publisher = $entry.Publisher; version = $entry.DisplayVersion; registryKey = $entry.PSPath; uninstallString = $entry.UninstallString; productVersion = $product.backboardVersion })
	Write-Host "$Label -> Name=$($entry.DisplayName); Publisher=$($entry.Publisher); Version=$($entry.DisplayVersion)"
	return $uninstaller
}

try {
	foreach ($line in Get-Content (Join-Path $release 'SHA256SUMS')) {
		if ($line -notmatch '^([a-fA-F0-9]{64})  ([^/\\]+)$') { throw 'Invalid checksum entry' }
		if ((Get-FileHash (Join-Path $release $Matches[2]) -Algorithm SHA256).Hash -ne $Matches[1]) { throw 'Release checksum mismatch' }
	}
	foreach ($installer in Get-ChildItem $release -Filter '*.exe') {
		$signature = Get-AuthenticodeSignature $installer.FullName
		if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -ne $subject) { throw 'Installer signature verification failed' }
	}
	if (@(Get-BackboardRegistration).Count -ne 0) { throw 'Test runner is not clean' }
	Invoke-Setup (Join-Path $release 'Backboard-Studio-User-Setup-x64.exe') 'fresh-user-install'
	$uninstaller = Assert-Registration 'fresh-user-install'
	$userAppFolder = Split-Path $uninstaller
	Test-BackgroundUpdate (Join-Path $release 'Backboard-Studio-User-Setup-x64.exe') $userAppFolder 'user-background-update'
	$uninstaller = Assert-Registration 'user-background-update'
	Invoke-Setup $uninstaller 'user-uninstall' -Uninstall
	if (@(Get-BackboardRegistration).Count -ne 0) { throw 'User uninstall left an Installed apps entry' }
	if (Test-Path -LiteralPath (Join-Path $userAppFolder 'resources')) { throw 'User uninstall after a background update left application files behind' }

	Invoke-Setup (Join-Path $release 'Backboard-Studio-System-Setup-x64.exe') 'fresh-system-install'
	$uninstaller = Assert-Registration 'fresh-system-install'
	Invoke-Setup $uninstaller 'system-uninstall' -Uninstall
	if (@(Get-BackboardRegistration).Count -ne 0) { throw 'System uninstall left an Installed apps entry' }

	Write-Host 'Fresh user/system installs, user background update, and uninstall checks passed.'
} finally {
	$observations | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $evidence 'installed-apps-evidence.json')
}
