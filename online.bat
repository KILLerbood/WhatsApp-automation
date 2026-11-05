@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules call npm install --omit=dev
if "%APP_PASSWORD%"=="" set /p APP_PASSWORD=اكتب باسورد للموقع (8 حروف او اكتر): 
if not exist cloudflared.exe (
  echo تحميل cloudflared لمرة واحدة...
  curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
)
start "WA-Server" cmd /k "set APP_PASSWORD=%APP_PASSWORD%&& node server.js"
timeout /t 3 >nul
echo.
echo هيظهر تحت لينك زي https://xxxx.trycloudflare.com - ده لينك موقعك الاونلاين.
echo سيب النافذة دي والتانية مفتوحتين طول ما بتستخدم الموقع.
cloudflared.exe tunnel --url http://localhost:3000
pause
