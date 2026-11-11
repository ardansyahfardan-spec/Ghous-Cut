$ErrorActionPreference = "Stop"
$iconDir = Join-Path $PSScriptRoot "..\..\src-tauri\icons"
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

$width = 32
$height = 32
$pixels = New-Object byte[] ($width * $height * 4)

for ($y = 0; $y -lt $height; $y++) {
  for ($x = 0; $x -lt $width; $x++) {
    $dx = $x - 15.5
    $dy = $y - 15.5
    $radius = [Math]::Sqrt(($dx * $dx) + ($dy * $dy))
    $b = 24; $g = 27; $r = 34
    if ($radius -le 13 -and $radius -ge 10) { $b = 42; $g = 62; $r = 238 }
    if ($radius -lt 10) { $b = 24; $g = 27; $r = 34 }
    if ($y -ge 5 -and $y -le 9 -and $x -ge 7 -and $x -le 24 -and (($x + $y) % 6 -lt 3)) {
      $b = 235; $g = 235; $r = 242
    }
    if ($y -ge 12 -and $y -le 19 -and $x -ge 12 -and $x -le 19) {
      $b = 235; $g = 235; $r = 242
    }
    $index = (($y * $width) + $x) * 4
    $pixels[$index] = [byte]$b
    $pixels[$index + 1] = [byte]$g
    $pixels[$index + 2] = [byte]$r
    $pixels[$index + 3] = 255
  }
}

$mask = New-Object byte[] ($height * 4)
$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([uint32]40)
$writer.Write([int32]$width)
$writer.Write([int32]($height * 2))
$writer.Write([uint16]1)
$writer.Write([uint16]32)
$writer.Write([uint32]0)
$writer.Write([uint32]$pixels.Length)
$writer.Write([int32]0)
$writer.Write([int32]0)
$writer.Write([uint32]0)
$writer.Write([uint32]0)
$writer.Write($pixels)
$writer.Write($mask)
$dib = $stream.ToArray()
$writer.Dispose()
$stream.Dispose()

$icoStream = New-Object System.IO.MemoryStream
$icoWriter = New-Object System.IO.BinaryWriter($icoStream)
$icoWriter.Write([uint16]0)
$icoWriter.Write([uint16]1)
$icoWriter.Write([uint16]1)
$icoWriter.Write([byte]$width)
$icoWriter.Write([byte]$height)
$icoWriter.Write([byte]0)
$icoWriter.Write([byte]0)
$icoWriter.Write([uint16]1)
$icoWriter.Write([uint16]32)
$icoWriter.Write([uint32]$dib.Length)
$icoWriter.Write([uint32]22)
$icoWriter.Write($dib)
[System.IO.File]::WriteAllBytes((Join-Path $iconDir "icon.ico"), $icoStream.ToArray())
$icoWriter.Dispose()
$icoStream.Dispose()
Write-Host "Generated src-tauri/icons/icon.ico"
