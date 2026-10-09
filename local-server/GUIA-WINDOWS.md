# Servidor local do Campori — Guia rápido para Windows

PC do evento: Windows 10/11, ligado à Starlink e ao roteador dos celulares.
Tempo estimado de instalação: **15 minutos** (precisa de internet só nesta etapa).

---

## PARTE 1 — Instalar (uma vez só, depois de formatar)

### 1. Instalar o Node.js
1. Abra https://nodejs.org e baixe a versão **LTS** (botão verde; tem que ser **22 ou 24**).
2. Instale clicando em *Next* até o fim (deixe tudo como está).
3. Confirme: abra o **Prompt de Comando** (tecla Windows → digite `cmd` → Enter) e digite `node -v`.
   Tem que aparecer `v22.…` ou `v24.…`. Se aparecer erro, reinicie o PC e tente de novo.

### 2. Copiar o projeto
Copie a pasta **inteira** do projeto (ex.: `Pontuação Campori de Líderes APV`) para `C:\campori\`
(pen-drive, ou baixe o ZIP do GitHub e extraia). **Não copie só a pasta `local-server`** —
ela precisa da pasta `shared` ao lado.

No final deve existir: `C:\campori\local-server\INICIAR.bat`

### 3. Instalar as dependências
Dê **dois cliques** em `C:\campori\local-server\INSTALAR.bat`.
- Ele instala tudo sozinho (1–2 min) e abre o Bloco de Notas com o arquivo `.env`.
- Preencha a linha `QR_SECRET=` com **o mesmo valor** do QR_SECRET da nuvem (Fly.io).
  Salve e feche.

- Preencha também `JWT_SECRET=` com **o mesmo valor** do JWT_SECRET da nuvem (Fly.io): é o que faz o
  login valer nos dois servidores (o app do Conselheiro troca entre servidor local e nuvem sozinho).

> ⚠️ **QR_SECRET igual ao da nuvem é obrigatório.** Se for diferente, todos os QR Codes
> já impressos darão "QR inválido" no modo offline. (O `flyctl secrets list` não mostra o
> valor — se ninguém guardou, é preciso definir um novo no Fly **e reimprimir os QRs**.)

### 4. Trazer os dados da nuvem para o PC (uma vez, com internet)
No Prompt de Comando:
```
cd C:\campori\local-server
npm run pull-cloud -- --dry-run
```
Mostra quantos registros existem na nuvem (não grava nada). Se os números fazem sentido:
```
npm run pull-cloud -- --yes
```
Isso copia regiões, unidades, participantes, requisitos, submissões, usuários e disciplina
para o banco local (e guarda um backup do banco anterior).
> Precisa do arquivo de credenciais `server\campori-apv-firebase-adminsdk.json`
> (ou aponte outro com a variável `FIREBASE_CREDENTIALS_FILE`).

### 5. Liberar o acesso dos celulares (Firewall)
Clique com o **botão direito** em `LIBERAR-FIREWALL.bat` → **Executar como administrador**.
Sem isso o Windows bloqueia os celulares.

### 6. Deixar o PC "à prova de soneca" (Prompt de Comando como Administrador)
```
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```
E em *Configurações → Windows Update*: **Pausar atualizações** por 1 semana (o Windows não
pode reiniciar sozinho no meio do evento).

### 7. (Recomendado) Iniciar sozinho ao ligar o PC
Dê dois cliques em `INSTALAR-AUTOINICIO.bat`. Se o PC reiniciar (queda de energia),
o servidor volta sozinho assim que o Windows entrar na conta.

### 8. Rede do evento e IP fixo do PC (`192.168.50.10`) — obrigatório
O nome `local.gdtmidia.com.br` vai apontar para o IP deste PC; se o IP mudar, os celulares deixam de achar o servidor.

**Como ligar os cabos (o roteador TP-Link manda na rede):**
- Roteador da Starlink (ou da Claro, nos testes) → cabo da **LAN dele** até a porta **WAN/Internet** do **TP-Link**.
- **Switch** → uma porta **LAN** do TP-Link. O **PC do servidor** (e o Mac, nos testes) ficam ligados no switch.
- **Nenhum cabo** liga a Starlink diretamente ao switch ou às portas LAN do TP-Link (dois DHCP na mesma rede dão conflito).
- Assim o PC acessa a internet (Starlink) através do TP-Link, e os celulares ficam na mesma rede do PC.

**Configuração do TP-Link** (os nomes dos menus variam um pouco entre modelos; painel em `http://tplinkwifi.net` ou `192.168.0.1`):
1. **Avançado → Rede → LAN:** IP do roteador `192.168.50.1`, máscara `255.255.255.0`. Salve (a conexão cai e volta).
   Essa faixa `192.168.50.x` é diferente da da Starlink (`192.168.1.x`) e da Claro (`192.168.0.x`), para não dar colisão.
2. **Servidor DHCP:** faixa `192.168.50.100` a `192.168.50.199`. (O DNS do DHCP só muda no passo 10.)
3. No Windows, rode `ipconfig /all` e anote o **Endereço Físico** da placa Ethernet do PC.
4. No TP-Link, **Reserva de endereço / Address Reservation:** associe esse endereço físico ao IP **`192.168.50.10`**.
5. No PC, rode `ipconfig /release` e `ipconfig /renew` (ou reinicie) e confirme com `ipconfig` que o IP é **`192.168.50.10`**.
6. Reinicie o `INICIAR.bat`: a linha "Celulares" deve mostrar `192.168.50.10`.
7. **Teste em HTTP:** com o celular no Wi-Fi do TP-Link e os dados móveis desligados, abra `http://192.168.50.10:8787/health` → `"ok":true`.

---

## PARTE 1B — HTTPS (obrigatório para o app instalado nos celulares)

**Por quê:** o app instalado vem de `https://campori.gdtmidia.com.br`. O navegador só deixa uma página `https` falar
com um servidor que também seja `https`, com certificado válido e com nome (`local.gdtmidia.com.br`) — não vale IP nem `http`.
Sem isto o app cai sozinho para a nuvem e **não usa o servidor local**.

Resumo: `local.gdtmidia.com.br` → IP do PC · certificado gratuito (Let's Encrypt) emitido com o **win-acme** · arquivos em `certs\`.
**Faça com internet (Starlink ou casa) e até 08/10**: o certificado vale 90 dias, então basta emitir uma vez.

### 9. Registro DNS do nome (Cloudflare)
1. Entre em https://dash.cloudflare.com → domínio **gdtmidia.com.br** → **DNS** → **Records** → **Add record**.
2. Tipo **A** · Nome `local` · Conteúdo = **o IP reservado no passo 8: `192.168.50.10`**.
3. **Proxy status: "DNS only" (nuvem CINZA).** Com a nuvem laranja não funciona (IP privado não passa pelo proxy).
4. TTL: **1 dia** (ou o maior disponível) — ajuda os celulares a lembrarem do endereço.
5. Salve. Teste no PC: `nslookup local.gdtmidia.com.br` deve responder com o IP reservado.

### 10. ⚠️ DNS dentro da rede dos celulares (para funcionar SEM internet)
O registro do passo 9 é público: só funciona quando o celular consegue **consultar a internet**. Se a Starlink cair, o celular
não resolve `local.gdtmidia.com.br` — e o servidor local ficaria inalcançável justamente quando mais precisa. Duas soluções:

- **A (melhor) — o próprio roteador responde o nome:** procure no roteador **"DNS local" / "Hosts" / "Static DNS" / "Hostnames"**
  e cadastre `local.gdtmidia.com.br` → IP do PC. (Existe em OpenWrt, MikroTik, Ubiquiti, pfSense e alguns TP-Link/ASUS;
  roteadores domésticos simples muitas vezes **não** têm.)
- **B — o PC responde o nome (plano principal):** instale o **Acrylic DNS Proxy** (gratuito, Windows) e:
  1. No menu Iniciar, abra **Edit Acrylic Hosts File** e adicione a linha `192.168.50.10 local.gdtmidia.com.br`. Salve.
  2. Reinicie o serviço do Acrylic (Iniciar → Acrylic DNS Proxy → Restart Acrylic Service). Os demais nomes ele repassa ao DNS de fora.
  3. **Obrigatório:** por padrão o Acrylic **recusa consultas de outros aparelhos**. Iniciar → Acrylic DNS Proxy → **Open Acrylic Configuration File**, e no FIM do arquivo, abaixo da linha `[AllowedAddressesSection]` (a que não tem `;` na frente), escreva `IP1=192.168.50.*` e `IP2=127.0.0.1`. Salve e faça **Restart Acrylic Service** (e **Purge Acrylic Cache**, se mudou o hosts).
  4. Libere a **porta 53 (UDP e TCP)** de entrada no Firewall do Windows, em qualquer perfil de rede, e crie regras de entrada para `AcrylicService.exe` e `AcrylicConsole.exe` (PowerShell como administrador: `New-NetFirewallRule -DisplayName "Campori DNS UDP" -Direction Inbound -Protocol UDP -LocalPort 53 -Action Allow -Profile Any`, o mesmo para TCP, e `-Program "C:\Program Files (x86)\Acrylic DNS Proxy\AcrylicService.exe"`). Confirme com `Get-NetConnectionProfile` que a rede está como Private.
  5. Teste de outro aparelho da rede: `nslookup local.gdtmidia.com.br 192.168.50.10` deve responder `192.168.50.10`, **também com a Starlink desconectada**.
  4. No TP-Link, **Rede → Servidor DHCP:** **DNS primário = `192.168.50.10`**, secundário em branco. Salve e reconecte os celulares ao Wi-Fi.
- Cuidados: alguns roteadores têm **"proteção contra DNS rebinding"** que bloqueia nomes públicos apontando para IP privado —
  desative-a ou use a solução A/B. No Android, **"DNS privado" deve estar "Automático" ou "Desativado"** (se estiver com um
  provedor fixo, o celular ignora o DNS do roteador).

**Teste obrigatório (faça antes do evento):** desconecte a Starlink do roteador, conecte um celular ao Wi-Fi do roteador e abra
`https://local.gdtmidia.com.br/health` (passo 14). Se não abrir sem internet, o DNS (passo 10) ainda não está certo.

### 11. Token da API do Cloudflare (para o win-acme criar o registro de validação)
1. Cloudflare → ícone do perfil → **My Profile** → **API Tokens** → **Create Token**.
2. Modelo **"Edit zone DNS"** → *Zone Resources*: **Include → Specific zone → gdtmidia.com.br** → **Continue to summary** → **Create Token**.
3. **Copie o token agora** (só aparece uma vez) e guarde num lugar seguro. **Não coloque no git nem mande por WhatsApp/e-mail.**

### 12. Emitir o certificado com o win-acme (validação DNS-01 no Cloudflare)
1. Baixe em https://www.win-acme.com (arquivo `win-acme.v2.x.x.x64.pluggable.zip`) e extraia em `C:\win-acme\`.
2. Do mesmo site (página **Plugins**), baixe o plugin de validação **Cloudflare** (`plugin.validation.dns.cloudflare...zip`) e
   extraia **dentro de `C:\win-acme\`**, junto do `wacs.exe`.
3. Clique com o botão direito em `wacs.exe` → **Executar como administrador**. No menu (os textos podem variar um pouco entre versões):
   - **N** — *Create certificate (default settings)*… escolha **M — Create certificate with full options** se pedir mais opções;
   - **Origem / site:** *Manual input* → digite o host: `local.gdtmidia.com.br`; nome amigável: `local.gdtmidia.com.br` (Enter);
   - **"Would you like to split this source into multiple certificates?"** → digite **`4`** (*Single certificate*);
   - **Validação:** **`[dns-01]` Create verification records in Cloudflare** → cole o **token do passo 11** (e escolha a zona se perguntar);
   - **Chave:** RSA (padrão);
   - **Armazenamento (Store):** **PEM encoded files** → pasta **`C:\campori\local-server\certs`** (crie a pasta se não existir);
   - **Instalação:** *No (additional) installation steps*.
4. Ao terminar, devem existir na pasta `certs\` (entre outros):
   `local.gdtmidia.com.br-chain.pem` (certificado + cadeia) e `local.gdtmidia.com.br-key.pem` (**chave privada — segredo!**).
5. O win-acme cria sozinho uma **tarefa agendada** que renova o certificado (a partir de ~55 dias). O servidor **recarrega o
   certificado novo sem reiniciar** (confira no log: "Certificado HTTPS recarregado").

> 🔒 **A chave privada (`-key.pem`) nunca pode ir para o git, e-mail, WhatsApp ou pen-drive compartilhado.** A pasta `certs\`
> já está no `.gitignore` e fora do deploy — se copiar o projeto para outro PC, **não leve a pasta `certs\`**: emita lá de novo.

### 13. Conferir o `.env` e liberar a porta 443
O `.env` (criado pelo INSTALAR.bat) já vem com os caminhos certos. Confira que existem estas linhas:
```
HTTPS_CERT_PATH=certs/local.gdtmidia.com.br-chain.pem
HTTPS_KEY_PATH=certs/local.gdtmidia.com.br-key.pem
HTTPS_PORT=443
```
Rode de novo `LIBERAR-FIREWALL.bat` (botão direito → Executar como administrador): agora ele libera as portas **443** e 8787.
Se a porta 443 já estiver ocupada (IIS, Skype, VMware…), o log avisa; descubra o programa com
`netstat -ano | findstr :443` e desligue-o (não mude a porta: o app espera `https://local.gdtmidia.com.br` sem número).

### 14. Testar o HTTPS
1. Inicie com `INICIAR.bat`. A janela deve mostrar:
   ```
   Celulares:     https://local.gdtmidia.com.br   (HTTPS ativo, certificado até 2026-xx-xx)
   Teste rápido:  https://local.gdtmidia.com.br/health
   ```
2. No **PC**: abra `https://local.gdtmidia.com.br/health` → cadeado fechado e `"ok":true` com `"https":{"enabled":true,...}`.
3. No **celular** (Wi-Fi do roteador, **Starlink desconectada**): abra o mesmo endereço → `"ok":true`. É o teste do passo 10.
4. No celular, abra `https://campori.gdtmidia.com.br`, entre como conselheiro: a barra do topo deve mostrar **"🟢 Online · servidor local"**.
   Na 1ª vez o Chrome pode perguntar **"permitir acesso a dispositivos da rede local?"** → **Permitir**.

---

## PARTE 1C — Sincronização com a nuvem (Firebase) e painel de status

O servidor local manda para a nuvem, sozinho e em segundo plano, tudo o que acontece em campo (scans de QR, avaliações do
fiscal, disciplina, aprovações). **Se a Starlink cair nada para**: o servidor continua funcionando e envia tudo quando a
internet voltar. Quem vence quando os dois lados mexem na mesma coisa está no `OFFLINE.md` (resumo: scan mais antigo vence;
revisão mais recente vence; nos cadastros vale a nuvem).

### 15. Ligar a sincronização
1. O arquivo de credenciais do Firebase (`campori-apv-firebase-adminsdk.json`) tem que estar em `C:\campori\server\`
   (é o mesmo do passo 4). **É uma chave de administrador: fica só neste PC, nunca vai para e-mail/WhatsApp/git.**
2. No `.env`, troque `CLOUD_SYNC=0` por **`CLOUD_SYNC=1`**. Defina também um **`STATUS_PIN`** (4 a 8 números) se quiser abrir o
   painel de outro aparelho.
3. Reinicie o servidor (feche a janela preta e abra `INICIAR.bat`). A janela mostra:
   `Painel (PC): http://localhost:8787/status   (sincronização com a nuvem LIGADA)`.
> O banco de **demonstração** (`npm run demo`) **nunca** sincroniza — de propósito.

### 16. O painel de status — `http://localhost:8787/status`
Abra no navegador **do PC** (ou fixe nos favoritos). Em outro aparelho, use o endereço do PC e digite o PIN.

| Cor grande | O que significa | O que fazer |
|---|---|---|
| 🟢 **Tudo certo** | Servidor rodando, nuvem conectada, tudo enviado. | Nada. |
| 🟡 **Sem internet — N itens aguardando envio** | A Starlink está fora. **Está tudo seguro neste PC.** | Nada: envia sozinho quando voltar (ou clique em **Sincronizar agora**). |
| 🟡 **N itens aguardando envio** | Internet ok; o envio está acontecendo. | Aguarde alguns segundos. |
| 🔴 **Atenção: há erros** | Algum item não pôde ser enviado (o motivo aparece na lista). | Clique em **Sincronizar agora**; se persistir, chame o responsável técnico com o texto do erro. |
| ⚪ **Funcionando só neste PC** | A sincronização está desligada ou sem credenciais. | Confira o passo 15. |

- **Última sincronização** e **itens aguardando envio** ficam sempre visíveis. Mais embaixo: cada **unidade** e cada
  **requisito** com ✅ Sincronizado / 🕓 Pendente / ❌ Erro.
- **🔄 Sincronizar agora:** **envia** o que está pendente **e traz** as novidades da nuvem. Responde com ✅ (deu certo, com o
  resumo), 📡 (sem acesso à nuvem — explica) ou ❌ (erro **com o motivo**).
- **⬇️ Atualizar dados da nuvem:** só traz (cadastros, requisitos, usuários, aprovações feitas na nuvem...). Os dados da
  nuvem também chegam **sozinhos** enquanto houver internet; o botão força uma conferência completa.
- **"Última atualização vinda da nuvem"** mostra a hora e se está acompanhando em tempo real. Alteração feita neste PC e
  ainda não enviada **nunca é apagada** por uma atualização da nuvem.
- **⚠️ "Pontos que já estavam cadastrados":** aparece em amarelo quando a sincronização acha uma pontuação repetida (ex.: a
  unidade já tinha pontuado aquela prova na nuvem). **Avise a organização** e depois clique em "Entendi — limpar avisos".
- Se o painel mostrar a faixa vermelha **"Não consigo falar com o servidor"**, a janela preta fechou: abra `INICIAR.bat`.

### 17. Teste com a nuvem de verdade (faça antes do evento, com internet)
Até aqui foi testado com uma nuvem simulada; este roteiro confirma credenciais e regras do Firebase reais:
1. Com `CLOUD_SYNC=1` e o banco recém-importado (`npm run pull-cloud -- --yes`), abra o painel: a luz **Nuvem** deve ficar 🟢
   em até 1 minuto. Clique **Sincronizar agora** → deve dizer "Tudo já estava sincronizado".
2. No app do conselheiro (rede do roteador, servidor local ativo), escaneie **um QR de uma unidade de teste**. No painel
   aparece 🕓 e, em seguida, ✅ (alguns segundos).
3. No **Console do Firebase → Firestore → `submissions`**, procure o documento `scan_…` e confira unidade, prova e pontos.
   **Apague esse documento de teste** (e o registro local de teste, se não quiser que conte).
4. **Teste da queda:** desconecte a Starlink, escaneie outro QR de teste → o painel fica 🟡 "Sem internet — 1 item aguardando
   envio". Reconecte → em até ~1 minuto fica 🟢 sozinho.

---

## PARTE 2 — Usar no dia do evento

### Ligar
**Dois cliques em `INICIAR.bat`.** Abre uma janela preta e mostra:

```
✅ SERVIDOR LOCAL RODANDO
   Neste PC:      http://localhost:8787
   Celulares:     https://local.gdtmidia.com.br   (HTTPS ativo, certificado até 2026-xx-xx)
   Teste rápido:  https://local.gdtmidia.com.br/health
```
Se aparecer **"⚠️ HTTPS DESLIGADO"**, o app instalado nos celulares **não conecta** — veja a tabela abaixo.
**Não feche a janela preta** (pode minimizar).

### Confirmar que está funcionando
1. No próprio PC, abra **https://local.gdtmidia.com.br/health** (ou http://localhost:8787/health)
   → tem que aparecer `"ok":true` e `"https":{"enabled":true,…}`.
2. No celular (Wi-Fi do roteador dos conselheiros), abra o mesmo endereço → `"ok":true`.
   Se não abrir: Firewall (passo 13), DNS (passo 10) ou Wi-Fi errado.
3. No app (`https://campori.gdtmidia.com.br`), a barra do topo mostra **🟢 Online · servidor local**.

### Se algo der errado
| Sintoma | O que fazer |
|---|---|
| O servidor caiu / travou | **Nada.** O vigia reinicia sozinho em até ~1 min. A janela mostra "Reiniciando…". |
| Janela preta fechada sem querer | Dois cliques em `INICIAR.bat` de novo. Nada é perdido. |
| Mensagem "JÁ ESTÁ RODANDO em outra janela" | Normal — já tem um servidor ligado. Feche esta janela. |
| Mensagem "Falta configurar o QR_SECRET" | Abra `.env` no Bloco de Notas, preencha `QR_SECRET=` e salve. |
| PC reiniciou | Se fez o passo 7, volta sozinho. Senão, `INICIAR.bat`. |
| Celulares não conectam | Firewall (passos 5 e 13), Wi-Fi errado, ou IP do PC mudou (reserva de IP — passo 8). |
| Aviso **"HTTPS DESLIGADO — … não estão no .env"** | Preencha `HTTPS_CERT_PATH`/`HTTPS_KEY_PATH` no `.env` (passo 13) e reinicie. |
| Aviso **"Arquivo não encontrado: …pem"** | O certificado ainda não foi emitido (passo 12) ou os arquivos não estão em `local-server\certs\`. |
| Aviso **"chave privada não corresponde"** | `-chain.pem` e `-key.pem` são de emissões diferentes. Emita de novo no win-acme e copie os DOIS. |
| Aviso **"porta 443 já está em uso"** | `netstat -ano \| findstr :443` e desligue o programa que usa a porta. |
| Aviso **"CERTIFICADO VENCIDO / vence em N dias"** | Abra o `wacs.exe` como administrador e renove (`R`). Precisa de internet. |
| Celular: "sua conexão não é particular" | Data/hora do celular ou do PC errada, ou o nome usado não é `local.gdtmidia.com.br`. |
| `https://local.gdtmidia.com.br/health` não abre no celular, mas abre no PC | DNS (passo 10): celular sem internet não resolve o nome; ou "DNS privado" do Android fixo; ou proteção contra DNS rebinding no roteador. |
| iPhone: `http://IP:8787` abre, mas pelo nome `local.gdtmidia.com.br` dá timeout (Android abre normal) | Em Ajustes → Wi-Fi → (i) da rede, desligue **Limitar Rastreamento de Endereço IP** (e, se precisar, a **Retransmissão Privada** do iCloud). Foi a causa nos testes de 08/10 (com a Claro como internet); no local do evento, 100% sem internet, pode nem acontecer — confirmar lá. |
| App mostra "🟢 Online · nuvem" em vez de "servidor local" | O app não achou o servidor local em 3 s: DNS, HTTPS desligado, ou celular em outra rede. |

### Onde ficam as coisas (não apague durante o evento)
| Pasta | Conteúdo |
|---|---|
| `local-server\data\` | **O banco de dados** e as fotos/comprovantes enviados |
| `local-server\backups\` | Cópia automática do banco a cada 10 min (guarda as últimas 48) |
| `local-server\logs\` | Registro do que aconteceu (para diagnóstico) |

**Fim do evento:** copie a pasta `local-server\data` e `local-server\backups` para um pen-drive.

---

## Limitações conhecidas
- **Fotos/comprovantes** ficam **só neste PC** (`data\uploads`): nada vai ao Google Drive. Na nuvem aparece "foto disponível apenas no PC do evento".
  **Copie ao fim do dia:** `npm run backup-uploads` (ou `npm run backup-uploads -- E:\` para o pen-drive).
- O app com servidor local precisa de **Chrome/Android ≥ 89** ou **iOS ≥ 16.4** (o próprio app avisa se o aparelho for antigo).
- Sem internet **nenhum aparelho novo** instala o app (a primeira instalação precisa de rede). Aparelhos que já abriram o app, ou que abrem `https://local.gdtmidia.com.br` na rede do evento, funcionam sem internet.
- Mudanças no código do app só chegam aos celulares quando eles abrem o app na rede (barra 🟢 → **Atualizar app**).
- Inspeção de uniforme: a pontuação só entra no ranking depois que o **admin/aprovador aprova**.

---

## PARTE 3 — Rotina e ferramentas do dia do evento

> Todos os comandos abaixo são no terminal, dentro da pasta `local-server` (`cd C:\campori\local-server`).

### Antes de abrir: `npm run preflight`
Um comando que confere e imprime ✅/❌/⚠️: Node ≥ 22.13, `.env` (QR_SECRET), `CLOUD_SYNC` + credenciais, certificado/chave e dias restantes,
portas 443/8787, banco com dados, **último backup há menos de 15 min**, espaço em disco, **DNS `local.gdtmidia.com.br` → IP deste PC** e
a nuvem (só informativo). Termina com **✅ PRONTO** ou a lista de ❌ a corrigir (cada um traz o que fazer). Rode com o servidor ligado.

### Fotos: `npm run backup-uploads`
Copia `data\uploads` para `backups\uploads-AAAAMMDD-HHMM\` e **confere** (nº de arquivos e bytes). Com destino: `npm run backup-uploads -- E:\`.
O painel `/status` mostra quantos arquivos/MB existem e o aviso "as fotos ficam só neste PC".

### Painel `/status` (`http://localhost:8787/status`)
Além do semáforo: contagens (regiões, unidades, participantes, requisitos, usuários, submissões pendentes/aprovadas), última sincronização,
espaço livre no disco, uploads, **dias restantes do certificado** e o botão **💾 Baixar backup agora** (baixa o banco e guarda cópia em `backups\`).

### Limpar os ensaios: `npm run resetar-eventos-de-teste`
Apaga **submissões, disciplinas e log de auditoria** (mantém regiões, unidades, participantes, requisitos e usuários). Faz **backup automático antes**
(`backups\campori-pre-reset-...db`; se o backup falhar, não apaga nada) e pede **duas confirmações**: `SIM` e depois `APAGAR <número>`.
- `-- --dry-run` mostra o que faria sem alterar nada.
- Por padrão a limpeza também vai para a nuvem no próximo sync; `-- --so-local` apaga só neste PC (a nuvem pode trazer de volta).
- **Só antes do evento.** Pare o servidor (feche a janela do `INICIAR.bat`) antes de rodar e abra de novo depois. As fotos em `data\uploads` não são apagadas.

### Ferramenta de último caso: `npm run dbtool`
Listar/ver/alterar/apagar um registro com **backup automático**, `dirty=1` e índices coerentes (detalhes em `DBTOOL.md`). Use só se o painel do admin não resolver.

### Plano B — voltar ao modo antigo: `LOCAL_APP_MODE=0`
Se o modo local total der problema, ponha `LOCAL_APP_MODE=0` no `.env` e reinicie o servidor: as páginas voltam a usar a nuvem (como antes). Para religar, `LOCAL_APP_MODE=1` (ou apague a linha).

### Inspeção de Uniforme (fiscal e admin)
- **Admin:** Requisitos → *Novo* → marque **👔 Inspeção de uniforme** → defina **Pontuação** (máximo, sugestão 10) e **pontos descontados por erro** (sugestão 1). Nome/código/tipo "Só Fiscal" são preenchidos sozinhos.
- **Fiscal (ou admin):** botão **👔 Inspeção de Uniforme** → escolha a **unidade** (a região preenche sozinha) → conte os erros nas 8 categorias (− / + ou digitando) e anote observações → **Salvar inspeção**.
  Pontos da unidade = `máx − erros × desconto` (mínimo 0; *Opcionais* não descontam). Reavaliar a mesma unidade **substitui** a anterior.
- Funciona offline: se o servidor cair, a inspeção fica na fila do aparelho e sobe sozinha (barra 🟡 → **Sincronizar agora**).
- O admin vê o detalhe (erros por categoria + observações) na **Fila**, aprova/rejeita, e baixa o **CSV** em *Histórico → 👔 CSV Uniforme*.

### Barra 🟢🟡🔴 em todas as telas
Bolinha no canto: 🟢 tudo certo · 🟡 há itens aguardando envio (número ao lado) · 🔴 sem servidor local/internet. Tocando: **Sincronizar agora**, versão do app
e **Atualizar app** (busca a versão nova e recarrega **sem apagar a fila nem o login**).

---

## Ranking
Nos celulares ligados à rede do evento, o ranking (tela de login, portais e painel do admin) vem **do servidor local**;
fora dela, da nuvem. Sempre aparece embaixo a hora da última atualização (ex.: *"Atualizado às 14:32 · servidor local"*).
