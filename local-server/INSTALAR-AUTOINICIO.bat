@echo off
title Campori APV - Iniciar sozinho ao ligar o PC
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
(
  echo @echo off
  echo start "Campori APV" /min "%~dp0INICIAR.bat"
) > "%STARTUP%\Campori-Servidor.bat"
echo.
echo Pronto: o servidor vai iniciar sozinho quando este usuario entrar no Windows.
echo (Para desfazer, apague o arquivo Campori-Servidor.bat da pasta Inicializar.)
pause
