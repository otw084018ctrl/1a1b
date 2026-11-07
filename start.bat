@echo off
chcp 65001 >nul
pushd "%~dp0"
if not exist "1a1b-server.js" (echo [!] Please unzip first, then run start.bat inside the 1a1b folder. & pause & exit /b)
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
if not "%NODE%"=="node" if not exist "%NODE%" (echo [!] Node.js not found. Install the LTS version from https://nodejs.org then restart the computer. & pause & exit /b)
"%NODE%" 1a1b-server.js
pause
