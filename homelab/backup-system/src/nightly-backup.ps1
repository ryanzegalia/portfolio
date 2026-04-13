# Nightly Disaster Recovery Backup
# Backs up all service databases, configs, Docker volumes, and system state
# Runs daily at 3:00 AM via Task Scheduler
#
# SANITIZED EXCERPT: Shows key architectural patterns only.
# Full script is ~2000 lines covering 9 backup categories.

param(
    [switch]$DryRun  # Simulate backup without writing files
)

$ErrorActionPreference = "SilentlyContinue"
$LogFile = "$PSScriptRoot\logs\nightly-backup.log"
$TranscriptFile = "$PSScriptRoot\logs\nightly-backup-transcript.log"
$MaxLogSize = 5MB

# Start transcript to capture ALL PowerShell output (the forensic record)
try {
    if (Test-Path $TranscriptFile) {
        $oldTranscript = "$TranscriptFile.old"
        if (Test-Path $oldTranscript) { Remove-Item $oldTranscript -Force }
        Rename-Item $TranscriptFile $oldTranscript -ErrorAction SilentlyContinue
    }
    Start-Transcript -Path $TranscriptFile -Force | Out-Null
} catch {
    # Transcript failure shouldn't stop the backup
}

# Configuration
$BackupRoot = "D:\Backups\nightly"
$DiscordWebhook = "https://discord.com/api/webhooks/YOUR_WEBHOOK"
$DateStamp = Get-Date -Format "yyyy-MM-dd"
$TodayBackupDir = "$BackupRoot\daily\$DateStamp"

# Retention
$DailyRetentionDays = 7
$WeeklyRetentionDays = 28
$MonthlyRetentionDays = 60

# Service API keys (for triggering service backups)
$MediaServiceAKey = "YOUR_API_KEY"
$MediaServiceBKey = "YOUR_API_KEY"
$IndexerServiceKey = "YOUR_API_KEY"

# Media management services to back up via API
$ManagedServices = @(
    @{ Name = "MediaServiceA"; Port = 8001; ApiKey = $MediaServiceAKey; DataDir = "$env:ProgramData\ServiceA"; ApiVersion = "v3"; MinSizeMB = 1 }
    @{ Name = "MediaServiceB"; Port = 8002; ApiKey = $MediaServiceBKey; DataDir = "$env:ProgramData\ServiceB"; ApiVersion = "v3"; MinSizeMB = 1 }
    @{ Name = "IndexerService"; Port = 8003; ApiKey = $IndexerServiceKey; DataDir = "$env:ProgramData\Indexer"; ApiVersion = "v1"; MinSizeMB = 0.1 }
)

# Tracking
$script:Results = @()
$script:Failures = @()
$script:Warnings = @()
$script:TotalSizeBytes = 0
$script:WSLAvailable = $false
$StartTime = Get-Date

# ==========================================
# Crash-Safe Alert (works even if nothing else is loaded)
# ==========================================

function Send-CrashAlert {
    param([string]$ErrorMessage)
    try {
        $payload = @{
            embeds = @(@{
                title = "[CRASH] Nightly Backup Script Failed"
                description = "The backup script crashed before completing. Check transcript log for details."
                color = 15548997  # Red
                fields = @(
                    @{ name = "Error"; value = if ($ErrorMessage.Length -gt 1000) { $ErrorMessage.Substring(0, 1000) + "..." } else { $ErrorMessage }; inline = $false }
                    @{ name = "Transcript"; value = "``$TranscriptFile``"; inline = $false }
                )
                footer = @{ text = "Backup System" }
                timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            })
        } | ConvertTo-Json -Depth 10 -Compress
        Invoke-RestMethod -Uri $DiscordWebhook -Method POST -Body $payload -ContentType "application/json" -TimeoutSec 10
    } catch {
        # Last resort - if even the alert fails, at least the transcript has the error
    }
}

# ==========================================
# Pre-Flight Checks
# ==========================================

function Invoke-PreFlightChecks {
    Write-Log "Running pre-flight checks" "INFO"
    $critical = $false

    # Check backup drive is mounted
    if (-not (Test-Path "D:\Backups")) {
        Write-Log "CRITICAL: Backup volume not accessible!" "ERROR"
        Send-CrashAlert "Pre-flight FAILED: Backup volume not accessible. No backups can be written."
        $critical = $true
    }

    # Check backup root is writable
    if (-not $critical -and -not $DryRun) {
        $testFile = "$BackupRoot\.write-test"
        try {
            New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
            Set-Content -Path $testFile -Value "test" -ErrorAction Stop
            Remove-Item $testFile -Force
            Write-Log "Backup root is writable: $BackupRoot" "INFO"
        } catch {
            Write-Log "CRITICAL: Cannot write to backup root $BackupRoot - $_" "ERROR"
            Send-CrashAlert "Pre-flight FAILED: Cannot write to ${BackupRoot}. Permission denied or drive full."
            $critical = $true
        }
    }

    if ($critical) {
        Write-Log "Pre-flight checks FAILED - aborting backup" "ERROR"
        try { Stop-Transcript } catch { }
        exit 1
    }

    # Check WSL availability (non-critical - skip Docker backups if down)
    # WSL2 VM can auto-suspend when idle -- wake it first, then verify
    try {
        Write-Log "Waking WSL..." "INFO"
        wsl -d Ubuntu -e true 2>&1 | Out-Null
        Start-Sleep -Seconds 10

        # Verify with retries
        $maxRetries = 3
        $script:WSLColdBooted = $false
        for ($i = 1; $i -le $maxRetries; $i++) {
            $wslTest = wsl -d Ubuntu -e echo "WSL_OK" 2>&1
            if ($wslTest -match "WSL_OK") {
                $script:WSLAvailable = $true
                if ($i -eq 1) {
                    Write-Log "WSL is running" "INFO"
                } else {
                    Write-Log "WSL is running (took $i attempts to wake)" "INFO"
                    $script:WSLColdBooted = $true
                }
                break
            }
            if ($i -lt $maxRetries) {
                Write-Log "WSL not ready yet, retrying in 10s (attempt $i/$maxRetries)..." "WARN"
                Start-Sleep -Seconds 10
            }
        }
        if (-not $script:WSLAvailable) {
            Add-Warning "WSL is NOT running after $maxRetries attempts - all Docker backups will be skipped"
        }

        # After WSL cold boot, Docker containers need time to initialize
        if ($script:WSLAvailable -and $script:WSLColdBooted) {
            Write-Log "WSL was cold-booted - waiting 30s for Docker containers to stabilize..." "INFO"
            Start-Sleep -Seconds 30
        }
    } catch {
        $script:WSLAvailable = $false
        Add-Warning "WSL check failed - all Docker backups will be skipped"
    }

    # Check disk space
    try {
        $dDrive = Get-PSDrive -Name D -PSProvider FileSystem -ErrorAction Stop
        $freeGB = [math]::Round($dDrive.Free / 1GB, 1)
        if ($freeGB -lt 20) {
            Add-Warning "Low disk space on backup drive - only ${freeGB}GB free (recommend 20GB+)"
        } else {
            Write-Log "Backup drive has ${freeGB}GB free" "INFO"
        }
    } catch {
        Add-Warning "Could not check backup drive space"
    }

    Write-Log "Pre-flight checks passed" "INFO"
}

# ==========================================
# API-Triggered Service Backup (with polling + fallback)
# ==========================================

function Invoke-ServiceBackup {
    param(
        [string]$Name,
        [int]$Port,
        [string]$ApiKey,
        [string]$DataDir,
        [string]$ApiVersion,
        [double]$MinSizeMB = 1
    )

    $destPath = "$TodayBackupDir\databases\$($Name.ToLower())"
    Write-Log "Triggering $Name API backup" "INFO"
    $sw = [Diagnostics.Stopwatch]::StartNew()

    if ($DryRun) {
        Write-Log "[DRY RUN] Would trigger $Name backup via API" "INFO"
        Add-Result -Category "databases" -Name $Name -Success $true -SizeMB 0
        return
    }

    try {
        # Trigger backup via API
        $headers = @{ "X-Api-Key" = $ApiKey; "Content-Type" = "application/json" }
        $body = '{"name": "Backup"}'
        $uri = "http://localhost:$Port/api/$ApiVersion/command"

        $response = Invoke-RestMethod -Uri $uri -Method POST -Headers $headers -Body $body -TimeoutSec 30

        # Wait for backup to complete
        $commandId = $response.id
        $maxWait = 60  # seconds
        $waited = 0
        $completed = $false

        while ($waited -lt $maxWait) {
            Start-Sleep -Seconds 5
            $waited += 5

            try {
                $status = Invoke-RestMethod -Uri "http://localhost:$Port/api/$ApiVersion/command/$commandId" -Headers $headers -TimeoutSec 10
                if ($status.status -eq "completed") {
                    $completed = $true
                    break
                } elseif ($status.status -eq "failed") {
                    $sw.Stop()
                    Add-Result -Category "databases" -Name $Name -Success $false -ErrorMsg "API backup command failed" -DurationSec ([math]::Round($sw.Elapsed.TotalSeconds, 1))
                    return
                }
            } catch {
                # Status check failed, continue waiting
            }
        }

        if (-not $completed) {
            Add-Warning "$Name backup command did not complete within ${maxWait}s, copying latest available"
        }

        # Find and copy the latest backup file
        $backupDir = "$DataDir\Backups"
        if (-not (Test-Path $backupDir)) {
            $sw.Stop()
            Add-Result -Category "databases" -Name $Name -Success $false -ErrorMsg "Backup directory not found: $backupDir" -DurationSec ([math]::Round($sw.Elapsed.TotalSeconds, 1))
            return
        }

        $latestBackup = Get-ChildItem -Path "$backupDir\*" -Include "*.zip" -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1

        if ($null -eq $latestBackup) {
            $sw.Stop()
            Add-Result -Category "databases" -Name $Name -Success $false -ErrorMsg "No backup zip found in $backupDir" -DurationSec ([math]::Round($sw.Elapsed.TotalSeconds, 1))
            return
        }

        # Copy the backup
        New-Item -ItemType Directory -Path $destPath -Force | Out-Null
        Copy-Item $latestBackup.FullName "$destPath\$($latestBackup.Name)" -Force

        # Also copy config for quick reference
        if (Test-Path "$DataDir\config.xml") {
            Copy-Item "$DataDir\config.xml" "$destPath\config.xml" -Force
        }

        $sizeMB = [math]::Round($latestBackup.Length / 1MB, 2)

        if ($sizeMB -lt $MinSizeMB) {
            Add-Warning "$Name backup undersized: ${sizeMB}MB (expected >=${MinSizeMB}MB)"
        }

        $sw.Stop()
        Add-Result -Category "databases" -Name $Name -Success $true -SizeMB $sizeMB -DurationSec ([math]::Round($sw.Elapsed.TotalSeconds, 1))
        Write-Log "$Name API backup complete: $($latestBackup.Name) (${sizeMB}MB)" "INFO"
    } catch {
        $sw.Stop()
        Add-Result -Category "databases" -Name $Name -Success $false -ErrorMsg $_.Exception.Message -DurationSec ([math]::Round($sw.Elapsed.TotalSeconds, 1))
    }
}

# ==========================================
# Docker Database Dump (with health check polling)
# ==========================================

function Backup-DockerDatabase {
    param(
        [string]$Name,
        [string]$ContainerName,
        [string]$DumpCommand,
        [string]$DestFile,
        [double]$MinSizeMB = 0.01
    )

    Write-Log "Backing up Docker database: $Name ($ContainerName)" "INFO"
    $sw = [Diagnostics.Stopwatch]::StartNew()

    if ($DryRun) {
        Write-Log "[DRY RUN] Would dump Docker database $Name" "INFO"
        Add-Result -Category "docker" -Name $Name -Success $true -SizeMB 0
        return
    }

    try {
        $destPath = Split-Path $DestFile -Parent
        New-Item -ItemType Directory -Path $destPath -Force | Out-Null

        # Check if container is running
        $containerCheck = wsl -d Ubuntu -e docker inspect -f '{{.State.Running}}' $ContainerName 2>&1
        if ($containerCheck -ne "true") {
            $sw.Stop()
            Add-Result -Category "docker" -Name $Name -Success $false -ErrorMsg "Container $ContainerName not running" -DurationSec ([math]::Round($sw.Elapsed.TotalSeconds, 1))
            return
        }

        # Wait for container health check if it has one and is still starting
        $healthStatus = wsl -d Ubuntu -e docker inspect -f '{{.State.Health.Status}}' $ContainerName 2>&1
        if ($healthStatus -eq "starting") {
            Write-Log "Waiting for $ContainerName to become healthy..." "INFO"
            $healthWait = 0
            while ($healthWait -lt 60 -and $healthStatus -eq "starting") {
                Start-Sleep -Seconds 5
                $healthWait += 5
                $healthStatus = wsl -d Ubuntu -e docker inspect -f '{{.State.Health.Status}}' $ContainerName 2>&1
            }
            if ($healthStatus -eq "healthy") {
                Write-Log "$ContainerName is healthy (waited ${healthWait}s)" "INFO"
            } else {
                Write-Log "$ContainerName health: $healthStatus after ${healthWait}s wait" "WARN"
            }
        }

        # Execute dump command inside container
        $output = wsl -d Ubuntu -e docker exec $ContainerName $DumpCommand.Split(" ") 2>&1
        Set-Content -Path $DestFile -Value $output -Encoding UTF8

        if (Test-Path $DestFile) {
            # Validate dump content
            $firstLine = Get-Content $DestFile -TotalCount 1 -ErrorAction SilentlyContinue
            if ($firstLine -match "^pg_dump.*error|^pg_dumpall.*error") {
                $sw.Stop()
                Add-Result -Category "docker" -Name $Name -Success $false -ErrorMsg "Dump contains error: $firstLine" -DurationSec ([math]::Round($sw.Elapsed.TotalSeconds, 1))
                return
            }

            $sizeMB = [math]::Round((Get-Item $DestFile).Length / 1MB, 2)

            if ($sizeMB -lt $MinSizeMB) {
                Add-Warning "$Name dump undersized: ${sizeMB}MB"
            }

            $sw.Stop()
            Add-Result -Category "docker" -Name $Name -Success $true -SizeMB $sizeMB -DurationSec ([math]::Round($sw.Elapsed.TotalSeconds, 1))
            Write-Log "$Name Docker dump: ${sizeMB}MB" "INFO"
        } else {
            $sw.Stop()
            Add-Result -Category "docker" -Name $Name -Success $false -ErrorMsg "Dump file not created" -DurationSec ([math]::Round($sw.Elapsed.TotalSeconds, 1))
        }
    } catch {
        $sw.Stop()
        Add-Result -Category "docker" -Name $Name -Success $false -ErrorMsg $_.Exception.Message -DurationSec ([math]::Round($sw.Elapsed.TotalSeconds, 1))
    }
}

# ==========================================
# Retention: Promotion + Cleanup
# ==========================================

function Invoke-RetentionCleanup {
    Write-Log "Starting retention cleanup" "INFO"

    if ($DryRun) {
        Write-Log "[DRY RUN] Would clean up old backups" "INFO"
        return
    }

    $now = Get-Date

    # Clean up old daily backups
    $dailyPath = "$BackupRoot\daily"
    if (Test-Path $dailyPath) {
        Get-ChildItem $dailyPath -Directory | ForEach-Object {
            try {
                $backupDate = [DateTime]::ParseExact($_.Name, "yyyy-MM-dd", $null)
                $age = ($now - $backupDate).Days

                if ($age -gt $DailyRetentionDays) {
                    # Don't delete if it's a weekly (Sunday) or monthly (1st)
                    $isWeekly = ($backupDate.DayOfWeek -eq "Sunday") -and ($age -le $WeeklyRetentionDays)
                    $isMonthly = ($backupDate.Day -eq 1) -and ($age -le $MonthlyRetentionDays)

                    if (-not $isWeekly -and -not $isMonthly) {
                        Write-Log "Deleting old daily backup: $($_.Name) (${age}d old)" "INFO"
                        Remove-Item $_.FullName -Recurse -Force
                    }
                }
            } catch {
                Write-Log "Skipping non-date directory: $($_.Name)" "WARN"
            }
        }
    }

    # Clean up old weekly backups
    $weeklyPath = "$BackupRoot\weekly"
    if (Test-Path $weeklyPath) {
        Get-ChildItem $weeklyPath -Directory | ForEach-Object {
            try {
                $backupDate = [DateTime]::ParseExact($_.Name, "yyyy-MM-dd", $null)
                $age = ($now - $backupDate).Days

                if ($age -gt $WeeklyRetentionDays) {
                    $isMonthly = ($backupDate.Day -eq 1) -and ($age -le $MonthlyRetentionDays)
                    if (-not $isMonthly) {
                        Write-Log "Deleting old weekly backup: $($_.Name) (${age}d old)" "INFO"
                        Remove-Item $_.FullName -Recurse -Force
                    }
                }
            } catch {
                Write-Log "Skipping non-date directory: $($_.Name)" "WARN"
            }
        }
    }

    # Clean up old monthly backups
    $monthlyPath = "$BackupRoot\monthly"
    if (Test-Path $monthlyPath) {
        Get-ChildItem $monthlyPath -Directory | ForEach-Object {
            try {
                $backupDate = [DateTime]::ParseExact($_.Name, "yyyy-MM-dd", $null)
                $age = ($now - $backupDate).Days

                if ($age -gt $MonthlyRetentionDays) {
                    Write-Log "Deleting old monthly backup: $($_.Name) (${age}d old)" "INFO"
                    Remove-Item $_.FullName -Recurse -Force
                }
            } catch {
                Write-Log "Skipping non-date directory: $($_.Name)" "WARN"
            }
        }
    }

    Write-Log "Retention cleanup completed" "INFO"
}

function Invoke-WeeklyMonthlyPromotion {
    Write-Log "Checking weekly/monthly promotion" "INFO"

    if ($DryRun) {
        Write-Log "[DRY RUN] Would check promotion" "INFO"
        return
    }

    $today = Get-Date

    # Promote to weekly on Sundays
    if ($today.DayOfWeek -eq "Sunday") {
        $weeklyDest = "$BackupRoot\weekly\$DateStamp"
        if (-not (Test-Path $weeklyDest)) {
            Write-Log "Promoting to weekly backup: $DateStamp" "INFO"
            New-Item -ItemType Directory -Path $weeklyDest -Force | Out-Null
            robocopy $TodayBackupDir $weeklyDest /MIR /R:3 /W:5 /NP /NFL /NDL /NJH /NJS | Out-Null
            Write-Log "Weekly backup created" "INFO"
        }
    }

    # Promote to monthly on 1st of month
    if ($today.Day -eq 1) {
        $monthlyDest = "$BackupRoot\monthly\$DateStamp"
        if (-not (Test-Path $monthlyDest)) {
            Write-Log "Promoting to monthly backup: $DateStamp" "INFO"
            New-Item -ItemType Directory -Path $monthlyDest -Force | Out-Null
            robocopy $TodayBackupDir $monthlyDest /MIR /R:3 /W:5 /NP /NFL /NDL /NJH /NJS | Out-Null
            Write-Log "Monthly backup created" "INFO"
        }
    }
}

# ==========================================
# Main Execution (abbreviated)
# ==========================================

Invoke-PreFlightChecks

try {

Write-Log "================================================================" "INFO"
Write-Log "  NIGHTLY BACKUP STARTED$(if ($DryRun) { ' [DRY RUN]' })" "INFO"
Write-Log "  Date: $DateStamp | Dest: $TodayBackupDir" "INFO"
Write-Log "================================================================" "INFO"

# Phase 1: Service Databases (API-triggered)
foreach ($svc in $ManagedServices) {
    Invoke-ServiceBackup -Name $svc.Name -Port $svc.Port -ApiKey $svc.ApiKey `
        -DataDir $svc.DataDir -ApiVersion $svc.ApiVersion -MinSizeMB $svc.MinSizeMB
}

# Phase 2: Docker (skipped if WSL unavailable)
if (-not $script:WSLAvailable) {
    Write-Log "SKIPPING Phase 2: WSL not available" "WARN"
    Add-Result -Category "docker" -Name "ALL-DOCKER" -Success $false -ErrorMsg "WSL not running"
} else {
    # Docker database dumps, volume backups, compose file copies...
}

# Phase 3: Config directories (robocopy incremental)
# Phase 4: System state (registry exports, scheduled tasks, firewall rules)
# Phase 5: Promotion + retention cleanup
Invoke-WeeklyMonthlyPromotion
Invoke-RetentionCleanup

# Phase 6: Report + notify
Write-Manifest
Send-DiscordReport

} catch {
    # Global crash handler - guarantees alert even on unexpected errors
    Write-Log "FATAL: Script crashed - $($_.Exception.Message)" "ERROR"
    Send-CrashAlert "$($_.Exception.Message)`n`nStack: $($_.ScriptStackTrace)"
} finally {
    try { Stop-Transcript } catch { }
}
