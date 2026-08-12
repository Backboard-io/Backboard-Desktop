[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[string[]]$Path,

	[Parameter(Mandatory = $true)]
	[string]$ExpectedSubject
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$signTool = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
if (-not $signTool) {
	throw 'signtool.exe was not found. Install the Windows SDK before validating release signatures.'
}

$files = foreach ($target in $Path) {
	if (-not (Test-Path -LiteralPath $target)) {
		throw "Signature validation target does not exist: $target"
	}

	$item = Get-Item -LiteralPath $target
	if (-not $item.PSIsContainer) {
		$item
		continue
	}

	Get-ChildItem -LiteralPath $item.FullName -File -Recurse |
		Where-Object { $_.Extension -in '.exe', '.dll', '.node' }
}

$files = @($files | Sort-Object -Property FullName -Unique)
if ($files.Count -eq 0) {
	throw 'No Authenticode-capable release files were found.'
}

$failures = [System.Collections.Generic.List[string]]::new()
foreach ($file in $files) {
	$signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
	if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
		$failures.Add("$($file.FullName): Authenticode status is $($signature.Status)")
		continue
	}
	if (-not $signature.SignerCertificate) {
		$failures.Add("$($file.FullName): signer certificate is missing")
		continue
	}
	if ($signature.SignerCertificate.Subject -ne $ExpectedSubject) {
		$failures.Add("$($file.FullName): expected signer '$ExpectedSubject', got '$($signature.SignerCertificate.Subject)'")
	}
	if (-not $signature.TimeStamperCertificate) {
		$failures.Add("$($file.FullName): RFC 3161 timestamp is missing")
	}

	& $signTool.Source verify /pa /all /tw /q $file.FullName
	if ($LASTEXITCODE -ne 0) {
		$failures.Add("$($file.FullName): signtool verification failed with exit code $LASTEXITCODE")
	}
}

if ($failures.Count -gt 0) {
	$failures | ForEach-Object { Write-Error $_ }
	throw "Authenticode validation failed for $($failures.Count) release file(s)."
}

Write-Host "Authenticode validation passed for $($files.Count) release file(s)."
Write-Host "Publisher: $ExpectedSubject"
