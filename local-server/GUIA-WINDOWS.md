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

### 8. IP fixo para o PC (reserva de IP) — obrigatório
O nome `local.gdtmidia.com.br` vai apontar para o IP deste PC; se o IP mudar, os celulares deixam de achar o servidor.
1. Abra a página de administração do **roteador dos celulares** (normalmente `192.168.0.1` ou `192.168.1.1`; a senha costuma estar na etiqueta do roteador).
2. Procure **"Reserva de endereço" / "DHCP Reservation" / "Address Reservation" / "IP estático"**.
3. Escolha o PC do evento (pelo nome ou MAC) e reserve um IP, por exemplo `192.168.0.10`. **Anote este IP.**
4. Reinicie o PC (ou desconecte/reconecte a rede) e confirme com `ipconfig` que ele pegou o IP reservado.

---

## PARTE 1B — HTTPS (obrigatório para o app instalado nos celulares)

**Por quê:** o app instalado vem de `https://campori.gdtmidia.com.br`. O navegador só deixa uma página `https` falar
com um servidor que também seja `https`, com certificado válido e com nome (`local.gdtmidia.com.br`) — não vale IP nem `http`.
Sem isto o app cai sozinho para a nuvem e **não usa o servidor local**.

Resumo: `local.gdtmidia.com.br` → IP do PC · certificado gratuito (Let's Encrypt) emitido com o **win-acme** · arquivos em `certs\`.
**Faça com internet (Starlink ou casa) e até 08/10**: o certificado vale 90 dias, então basta emitir uma vez.

### 9. Registro DNS do nome (Cloudflare)
1. Entre em https://dash.cloudflare.com → domínio **gdtmidia.com.br** → **DNS** → **Records** → **Add record**.
2. Tipo **A** · Nome `local` · Conteúdo = **o IP reservado no passo 8** (ex.: `192.168.0.10`).
3. **Proxy status: "DNS only" (nuvem CINZA).** Com a nuvem laranja não funciona (IP privado não passa pelo proxy).
4. TTL: **1 dia** (ou o maior disponível) — ajuda os celulares a lembrarem do endereço.
5. Salve. Teste no PC: `nslookup local.gdtmidia.com.br` deve responder com o IP reservado.

### 10. ⚠️ DNS dentro da rede dos celulares (para funcionar SEM internet)
O registro do passo 9 é público: só funciona quando o celular consegue **consultar a internet**. Se a Starlink cair, o celular
não resolve `local.gdtmidia.com.br` — e o servidor local ficaria inalcançável justamente quando mais precisa. Duas soluções:

- **A (melhor) — o próprio roteador responde o nome:** procure no roteador **"DNS local" / "Hosts" / "Static DNS" / "Hostnames"**
  e cadastre `local.gdtmidia.com.br` → IP do PC. (Existe em OpenWrt, MikroTik, Ubiquiti, pfSense e alguns TP-Link/ASUS;
  roteadores domésticos simples muitas vezes **não** têm.)
- **B — o PC responde o nome:** instale o **Acrylic DNS Proxy** (gratuito, Windows), adicione a linha
  `192.168.0.10 local.gdtmidia.com.br` (seu IP) ao arquivo de hosts dele, e no roteador configure o **DNS do DHCP = IP do PC**.
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
   - **Origem / site:** *Manual input* → digite o host: `local.gdtmidia.com.br`; nome amigável: `local.gdtmidia.com.br`;
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
| App mostra "🟢 Online · nuvem" em vez de "servidor local" | O app não achou o servidor local em 3 s: DNS, HTTPS desligado, ou celular em outra rede. |

### Onde ficam as coisas (não apague durante o evento)
| Pasta | Conteúdo |
|---|---|
| `local-server\data\` | **O banco de dados** e as fotos/comprovantes enviados |
| `local-server\backups\` | Cópia automática do banco a cada 10 min (guarda as últimas 48) |
| `local-server\logs\` | Registro do que aconteceu (para diagnóstico) |

**Fim do evento:** copie a pasta `local-server\data` e `local-server\backups` para um pen-drive.

---

## O que ainda NÃO existe
- **Sincronização do servidor local com a nuvem (Firebase):** scans feitos no servidor local só aparecem na nuvem depois
  dessa fase. Até lá, trate o PC do evento como a fonte da verdade durante o evento e **guarde os backups** (`backups\`).
- Painel de status do PC.
