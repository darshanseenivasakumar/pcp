# Start the PCP verifier on Windows (PowerShell).
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (Test-Path .env) {
  Get-Content .env | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2; [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim())
  }
}
$hostAddr = if ($env:PCP_HOST) { $env:PCP_HOST } else { "127.0.0.1" }
$port = if ($env:PCP_PORT) { $env:PCP_PORT } else { "8765" }
& .\.venv\Scripts\python.exe -m uvicorn pcp_verifier.server:app --host $hostAddr --port $port --app-dir verifier
# Person 2: start the extension dev host here.
