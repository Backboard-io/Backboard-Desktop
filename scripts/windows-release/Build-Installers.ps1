[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$ApplicationPath,
	[Parameter(Mandatory = $true)][string]$RepositoryPath,
	[Parameter(Mandatory = $true)][string]$OutputPath,
	[Parameter(Mandatory = $true)][string]$CompilerPath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$app = (Resolve-Path $ApplicationPath).Path
$repo = (Resolve-Path $RepositoryPath).Path
New-Item -ItemType Directory -Force $OutputPath | Out-Null
$output = (Resolve-Path $OutputPath).Path
$product = Get-Content -Raw (Join-Path $app 'resources\app\product.json') | ConvertFrom-Json
if ($product.commit -notmatch '^[a-fA-F0-9]{40}$') { throw 'Signed application has no valid source commit' }
if ($product.backboardVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version in signed application' }
if ($product.PSObject.Properties['win32VersionedUpdate'] -and $product.win32VersionedUpdate) { throw 'This installer path expects an unversioned application layout' }

foreach ($target in @('system', 'user')) {
	$targetOutput = Join-Path $output $target
	New-Item -ItemType Directory -Force $targetOutput | Out-Null
	$targetProduct = Get-Content -Raw (Join-Path $app 'resources\app\product.json') | ConvertFrom-Json
	$targetProduct | Add-Member -NotePropertyName target -NotePropertyValue $target -Force
	$productPath = Join-Path $targetOutput 'product.json'
	$targetProduct | ConvertTo-Json -Depth 100 | Set-Content $productPath -Encoding utf8NoBOM
	$definitions = [ordered]@{
		NameLong = $product.nameLong
		PublisherName = $product.companyName
		NameShort = $product.nameShort
		DirName = $product.win32DirName
		Version = $product.backboardVersion
		RawVersion = $product.backboardVersion
		Commit = $product.commit
		NameVersion = $product.win32NameVersion + $(if ($target -eq 'user') { ' (User)' } else { '' })
		ExeBasename = $product.nameShort
		RegValueName = $product.win32RegValueName
		ShellNameShort = $product.win32ShellNameShort
		AppMutex = $product.win32MutexName
		TunnelMutex = $product.win32TunnelMutex
		TunnelServiceMutex = $product.win32TunnelServiceMutex
		TunnelApplicationName = $product.tunnelApplicationName
		ApplicationName = $product.applicationName
		Arch = 'x64'
		AppId = $(if ($target -eq 'user') { $product.win32x64UserAppId } else { $product.win32x64AppId })
		IncompatibleTargetAppId = $product.win32x64AppId
		AppUserId = $product.win32AppUserModelId
		ArchitecturesAllowed = 'x64'
		ArchitecturesInstallIn64BitMode = 'x64'
		SourceDir = $app
		RepoDir = $repo
		OutputDir = $targetOutput
		InstallTarget = $target
		ProductJsonPath = $productPath
		VersionedResourcesFolder = ''
		Quality = 'dev'
	}
	$arguments = @((Join-Path $repo 'build\win32\code.iss'))
	foreach ($entry in $definitions.GetEnumerator()) {
		if ($null -eq $entry.Value) { throw "Missing installer definition: $($entry.Key)" }
		$arguments += "/d$($entry.Key)=$($entry.Value)"
	}
	& $CompilerPath @arguments
	if ($LASTEXITCODE -ne 0) { throw "$target installer compilation failed" }
	$name = if ($target -eq 'user') { 'User' } else { 'System' }
	Move-Item (Join-Path $targetOutput 'VSCodeSetup.exe') (Join-Path $output "Backboard-Studio-$name-Setup-x64.exe") -Force
	Remove-Item -LiteralPath $targetOutput -Recurse -Force
}
