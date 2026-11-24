# Loads the latest copy of the client's sheets into the dashboard's database.
#
# Run after the Chrome steps in scripts\chrome have saved sofia-spritz-sheets-all.json
# to the Downloads folder:
#     powershell -ExecutionPolicy Bypass -File .\scripts\refresh.ps1
#
# The copy is moved to the private data folder next to this project (never into the
# project, which is public), turned into private seed files, and pushed to Supabase.

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$data = Join-Path (Split-Path -Parent $project) 'data'
New-Item -ItemType Directory -Force $data | Out-Null

$src = Get-ChildItem "$env:USERPROFILE\Downloads" -Filter 'sofia-spritz-sheets-all*.json' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $src) { Write-Host 'No new copy found in Downloads (sofia-spritz-sheets-all*.json). Nothing loaded.'; exit 2 }
if ($src.LastWriteTime -lt (Get-Date).AddHours(-3)) { Write-Host "The newest copy is old ($($src.LastWriteTime)). Nothing loaded."; exit 2 }

$all = Join-Path $data 'sheets-all.json'
Move-Item $src.FullName $all -Force
# Clear out any older duplicate downloads of the same file.
Get-ChildItem "$env:USERPROFILE\Downloads" -Filter 'sofia-spritz-sheets-all*.json' -ErrorAction SilentlyContinue | Remove-Item -Force

Set-Location $project
$funnel = Join-Path $data 'daily-funnel.json'
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(j.funnel&&j.funnel.tabs&&Object.keys(j.funnel.tabs).length){fs.writeFileSync(process.argv[2],JSON.stringify(j.funnel));console.log('Funnel numbers: updated');}else{console.log('Funnel numbers: not in this copy, keeping the previous ones');}" $all $funnel
if ($LASTEXITCODE -ne 0) { Write-Host 'Could not read the copy.'; exit 1 }

if (Test-Path $funnel) { node scripts/load-funnel.mjs $funnel; if ($LASTEXITCODE -ne 0) { Write-Host 'Funnel loader failed.'; exit 1 } }
node scripts/load-snapshot.mjs $all | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { Write-Host 'Sheet loader failed.'; exit 1 }

# The database connection sometimes drops partway. A rerun carries on where it stopped,
# so try up to five times before giving up.
$n = 0; $ok = $false; $push = ''
foreach ($try in 1..5) {
  $push = npx --yes supabase db push --remote --include-seed --yes 2>&1 | Out-String
  $n += ([regex]::Matches($push, 'Seeding data from')).Count
  if ($LASTEXITCODE -eq 0 -and $push -notmatch '"_tag":"Error"') { $ok = $true; break }
  Start-Sleep -Seconds 10
}
if (-not $ok) { Write-Host 'Supabase push failed after 5 tries:'; Write-Host $push.Substring([Math]::Max(0, $push.Length - 500)); exit 1 }
Write-Host "Loaded. Sheets or tables that had changed and were refreshed: $n. Finished $(Get-Date -Format 'HH:mm')."
