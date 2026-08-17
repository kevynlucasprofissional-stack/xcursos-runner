param(
  [int]$MaxPasses = 12,
  [int]$DelaySeconds = 8,
  [int]$NoProgressLimit = 3,
  [switch]$Background
)

$ErrorActionPreference = 'Stop'
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

# Windows PowerShell 5.1 may otherwise decode native UTF-8 output using a legacy code page.
# Keep this script ASCII-only, but make the child Node process and console exchange UTF-8 explicitly.
$utf8 = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8
try { [Console]::InputEncoding = $utf8 } catch {}
try { [Console]::OutputEncoding = $utf8 } catch {}

$diagnosticBase = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'XCursosRunner\logs' } else { Join-Path $env:TEMP 'XCursosRunner\logs' }
New-Item -ItemType Directory -Force -Path $diagnosticBase | Out-Null

if ($Background -and $env:XCURSOS_BACKGROUND_WORKER -ne '1') {
  $backgroundStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutPath = Join-Path $diagnosticBase "xcursos-all-background-$backgroundStamp-$PID.stdout.log"
  $stderrPath = Join-Path $diagnosticBase "xcursos-all-background-$backgroundStamp-$PID.stderr.log"
  $childArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -MaxPasses $MaxPasses -DelaySeconds $DelaySeconds -NoProgressLimit $NoProgressLimit"
  $previousWorker = $env:XCURSOS_BACKGROUND_WORKER
  $previousLaunchMode = $env:XCURSOS_LAUNCH_MODE
  try {
    $env:XCURSOS_BACKGROUND_WORKER = '1'
    $env:XCURSOS_LAUNCH_MODE = 'background'
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $childArgs -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  } finally {
    if ($null -eq $previousWorker) { Remove-Item Env:XCURSOS_BACKGROUND_WORKER -ErrorAction SilentlyContinue } else { $env:XCURSOS_BACKGROUND_WORKER = $previousWorker }
    if ($null -eq $previousLaunchMode) { Remove-Item Env:XCURSOS_LAUNCH_MODE -ErrorAction SilentlyContinue } else { $env:XCURSOS_LAUNCH_MODE = $previousLaunchMode }
  }
  Write-Host "[XCursos ALL] Background iniciado. PID=$($process.Id)" -ForegroundColor Cyan
  Write-Host "[XCursos ALL] stdout: $stdoutPath" -ForegroundColor Cyan
  Write-Host "[XCursos ALL] stderr: $stderrPath" -ForegroundColor Cyan
  exit 0
}

$transcriptStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$transcriptPath = Join-Path $diagnosticBase "xcursos-all-$transcriptStamp-$PID.log"
$env:XCURSOS_POWERSHELL_TRANSCRIPT = $transcriptPath
$transcriptStarted = $false
try {
  Start-Transcript -Path $transcriptPath -Force | Out-Null
  $transcriptStarted = $true
} catch {
  Write-Warning "PowerShell transcript could not be started: $($_.Exception.Message)"
}

try {
  function Write-Step([string]$Message) {
    Write-Host "[XCursos ALL] $Message" -ForegroundColor Cyan
  }

  function Get-FailureFingerprint($result) {
    $missing = @()
    if ($result.audit -and $result.audit.missingPositions) { $missing = @($result.audit.missingPositions | ForEach-Object { [int]$_ } | Sort-Object) }
    $downloaded = if ($result.audit) { [int]$result.audit.downloaded } else { 0 }
    $processed = if ($result.audit) { [int]$result.audit.processed } else { 0 }
    return "downloaded=$downloaded;processed=$processed;missing=$($missing -join ',')"
  }

  function Show-FailureSummary($result) {
    if (-not $result.failureSummary) { return }
    foreach ($item in @($result.failureSummary)) {
      $positions = @($item.positions) -join ','
      Write-Step "Falha $([string]$item.code): count=$([int]$item.count) positions=$positions"
    }
  }

  if (-not (Get-Command xcursos -ErrorAction SilentlyContinue)) {
    throw 'Comando xcursos nao encontrado. Execute install.ps1 e abra um terminal novo.'
  }

  if ($MaxPasses -lt 1) { throw 'MaxPasses deve ser >= 1.' }
  if ($DelaySeconds -lt 0) { throw 'DelaySeconds deve ser >= 0.' }
  if ($NoProgressLimit -lt 1) { throw 'NoProgressLimit deve ser >= 1.' }

  Write-Step "PowerShell transcript: $transcriptPath"
  $previousFingerprint = $null
  $stagnantPasses = 0

  for ($pass = 1; $pass -le $MaxPasses; $pass++) {
    Write-Step "Passada $pass/$MaxPasses - processando todas as posicoes pendentes..."

    # Windows PowerShell 5.1 turns native stderr into NativeCommandError records.
    # Progress intentionally lives on stderr, so do not let ErrorActionPreference=Stop abort the JSON capture.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $raw = (& xcursos download --json | Out-String).Trim()
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }

    if (-not $raw) { throw "xcursos download nao retornou JSON (exit code $exitCode)." }
    try { $result = $raw | ConvertFrom-Json }
    catch { Write-Host $raw; throw 'Nao foi possivel interpretar a saida JSON do xcursos download.' }

    $status = [string]$result.status
    $missingCount = if ($result.audit -and $result.audit.missingPositions) { @($result.audit.missingPositions).Count } else { 0 }
    $downloaded = if ($result.audit) { [int]$result.audit.downloaded } else { 0 }
    $already = if ($result.audit) { [int]$result.audit.alreadyPresent } else { 0 }
    $invalidCount = if ($result.audit -and $result.audit.invalidFilePositions) { @($result.audit.invalidFilePositions).Count } else { 0 }

    Write-Step "Status=$status | childExit=$exitCode | downloaded=$downloaded | alreadyPresent=$already | pendentes=$missingCount | invalidos=$invalidCount"
    if ($result.diagnostics -and $result.diagnostics.reportMarkdown) { Write-Step "Child diagnostic report: $([string]$result.diagnostics.reportMarkdown)" }
    Show-FailureSummary $result

    if ($result.ok -eq $true -and $status -eq 'COMPLETE') {
      Write-Host ''
      Write-Host 'CURSO COMPLETO E AUDITADO.' -ForegroundColor Green
      & xcursos audit --json
      exit 0
    }

    if ($result.audit) {
      $fingerprint = Get-FailureFingerprint $result
      if ($previousFingerprint -and $fingerprint -eq $previousFingerprint) { $stagnantPasses++ } else { $stagnantPasses = 0 }
      $previousFingerprint = $fingerprint
      if ($stagnantPasses -ge $NoProgressLimit) {
        Write-Host ''
        Write-Host "NO_PROGRESS: $($stagnantPasses + 1) passadas consecutivas sem ganho real de cobertura." -ForegroundColor Yellow
        Show-FailureSummary $result
        Write-Host 'Veja o diagnostic-report.md indicado acima e os artefatos listados nele.'
        exit 4
      }
    }

    $errorCode = if ($result.error) { [string]$result.error.code } else { '' }
    $errorMessage = if ($result.error) { [string]$result.error.message } else { '' }
    $auditRetry = $errorCode -in @('AUDIT_INCOMPLETE', 'AUDIT_UNHEALTHY')
    $browserRetry = ($errorCode -in @('LESSON_REFRESH_FAILED', 'LESSON_REFRESH_RECOVERY_FAILED', 'PAGE_CLOSED')) -and ($errorMessage -match 'closed|disconnected|Target page')
    $retryableBlock = $auditRetry -or $browserRetry

    if (-not $retryableBlock) {
      Write-Host ''
      Write-Host 'O runner parou por um erro que nao deve ser repetido automaticamente:' -ForegroundColor Red
      Write-Host $raw
      exit 2
    }

    if ($pass -lt $MaxPasses) {
      if ($browserRetry) { Write-Step "A sessao de pagina/CDP foi interrompida. Nova tentativa em $DelaySeconds s..." }
      else { Write-Step "Ainda ha posicoes pendentes. Nova tentativa em $DelaySeconds s..." }
      if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
    }
  }

  Write-Host ''
  Write-Host "Limite de $MaxPasses passadas atingido sem concluir o curso." -ForegroundColor Yellow
  Write-Host 'Veja o diagnostic-report.md da ultima passada e os artefatos listados nele.'
  exit 3
} finally {
  if ($transcriptStarted) {
    try { Stop-Transcript | Out-Null } catch {}
  }
}
