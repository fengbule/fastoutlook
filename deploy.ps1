$ErrorActionPreference = "Stop"

$AppName = "fastoutlook"
$Port = if ($env:PORT) { $env:PORT } else { "3001" }
$FetchConcurrency = if ($env:FETCH_CONCURRENCY) { $env:FETCH_CONCURRENCY } else { "5" }
$Tenant = if ($env:MS_TENANT) { $env:MS_TENANT } else { "consumers" }
$ClientId = if ($env:MS_CLIENT_ID) { $env:MS_CLIENT_ID } else { "" }
$ClientSecret = if ($env:MS_CLIENT_SECRET) { $env:MS_CLIENT_SECRET } else { "" }
$RedirectUri = if ($env:MS_REDIRECT_URI) { $env:MS_REDIRECT_URI } else { "http://127.0.0.1:$Port/auth/callback" }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Error "Docker is not installed or not in PATH. Install Docker first: https://docs.docker.com/get-docker/"
}

$composeArgs = @("compose", "version")
try {
  docker @composeArgs | Out-Null
  $Compose = @("docker", "compose")
} catch {
  if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
    $Compose = @("docker-compose")
  } else {
    Write-Error "Docker Compose is not available. Install Docker Compose first: https://docs.docker.com/compose/install/"
  }
}

if (-not (Test-Path ".env")) {
@"
PORT=$Port
HOST=0.0.0.0
DOCKER=1
FETCH_CONCURRENCY=$FetchConcurrency
MS_TENANT=$Tenant
MS_CLIENT_ID=$ClientId
MS_CLIENT_SECRET=$ClientSecret
MS_REDIRECT_URI=$RedirectUri
"@ | Set-Content -Encoding UTF8 ".env"
  Write-Host "[OK] Created .env"
} else {
  Write-Host "[OK] Using existing .env"
}

& $Compose[0] @($Compose[1..($Compose.Length - 1)] + @("up", "-d", "--build"))

Write-Host ""
Write-Host "[OK] $AppName deployed."
Write-Host "URL: http://127.0.0.1:$Port"
Write-Host "Logs: $($Compose -join ' ') logs -f"
Write-Host "Stop: $($Compose -join ' ') down"
