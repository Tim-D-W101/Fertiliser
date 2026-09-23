@echo off
REM Double-click to start the fertiliser app on the tower server.
cd /d "%~dp0"

REM ---- Settings: change these ----
set FERT_ADMIN_PIN=1234
set FERT_CURRENCY=R
set FERT_SITE_NAME=Fertiliser Stock
REM --------------------------------

if not exist venv (
    echo First run: setting up...
    python -m venv venv || goto :nopython
    venv\Scripts\python -m pip install -r requirements.txt || goto :error
)
venv\Scripts\python run_server.py 8080
pause
exit /b

:nopython
echo Python is not installed. Install it from https://www.python.org/downloads/
echo (tick "Add python.exe to PATH" during install), then run this again.
pause
exit /b

:error
echo Setup failed - check the internet connection and try again.
pause
