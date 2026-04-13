# Docker Watchdog Script
# Monitors Docker daemon in WSL and restarts if down
# Schedule via Task Scheduler to run every 5 minutes
#
# Task Scheduler settings:
#   Trigger: Every 5 minutes
#   Action: powershell.exe -ExecutionPolicy Bypass -File "C:\Scripts\docker-watchdog.ps1"
#   Run whether user logged in or not

$ErrorActionPreference = "SilentlyContinue"
$LogFile = "C:\Scripts\logs\docker-watchdog.log"
$MaxLogSize = 5MB

# Ensure log directory exists
$logDir = Split-Path $LogFile -Parent
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    Add-Content -Path $LogFile -Value $logEntry

    # Rotate log if too large
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt $MaxLogSize) {
        $backupLog = "$LogFile.old"
        if (Test-Path $backupLog) { Remove-Item $backupLog -Force }
        Rename-Item $LogFile $backupLog
    }
}

function Test-DockerDaemon {
    # Check if dockerd is running in WSL
    $result = wsl -d Ubuntu -e pgrep -x dockerd 2>$null
    return ($null -ne $result -and $result.Trim() -ne "")
}

function Start-DockerDaemon {
    Write-Log "Attempting to start Docker daemon in WSL..." "WARN"

    # Start Docker service in WSL
    $startResult = wsl -d Ubuntu -e sudo service docker start 2>&1

    # Wait for it to come up
    Start-Sleep -Seconds 5

    # Verify it started
    if (Test-DockerDaemon) {
        Write-Log "Docker daemon started successfully" "INFO"
        return $true
    } else {
        Write-Log "Failed to start Docker daemon. Output: $startResult" "ERROR"
        return $false
    }
}

function Test-WSLRunning {
    # Check if WSL is running
    $wslStatus = wsl -l --running 2>$null
    return ($wslStatus -match "Ubuntu")
}

# Main execution
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# First check if WSL distribution is running
if (-not (Test-WSLRunning)) {
    Write-Log "WSL is not running, starting it..." "WARN"
    wsl -d Ubuntu -e echo "WSL started" 2>$null
    Start-Sleep -Seconds 3
}

# Check Docker daemon
if (Test-DockerDaemon) {
    # Docker is running - no action needed (don't log routine checks to reduce noise)
    exit 0
} else {
    Write-Log "Docker daemon is not running!" "WARN"

    # Attempt restart
    $success = Start-DockerDaemon

    if ($success) {
        # Check if any containers need to be restarted
        Write-Log "Checking for stopped containers with restart policy..." "INFO"

        # Get list of containers that should auto-restart but are stopped
        $stoppedContainers = wsl -d Ubuntu -e docker ps -a --filter "status=exited" --format "{{.Names}}" 2>$null

        if ($stoppedContainers) {
            foreach ($container in $stoppedContainers -split "`n") {
                if ($container.Trim()) {
                    Write-Log "Starting container: $($container.Trim())" "INFO"
                    wsl -d Ubuntu -e docker start $container.Trim() 2>$null
                }
            }
        }

        Write-Log "Docker recovery complete" "INFO"
    } else {
        Write-Log "Docker recovery FAILED - manual intervention required" "ERROR"
        exit 1
    }
}