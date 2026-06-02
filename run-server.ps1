$ErrorActionPreference = "Stop"
$Python = "C:\Users\david\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$EnvFile = Join-Path $PSScriptRoot ".env"

if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    $Line = $_.Trim()
    if ($Line -and -not $Line.StartsWith("#") -and $Line.Contains("=")) {
      $Name, $Value = $Line.Split("=", 2)
      [Environment]::SetEnvironmentVariable($Name.Trim(), $Value.Trim(), "Process")
    }
  }
}

if (-not (Test-Path $Python)) {
  $Python = "python"
}

& $Python "$PSScriptRoot\server.py"
