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
# Person 2: build the extension and open VS Code with it on the demo repo (skip with $env:PCP_NO_EDITOR=1).
if (-not $env:PCP_NO_EDITOR -and (Get-Command code -ErrorAction SilentlyContinue) -and (Get-Command npm -ErrorAction SilentlyContinue)) {
  Push-Location extension
  if (-not (Test-Path node_modules)) { npm ci --silent }
  npm run build --silent
  Pop-Location
  $demoRepo = if ($env:PCP_DEMO_REPO) { $env:PCP_DEMO_REPO } elseif (Test-Path bench\repos\flask) { "bench\repos\flask" } else { "fixtures\tiny_repo" }
  code --extensionDevelopmentPath="$PWD\extension" $demoRepo
}
& .\.venv\Scripts\python.exe -m uvicorn pcp_verifier.server:app --host $hostAddr --port $port --app-dir verifier
