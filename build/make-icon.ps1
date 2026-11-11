Add-Type -AssemblyName System.Drawing
$outDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$bmps = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $pink = [System.Drawing.Color]::FromArgb(255, 251, 114, 153)
  $dark = [System.Drawing.Color]::FromArgb(255, 230, 80, 120)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
    [System.Drawing.Point]::new(0, 0),
    [System.Drawing.Point]::new($s, $s),
    $pink,
    $dark
  )
  $g.FillEllipse($brush, 0, 0, $s - 1, $s - 1)

  $white = [System.Drawing.Color]::White
  $lw = [Math]::Max(1.5, $s / 12.0)
  $pen = New-Object System.Drawing.Pen $white, $lw
  $pen.StartCap = 'Round'
  $pen.EndCap = 'Round'
  $pad = $s * 0.22
  # headband
  $g.DrawArc($pen, $pad, $pad * 0.85, $s - $pad * 2, $s - $pad * 1.6, 200, 140)
  $fill = New-Object System.Drawing.SolidBrush $white
  $cupW = [Math]::Max(2, $s * 0.16)
  $cupH = [Math]::Max(3, $s * 0.26)
  $cupY = $s * 0.40
  $g.FillRectangle($fill, $pad * 0.75, $cupY, $cupW, $cupH)
  $g.FillRectangle($fill, $s - $pad * 0.75 - $cupW, $cupY, $cupW, $cupH)
  # small music note between cups
  $nx = $s * 0.46
  $ny = $s * 0.36
  $nlw = [Math]::Max(1.2, $s / 20.0)
  $npen = New-Object System.Drawing.Pen $white, $nlw
  $npen.StartCap = 'Round'
  $npen.EndCap = 'Round'
  $g.DrawLine($npen, $nx, $ny, $nx, $ny + $s * 0.22)
  $g.FillEllipse($fill, $nx - $s * 0.08, $ny + $s * 0.16, $s * 0.11, $s * 0.08)
  $g.DrawLine($npen, $nx, $ny, $nx + $s * 0.12, $ny + $s * 0.04)

  $g.Dispose(); $brush.Dispose(); $pen.Dispose(); $npen.Dispose(); $fill.Dispose()
  $bmps += $bmp
}
$bmps[-1].Save((Join-Path $outDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$fs = [IO.File]::Open((Join-Path $outDir 'icon.ico'), 'Create')
$bw = New-Object IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$bmps.Count)
$offset = 6 + 16 * $bmps.Count
$streams = @()
foreach ($b in $bmps) {
  $ms = New-Object IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $streams += , $ms.ToArray()
  $ms.Dispose()
}
for ($i = 0; $i -lt $bmps.Count; $i++) {
  $b = $bmps[$i]; $data = $streams[$i]
  $wb = if ($b.Width -eq 256) { 0 } else { $b.Width }
  $hb = if ($b.Height -eq 256) { 0 } else { $b.Height }
  $bw.Write([byte]$wb); $bw.Write([byte]$hb); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($d in $streams) { $bw.Write($d) }
$bw.Close(); $fs.Close()
foreach ($b in $bmps) { $b.Dispose() }
'ok'
