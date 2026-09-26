@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
node studio\server.mjs
if errorlevel 1 pause
