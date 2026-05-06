@echo off
cd /d "%~dp0"
title Configurateur d'affaires - atelier
cls
echo Lancement du configurateur...
echo.
echo Une page va s'ouvrir automatiquement sur http://127.0.0.1:8000
echo Garde cette fenetre ouverte pendant l'utilisation.
echo.
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 app.py
) else (
  python app.py
)
pause
