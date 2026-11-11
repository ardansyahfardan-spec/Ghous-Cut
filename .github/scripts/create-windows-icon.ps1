$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Join-Path $PSScriptRoot "..\.."
$iconDir = Join-Path $root "src-tauri\icons"
$logoPath = Join-Path $root "public\logo ghous cut.png"
$outputPath = Join-Path $iconDir "icon.ico"

if (-not (Test-Path $logoPath)) {
  throw "Official Ghous Cut logo not found: $logoPath"
}
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

# Keep the supplied black logo unchanged. A warm cream tile preserves contrast
# in Windows taskbars, Start menu, shortcuts, and installer surfaces.
$size = 256
$bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.Clear([System.Drawing.Color]::Transparent)

$tile = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 242, 232, 211))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 48
$diameter = $radius * 2
$path.AddArc(0, 0, $diameter, $diameter, 180, 90)
$path.AddArc(($size - $diameter), 0, $diameter, $diameter, 270, 90)
$path.AddArc(($size - $diameter), ($size - $diameter), $diameter, $diameter, 0, 90)
$path.AddArc(0, ($size - $diameter), $diameter, $diameter, 90, 90)
$path.CloseFigure()
$graphics.FillPath($tile, $path)

$logo = [System.Drawing.Image]::FromFile($logoPath)
$maxSize = 196.0
$scale = [Math]::Min($maxSize / $logo.Width, $maxSize / $logo.Height)
$drawWidth = [int][Math]::Round($logo.Width * $scale)
$drawHeight = [int][Math]::Round($logo.Height * $scale)
$drawX = [int](($size - $drawWidth) / 2)
$drawY = [int](($size - $drawHeight) / 2)
$graphics.DrawImage($logo, $drawX, $drawY, $drawWidth, $drawHeight)

$hIcon = $bitmap.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$stream = [System.IO.File]::Create($outputPath)
try {
  $icon.Save($stream)
} finally {
  $stream.Dispose()
  $icon.Dispose()
  $logo.Dispose()
  $path.Dispose()
  $tile.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
  Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyIcon(System.IntPtr hIcon);' -ErrorAction SilentlyContinue
  [Win32.NativeMethods]::DestroyIcon($hIcon) | Out-Null
}
Write-Host "Generated Windows icon from the official Ghous Cut logo: $outputPath"
