@echo off
cd /d "%~dp0"
title KBS - Google Cloud Functions Deploy

echo ===================================================================
echo   KBS OnAir Reservation - Google Cloud Functions Deploy Wizard
echo ===================================================================
echo.
echo [Step 1] Firebase Login: Opening browser for Google login...
echo (Please log in with your Google account that owns workshift-6ca5d)
echo.
call npx.cmd firebase-tools login
if errorlevel 1 (
    echo.
    echo [ERROR] Firebase login failed or was cancelled.
    pause
    exit /b %errorlevel%
)

echo.
echo ===================================================================
echo [Step 2] Deploying Cloud Functions to Google Cloud...
echo (This may take about 1-2 minutes to deploy on Google Cloud)
echo ===================================================================
echo.
call npx.cmd firebase-tools deploy --only functions
if errorlevel 1 (
    echo.
    echo [NOTE] If it says Blaze plan required, please enable Blaze plan in Firebase Console.
    pause
    exit /b %errorlevel%
)

echo.
echo ===================================================================
echo   [SUCCESS] Cloud Functions deployment completed successfully!
echo   You can now close this window.
echo ===================================================================
pause
