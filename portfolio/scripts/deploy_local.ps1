# Portfolio local-network deploy to the server (localhost on the LAN).
#
# Uses a TempTransfer share + WSL pattern. CRITICAL: WSL Linux paths (/mnt/d/...)
# only — Docker builds inside WSL don't see files written through the
# Windows bridge (\\wsl$\...).
#
# Run from the workstation (this directory):
#   .\scripts\deploy_local.ps1
#
# Prereqs:
#   - Docker Desktop on the workstation (this script does the build)
#   - SSH key trust for your-server@localhost (passwordless)
#   - Y:\TempTransfer mapped to the server's D:\Media\TempTransfer
#   - Caddy running on the server
#   - Pi-hole local DNS entry: localhost -> localhost

$ErrorActionPreference = "Stop"

$projectRoot   = Split-Path -Parent $PSScriptRoot
$imageName     = "portfolio-app:latest"
$tarFile       = "portfolio-image.tar"
$tempTransfer  = "Y:\TempTransfer"
$wslComposeDir = "/home/youruser/docker/portfolio"

Write-Host "[1/9] Building Docker image on workstation..."
Push-Location $projectRoot
docker compose build
docker tag portfolio-portfolio-web $imageName 2>$null
Pop-Location

Write-Host "[2/9] Saving image to TempTransfer..."
docker save $imageName -o "$tempTransfer\$tarFile"

Write-Host "[3/9] Copying compose files via TempTransfer..."
Copy-Item -Force "$projectRoot\docker-compose.yml" "$tempTransfer\docker-compose.yml"
Copy-Item -Force "$projectRoot\.env" "$tempTransfer\.env"

Write-Host "[4/9] Creating WSL compose directory on the server..."
ssh your-server@localhost "wsl -d Ubuntu -e mkdir -p $wslComposeDir"

Write-Host "[5/9] Copying compose files into WSL..."
ssh your-server@localhost "wsl -d Ubuntu -e cp /mnt/d/Media/TempTransfer/docker-compose.yml $wslComposeDir/"
ssh your-server@localhost "wsl -d Ubuntu -e cp /mnt/d/Media/TempTransfer/.env $wslComposeDir/"

Write-Host "[6/9] Loading image inside WSL..."
ssh your-server@localhost "wsl -d Ubuntu -e docker load -i /mnt/d/Media/TempTransfer/$tarFile"

Write-Host "[7/9] Bringing the stack up..."
ssh your-server@localhost "wsl -d Ubuntu -e docker compose -f $wslComposeDir/docker-compose.yml up -d"

Write-Host "[8/9] Reloading Caddy..."
ssh your-server@localhost 'schtasks /End /TN "Caddy"; schtasks /Run /TN "Caddy"'

Write-Host "[9/9] Smoke-checking localhost..."
Start-Sleep -Seconds 3
$response = Invoke-WebRequest -Uri "http://localhost/" -UseBasicParsing -ErrorAction SilentlyContinue
if ($response -and $response.StatusCode -eq 200) {
    Write-Host "Deploy complete. http://localhost is up."
} else {
    Write-Warning "Deploy script finished, but http://localhost did not return 200. Check Pi-hole DNS, Caddyfile, and the portfolio container logs."
}

Write-Host ""
Write-Host "Caddyfile snippet to append to C:\Caddy\Caddyfile if not yet present:"
Write-Host ""
Write-Host "localhost {"
Write-Host "    reverse_proxy localhost:8550"
Write-Host "    log {"
Write-Host "        output file C:\Caddy\logs\portfolio.log"
Write-Host "    }"
Write-Host "    header {"
Write-Host "        X-Content-Type-Options ""nosniff"""
Write-Host "        Referrer-Policy ""strict-origin-when-cross-origin"""
Write-Host "    }"
Write-Host "}"
Write-Host ""
Write-Host "Pi-hole local DNS entry: localhost -> localhost"