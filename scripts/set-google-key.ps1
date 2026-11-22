# Saves the Google robot's key file into Supabase as the secret GOOGLE_SERVICE_ACCOUNT.
# The key goes straight from your Downloads folder to Supabase. It is not printed,
# and nothing is written into this project folder.
#
# Run from the pl-planner folder:   & .\scripts\set-google-key.ps1
# Or name the file yourself:        & .\scripts\set-google-key.ps1 -KeyFile "C:\path\to\key.json"

param([string]$KeyFile)

$ErrorActionPreference = 'Stop'

if (-not $KeyFile) {
  $found = Get-ChildItem "$env:USERPROFILE\Downloads" -Filter 'pl-planner-sync*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $found) { Write-Host 'No pl-planner-sync*.json key file found in Downloads.' -ForegroundColor Red; exit 1 }
  $KeyFile = $found.FullName
}
if (-not (Test-Path $KeyFile)) { Write-Host "Key file not found: $KeyFile" -ForegroundColor Red; exit 1 }

Write-Host "Using key file: $KeyFile"

# One safe line: the file's bytes in base64. The sync function accepts this form.
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($KeyFile))
$tmp = Join-Path $env:TEMP ("pl-key-" + [Guid]::NewGuid().ToString('N') + ".env")
try {
  [IO.File]::WriteAllText($tmp, "GOOGLE_SERVICE_ACCOUNT=$b64`n")
  npx --yes supabase secrets set --env-file $tmp --yes
  if ($LASTEXITCODE -ne 0) { Write-Host 'Supabase did not accept the secret. Nothing was saved.' -ForegroundColor Red; exit 1 }
  Write-Host 'Done. The key is saved in Supabase as GOOGLE_SERVICE_ACCOUNT.' -ForegroundColor Green
}
finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
}
