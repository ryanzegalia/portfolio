# Portfolio NSSM service installer.
# Mirrors portfolio nssm-setup patterns.
#
# Wraps `wsl -d Ubuntu -e docker compose ... up -d` so the portfolio stack
# auto-starts on Windows boot and auto-restarts on crash.
#
# Run as admin from the server:
#   .\portfolio.ps1
#
# Side-effects:
#   - registers a Windows service named "Portfolio"
#   - opens Windows Firewall TCP 8550 inbound on the Public profile
#
# Removes the service:
#   nssm.exe stop Portfolio
#   nssm.exe remove Portfolio confirm

$ErrorActionPreference = "Stop"

$serviceName = "Portfolio"
$nssmPath    = "C:\Program Files\Jellyfin\Server\nssm.exe"
$composeDir  = "/home/youruser/docker/portfolio"
$logDir      = "C:\Services\Portfolio\logs"
$port        = 8550

# Sanity checks
if (-not (Test-Path $nssmPath)) {
    throw "nssm.exe not found at $nssmPath. Install NSSM or update the path."
}

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

# Stop + remove existing service if present
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping and removing existing $serviceName service..."
    & $nssmPath stop $serviceName
    & $nssmPath remove $serviceName confirm
}

# Install the service: NSSM runs `wsl ... docker compose up` and stays attached
Write-Host "Installing $serviceName service..."
& $nssmPath install $serviceName "C:\Windows\System32\wsl.exe" "-d Ubuntu -e docker compose -f $composeDir/docker-compose.yml up"

& $nssmPath set $serviceName DisplayName "Portfolio"
& $nssmPath set $serviceName Description "Ryan Zegalia portfolio site — Docker stack in WSL Ubuntu"
& $nssmPath set $serviceName Start SERVICE_AUTO_START
& $nssmPath set $serviceName AppStdout "$logDir\stdout.log"
& $nssmPath set $serviceName AppStderr "$logDir\stderr.log"
& $nssmPath set $serviceName AppRotateFiles 1
& $nssmPath set $serviceName AppRotateBytes 10485760

# Restart on failure
& $nssmPath set $serviceName AppExit Default Restart
& $nssmPath set $serviceName AppRestartDelay 5000

# Open firewall port 8550 for WSL Docker -> host (Public profile)
$ruleName = "Portfolio-${port}-inbound"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule `
        -DisplayName $ruleName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $port `
        -Profile Public `
        -ErrorAction SilentlyContinue | Out-Null
    Write-Host "Opened firewall TCP $port (Public profile)"
} else {
    Write-Host "Firewall rule $ruleName already present, skipping"
}

# Start it
Write-Host "Starting $serviceName..."
& $nssmPath start $serviceName

Write-Host "Portfolio service installed and started."
Write-Host "Logs: $logDir"
Write-Host "Caddy should already be proxying localhost -> localhost:$port"