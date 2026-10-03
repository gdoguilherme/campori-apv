@echo off
title Campori APV - SERVIDOR LOCAL (NAO FECHE ESTA JANELA)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao esta instalado. Rode o INSTALAR.bat primeiro.
  pause
  exit /b 1
)
if not exist node_modules (
  echo [ERRO] Dependencias nao instaladas. Rode o INSTALAR.bat primeiro.
  pause
  exit /b 1
)
:loop
node src\supervisor.js
set CODE=%ERRORLEVEL%
if "%CODE%"=="10" goto fim
if "%CODE%"=="11" goto erro
if "%CODE%"=="12" goto erro
echo.
echo [!] O programa de vigilancia parou (codigo %CODE%). Reiniciando em 3 segundos...
timeout /t 3 /nobreak >nul
goto loop
:erro
echo.
echo [ERRO DE CONFIGURACAO] Veja a mensagem acima e o GUIA-WINDOWS.md.
:fim
echo.
pause
