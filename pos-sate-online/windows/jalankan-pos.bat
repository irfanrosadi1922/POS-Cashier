@echo off
chcp 65001 >nul
title POS SATE Server
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js belum terpasang. Pasang Node.js LTS (versi 22 atau lebih baru) dari https://nodejs.org lalu jalankan file ini lagi.
  pause
  exit /b 1
)
if not exist ".env" (
  echo File .env belum ada. Salin ".env.example" menjadi ".env", lalu isi POS_PASSWORD dengan sandi owner.
  pause
  exit /b 1
)
rem Server berada di belakang Cloudflare Tunnel: baca IP asli pelanggan dari header Cloudflare
set TRUST_PROXY=cloudflare
:loop
node --disable-warning=ExperimentalWarning server.js
echo.
echo Server berhenti. Dinyalakan ulang dalam 5 detik... (tutup jendela ini untuk menghentikan)
timeout /t 5 /nobreak >nul
goto loop
