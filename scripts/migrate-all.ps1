# ==============================================================================
# LogiX Backend - Unified Migration Runner for Windows PowerShell
# ==============================================================================

param (
    [switch]$PrismaOnly,
    [switch]$PythonOnly
)

$ErrorActionPreference = "Stop"
$rootDir = (Get-Item $PSScriptRoot).Parent.FullName

$prismaServices = @(
    "identity-service",
    "master-data-service",
    "order-service",
    "inventory-service",
    "fulfillment-service",
    "transport-service",
    "notification-service",
    "audit-service"
)

$pythonServices = @(
    "agent-service",
    "forecast-service",
    "route-optimizer-service"
)

# Detect Python in .venv or PATH
$pythonExe = Join-Path $rootDir ".venv\Scripts\python.exe"
if (-not (Test-Path $pythonExe)) {
    $pythonExe = "python"
}

Write-Host "`n===============================================================" -ForegroundColor Magenta
Write-Host "              LogiX Database Migration Runner                 " -ForegroundColor Magenta
Write-Host "===============================================================`n" -ForegroundColor Magenta

$successCount = 0
$failCount = 0
$failedServices = @()

# 1. Prisma Migrations
if (-not $PythonOnly) {
    Write-Host "--- Phase 1: Prisma Migrations (Node.js Services) ---" -ForegroundColor Yellow
    foreach ($svc in $prismaServices) {
        Write-Host "`n[Prisma] Migrating $svc..." -ForegroundColor Cyan
        try {
            Push-Location $rootDir
            pnpm --filter $svc db:migrate:deploy
            if ($LASTEXITCODE -eq 0) {
                Write-Host "✔ $svc migration succeeded" -ForegroundColor Green
                $successCount++
            } else {
                Write-Host "✘ $svc migration failed" -ForegroundColor Red
                $failCount++
                $failedServices += $svc
            }
        } catch {
            Write-Host "✘ $svc error: $_" -ForegroundColor Red
            $failCount++
            $failedServices += $svc
        } finally {
            Pop-Location
        }
    }
}

# 2. Python / Alembic Migrations
if (-not $PrismaOnly) {
    Write-Host "`n--- Phase 2: Alembic Migrations (Python Services) ---" -ForegroundColor Yellow
    foreach ($svc in $pythonServices) {
        Write-Host "`n[Alembic] Migrating $svc..." -ForegroundColor Cyan
        try {
            Push-Location $rootDir
            $iniPath = "apps/$svc/alembic.ini"
            & $pythonExe -m alembic -c $iniPath upgrade head
            if ($LASTEXITCODE -eq 0) {
                Write-Host "✔ $svc migration succeeded" -ForegroundColor Green
                $successCount++
            } else {
                Write-Host "✘ $svc migration failed" -ForegroundColor Red
                $failCount++
                $failedServices += $svc
            }
        } catch {
            Write-Host "✘ $svc error: $_" -ForegroundColor Red
            $failCount++
            $failedServices += $svc
        } finally {
            Pop-Location
        }
    }
}

# Summary
Write-Host "`n===============================================================" -ForegroundColor Magenta
Write-Host "                      Migration Summary                       " -ForegroundColor Magenta
Write-Host "===============================================================" -ForegroundColor Magenta
Write-Host "Total: $($successCount + $failCount) | Succeeded: $successCount | Failed: $failCount"

if ($failCount -gt 0) {
    Write-Host "`nFailed services: $($failedServices -join ', ')" -ForegroundColor Red
    Write-Host "Make sure PostgreSQL is running on port 5433 (docker compose database.yml)" -ForegroundColor Yellow
    exit 1
} else {
    Write-Host "`nAll database migrations applied successfully! 🎉`n" -ForegroundColor Green
}

