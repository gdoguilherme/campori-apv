# local-server — servidor offline do Campori APV (Fase 1)

Express + SQLite (módulo nativo `node:sqlite` — **sem compilação nativa no Windows**).
Requer **Node.js ≥ 22.13**. Para o evento: ver [GUIA-WINDOWS.md](GUIA-WINDOWS.md).

## Arquitetura

```
shared/scoring.js        ← regras de negócio (pontuação, disciplina, trava de QR). Puro, sem dependências.
   ├─ js/api.js          ← frontend (mesmas funções de antes, agora re-exportadas daqui)
   └─ local-server/      ← servidor local (usa as MESMAS funções)
server/                  ← backend da nuvem (Fly.io) — NÃO foi alterado
```

Importante: na nuvem, a pontuação **roda no navegador** (o backend só cuida de login, upload e
QR). O módulo compartilhado extrai exatamente essa lógica; o servidor local a executa
**no servidor**, então a trava de duplicidade de QR é autoritativa (atômica, vale mesmo com 2
celulares escaneando juntos). Paridade com a implementação antiga verificada com 3000
cenários aleatórios.

| Arquivo | Papel |
|---|---|
| `src/db.js` | Schema SQLite: 1 tabela por coleção do Firestore (`regions, units, participants, requirements, submissions, disciplinaryActions, auditLog, users`), doc completo em JSON + colunas indexadas + `updatedAt/deleted/dirty` (prontos p/ sincronização) |
| `src/app.js`, `src/routes/*` | API HTTP |
| `src/server.js` | Processo do servidor |
| `src/supervisor.js` | Watchdog: reinicia em crash, mata/reinicia se `/health` travar, evita instância duplicada |
| `INICIAR.bat` | Duplo-clique: sobe o watchdog (e re-sobe o próprio watchdog se ele morrer) |

## Validar na sua máquina (Mac/Linux/Windows)

```bash
nvm use 22            # sua versão padrão é a 16 — precisa ser ≥ 22.13
cd local-server
npm install
npm test              # 16 testes: pontuação, disciplina, QR, permissões, concorrência
npm run demo          # cria banco de demonstração + sobe com watchdog em http://localhost:8787
```

Usuários da demo (senha `demo1234`): `admin`, `fiscal`, `regiao1`, `conselheiro1`, `conselheiro2`.
Recriar a demo do zero: `npm run seed-demo -- --reset`.

Fluxo completo de QR via curl:
```bash
B=http://localhost:8787
tok() { curl -s -XPOST $B/users/login -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"demo1234\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
F=$(tok fiscal); C=$(tok conselheiro1)
QR=$(curl -s -XPOST $B/qr/generate -H "authorization: Bearer $F" -H 'content-type: application/json' \
     -d '{"requirementId":"demoReqQR","variantId":"basico","points":5}')
curl -s -XPOST $B/qr/redeem -H "authorization: Bearer $C" -H 'content-type: application/json' -d "$QR"   # 200 → +5 pts na unidade Águias
curl -s -XPOST $B/qr/redeem -H "authorization: Bearer $C" -H 'content-type: application/json' -d "$QR"   # 409 DUPLICATE
curl -s $B/ranking                                                                                        # público, anônimo
```

## API

Mesmos caminhos/contratos da nuvem: `POST /users/login`, `/users/*`, `POST /qr/generate`,
`POST /qr/verify`, `POST /upload` (grava em `data/uploads`, serve em `/files/...`).
Autenticação: `Authorization: Bearer <token>` (JWT 8h, mesmo formato da nuvem).

| Rota | Perfis | Descrição |
|---|---|---|
| `GET /health` | público | status, contagem de registros, `revision` |
| `GET /ranking` | público | posição + pontos + estrelas (anônimo) |
| `GET /scores/units` | logado | pontuação por unidade (`computeUnitScores`) + estrelas |
| `GET /data/:colecao[?campo=valor&since=ms]` | logado | lista (filtros: campos indexados; `since` inclui exclusões p/ sync) |
| `POST/PATCH/DELETE /data/:colecao[/:id]` | conforme coleção | CRUD de `regions, requirements, units, participants` |
| `POST /submissions` | region, counselor | envio com validação de tipo, prazo e duplicidade |
| `POST /submissions/fiscal-suggestion` | judge, admin | sugestão do Fiscal (fica pendente) |
| `POST /submissions/:id/review` | approver, admin | aprova/rejeita/reabre + `auditLog` |
| `POST /qr/redeem` | counselor | valida o QR **e** pontua, com trava `(unitId, prova)` |
| `POST /discipline`, `DELETE /discipline/:id` | admin | −5 pts fixos por unidade ou região |

O servidor também serve o frontend estático (`/pages`, `/js`, `/css`, `/assets`, `/shared`) —
**apenas essas pastas**; credenciais e o banco nunca são expostos.

## Decisões / limites conhecidos

- **`node:sqlite`** em vez de `better-sqlite3`: não precisa de Visual Studio/Python no Windows.
  O aviso "SQLite is an experimental feature" no console é esperado e inofensivo.
- **Hash de QR idêntico ao da nuvem** (`test/qr-compat.test.js` carrega `server/services/qrTokens.js`
  e compara). O `QR_SECRET` local precisa ser o mesmo do Fly.
- Lógica de **usuários/login** (`routes/users.js`) é cópia do backend da nuvem, de propósito: o
  backend de produção não foi tocado a poucos dias do evento. Só a pontuação foi centralizada.
- Ainda **não** existe: sincronização com a nuvem, frontend apontando para este servidor, push em
  tempo real (use `GET /data/...?since=<ms>` / `revision`), upload para o Google Drive.
- Segurança: rede local confiável; qualquer origem é aceita por CORS, a proteção é o token Bearer.
