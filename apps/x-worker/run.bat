@echo off
cd /d "%~dp0"
where py >nul 2>nul && (py worker.py) || (python worker.py)
pause
