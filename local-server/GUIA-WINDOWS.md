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

### 8. (Recomendado) IP fixo
No roteador dos celulares, reserve um IP fixo para este PC (DHCP reservation / "IP estático"),
para o endereço que os celulares usam nunca mudar.

---

## PARTE 2 — Usar no dia do evento

### Ligar
**Dois cliques em `INICIAR.bat`.** Abre uma janela preta e mostra:

```
✅ SERVIDOR LOCAL RODANDO
   Neste PC:      http://localhost:8787
   Nos celulares: http://192.168.0.10:8787
```
**Não feche a janela preta** (pode minimizar).

### Confirmar que está funcionando
1. No próprio PC, abra o navegador em **http://localhost:8787/health**
   → tem que aparecer `"ok":true`.
2. No celular (conectado ao Wi-Fi do roteador dos conselheiros), abra o endereço
   "Nos celulares" mostrado na janela → deve abrir a tela de login.
   Se não abrir: rode o passo 5 (Firewall) e confirme que o celular está no Wi-Fi certo.

### Se algo der errado
| Sintoma | O que fazer |
|---|---|
| O servidor caiu / travou | **Nada.** O vigia reinicia sozinho em até ~1 min. A janela mostra "Reiniciando…". |
| Janela preta fechada sem querer | Dois cliques em `INICIAR.bat` de novo. Nada é perdido. |
| Mensagem "JÁ ESTÁ RODANDO em outra janela" | Normal — já tem um servidor ligado. Feche esta janela. |
| Mensagem "Falta configurar o QR_SECRET" | Abra `.env` no Bloco de Notas, preencha `QR_SECRET=` e salve. |
| PC reiniciou | Se fez o passo 7, volta sozinho. Senão, `INICIAR.bat`. |
| Celulares não conectam | Firewall (passo 5), Wi-Fi errado, ou IP do PC mudou (veja o IP na janela preta). |

### Onde ficam as coisas (não apague durante o evento)
| Pasta | Conteúdo |
|---|---|
| `local-server\data\` | **O banco de dados** e as fotos/comprovantes enviados |
| `local-server\backups\` | Cópia automática do banco a cada 10 min (guarda as últimas 48) |
| `local-server\logs\` | Registro do que aconteceu (para diagnóstico) |

**Fim do evento:** copie a pasta `local-server\data` e `local-server\backups` para um pen-drive.

---

## O que esta fase NÃO faz ainda
O servidor está pronto e testado, mas **o app dos conselheiros ainda fala com a nuvem**.
Chegam nas próximas fases: apontar o app para o servidor local, fila offline no celular,
sincronização automática com a nuvem, painel de status.
