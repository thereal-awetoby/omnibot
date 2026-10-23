@echo off
cd /d "%~dp0"
echo Installing the X worker parts (one time)...
where py >nul 2>nul && (py -m pip install -r requirements.txt) || (python -m pip install -r requirements.txt)
echo.
echo If you saw errors above, send me a photo of them. Otherwise next: add-account.bat
pause
