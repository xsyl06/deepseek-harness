@echo off
rem Double-click launcher for the dsh desktop shell (Electron + spawned backend).
cd /d "%~dp0"
call apps\desktop\node_modules\.bin\electron.cmd apps\desktop
