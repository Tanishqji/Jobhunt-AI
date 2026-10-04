@echo off
cd /d "%~dp0"
echo Starting JobHunt AI Dashboard...
call .venv\Scripts\activate.bat
python -m backend web --port 8000
pause
