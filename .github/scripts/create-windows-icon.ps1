$ErrorActionPreference = "Stop"
$iconDir = Join-Path $PSScriptRoot "..\..\src-tauri\icons"
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

$width = 32
$height = 32
$pixels = New-Object byte[] ($width * $height * 4)

for ($y = 0; $y -lt $height; $y++) {
  for ($x = 0; $x -lt $width; $x++) {
    $cornerX = $x
    if ($x -lt 6) { $cornerX = 6 } elseif ($x -ge 26) { $cornerX = 25 }
    $cornerY = $y
    if ($y -lt 6) { $cornerY = 6 } elseif ($y -ge 26) { $cornerY = 25 }
    $inside = (($x - $cornerX) * ($x - $cornerX) + ($y - $cornerY) * ($y - $cornerY)) -le 36

    $dx = $x - 16
    $dy = $y - 15
    $head = (($dx * $dx) + ($dy * $dy)) -le 110 -and $y -le 16
    $body = $x -ge 7 -and $x -le 24 -and $y -ge 13 -and $y -le 24
    $scallop = $y -ge 25 -and $y -le 27 -and (($x -ge 7 -and $x -le 10) -or ($x -ge 13 -and $x -le 19) -or ($x -ge 22 -and $x -le 24))
    $ghost = $head -or $body -or $scallop

    $r = 34; $g = 23; $b = 45; $a = 255
    if (-not $inside) { $a = 0 }
    if ($ghost -and $inside) { $r = 239; $g = 222; $b = 255 }
    $eyeLeft = (($x - 12.5) * ($x - 12.5) / 3.2) + (($y - 16) * ($y - 16) / 6.2) -le 1
    $eyeRight = (($x - 19.5) * ($x - 19.5) / 3.2) + (($y - 16) * ($y - 16) / 6.2) -le 1
    if (($eyeLeft -or $eyeRight) -and $ghost) { $r = 34; $g = 23; $b = 45 }
    if ($y -eq 21 -and $x -ge 14 -and $x -le 17 -and $ghost) { $r = 34; $g = 23; $b = 45 }

    # DIB bitmap rows are stored bottom-up.
    $index = (((($height - 1 - $y) * $width) + $x) * 4)
    $pixels[$index] = [byte]$b
    $pixels[$index + 1] = [byte]$g
    $pixels[$index + 2] = [byte]$r
    $pixels[$index + 3] = [byte]$a
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
Write-Host "Generated Ghous Cut ghost icon: src-tauri/icons/icon.ico"
