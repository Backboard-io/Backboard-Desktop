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
	Invoke-Setup $uninstaller 'user-uninstall' -Uninstall
	if (@(Get-BackboardRegistration).Count -ne 0) { throw 'User uninstall left an Installed apps entry' }

	Invoke-Setup (Join-Path $release 'Backboard-Studio-System-Setup-x64.exe') 'fresh-system-install'
	$uninstaller = Assert-Registration 'fresh-system-install'
	Invoke-Setup $uninstaller 'system-uninstall' -Uninstall
	if (@(Get-BackboardRegistration).Count -ne 0) { throw 'System uninstall left an Installed apps entry' }

	$oldInstaller = Join-Path $env:RUNNER_TEMP 'Backboard-Studio-3.1.1-System.exe'
	Invoke-WebRequest 'https://backboard-studio-releases.s3.ca-central-1.amazonaws.com/ide-releases/stable/latest/bbide/windows-x86_64/Backboard-Studio-System-Setup-x64.exe' -OutFile $oldInstaller
	$oldSignature = Get-AuthenticodeSignature $oldInstaller
	if ($oldSignature.Status -ne 'Valid') { throw 'Old installer signature is not valid' }
	if ((Get-Item $oldInstaller).VersionInfo.ProductVersion -notlike '3.1.1*') { throw 'Expected the previous 3.1.1 installer' }
	Invoke-Setup $oldInstaller 'old-system-install'
	Invoke-Setup (Join-Path $release 'Backboard-Studio-System-Setup-x64.exe') 'upgrade-system-install'
	$uninstaller = Assert-Registration 'upgrade-from-3.1.1'
	Invoke-Setup $uninstaller 'upgrade-uninstall' -Uninstall
	if (@(Get-BackboardRegistration).Count -ne 0) { throw 'Upgrade uninstall left an Installed apps entry' }
	Write-Host 'Fresh user/system installs, upgrade registration, and uninstall checks passed.'
} finally {
	$observations | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $evidence 'installed-apps-evidence.json')
}
