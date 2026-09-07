# The check that runs before every demo, and before every deploy.
#
# The PowerShell twin of scripts/smoke.sh - same steps, same assertions, same
# exit codes. Use whichever your shell is; do not maintain one and forget the
# other.
#
#   .\scripts\smoke.ps1
#   .\scripts\smoke.ps1 -DatabaseUrl "postgresql+asyncpg://user:pass@host/db"
#   .\scripts\smoke.ps1 -SkipBuild
[CmdletBinding()]
param(
    [string]$Image = "dwi-backend:smoke",
    [string]$Container = "dwi-smoke",
    [int]$Port = 8099,
    [string]$AdminToken = "smoke-token",
    [string]$DatabaseUrl = "",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Continue"
$base = "http://127.0.0.1:$Port"
$campus = "00000000-0000-0000-0000-000000000001"
$battery = "00000000-0000-0000-0000-000000000002"
$script:failures = 0
$startedAt = Get-Date

function Step($title) {
    Write-Host ""
    Write-Host $title
    Write-Host ("-" * 70)
}

function Check($label, $ok, $detail = "") {
    if ($ok) {
        Write-Host "  [PASS] $label"
    } else {
        $suffix = if ($detail) { " - $detail" } else { "" }
        Write-Host "  [FAIL] $label$suffix"
        $script:failures++
    }
}

function Remove-SmokeContainer {
    docker rm -f $Container 2>&1 | Out-Null
}

function Invoke-Api($method, $path, $body = $null, $headers = @{}, $timeout = 30) {
    try {
        $args = @{
            Uri         = "$base$path"
            Method      = $method
            TimeoutSec  = $timeout
            Headers     = $headers
            ErrorAction = "Stop"
            # Required on Windows PowerShell 5.1: without it Invoke-WebRequest
            # tries to parse the response with the Internet Explorer engine,
            # which is not present on a modern Windows, and every call fails
            # with an error that has nothing to do with HTTP.
            UseBasicParsing = $true
        }
        if ($null -ne $body) {
            $args.Body = $body
            $args.ContentType = "application/json"
        }
        $response = Invoke-WebRequest @args
        return @{ ok = $true; status = $response.StatusCode; body = $response.Content }
    } catch {
        $status = 0
        $content = ""
        # A non-2xx is an exception here, and the body has to be dug out. On
        # 5.1 the response stream is usually already consumed by the time we
        # get it, so ErrorDetails.Message is the reliable source and the
        # stream is the fallback - not the other way round. Getting this
        # backwards makes every error-path assertion silently compare against
        # an empty string.
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $content = $_.ErrorDetails.Message
        }
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            if (-not $content) {
                try {
                    $stream = $_.Exception.Response.GetResponseStream()
                    $stream.Position = 0
                    $content = (New-Object System.IO.StreamReader($stream)).ReadToEnd()
                } catch {}
            }
        }
        return @{ ok = $false; status = $status; body = $content; error = $_.Exception.Message }
    }
}

try {
    # -----------------------------------------------------------------------
    Step "1 - Build the image from scratch"
    # -----------------------------------------------------------------------
    if ($SkipBuild) {
        Write-Host "  (skipped: -SkipBuild)"
    } else {
        $log = docker build -f backend/Dockerfile -t $Image . 2>&1
        if ($LASTEXITCODE -eq 0) {
            Check "docker build" $true
        } else {
            Check "docker build" $false
            $log | Select-Object -Last 25 | ForEach-Object { Write-Host $_ }
            exit 1
        }
    }

    # -----------------------------------------------------------------------
    Step "2 - Start a container"
    # -----------------------------------------------------------------------
    Remove-SmokeContainer
    $runArgs = @(
        "run", "-d", "--name", $Container,
        "-p", "${Port}:${Port}",
        "--add-host=host.docker.internal:host-gateway",
        "-e", "PORT=$Port",
        "-e", "ADMIN_TOKEN=$AdminToken"
    )
    if ($DatabaseUrl) {
        $runArgs += @("-e", "DATABASE_URL=$DatabaseUrl")
        Write-Host "  database: $($DatabaseUrl.Split(':')[0])  (external)"
    } else {
        Write-Host "  database: sqlite (in-container, empty)"
    }
    $runArgs += $Image
    docker @runArgs | Out-Null
    Check "container started" ($LASTEXITCODE -eq 0)
    if ($LASTEXITCODE -ne 0) { exit 1 }

    # -----------------------------------------------------------------------
    Step "3 - Wait for liveness, then readiness"
    # -----------------------------------------------------------------------
    # Different questions: /health says the process is up, /ready says the
    # database answers. A bad DATABASE_URL produces live-but-not-ready, and
    # the point is to see which.
    $live = $false
    foreach ($i in 1..40) {
        if ((Invoke-Api GET "/health" -timeout 2).ok) { $live = $true; break }
        Start-Sleep -Seconds 1
    }
    Check "/health answers" $live
    if (-not $live) {
        Write-Host "  --- container logs ---"
        docker logs $Container 2>&1 | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
        exit 1
    }

    $ready = $null
    foreach ($i in 1..30) {
        $r = Invoke-Api GET "/ready" -timeout 5
        if ($r.ok) { $ready = $r; break }
        Start-Sleep -Seconds 1
    }
    Check "/ready answers, so the database is reachable" ($null -ne $ready)
    if ($ready) { Write-Host "  $($ready.body)" }

    # -----------------------------------------------------------------------
    Step "4 - Reset the seed through the guarded endpoint"
    # -----------------------------------------------------------------------
    $reset = Invoke-Api POST "/admin/reset-seed" '{}' @{ "X-Admin-Token" = $AdminToken } 60
    Check "both seed domains reloaded" ($reset.body -match "campus-symposium") $reset.body

    $untokened = Invoke-Api POST "/admin/reset-seed" '{}' @{} 10
    Check "an untokened reset is refused" ($untokened.status -eq 401) "got $($untokened.status)"

    # -----------------------------------------------------------------------
    Step "5 - Analyze both seed domains"
    # -----------------------------------------------------------------------
    function Test-Analyze($name, $id) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-Api POST "/api/projects/$id/analyze" '{}'
        $sw.Stop()
        $ms = [int]$sw.ElapsedMilliseconds

        if (-not $r.ok) { Check "${name}: analyze" $false $r.error; return }
        Check "${name}: analyze returns findings" ($r.body -match '"findings"')
        Check "${name}: analyze returns a critical path" ($r.body -match '"critical_path"')
        # The domain-agnosticism claim, checked on the wire.
        Check "${name}: the analysis payload carries no domain field" ($r.body -notmatch '"domain"')
        Check "${name}: analyze under 1s warm" ($ms -lt 1000) "${ms}ms"
        Write-Host "         $name analyze: ${ms}ms"
    }

    # Warm-up: the first request pays for connection setup, and the floor in
    # the brief is a warm one.
    Invoke-Api POST "/api/projects/$campus/analyze" '{}' | Out-Null
    Invoke-Api POST "/api/projects/$battery/analyze" '{}' | Out-Null
    Test-Analyze "campus" $campus
    Test-Analyze "battery" $battery

    # -----------------------------------------------------------------------
    Step "6 - The refusal still refuses"
    # -----------------------------------------------------------------------
    $refusalBody = '{"name":"smoke","mutations":[{"kind":"TASK_REMOVE","payload":{"key":"M09"}}]}'
    $refusal = Invoke-Api POST "/api/projects/$battery/what-if" $refusalBody
    Check "deleting a mandatory task is refused with the constraint" `
        ($refusal.body -match "MANDATORY_TASK") $refusal.body

    # -----------------------------------------------------------------------
    Step "7 - Errors are structured"
    # -----------------------------------------------------------------------
    $missing = Invoke-Api GET "/api/projects/00000000-0000-0000-0000-0000000000ff/workflow" $null @{} 10
    Check "a 404 carries an actionable hint" ($missing.body -match '"hint"') $missing.body

} finally {
    Remove-SmokeContainer
}

Write-Host ""
Write-Host ("-" * 70)
$elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
if ($script:failures -eq 0) {
    Write-Host "SMOKE PASSED in ${elapsed}s"
    exit 0
}
Write-Host "SMOKE FAILED: $($script:failures) check(s) in ${elapsed}s"
exit 1
