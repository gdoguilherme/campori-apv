@echo off
title Campori APV - Liberar acesso dos celulares (Firewall)
net session >nul 2>&1
if errorlevel 1 (
  echo Este arquivo precisa ser executado como ADMINISTRADOR:
  echo clique com o botao direito neste arquivo e escolha "Executar como administrador".
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="Campori APV Servidor Local" >nul 2>&1
netsh advfirewall firewall add rule name="Campori APV Servidor Local" dir=in action=allow protocol=TCP localport=8787 profile=any
echo.
echo Pronto: os celulares na rede local agora conseguem acessar o servidor (porta 8787).
pause
