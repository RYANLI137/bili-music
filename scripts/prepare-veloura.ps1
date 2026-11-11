# Prepare a relocatable Veloura runtime for the NSIS installer.
# Downloads embeddable CPython, installs veloura-audio + deps, warms FFmpeg.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Runtime = Join-Path $Root 'vendor\veloura-runtime'
$BridgeSrc = Join-Path $Root 'vendor\bridge\veloura_bridge.py'
$PyVer = '3.12.8'
$ZipName = "python-$PyVer-embed-amd64.zip"
$ZipUrl = "https://www.python.org/ftp/python/$PyVer/$ZipName"
$ZipPath = Join-Path $env:TEMP $ZipName
$GetPip = Join-Path $env:TEMP 'get-pip-veloura.py'

Write-Host "==> Veloura runtime -> $Runtime"

if (Test-Path (Join-Path $Runtime 'ready.flag')) {
  $flag = Get-Content (Join-Path $Runtime 'ready.flag') -ErrorAction SilentlyContinue
  if ($flag -match 'veloura' -and (Test-Path (Join-Path $Runtime 'python.exe'))) {
    Write-Host "Runtime already ready ($flag). Use -Force to rebuild."
    if (-not $args.Contains('-Force')) { exit 0 }
  }
}

if (Test-Path $Runtime) { Remove-Item $Runtime -Recurse -Force }
New-Item -ItemType Directory -Path $Runtime | Out-Null

Write-Host "==> Download embeddable Python $PyVer"
if (-not (Test-Path $ZipPath)) {
  Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing
}
Expand-Archive -Path $ZipPath -DestinationPath $Runtime -Force

$Pth = Get-ChildItem $Runtime -Filter 'python*._pth' | Select-Object -First 1
if (-not $Pth) { throw 'python._pth not found' }
@(
  'python312.zip'
  '.'
  'Lib\site-packages'
  'import site'
) | Set-Content -Path $Pth.FullName -Encoding ASCII

New-Item -ItemType Directory -Path (Join-Path $Runtime 'Lib\site-packages') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Runtime 'Scripts') -Force | Out-Null

Write-Host '==> Bootstrap pip'
if (-not (Test-Path $GetPip)) {
  Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $GetPip -UseBasicParsing
}
& (Join-Path $Runtime 'python.exe') $GetPip --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw 'get-pip failed' }

$Py = Join-Path $Runtime 'python.exe'
Write-Host '==> pip install veloura-audio'
& $Py -m pip install --no-warn-script-location --upgrade pip setuptools wheel
& $Py -m pip install --no-warn-script-location 'veloura-audio>=0.6.5'
if ($LASTEXITCODE -ne 0) { throw 'pip install veloura-audio failed' }

Write-Host '==> Warm FFmpeg binary (imageio-ffmpeg)'
& $Py -c "import imageio_ffmpeg; p=imageio_ffmpeg.get_ffmpeg_exe(); print(p)"
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg warm failed' }

Write-Host '==> Install bridge'
Copy-Item $BridgeSrc (Join-Path $Runtime 'veloura_bridge.py') -Force
New-Item -ItemType Directory -Path (Join-Path $Runtime 'bridge') -Force | Out-Null
Copy-Item $BridgeSrc (Join-Path $Runtime 'bridge\veloura_bridge.py') -Force

$ver = & $Py -c "import veloura; print(veloura.__version__)"
$status = '{"cmd":"status"}' | & $Py (Join-Path $Runtime 'veloura_bridge.py')
Write-Host $status
if ($status -notmatch '"ok": true') { throw "veloura bridge status failed: $status" }
"veloura=$ver" | Set-Content (Join-Path $Runtime 'ready.flag') -Encoding ASCII
Write-Host "==> Done. veloura $ver"
