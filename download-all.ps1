param(
  [int]$MaxPasses = 12,
  [int]$DelaySeconds = 8,
  [int]$NoProgressLimit = 3,
  [switch]$Background,
  [switch]$Status,
  [switch]$Stop
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

$appBase = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'XCursosRunner' } else { Join-Path $env:TEMP 'XCursosRunner' }
$diagnosticBase = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'XCursosRunner\logs' } else { Join-Path $env:TEMP 'XCursosRunner\logs' }
$backgroundBase = Join-Path $appBase 'background'
$backgroundControlPath = Join-Path $appBase 'background\xcursos-all.json'
New-Item -ItemType Directory -Force -Path $diagnosticBase | Out-Null
New-Item -ItemType Directory -Force -Path $backgroundBase | Out-Null

function Read-BackgroundDescriptor {
  if (-not (Test-Path -LiteralPath $backgroundControlPath)) { return $null }
  try { return (Get-Content -Raw -LiteralPath $backgroundControlPath | ConvertFrom-Json) }
  catch { return $null }
}

function Write-BackgroundDescriptor($descriptor) {
  $tmp = "$backgroundControlPath.tmp-$PID"
  $descriptor | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $backgroundControlPath -Force
}

function Get-ValidatedBackgroundProcess($descriptor) {
  if (-not $descriptor -or -not $descriptor.pid) { return $null }
  $candidatePid = [int]$descriptor.pid
  if ($candidatePid -le 0) { return $null }
  try {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $candidatePid" -ErrorAction Stop
    if (-not $processInfo) { return $null }
    $commandLine = [string]$processInfo.CommandLine
    $scriptPath = [string]$descriptor.scriptPath
    if (-not $commandLine -or -not $scriptPath) { return $null }
    if ($commandLine.IndexOf($scriptPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
    return $processInfo
  } catch {
    return $null
  }
}

function Get-BackgroundStatusObject {
  $descriptor = Read-BackgroundDescriptor
  if (-not $descriptor) {
    return [ordered]@{ ok = $true; status = 'BACKGROUND_NOT_FOUND'; active = $false }
  }
  $validatedProcess = Get-ValidatedBackgroundProcess $descriptor
  $active = $null -ne $validatedProcess
  return [ordered]@{
    ok = $true
    status = if ($active) { 'BACKGROUND_RUNNING' } else { 'BACKGROUND_INACTIVE' }
    active = $active
    instanceId = [string]$descriptor.instanceId
    pid = [int]$descriptor.pid
    startedAt = [string]$descriptor.startedAt
    endedAt = [string]$descriptor.endedAt
    workerStatus = [string]$descriptor.status
    stdoutPath = [string]$descriptor.stdoutPath
    stderrPath = [string]$descriptor.stderrPath
    transcriptPath = [string]$descriptor.transcriptPath
    stopFile = [string]$descriptor.stopFile
    reason = if ($active) { $null } else { 'PID_STALE_EXITED_OR_REUSED' }
  }
}

if ($Status) {
  Get-BackgroundStatusObject | ConvertTo-Json -Depth 8
  exit 0
}

if ($Stop) {
  $descriptor = Read-BackgroundDescriptor
  $validatedProcess = Get-ValidatedBackgroundProcess $descriptor
  if (-not $descriptor -or -not $validatedProcess) {
    [ordered]@{ ok = $true; status = 'BACKGROUND_NOT_RUNNING'; active = $false } | ConvertTo-Json -Depth 8
    exit 0
  }
  $stopFile = [string]$descriptor.stopFile
  if (-not $stopFile) { throw 'Background descriptor does not contain a stop request path.' }
  [ordered]@{ instanceId = [string]$descriptor.instanceId; requestedAt = (Get-Date).ToUniversalTime().ToString('o'); reason = 'USER_REQUEST' } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stopFile -Encoding UTF8
  [ordered]@{ ok = $true; status = 'STOP_REQUESTED'; active = $true; instanceId = [string]$descriptor.instanceId; pid = [int]$descriptor.pid; stopFile = $stopFile } | ConvertTo-Json -Depth 8
  exit 0
}

if ($Background -and $env:XCURSOS_BACKGROUND_WORKER -ne '1') {
  $existing = Read-BackgroundDescriptor
  if (Get-ValidatedBackgroundProcess $existing) {
    [ordered]@{ ok = $false; status = 'BACKGROUND_ALREADY_RUNNING'; active = $true; instanceId = [string]$existing.instanceId; pid = [int]$existing.pid } | ConvertTo-Json -Depth 8
    exit 2
  }

  $backgroundStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $instanceId = [guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $diagnosticBase "xcursos-all-background-$backgroundStamp-$instanceId.stdout.log"
  $stderrPath = Join-Path $diagnosticBase "xcursos-all-background-$backgroundStamp-$instanceId.stderr.log"
  $stopFile = Join-Path $backgroundBase "stop-$instanceId.request"
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  $childArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -MaxPasses $MaxPasses -DelaySeconds $DelaySeconds -NoProgressLimit $NoProgressLimit"
  $previousWorker = $env:XCURSOS_BACKGROUND_WORKER
  $previousLaunchMode = $env:XCURSOS_LAUNCH_MODE
  $previousSessionId = $env:XCURSOS_BACKGROUND_SESSION_ID
  $previousStopFile = $env:XCURSOS_BACKGROUND_STOP_FILE
  $previousLauncherPid = $env:XCURSOS_LAUNCHER_PID
  try {
    $env:XCURSOS_BACKGROUND_WORKER = '1'
    $env:XCURSOS_LAUNCH_MODE = 'background'
    $env:XCURSOS_BACKGROUND_SESSION_ID = $instanceId
    $env:XCURSOS_BACKGROUND_STOP_FILE = $stopFile
    $env:XCURSOS_LAUNCHER_PID = [string]$PID
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $childArgs -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  } finally {
    if ($null -eq $previousWorker) { Remove-Item Env:XCURSOS_BACKGROUND_WORKER -ErrorAction SilentlyContinue } else { $env:XCURSOS_BACKGROUND_WORKER = $previousWorker }
    if ($null -eq $previousLaunchMode) { Remove-Item Env:XCURSOS_LAUNCH_MODE -ErrorAction SilentlyContinue } else { $env:XCURSOS_LAUNCH_MODE = $previousLaunchMode }
    if ($null -eq $previousSessionId) { Remove-Item Env:XCURSOS_BACKGROUND_SESSION_ID -ErrorAction SilentlyContinue } else { $env:XCURSOS_BACKGROUND_SESSION_ID = $previousSessionId }
    if ($null -eq $previousStopFile) { Remove-Item Env:XCURSOS_BACKGROUND_STOP_FILE -ErrorAction SilentlyContinue } else { $env:XCURSOS_BACKGROUND_STOP_FILE = $previousStopFile }
    if ($null -eq $previousLauncherPid) { Remove-Item Env:XCURSOS_LAUNCHER_PID -ErrorAction SilentlyContinue } else { $env:XCURSOS_LAUNCHER_PID = $previousLauncherPid }
  }
  $descriptor = [ordered]@{
    schemaVersion = 1
    instanceId = $instanceId
    pid = $process.Id
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    endedAt = $null
    status = 'RUNNING'
    launchMode = 'background'
    scriptPath = $PSCommandPath
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    transcriptPath = $null
    stopFile = $stopFile
  }
  Write-BackgroundDescriptor $descriptor
  [ordered]@{ ok = $true; status = 'BACKGROUND_STARTED'; active = $true; instanceId = $instanceId; pid = $process.Id; startedAt = $descriptor.startedAt; stdoutPath = $stdoutPath; stderrPath = $stderrPath; stopFile = $stopFile; statusCommand = 'xcursos-all -Status'; stopCommand = 'xcursos-all -Stop' } | ConvertTo-Json -Depth 8
  exit 0
}

$transcriptStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$transcriptPath = Join-Path $diagnosticBase "xcursos-all-$transcriptStamp-$PID.log"
$env:XCURSOS_POWERSHELL_TRANSCRIPT = $transcriptPath
$transcriptStarted = $false
if ($env:XCURSOS_BACKGROUND_WORKER -eq '1' -and $env:XCURSOS_BACKGROUND_SESSION_ID) {
  $workerDescriptor = Read-BackgroundDescriptor
  if ($workerDescriptor -and [string]$workerDescriptor.instanceId -eq [string]$env:XCURSOS_BACKGROUND_SESSION_ID) {
    $workerDescriptor.transcriptPath = $transcriptPath
    Write-BackgroundDescriptor $workerDescriptor
  }
}
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
  if ($env:XCURSOS_BACKGROUND_WORKER -eq '1' -and $env:XCURSOS_BACKGROUND_SESSION_ID) {
    try {
      $finalDescriptor = Read-BackgroundDescriptor
      if ($finalDescriptor -and [string]$finalDescriptor.instanceId -eq [string]$env:XCURSOS_BACKGROUND_SESSION_ID) {
        $finalDescriptor.status = 'EXITED'
        $finalDescriptor.endedAt = (Get-Date).ToUniversalTime().ToString('o')
        Write-BackgroundDescriptor $finalDescriptor
      }
    } catch {}
  }
}
