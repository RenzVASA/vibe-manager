@echo off
cls
color 0B
title --- VIBE MANAGER DASHBOARD ---
echo ====================================================
echo    VIBE MANAGER : SYSTEME DE VOTE INTERACTIF
echo ====================================================
echo.
echo [INFO] Verification des dependances...
if not exist node_modules (
    echo [ERREUR] Dossier node_modules absent. Installation...
    npm install
)
echo [INFO] Tentative de lancement du serveur...
echo.
node server.js
pause