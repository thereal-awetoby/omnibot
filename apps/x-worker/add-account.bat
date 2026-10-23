@echo off
cd /d "%~dp0"
where py >nul 2>nul && (py add_account.py) || (python add_account.py)
pause
