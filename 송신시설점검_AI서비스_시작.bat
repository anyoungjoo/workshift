@echo off
chcp 65001 > nul
title KBS 송출센터 - 송신 시설 점검 계획 AI 연동 서비스
cd /d "%~dp0"
echo ============================================================
echo   KBS 송출센터 - 송신 시설 점검 계획 한글(.hwp) AI 연동 서비스
echo ============================================================
echo.
echo 백그라운드 서버를 시작합니다... (종료하려면 Ctrl+C 또는 창 닫기)
echo.
python maint_hwp_service.py
pause
