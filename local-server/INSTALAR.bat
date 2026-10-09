@echo off
title Campori APV - Instalacao do servidor local
cd /d "%~dp0"
echo.
echo  === Instalacao do servidor local - Campori APV ===
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao esta instalado.
  echo        Baixe a versao "LTS" em https://nodejs.org , instale, e rode este arquivo de novo.
  pause
  exit /b 1
)
echo Node.js encontrado:
node -v
echo.
echo Instalando dependencias (precisa de internet, leva 1 a 2 minutos)...
call npm install
if errorlevel 1 (
  echo [ERRO] Falha ao instalar. Verifique a internet e tente de novo.
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo Vou abrir o arquivo de configuracao. Preencha a linha QR_SECRET= com o mesmo
  echo valor usado na nuvem, SALVE e feche o Bloco de Notas.
  pause
  notepad .env
)
echo.
echo  PRONTO. Para iniciar o servidor, de dois cliques em INICIAR.bat
echo.
pause
