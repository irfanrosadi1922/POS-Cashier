@echo off
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  echo Klik kanan file ini lalu pilih "Run as administrator".
  pause
  exit /b 1
)
rem Jalan otomatis setiap komputer menyala (tanpa perlu login), dan komputer tidak tidur saat dicolok listrik
schtasks /Create /TN "POS SATE Server" /TR "\"%~dp0jalankan-pos.bat\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
schtasks /Run /TN "POS SATE Server"
echo.
echo Selesai. Server akan menyala otomatis setiap komputer hidup.
echo Untuk melepas: schtasks /Delete /TN "POS SATE Server" /F
pause
