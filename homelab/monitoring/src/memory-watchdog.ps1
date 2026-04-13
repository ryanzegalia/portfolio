# Memory Leak Watchdog
# Monitors processes for memory leaks, auto-restarts when threshold exceeded, alerts via Discord
# Schedule via Task Scheduler to run every 10 minutes
#
# Task Scheduler settings:
#   Trigger: Every 10 minutes
#   Action: powershell.exe -ExecutionPolicy Bypass -File "C:\Scripts\memory-watchdog.ps1"
#   Run whether user logged in or not

$ErrorActionPreference = "SilentlyContinue"
$LogFile = "C:\Scripts\logs\memory-watchdog.log"
$StateFile = "C:\Scripts\logs\memory-watchdog-state.json"
$MaxLogSize = 2MB

# Configuration
$DiscordWebhook = "https://discord.com/api/webhooks/YOUR_WEBHOOK"
$CooldownMinutes = 30

# Processes to monitor with their thresholds and restart methods
# ThresholdMB = memory threshold in MB that triggers action
# RestartType = "service" (uses Restart-Service) or "process" (kills and starts exe)
# RestartTarget = service name OR full path to executable
# AlertOnly = $true means only send alert, don't restart (for services where restart would disrupt users)
$MonitoredProcesses = @(
    @{ ProcessName = "MediaServiceA"; ThresholdMB = 1024; RestartType = "service"; RestartTarget = "MediaServiceA"; AlertOnly = $false }
    @{ ProcessName = "MediaServiceB"; ThresholdMB = 1024; RestartType = "service"; RestartTarget = "MediaServiceB"; AlertOnly = $false }
    @{ ProcessName = "IndexerService"; ThresholdMB = 768; RestartType = "service"; RestartTarget = "IndexerService"; AlertOnly = $false }
    @{ ProcessName = "DownloadServiceA"; ThresholdMB = 1024; RestartType = "service"; RestartTarget = "DownloadServiceA"; AlertOnly = $false }
    @{ ProcessName = "DownloadServiceB"; ThresholdMB = 1024; RestartType = "process"; RestartTarget = "C:\Program Files\DownloadClient\client.exe"; AlertOnly = $false }
)

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

function Get-ProcessMemoryMB {
    param([string]$ProcessName)

    try {
        $processes = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
        if ($null -eq $processes) {
            return $null  # Process not running
        }

        # Sum memory if multiple instances (rare but possible)
        $totalBytes = ($processes | Measure-Object -Property WorkingSet64 -Sum).Sum
        return [math]::Round($totalBytes / 1MB, 0)
    } catch {
        Write-Log "Failed to get memory for ${ProcessName}: $_" "ERROR"
        return $null
    }
}

function Get-WatchdogState {
    if (-not (Test-Path $StateFile)) {
        return @{}
    }

    try {
        $json = Get-Content $StateFile -Raw | ConvertFrom-Json
        $state = @{}
        $json.PSObject.Properties | ForEach-Object {
            $state[$_.Name] = @{
                lastRestartTime = $_.Value.lastRestartTime
                lastMemoryMB = $_.Value.lastMemoryMB
                restartCount = $_.Value.restartCount
            }
        }
        return $state
    } catch {
        Write-Log "Failed to parse state file, creating fresh state: $_" "WARN"
        return @{}
    }
}

function Save-WatchdogState {
    param([hashtable]$State)

    try {
        $json = $State | ConvertTo-Json -Depth 3 -Compress
        Set-Content -Path $StateFile -Value $json -Force
    } catch {
        Write-Log "Failed to save state file: $_" "ERROR"
    }
}

function Test-CooldownExpired {
    param(
        [string]$ProcessName,
        [hashtable]$State
    )

    if (-not $State.ContainsKey($ProcessName)) {
        return $true  # Never restarted before
    }

    $lastRestart = $State[$ProcessName].lastRestartTime
    if ($null -eq $lastRestart) {
        return $true
    }

    $lastRestartTime = [DateTime]$lastRestart
    $timeSinceRestart = (Get-Date) - $lastRestartTime

    return ($timeSinceRestart.TotalMinutes -ge $CooldownMinutes)
}
function Restart-LeakyProcess {
    param(
        [hashtable]$ProcessConfig
    )

    $name = $ProcessConfig.ProcessName
    $restartType = $ProcessConfig.RestartType
    $target = $ProcessConfig.RestartTarget

    Write-Log "Attempting to restart $name (type: $restartType)" "WARN"

    try {
        if ($restartType -eq "service") {
            # Restart Windows service
            Restart-Service -Name $target -Force -ErrorAction Stop
            Start-Sleep -Seconds 5  # Wait for service to start
        } else {
            # Kill process and start executable
            Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force
            Start-Sleep -Seconds 2  # Wait for process to die
            Start-Process -FilePath $target -ErrorAction Stop
            Start-Sleep -Seconds 5  # Wait for process to start
        }

        Write-Log "Successfully restarted $name" "INFO"
        return $true
    } catch {
        Write-Log "Failed to restart $name : $_" "ERROR"
        return $false
    }
}

function Send-DiscordAlert {
    param(
        [string]$ProcessName,
        [int]$MemoryBeforeMB,
        [int]$ThresholdMB,
        [int]$MemoryAfterMB,
        [string]$AlertType = "threshold"  # "threshold", "scheduled", or "alertonly"
    )

    if ($AlertType -eq "scheduled") {
        $color = 3447003  # Blue
        $title = "[MAINTENANCE] Scheduled Restart"
        $description = "**$ProcessName** was restarted as part of scheduled maintenance"
        $action = "Restarted"
    } elseif ($AlertType -eq "alertonly") {
        $color = 15844367  # Yellow/Gold
        $title = "[MEMORY] High Memory Warning"
        $description = "**$ProcessName** has exceeded memory threshold (manual restart may be needed)"
        $action = "Alert Only"
    } else {
        $color = 15105570  # Orange
        $title = "[MEMORY] Watchdog Alert"
        $description = "**$ProcessName** was auto-restarted due to high memory usage"
        $action = "Restarted"
    }

    $fields = @(
        @{ name = "Process"; value = $ProcessName; inline = $true }
        @{ name = "Action"; value = $action; inline = $true }
        @{ name = "Cooldown"; value = "$CooldownMinutes min"; inline = $true }
    )

    if ($AlertType -ne "scheduled") {
        $fields += @{ name = "Current Memory"; value = "$MemoryBeforeMB MB"; inline = $true }
        $fields += @{ name = "Threshold"; value = "$ThresholdMB MB"; inline = $true }
    }

    if ($AlertType -eq "threshold" -and $null -ne $MemoryAfterMB -and $MemoryAfterMB -gt 0) {
        $fields += @{ name = "Memory After"; value = "$MemoryAfterMB MB"; inline = $true }
    }

    $payload = @{
        embeds = @(
            @{
                title = $title
                description = $description
                color = $color
                fields = $fields
                footer = @{ text = "Memory Watchdog" }
                timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            }
        )
    } | ConvertTo-Json -Depth 10 -Compress

    try {
        Invoke-RestMethod -Uri $DiscordWebhook -Method POST -Body $payload -ContentType "application/json" -TimeoutSec 10
        Write-Log "Discord alert sent for $ProcessName" "INFO"
        return $true
    } catch {
        Write-Log "Failed to send Discord alert: $_" "ERROR"
        return $false
    }
}

# Main execution
Write-Log "Memory watchdog check started" "INFO"

# Load state
$state = Get-WatchdogState

$restartedAny = $false

# Check each monitored process
foreach ($procConfig in $MonitoredProcesses) {
    $name = $procConfig.ProcessName
    $threshold = $procConfig.ThresholdMB
    $alertOnly = $procConfig.AlertOnly

    $currentMemory = Get-ProcessMemoryMB -ProcessName $name

    if ($null -eq $currentMemory) {
        # Process not running - could log this but it's often normal
        continue
    }

    # Check if over threshold
    if ($currentMemory -gt $threshold) {
        Write-Log "$name using $currentMemory MB (threshold: $threshold MB) - OVER THRESHOLD" "WARN"

        # Check cooldown
        if (Test-CooldownExpired -ProcessName $name -State $state) {

            if ($alertOnly) {
                # Alert-only mode: send notification without restart
                Write-Log "$name is alert-only, sending notification without restart" "WARN"
                Send-DiscordAlert -ProcessName $name -MemoryBeforeMB $currentMemory -ThresholdMB $threshold -AlertType "alertonly"

                # Update state (for cooldown tracking)
                if (-not $state.ContainsKey($name)) {
                    $state[$name] = @{ lastRestartTime = $null; lastMemoryMB = $null; restartCount = 0 }
                }
                $state[$name].lastRestartTime = Get-Date
                $state[$name].lastMemoryMB = $currentMemory
            } else {
                # Auto-restart mode
                Write-Log "$name cooldown expired, initiating restart" "WARN"

                # Restart the process
                $success = Restart-LeakyProcess -ProcessConfig $procConfig

                if ($success) {
                    $restartedAny = $true

                    # Wait a moment then check new memory
                    Start-Sleep -Seconds 3
                    $newMemory = Get-ProcessMemoryMB -ProcessName $name

                    # Send alert
                    Send-DiscordAlert -ProcessName $name -MemoryBeforeMB $currentMemory -ThresholdMB $threshold -MemoryAfterMB $newMemory

                    # Update state
                    if (-not $state.ContainsKey($name)) {
                        $state[$name] = @{ lastRestartTime = $null; lastMemoryMB = $null; restartCount = 0 }
                    }
                    $state[$name].lastRestartTime = Get-Date
                    $state[$name].lastMemoryMB = $currentMemory
                    $state[$name].restartCount = $state[$name].restartCount + 1
                }
            }
        } else {
            $lastRestart = [DateTime]$state[$name].lastRestartTime
            $minutesRemaining = [math]::Round($CooldownMinutes - ((Get-Date) - $lastRestart).TotalMinutes, 0)
            Write-Log "$name over threshold but in cooldown ($minutesRemaining min remaining)" "INFO"
        }
    } else {
        # Log high memory usage even if under threshold (for tracking trends)
        $warningLevel = [math]::Round($threshold * 0.75, 0)
        if ($currentMemory -gt $warningLevel) {
            Write-Log "$name using $currentMemory MB (threshold: $threshold MB) - approaching threshold" "INFO"
        }
    }
}

# Save state
Save-WatchdogState -State $state

if ($restartedAny) {
    Write-Log "Memory watchdog check completed (restarts performed)" "WARN"
} else {
    Write-Log "Memory watchdog check completed (all normal)" "INFO"
}