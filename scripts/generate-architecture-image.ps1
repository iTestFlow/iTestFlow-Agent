param(
  [string]$OutputPath = "public/brand/itestflow-architecture-hosted.png"
)

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  $resolvedOutput = $OutputPath
} else {
  $resolvedOutput = Join-Path $repoRoot $OutputPath
}

$outputDir = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir | Out-Null
}

$W = 1536
$H = 1024
$FontFamily = "Segoe UI"

function C([string]$Hex) {
  return [System.Drawing.ColorTranslator]::FromHtml($Hex)
}

function CA([string]$Hex, [int]$Alpha) {
  $base = C $Hex
  return [System.Drawing.Color]::FromArgb($Alpha, $base.R, $base.G, $base.B)
}

function Brush([string]$Hex, [int]$Alpha = 255) {
  return New-Object System.Drawing.SolidBrush (CA $Hex $Alpha)
}

function PenEx([string]$Hex, [float]$Width = 1.5, [int]$Alpha = 255) {
  $pen = New-Object System.Drawing.Pen (CA $Hex $Alpha), $Width
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  return $pen
}

function FontEx([float]$Size, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular) {
  return New-Object System.Drawing.Font $FontFamily, $Size, $Style, ([System.Drawing.GraphicsUnit]::Pixel)
}

function RectF([float]$X, [float]$Y, [float]$Width, [float]$Height) {
  return New-Object System.Drawing.RectangleF $X, $Y, $Width, $Height
}

function PointF([float]$X, [float]$Y) {
  return New-Object System.Drawing.PointF $X, $Y
}

function RoundPath([float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = [Math]::Min($Radius, [Math]::Min($Width, $Height) / 2)
  $d = $r * 2
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $Width - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $Width - $d, $Y + $Height - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $Height - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function DrawRoundFill([System.Drawing.Graphics]$G, [System.Drawing.Brush]$Fill, [float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius) {
  $path = RoundPath $X $Y $Width $Height $Radius
  $G.FillPath($Fill, $path)
  $path.Dispose()
}

function DrawRoundStroke([System.Drawing.Graphics]$G, [System.Drawing.Pen]$Stroke, [float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius) {
  $path = RoundPath $X $Y $Width $Height $Radius
  $G.DrawPath($Stroke, $path)
  $path.Dispose()
}

function DrawText(
  [System.Drawing.Graphics]$G,
  [string]$Text,
  [float]$X,
  [float]$Y,
  [float]$Width,
  [float]$Height,
  [System.Drawing.Font]$Font,
  [string]$ColorHex,
  [System.Drawing.StringAlignment]$Align = [System.Drawing.StringAlignment]::Near,
  [System.Drawing.StringAlignment]$LineAlign = [System.Drawing.StringAlignment]::Near
) {
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = $Align
  $sf.LineAlignment = $LineAlign
  $sf.Trimming = [System.Drawing.StringTrimming]::EllipsisWord
  $brush = Brush $ColorHex
  $G.DrawString($Text, $Font, $brush, (RectF $X $Y $Width $Height), $sf)
  $brush.Dispose()
  $sf.Dispose()
}

function DrawHeaderPill(
  [System.Drawing.Graphics]$G,
  [float]$X,
  [float]$Y,
  [float]$Width,
  [float]$Height,
  [string]$LeftColor,
  [string]$RightColor,
  [string]$Text,
  [System.Drawing.Font]$Font
) {
  $path = RoundPath $X $Y $Width $Height 7
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (RectF $X $Y $Width $Height), (C $LeftColor), (C $RightColor), 0
  $G.FillPath($brush, $path)
  $pen = PenEx "#ffffff" 0.8 80
  $G.DrawPath($pen, $path)
  DrawText $G $Text $X ($Y + 1) $Width ($Height - 2) $Font "#ffffff" ([System.Drawing.StringAlignment]::Center) ([System.Drawing.StringAlignment]::Center)
  $pen.Dispose()
  $brush.Dispose()
  $path.Dispose()
}

function DrawCard(
  [System.Drawing.Graphics]$G,
  [float]$X,
  [float]$Y,
  [float]$Width,
  [float]$Height,
  [string]$FillHex = "#ffffff",
  [string]$StrokeHex = "#82a6db",
  [float]$Radius = 8
) {
  $shadow = Brush "#0a3a80" 14
  DrawRoundFill $G $shadow ($X + 2) ($Y + 5) $Width $Height $Radius
  $shadow.Dispose()
  $fill = Brush $FillHex
  $stroke = PenEx $StrokeHex 1.25
  DrawRoundFill $G $fill $X $Y $Width $Height $Radius
  DrawRoundStroke $G $stroke $X $Y $Width $Height $Radius
  $fill.Dispose()
  $stroke.Dispose()
}

function DrawArrow(
  [System.Drawing.Graphics]$G,
  [float]$X1,
  [float]$Y1,
  [float]$X2,
  [float]$Y2,
  [string]$ColorHex = "#081f5c",
  [float]$Width = 2.4,
  [bool]$Both = $false
) {
  $pen = PenEx $ColorHex $Width
  $cap = New-Object System.Drawing.Drawing2D.AdjustableArrowCap 5, 7
  $pen.CustomEndCap = $cap
  if ($Both) {
    $startCap = New-Object System.Drawing.Drawing2D.AdjustableArrowCap 5, 7
    $pen.CustomStartCap = $startCap
  }
  $G.DrawLine($pen, $X1, $Y1, $X2, $Y2)
  if ($Both) { $startCap.Dispose() }
  $cap.Dispose()
  $pen.Dispose()
}

function DrawCheck([System.Drawing.Graphics]$G, [float]$X, [float]$Y, [float]$Size, [string]$ColorHex) {
  $pen = PenEx $ColorHex ([Math]::Max(2.0, $Size * 0.11))
  $G.DrawLines($pen, [System.Drawing.PointF[]]@(
    (PointF ($X + $Size * 0.18) ($Y + $Size * 0.54)),
    (PointF ($X + $Size * 0.42) ($Y + $Size * 0.76)),
    (PointF ($X + $Size * 0.84) ($Y + $Size * 0.24))
  ))
  $pen.Dispose()
}

function DrawLogoMark([System.Drawing.Graphics]$G, [float]$X, [float]$Y, [float]$Size) {
  $blue = PenEx "#1769ff" ([Math]::Max(4, $Size * 0.07))
  $teal = PenEx "#12b9c7" ([Math]::Max(4, $Size * 0.07))
  $navy = PenEx "#092060" ([Math]::Max(4, $Size * 0.07))
  $G.DrawArc($blue, $X + $Size * 0.15, $Y + $Size * 0.15, $Size * 0.58, $Size * 0.58, 205, 135)
  $G.DrawArc($teal, $X + $Size * 0.15, $Y + $Size * 0.15, $Size * 0.58, $Size * 0.58, 330, 135)
  $G.DrawArc($navy, $X + $Size * 0.15, $Y + $Size * 0.15, $Size * 0.58, $Size * 0.58, 115, 110)

  $white = Brush "#ffffff"
  $nodePen = PenEx "#1769ff" ([Math]::Max(4, $Size * 0.06))
  $darkPen = PenEx "#092060" ([Math]::Max(4, $Size * 0.06))
  $G.FillEllipse($white, $X + $Size * 0.38, $Y + $Size * 0.04, $Size * 0.20, $Size * 0.20)
  $G.DrawEllipse($nodePen, $X + $Size * 0.38, $Y + $Size * 0.04, $Size * 0.20, $Size * 0.20)
  $G.FillEllipse($white, $X + $Size * 0.04, $Y + $Size * 0.42, $Size * 0.20, $Size * 0.20)
  $G.DrawEllipse($darkPen, $X + $Size * 0.04, $Y + $Size * 0.42, $Size * 0.20, $Size * 0.20)

  $okFill = Brush "#ffffff"
  $okPen = PenEx "#14b8a6" ([Math]::Max(4, $Size * 0.06))
  $G.FillEllipse($okFill, $X + $Size * 0.63, $Y + $Size * 0.52, $Size * 0.27, $Size * 0.27)
  $G.DrawEllipse($okPen, $X + $Size * 0.63, $Y + $Size * 0.52, $Size * 0.27, $Size * 0.27)
  DrawCheck $G ($X + $Size * 0.66) ($Y + $Size * 0.55) ($Size * 0.23) "#14b8a6"

  $blue.Dispose(); $teal.Dispose(); $navy.Dispose(); $white.Dispose()
  $nodePen.Dispose(); $darkPen.Dispose(); $okFill.Dispose(); $okPen.Dispose()
}

function DrawImageContained(
  [System.Drawing.Graphics]$G,
  [string]$ImagePath,
  [float]$X,
  [float]$Y,
  [float]$MaxWidth,
  [float]$MaxHeight
) {
  if (-not (Test-Path -LiteralPath $ImagePath)) {
    throw "Missing image asset: $ImagePath"
  }

  $img = [System.Drawing.Image]::FromFile($ImagePath)
  try {
    $scale = [Math]::Min($MaxWidth / $img.Width, $MaxHeight / $img.Height)
    $drawW = $img.Width * $scale
    $drawH = $img.Height * $scale
    $drawX = $X + (($MaxWidth - $drawW) / 2)
    $drawY = $Y + (($MaxHeight - $drawH) / 2)
    $G.DrawImage($img, (RectF $drawX $drawY $drawW $drawH))
  } finally {
    $img.Dispose()
  }
}

function DrawIcon([System.Drawing.Graphics]$G, [string]$Kind, [float]$X, [float]$Y, [float]$Size, [string]$ColorHex = "#0a3a80") {
  $pen = PenEx $ColorHex ([Math]::Max(2.0, $Size * 0.055))
  $thin = PenEx $ColorHex ([Math]::Max(1.4, $Size * 0.035)) 220
  $fill = Brush $ColorHex 28
  $strong = Brush $ColorHex
  $cx = $X + $Size / 2
  $cy = $Y + $Size / 2

  switch ($Kind) {
    "org" {
      $G.DrawLine($thin, $X + $Size * 0.25, $Y + $Size * 0.30, $X + $Size * 0.62, $Y + $Size * 0.23)
      $G.DrawLine($thin, $X + $Size * 0.25, $Y + $Size * 0.30, $X + $Size * 0.45, $Y + $Size * 0.72)
      $G.DrawLine($thin, $X + $Size * 0.62, $Y + $Size * 0.23, $X + $Size * 0.75, $Y + $Size * 0.63)
      foreach ($p in @(
        @(0.13, 0.17), @(0.50, 0.10), @(0.33, 0.62), @(0.65, 0.52)
      )) {
        $G.FillEllipse((Brush "#ffffff"), $X + $Size * $p[0], $Y + $Size * $p[1], $Size * 0.22, $Size * 0.22)
        $G.DrawEllipse($pen, $X + $Size * $p[0], $Y + $Size * $p[1], $Size * 0.22, $Size * 0.22)
      }
    }
    "doc" {
      $G.DrawRectangle($pen, $X + $Size * 0.22, $Y + $Size * 0.12, $Size * 0.52, $Size * 0.72)
      $G.DrawLine($thin, $X + $Size * 0.34, $Y + $Size * 0.35, $X + $Size * 0.63, $Y + $Size * 0.35)
      $G.DrawLine($thin, $X + $Size * 0.34, $Y + $Size * 0.50, $X + $Size * 0.63, $Y + $Size * 0.50)
      $G.DrawLine($thin, $X + $Size * 0.34, $Y + $Size * 0.65, $X + $Size * 0.55, $Y + $Size * 0.65)
    }
    "list" {
      $G.DrawRectangle($pen, $X + $Size * 0.18, $Y + $Size * 0.18, $Size * 0.58, $Size * 0.66)
      $G.DrawRectangle($thin, $X + $Size * 0.35, $Y + $Size * 0.08, $Size * 0.24, $Size * 0.18)
      foreach ($yy in @(0.35, 0.52, 0.69)) {
        DrawCheck $G ($X + $Size * 0.27) ($Y + $Size * ($yy - 0.05)) ($Size * 0.12) $ColorHex
        $G.DrawLine($thin, $X + $Size * 0.43, $Y + $Size * $yy, $X + $Size * 0.65, $Y + $Size * $yy)
      }
    }
    "folder" {
      $G.DrawLine($pen, $X + $Size * 0.13, $Y + $Size * 0.32, $X + $Size * 0.37, $Y + $Size * 0.32)
      $G.DrawLine($pen, $X + $Size * 0.37, $Y + $Size * 0.32, $X + $Size * 0.45, $Y + $Size * 0.42)
      $G.DrawRectangle($pen, $X + $Size * 0.13, $Y + $Size * 0.42, $Size * 0.74, $Size * 0.36)
    }
    "book" {
      $G.FillRectangle($fill, $X + $Size * 0.18, $Y + $Size * 0.13, $Size * 0.13, $Size * 0.74)
      $G.DrawRectangle($pen, $X + $Size * 0.18, $Y + $Size * 0.13, $Size * 0.62, $Size * 0.74)
      $G.DrawLine($pen, $X + $Size * 0.31, $Y + $Size * 0.13, $X + $Size * 0.31, $Y + $Size * 0.87)
      $G.DrawLine($thin, $X + $Size * 0.39, $Y + $Size * 0.34, $X + $Size * 0.72, $Y + $Size * 0.34)
      $G.DrawLine($thin, $X + $Size * 0.39, $Y + $Size * 0.50, $X + $Size * 0.72, $Y + $Size * 0.50)
      $G.DrawLine($thin, $X + $Size * 0.39, $Y + $Size * 0.66, $X + $Size * 0.72, $Y + $Size * 0.66)
    }
    "bug" {
      $G.DrawEllipse($pen, $X + $Size * 0.30, $Y + $Size * 0.25, $Size * 0.40, $Size * 0.50)
      $G.DrawEllipse($thin, $X + $Size * 0.38, $Y + $Size * 0.12, $Size * 0.24, $Size * 0.22)
      foreach ($yy in @(0.35, 0.50, 0.65)) {
        $G.DrawLine($thin, $X + $Size * 0.30, $Y + $Size * $yy, $X + $Size * 0.13, $Y + $Size * ($yy - 0.06))
        $G.DrawLine($thin, $X + $Size * 0.70, $Y + $Size * $yy, $X + $Size * 0.87, $Y + $Size * ($yy - 0.06))
      }
      $G.DrawLine($thin, $cx, $Y + $Size * 0.26, $cx, $Y + $Size * 0.75)
    }
    "user" {
      $G.DrawEllipse($pen, $X + $Size * 0.35, $Y + $Size * 0.12, $Size * 0.30, $Size * 0.30)
      $G.DrawArc($pen, $X + $Size * 0.18, $Y + $Size * 0.44, $Size * 0.64, $Size * 0.55, 200, 140)
    }
    "people" {
      $G.DrawEllipse($pen, $X + $Size * 0.28, $Y + $Size * 0.16, $Size * 0.22, $Size * 0.22)
      $G.DrawEllipse($pen, $X + $Size * 0.55, $Y + $Size * 0.17, $Size * 0.20, $Size * 0.20)
      $G.DrawArc($pen, $X + $Size * 0.16, $Y + $Size * 0.43, $Size * 0.46, $Size * 0.38, 200, 140)
      $G.DrawArc($thin, $X + $Size * 0.48, $Y + $Size * 0.44, $Size * 0.40, $Size * 0.34, 200, 140)
    }
    "board" {
      $G.DrawRectangle($pen, $X + $Size * 0.15, $Y + $Size * 0.17, $Size * 0.66, $Size * 0.56)
      $G.DrawLine($thin, $X + $Size * 0.15, $Y + $Size * 0.37, $X + $Size * 0.81, $Y + $Size * 0.37)
      $G.DrawLine($thin, $X + $Size * 0.37, $Y + $Size * 0.17, $X + $Size * 0.37, $Y + $Size * 0.73)
      $G.DrawLine($thin, $X + $Size * 0.59, $Y + $Size * 0.17, $X + $Size * 0.59, $Y + $Size * 0.73)
      $G.FillEllipse($strong, $X + $Size * 0.65, $Y + $Size * 0.58, $Size * 0.22, $Size * 0.22)
      DrawCheck $G ($X + $Size * 0.68) ($Y + $Size * 0.60) ($Size * 0.16) "#ffffff"
    }
    "brain" {
      $G.DrawArc($pen, $X + $Size * 0.20, $Y + $Size * 0.25, $Size * 0.28, $Size * 0.34, 90, 250)
      $G.DrawArc($pen, $X + $Size * 0.43, $Y + $Size * 0.20, $Size * 0.36, $Size * 0.42, 250, 260)
      $G.DrawArc($pen, $X + $Size * 0.22, $Y + $Size * 0.45, $Size * 0.58, $Size * 0.35, 20, 250)
      $G.DrawLine($thin, $cx, $Y + $Size * 0.24, $cx, $Y + $Size * 0.78)
      $G.DrawEllipse($thin, $X + $Size * 0.28, $Y + $Size * 0.35, $Size * 0.13, $Size * 0.13)
      $G.DrawEllipse($thin, $X + $Size * 0.60, $Y + $Size * 0.43, $Size * 0.13, $Size * 0.13)
    }
    "chip" {
      $G.DrawRectangle($pen, $X + $Size * 0.27, $Y + $Size * 0.27, $Size * 0.46, $Size * 0.46)
      $G.FillRectangle($fill, $X + $Size * 0.37, $Y + $Size * 0.37, $Size * 0.26, $Size * 0.26)
      $G.DrawRectangle($thin, $X + $Size * 0.37, $Y + $Size * 0.37, $Size * 0.26, $Size * 0.26)
      foreach ($t in @(0.37, 0.50, 0.63)) {
        $G.DrawLine($thin, $X + $Size * $t, $Y + $Size * 0.27, $X + $Size * $t, $Y + $Size * 0.14)
        $G.DrawLine($thin, $X + $Size * $t, $Y + $Size * 0.73, $X + $Size * $t, $Y + $Size * 0.86)
        $G.DrawLine($thin, $X + $Size * 0.27, $Y + $Size * $t, $X + $Size * 0.14, $Y + $Size * $t)
        $G.DrawLine($thin, $X + $Size * 0.73, $Y + $Size * $t, $X + $Size * 0.86, $Y + $Size * $t)
      }
    }
    "brief" {
      $G.DrawRectangle($pen, $X + $Size * 0.13, $Y + $Size * 0.35, $Size * 0.74, $Size * 0.48)
      $G.DrawArc($pen, $X + $Size * 0.32, $Y + $Size * 0.17, $Size * 0.36, $Size * 0.28, 180, 180)
      $G.DrawLine($thin, $X + $Size * 0.13, $Y + $Size * 0.57, $X + $Size * 0.87, $Y + $Size * 0.57)
      $G.DrawRectangle($thin, $X + $Size * 0.41, $Y + $Size * 0.50, $Size * 0.18, $Size * 0.14)
    }
    "db" {
      $G.DrawEllipse($pen, $X + $Size * 0.18, $Y + $Size * 0.15, $Size * 0.64, $Size * 0.22)
      $G.DrawLine($pen, $X + $Size * 0.18, $Y + $Size * 0.26, $X + $Size * 0.18, $Y + $Size * 0.70)
      $G.DrawLine($pen, $X + $Size * 0.82, $Y + $Size * 0.26, $X + $Size * 0.82, $Y + $Size * 0.70)
      foreach ($yy in @(0.45, 0.64)) {
        $G.DrawArc($pen, $X + $Size * 0.18, $Y + $Size * ($yy - 0.11), $Size * 0.64, $Size * 0.22, 0, 180)
        $G.DrawArc($pen, $X + $Size * 0.18, $Y + $Size * ($yy - 0.11), $Size * 0.64, $Size * 0.22, 0, -180)
      }
    }
    "lock" {
      $G.DrawRectangle($pen, $X + $Size * 0.25, $Y + $Size * 0.43, $Size * 0.50, $Size * 0.34)
      $G.DrawArc($pen, $X + $Size * 0.34, $Y + $Size * 0.18, $Size * 0.32, $Size * 0.42, 180, 180)
      $G.FillEllipse($strong, $cx - $Size * 0.04, $Y + $Size * 0.56, $Size * 0.08, $Size * 0.08)
    }
    "gear" {
      $G.DrawEllipse($pen, $X + $Size * 0.27, $Y + $Size * 0.27, $Size * 0.46, $Size * 0.46)
      $G.DrawEllipse($thin, $X + $Size * 0.41, $Y + $Size * 0.41, $Size * 0.18, $Size * 0.18)
      foreach ($a in @(0, 45, 90, 135, 180, 225, 270, 315)) {
        $rad = $a * [Math]::PI / 180
        $G.DrawLine($pen, $cx + [Math]::Cos($rad) * $Size * 0.29, $cy + [Math]::Sin($rad) * $Size * 0.29, $cx + [Math]::Cos($rad) * $Size * 0.40, $cy + [Math]::Sin($rad) * $Size * 0.40)
      }
    }
    "search" {
      $G.DrawRectangle($thin, $X + $Size * 0.15, $Y + $Size * 0.14, $Size * 0.46, $Size * 0.56)
      $G.DrawEllipse($pen, $X + $Size * 0.44, $Y + $Size * 0.42, $Size * 0.28, $Size * 0.28)
      $G.DrawLine($pen, $X + $Size * 0.66, $Y + $Size * 0.66, $X + $Size * 0.84, $Y + $Size * 0.84)
      $G.DrawLine($thin, $X + $Size * 0.25, $Y + $Size * 0.32, $X + $Size * 0.48, $Y + $Size * 0.32)
    }
    "matrix" {
      $G.DrawRectangle($pen, $X + $Size * 0.16, $Y + $Size * 0.16, $Size * 0.68, $Size * 0.68)
      foreach ($v in @(0.38, 0.61)) {
        $G.DrawLine($thin, $X + $Size * $v, $Y + $Size * 0.16, $X + $Size * $v, $Y + $Size * 0.84)
        $G.DrawLine($thin, $X + $Size * 0.16, $Y + $Size * $v, $X + $Size * 0.84, $Y + $Size * $v)
      }
    }
    "timer" {
      $G.DrawEllipse($pen, $X + $Size * 0.22, $Y + $Size * 0.24, $Size * 0.56, $Size * 0.56)
      $G.DrawLine($pen, $cx, $Y + $Size * 0.22, $cx, $Y + $Size * 0.10)
      $G.DrawLine($thin, $X + $Size * 0.40, $Y + $Size * 0.10, $X + $Size * 0.60, $Y + $Size * 0.10)
      $G.DrawLine($thin, $cx, $cy, $cx, $Y + $Size * 0.36)
      $G.DrawLine($thin, $cx, $cy, $X + $Size * 0.62, $Y + $Size * 0.56)
    }
    "target" {
      $G.DrawEllipse($pen, $X + $Size * 0.18, $Y + $Size * 0.18, $Size * 0.62, $Size * 0.62)
      $G.DrawEllipse($thin, $X + $Size * 0.32, $Y + $Size * 0.32, $Size * 0.34, $Size * 0.34)
      $G.FillEllipse($strong, $cx - $Size * 0.04, $cy - $Size * 0.04, $Size * 0.08, $Size * 0.08)
      $G.DrawLine($pen, $X + $Size * 0.66, $Y + $Size * 0.34, $X + $Size * 0.88, $Y + $Size * 0.12)
    }
    "chart" {
      $G.DrawLine($pen, $X + $Size * 0.16, $Y + $Size * 0.78, $X + $Size * 0.86, $Y + $Size * 0.78)
      foreach ($bar in @(@(0.25, 0.50), @(0.45, 0.33), @(0.65, 0.22))) {
        $G.FillRectangle($fill, $X + $Size * $bar[0], $Y + $Size * $bar[1], $Size * 0.12, $Size * (0.78 - $bar[1]))
        $G.DrawRectangle($thin, $X + $Size * $bar[0], $Y + $Size * $bar[1], $Size * 0.12, $Size * (0.78 - $bar[1]))
      }
    }
    "trend" {
      $G.DrawLine($thin, $X + $Size * 0.15, $Y + $Size * 0.76, $X + $Size * 0.85, $Y + $Size * 0.76)
      $G.DrawLines($pen, [System.Drawing.PointF[]]@(
        (PointF ($X + $Size * 0.18) ($Y + $Size * 0.62)),
        (PointF ($X + $Size * 0.38) ($Y + $Size * 0.45)),
        (PointF ($X + $Size * 0.56) ($Y + $Size * 0.52)),
        (PointF ($X + $Size * 0.80) ($Y + $Size * 0.24))
      ))
    }
    "layers" {
      for ($i = 0; $i -lt 3; $i++) {
        $dy = $i * $Size * 0.14
        $pts = [System.Drawing.PointF[]]@(
          (PointF ($X + $Size * 0.50) ($Y + $Size * (0.18 + $dy))),
          (PointF ($X + $Size * 0.82) ($Y + $Size * (0.34 + $dy))),
          (PointF ($X + $Size * 0.50) ($Y + $Size * (0.50 + $dy))),
          (PointF ($X + $Size * 0.18) ($Y + $Size * (0.34 + $dy)))
        )
        $G.DrawPolygon($thin, $pts)
      }
    }
    default {
      $G.DrawRectangle($pen, $X + $Size * 0.18, $Y + $Size * 0.18, $Size * 0.64, $Size * 0.64)
      $G.DrawLine($thin, $X + $Size * 0.30, $Y + $Size * 0.38, $X + $Size * 0.70, $Y + $Size * 0.38)
      $G.DrawLine($thin, $X + $Size * 0.30, $Y + $Size * 0.54, $X + $Size * 0.70, $Y + $Size * 0.54)
    }
  }

  $pen.Dispose(); $thin.Dispose(); $fill.Dispose(); $strong.Dispose()
}

function DrawSideItem(
  [System.Drawing.Graphics]$G,
  [hashtable]$Item,
  [float]$X,
  [float]$Y,
  [float]$Width,
  [float]$Height,
  [string]$Accent,
  [System.Drawing.Font]$TitleFont,
  [System.Drawing.Font]$SubFont
) {
  DrawCard $G $X $Y $Width $Height "#ffffff" "#8bb0df" 7
  $iconY = $Y + (($Height - 44) / 2)
  DrawIcon $G $Item.Icon ($X + 15) $iconY 44 $Accent
  DrawText $G $Item.Title ($X + 86) ($Y + 7) ($Width - 100) ($Height - 26) $TitleFont "#061747"
  if ($Item.Sub) {
    DrawText $G $Item.Sub ($X + 86) ($Y + $Height - 17) ($Width - 100) 15 $SubFont "#335075"
  }
}

function DrawWorkflowCard(
  [System.Drawing.Graphics]$G,
  [hashtable]$Item,
  [float]$X,
  [float]$Y,
  [float]$Width,
  [float]$Height,
  [string]$Accent,
  [System.Drawing.Font]$TitleFont,
  [System.Drawing.Font]$SmallFont
) {
  DrawCard $G $X $Y $Width $Height "#ffffff" "#9dc0f2" 7
  DrawIcon $G $Item.Icon ($X + ($Width - 48) / 2) ($Y + 14) 48 $Accent
  DrawText $G $Item.Title ($X + 7) ($Y + 67) ($Width - 14) 46 $TitleFont "#092060" ([System.Drawing.StringAlignment]::Center)
  $by = $Y + 122
  foreach ($bullet in $Item.Bullets) {
    $dot = Brush $Accent
    $G.FillEllipse($dot, $X + 11, $by + 6, 4, 4)
    $dot.Dispose()
    DrawText $G $bullet ($X + 21) $by ($Width - 28) 28 $SmallFont "#061747"
    $by += 30
  }
}

function DrawGovItem(
  [System.Drawing.Graphics]$G,
  [hashtable]$Item,
  [float]$X,
  [float]$Y,
  [float]$Width,
  [float]$Height,
  [string]$Accent,
  [System.Drawing.Font]$Font
) {
  DrawIcon $G $Item.Icon ($X + ($Width - 42) / 2) ($Y + 15) 42 $Accent
  DrawText $G $Item.Title ($X + 4) ($Y + 62) ($Width - 8) 38 $Font "#061747" ([System.Drawing.StringAlignment]::Center)
}

function DrawSmallMetric(
  [System.Drawing.Graphics]$G,
  [hashtable]$Item,
  [float]$X,
  [float]$Y,
  [float]$Width,
  [float]$Height,
  [string]$Accent,
  [System.Drawing.Font]$Font
) {
  DrawIcon $G $Item.Icon ($X + ($Width - 42) / 2) ($Y + 13) 42 $Accent
  DrawText $G $Item.Title ($X + 4) ($Y + 60) ($Width - 8) 42 $Font "#061747" ([System.Drawing.StringAlignment]::Center)
}

$bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$bgRect = RectF 0 0 $W $H
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $bgRect, (C "#fbfdff"), (C "#edf8f9"), 90
$g.FillRectangle($bg, $bgRect)
$bg.Dispose()

$subtle = PenEx "#c8d8f2" 0.8 80
for ($x = 80; $x -lt $W; $x += 160) {
  $g.DrawLine($subtle, $x, 0, $x + 220, $H)
}
$subtle.Dispose()

$fontSubtitle = FontEx 21 ([System.Drawing.FontStyle]::Regular)
$fontSmallSubtitle = FontEx 17 ([System.Drawing.FontStyle]::Regular)
$fontHeader = FontEx 17 ([System.Drawing.FontStyle]::Bold)
$fontHeaderLarge = FontEx 20 ([System.Drawing.FontStyle]::Bold)
$fontCardTitle = FontEx 15.8 ([System.Drawing.FontStyle]::Bold)
$fontCardSub = FontEx 10.6 ([System.Drawing.FontStyle]::Regular)
$fontCore = FontEx 16 ([System.Drawing.FontStyle]::Regular)
$fontCoreBold = FontEx 17 ([System.Drawing.FontStyle]::Bold)
$fontWorkflowTitle = FontEx 14.2 ([System.Drawing.FontStyle]::Bold)
$fontWorkflowSmall = FontEx 10.8 ([System.Drawing.FontStyle]::Regular)
$fontGov = FontEx 13.3 ([System.Drawing.FontStyle]::Bold)
$fontMetric = FontEx 12.8 ([System.Drawing.FontStyle]::Bold)
$fontBenefit = FontEx 13.5 ([System.Drawing.FontStyle]::Bold)
$fontArrowLabel = FontEx 9.5 ([System.Drawing.FontStyle]::Italic)

$brandLogoPath = Join-Path $repoRoot "public/brand/itestflow-logo-full.png"
$brandIconPath = Join-Path $repoRoot "public/brand/itestflow-icon.png"

DrawImageContained $g $brandLogoPath 507 8 520 70
DrawText $g "Hosted Multi-User QA Intelligence for Azure DevOps" 494 77 550 28 $fontSubtitle "#061747" ([System.Drawing.StringAlignment]::Center)
DrawText $g "Org-scoped sessions + workspace isolation + AI-assisted human review" 455 106 630 23 $fontSmallSubtitle "#274464" ([System.Drawing.StringAlignment]::Center)

$leftX = 36
$leftW = 276
$rightX = 1230
$rightW = 270
$sideHeaderY = 72
$itemY = 120
$itemH = 76
$gap = 9

DrawHeaderPill $g $leftX $sideHeaderY $leftW 38 "#092060" "#0f2e79" "INPUTS & CONTEXT" $fontHeader
DrawHeaderPill $g $rightX $sideHeaderY $rightW 38 "#048b8f" "#12a7a7" "PLATFORM & INTEGRATIONS" $fontHeader

$leftItems = @(
  @{ Title = "Org & User`nLogin"; Sub = "Selected workspace session"; Icon = "org" },
  @{ Title = "Azure DevOps`nRequirements"; Sub = "User stories and features"; Icon = "doc" },
  @{ Title = "Work Items &`nCriteria"; Sub = "Acceptance and metadata"; Icon = "list" },
  @{ Title = "Project Wiki &`nKnowledge"; Sub = "Compiled project context"; Icon = "book" },
  @{ Title = "Defects & Test`nHistory"; Sub = "Runs, bugs, outcomes"; Icon = "bug" },
  @{ Title = "Human`nInstructions"; Sub = "Reviewer intent and edits"; Icon = "user" }
)

for ($i = 0; $i -lt $leftItems.Count; $i++) {
  DrawSideItem $g $leftItems[$i] $leftX ($itemY + $i * ($itemH + $gap)) $leftW $itemH "#0b579e" $fontCardTitle $fontCardSub
}

$rightItems = @(
  @{ Title = "Hosted Next.js`nApp + API"; Sub = "Authenticated web surface"; Icon = "doc" },
  @{ Title = "Azure DevOps`nBoards"; Sub = "Requirements and tasks"; Icon = "board" },
  @{ Title = "Azure Test`nPlans"; Sub = "Cases, suites, outcomes"; Icon = "list" },
  @{ Title = "LLM Provider`nAPIs"; Sub = "OpenAI, Gemini, Anthropic"; Icon = "chip" },
  @{ Title = "PostgreSQL`nWorkspace Data"; Sub = "Users, sessions, jobs, audit"; Icon = "db" },
  @{ Title = "Worker &`nJob Queue"; Sub = "Scheduled sync and indexing"; Icon = "gear" },
  @{ Title = "Encrypted`nCredentials"; Sub = "Per-user and workspace secrets"; Icon = "lock" }
)

$rightItemH = 64
$rightGap = 7
for ($i = 0; $i -lt $rightItems.Count; $i++) {
  DrawSideItem $g $rightItems[$i] $rightX ($itemY + $i * ($rightItemH + $rightGap)) $rightW $rightItemH "#088a8a" $fontCardTitle $fontCardSub
}

$coreX = 385
$coreY = 142
$coreW = 760
$coreH = 232
DrawCard $g $coreX $coreY $coreW $coreH "#ffffff" "#1769ff" 10
DrawHeaderPill $g 565 $coreY 400 35 "#1769ff" "#1160f2" "WORKSPACE-SCOPED AI TEST CORE" $fontHeader
DrawImageContained $g $brandIconPath 430 198 108 108

$checkBrush = Brush "#11a99b"
$bulletTextX = 585
$bulletY = 195
$coreBullets = @(
  "Authenticated workspace context",
  "RAG knowledge grounding",
  "Trusted project anchors",
  "Multi-provider LLM reasoning",
  "Structured, traceable outputs"
)
foreach ($txt in $coreBullets) {
  $g.FillEllipse($checkBrush, $bulletTextX, $bulletY + 2, 20, 20)
  DrawCheck $g ($bulletTextX + 3) ($bulletY + 5) 14 "#ffffff"
  DrawText $g $txt ($bulletTextX + 31) ($bulletY - 1) 260 26 $fontCore "#061747"
  $bulletY += 39
}
$checkBrush.Dispose()

$dividerPen = PenEx "#9eb8e6" 1.4
$g.DrawLine($dividerPen, 875, 193, 875, 352)
$dividerPen.Dispose()

$capY = 192
$capItems = @(
  @{ Text = "Understands reqs"; Icon = "doc" },
  @{ Text = "Finds risks"; Icon = "target" },
  @{ Text = "Designs coverage"; Icon = "matrix" },
  @{ Text = "Explains guidance"; Icon = "list" },
  @{ Text = "Enforces scope"; Icon = "lock" }
)
foreach ($cap in $capItems) {
  DrawIcon $g $cap.Icon 900 ($capY - 4) 32 "#1769ff"
  DrawText $g $cap.Text 947 $capY 185 24 $fontCore "#061747"
  $capY += 32
}

DrawArrow $g ($leftX + $leftW) 246 ($coreX - 9) 246 "#061747" 2.3 $false
DrawArrow $g ($coreX + $coreW + 8) 193 ($rightX - 12) 193 "#061747" 2.1 $true
DrawArrow $g ($coreX + $coreW + 8) 274 ($rightX - 12) 274 "#061747" 2.1 $true
DrawArrow $g ($coreX + $coreW + 8) 354 ($rightX - 12) 354 "#061747" 2.1 $true
DrawArrow $g 765 ($coreY + $coreH) 765 405 "#061747" 2.2 $false

$workX = 325
$workY = 413
$workW = 894
$workH = 218
DrawCard $g $workX $workY $workW $workH "#f7fbff" "#7db0ff" 10
DrawHeaderPill $g 578 397 368 34 "#1769ff" "#1159e8" "SPECIALIZED QA WORKFLOWS" $fontHeaderLarge

$workflowItems = @(
  @{ Title = "Requirement`nAnalysis"; Icon = "search"; Bullets = @("Quality findings", "Reviewed ADO comments") },
  @{ Title = "Test Case`nDesign"; Icon = "list"; Bullets = @("Positive & negative cases", "Publish to Test Plans") },
  @{ Title = "Test Gap`nAnalysis"; Icon = "matrix"; Bullets = @("Coverage matrix", "Suggested additions") },
  @{ Title = "Execution`nEffort"; Icon = "timer"; Bullets = @("Manual effort estimates", "Complexity insights") },
  @{ Title = "Bug`nReporting"; Icon = "bug"; Bullets = @("Evidence-based defects", "Ready-to-post reports") },
  @{ Title = "Suite`nMigration"; Icon = "folder"; Bullets = @("Preview copy or move", "Preserve outcomes") },
  @{ Title = "Bulk Task`nCreation"; Icon = "layers"; Bullets = @("Structured task batches", "Controlled publishing") }
)

$wfCardW = 116
$wfGap = 10
for ($i = 0; $i -lt $workflowItems.Count; $i++) {
  DrawWorkflowCard $g $workflowItems[$i] ($workX + 10 + $i * ($wfCardW + $wfGap)) ($workY + 17) $wfCardW 186 "#0b4aae" $fontWorkflowTitle $fontWorkflowSmall
}

$govX = 235
$govY = 659
$govW = 1064
$govH = 113
DrawCard $g $govX $govY $govW $govH "#fbfbff" "#6f75ff" 10
DrawHeaderPill $g 584 649 370 31 "#2b36c9" "#4a3fd6" "WORKSPACE KNOWLEDGE & GOVERNANCE" $fontHeader

$govItems = @(
  @{ Title = "Knowledge`nHub"; Icon = "book" },
  @{ Title = "Business Owner`nAssistant"; Icon = "brief" },
  @{ Title = "Project Context`nIndex"; Icon = "db" },
  @{ Title = "Audit`nTrail"; Icon = "doc" },
  @{ Title = "Trusted Project`nAnchors"; Icon = "target" },
  @{ Title = "Members`n& Roles"; Icon = "people" },
  @{ Title = "Human Review`nGates"; Icon = "lock" }
)

$govItemW = $govW / $govItems.Count
for ($i = 0; $i -lt $govItems.Count; $i++) {
  $x = $govX + $i * $govItemW
  if ($i -gt 0) {
    $linePen = PenEx "#d6d4fa" 1
    $g.DrawLine($linePen, $x, $govY + 28, $x, $govY + $govH - 24)
    $linePen.Dispose()
  }
  DrawGovItem $g $govItems[$i] $x $govY $govItemW $govH "#092060" $fontGov
}

for ($i = 0; $i -lt $workflowItems.Count; $i++) {
  $tx = $workX + 10 + $i * ($wfCardW + $wfGap) + $wfCardW / 2
  DrawArrow $g $tx ($govY - 6) $tx ($workY + $workH + 3) "#2b36c9" 1.7 $false
}

$outX = 64
$outY = 798
$outW = 708
$outH = 118
DrawCard $g $outX $outY $outW $outH "#fffaf4" "#f0a236" 9
DrawHeaderPill $g 265 784 230 33 "#ed8500" "#f1a000" "REVIEWED OUTPUTS" $fontHeader

$outputs = @(
  @{ Title = "Analysis`nFindings"; Icon = "list" },
  @{ Title = "Test`nCases"; Icon = "doc" },
  @{ Title = "Coverage`nGuidance"; Icon = "target" },
  @{ Title = "Effort`nEstimates"; Icon = "timer" },
  @{ Title = "Bug`nReports"; Icon = "bug" },
  @{ Title = "Migration`nPlans"; Icon = "folder" }
)
$outItemW = $outW / $outputs.Count
for ($i = 0; $i -lt $outputs.Count; $i++) {
  $x = $outX + $i * $outItemW
  if ($i -gt 0) {
    $linePen = PenEx "#f4d5a6" 1
    $g.DrawLine($linePen, $x, $outY + 27, $x, $outY + $outH - 25)
    $linePen.Dispose()
  }
  DrawSmallMetric $g $outputs[$i] $x $outY $outItemW $outH "#d97706" $fontMetric
}

$insX = 833
$insY = 798
$insW = 574
$insH = 118
DrawCard $g $insX $insY $insW $insH "#f5ffff" "#43b9c6" 9
DrawHeaderPill $g 992 784 236 33 "#058b8f" "#12a7a7" "INSIGHTS & FEEDBACK" $fontHeader

$insights = @(
  @{ Title = "Dashboards"; Icon = "chart" },
  @{ Title = "Coverage &`nQuality Trends"; Icon = "trend" },
  @{ Title = "Recent`nActivity"; Icon = "list" },
  @{ Title = "Job`nStatus"; Icon = "gear" },
  @{ Title = "Traceable`nDecisions"; Icon = "lock" }
)
$insItemW = $insW / $insights.Count
for ($i = 0; $i -lt $insights.Count; $i++) {
  $x = $insX + $i * $insItemW
  if ($i -gt 0) {
    $linePen = PenEx "#c4edf1" 1
    $g.DrawLine($linePen, $x, $insY + 27, $x, $insY + $insH - 25)
    $linePen.Dispose()
  }
  DrawSmallMetric $g $insights[$i] $x $insY $insItemW $insH "#0b4aae" $fontMetric
}

DrawArrow $g ($outX + $outW + 8) 855 ($insX - 8) 855 "#e48300" 2.2 $false
DrawArrow $g ($rightX + 130) 618 ($rightX + 130) 792 "#058b8f" 2.0 $false

# --- Arrow labels ---
# Inputs → Core: carry context into AI core
DrawText $g "context" 314 230 70 13 $fontArrowLabel "#274464" ([System.Drawing.StringAlignment]::Center) ([System.Drawing.StringAlignment]::Center)
# Core ↔ Azure DevOps Boards
DrawText $g "reads reqs" 1152 178 68 12 $fontArrowLabel "#274464" ([System.Drawing.StringAlignment]::Center) ([System.Drawing.StringAlignment]::Center)
# Core ↔ Azure Test Plans
DrawText $g "publishes" 1152 258 68 12 $fontArrowLabel "#274464" ([System.Drawing.StringAlignment]::Center) ([System.Drawing.StringAlignment]::Center)
# Core ↔ LLM Provider APIs
DrawText $g "AI reasoning" 1152 339 68 12 $fontArrowLabel "#274464" ([System.Drawing.StringAlignment]::Center) ([System.Drawing.StringAlignment]::Center)
# Core → Specialized QA Workflows
DrawText $g "dispatches" 770 384 78 12 $fontArrowLabel "#274464"
# Governance ↑ Workflows: knowledge grounds each workflow
DrawText $g "knowledge anchors" 682 639 168 12 $fontArrowLabel "#2b36c9" ([System.Drawing.StringAlignment]::Center) ([System.Drawing.StringAlignment]::Center)
# Reviewed Outputs → Insights & Feedback
DrawText $g "reviewed" 756 840 76 12 $fontArrowLabel "#b86000" ([System.Drawing.StringAlignment]::Center) ([System.Drawing.StringAlignment]::Center)
# Platform data → Insights (audit trail)
DrawText $g "audit & data" 1365 700 112 13 $fontArrowLabel "#058b8f"

$benefitX = 31
$benefitY = 942
$benefitW = 1475
$benefitH = 64
DrawCard $g $benefitX $benefitY $benefitW $benefitH "#f9fbff" "#a9bce5" 7
DrawHeaderPill $g 44 951 172 44 "#092060" "#0f2e79" "KEY BENEFITS" $fontHeaderLarge

$benefits = @(
  @{ Title = "Multi-Org Ready"; Icon = "org" },
  @{ Title = "Workspace Isolation"; Icon = "lock" },
  @{ Title = "Private Credentials"; Icon = "lock" },
  @{ Title = "Trusted Project Scope"; Icon = "target" },
  @{ Title = "Worker-Backed Sync"; Icon = "gear" },
  @{ Title = "Human-Controlled AI"; Icon = "user" }
)

$startX = 236
$benefitItemW = 205
for ($i = 0; $i -lt $benefits.Count; $i++) {
  $x = $startX + $i * $benefitItemW
  if ($i -gt 0) {
    $linePen = PenEx "#d3dcec" 1
    $g.DrawLine($linePen, $x - 18, $benefitY + 13, $x - 18, $benefitY + $benefitH - 13)
    $linePen.Dispose()
  }
  DrawIcon $g $benefits[$i].Icon $x ($benefitY + 14) 38 "#1769ff"
  DrawText $g $benefits[$i].Title ($x + 47) ($benefitY + 13) ($benefitItemW - 55) 38 $fontBenefit "#092060"
}

$bmp.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()

Write-Output "Generated $resolvedOutput"
