# Starts the local server + a free Cloudflare quick tunnel, then opens the GitHub Pages site wired to this laptop.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$Pages = 'https://killerbood.github.io/WhatsApp-automation/'
if (-not (Test-Path node_modules)) { npm install --omit=dev }
if (-not $env:APP_PASSWORD -or $env:APP_PASSWORD.Length -lt 8) {
  $env:APP_PASSWORD = Read-Host 'اكتب باسورد للموقع (8 حروف او اكتر)'
}
if (-not (Test-Path cloudflared.exe)) {
  Write-Host 'تحميل cloudflared لمرة واحدة...'
  Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile cloudflared.exe
}
$env:PORT = '3000'
$srv = Start-Process node -ArgumentList 'server.js' -PassThru
Start-Sleep 2
$log = Join-Path $env:TEMP 'wa-cloudflared.log'
Remove-Item $log -ErrorAction SilentlyContinue
$tun = Start-Process .\cloudflared.exe -ArgumentList 'tunnel','--url','http://localhost:3000' -RedirectStandardError $log -PassThru -WindowStyle Hidden
$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep 1
  if (Test-Path $log) { $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } }
}
if (-not $url) { Write-Host 'مقدرتش أجيب لينك التونل. جرّب تاني.'; $srv.Kill(); $tun.Kill(); exit 1 }
$link = "$Pages`?backend=$url"
Write-Host ''
Write-Host 'جاهز! الموقع بيفتح دلوقتي. لو الباسورد اتطلب اكتب نفس الباسورد.'
Write-Host $link
Start-Process $link
Write-Host ''
Write-Host 'سيب النافذة دي مفتوحة. اقفلها لو عايز توقف كل حاجة.'
try { Wait-Process -Id $srv.Id } finally { if (-not $tun.HasExited) { $tun.Kill() }; if (-not $srv.HasExited) { $srv.Kill() } }
