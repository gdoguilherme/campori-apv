# Modo offline — Fase 3: fila offline do Conselheiro

O Conselheiro registra pontuação por QR Code **mesmo sem nenhum servidor**; os registros ficam
guardados no aparelho (IndexedDB) e são enviados quando houver conexão. Nada se perde se o app
for fechado, se a bateria acabar ou se o login vencer.

## Como funciona
```
 escaneia QR ─▶ valida OFFLINE ─▶ entra na FILA (IndexedDB) ─▶ tenta enviar na hora (≤4 s)
                (prova certa? já pontuou?)                         │
                                                  ┌────────────────┴───────────────┐
                                           enviou: ✅ sincronizado         não enviou: 🕓 pendente
                                                                            (reenvio automático)
```
- **Fila primeiro:** o scan é gravado *antes* de qualquer rede. O `id` (UUID) gerado no aparelho é a
  chave de idempotência — reenviar o mesmo item devolve o mesmo resultado, sem duplicar pontos.
- **Validação offline** usa só dados já baixados (prova, variantes, o que a unidade já pontuou **e a
  própria fila**). O **hash do QR nunca vai para o celular** nem é validado nele: só o servidor tem o
  segredo e confere na sincronização (QR adulterado → `rejeitado`).
- **Servidor:** o app testa o **servidor local** (timeout 3 s) e cai para a **nuvem**. Nenhuma chamada
  de rede fica sem timeout (`js/net.js`).

## Endpoints (idênticos no servidor local e no backend da nuvem)
| Rota | Descrição |
|---|---|
| `POST /sync/scans` | Lote de até 100 scans. Por item: `aceito` · `duplicado` · `rejeitado` (+ `code`/`message`). |
| `GET /sync/bootstrap` | Snapshot da unidade (unidade, participantes, provas+variantes **sem hash**, pontuação confirmada, ranking, regiões). |

Regras (em [`shared/sync.js`](shared/sync.js), uma só para os dois servidores):
1. Hash válido → prova/variante/pontos conferem com o requisito → unidade do item = unidade do login.
2. **Trava (unitId + prova-pai):** só um scan aprovado por unidade e prova.
3. **Conflito entre aparelhos da mesma unidade: vence o `scanTimestamp` mais ANTIGO**, não a ordem de
   chegada. O registro mais novo vira `rejected/superseded` e o aparelho dele passa a mostrar
   "Substituído". Aprovação manual do admin nunca é substituída.
4. Idempotência pelo id do cliente (`submissions/scan_<id>`); `scanTimestamp` do futuro é limitado ao agora.
5. Lote processado do scan mais antigo ao mais novo; resposta na ordem enviada; um item ruim não derruba o lote.

Arquivos: `shared/sync.js` (decisão pura) · `local-server/src/routes/sync.js` (SQLite, `BEGIN IMMEDIATE`
por item) · `server/services/syncStore.js` + `server/routes/sync.js` (Firestore, transação por item).
`server/shared/` é **cópia gerada** de `shared/` (o Docker do Fly.io só enxerga `server/`):
`node scripts/sync-shared.mjs` — um teste falha se estiver desatualizada.

## Sessão
`localStorage` (sobrevive a fechar o app). Expira junto com o JWT: **Conselheiro 5 dias** (cobre 9–12/10),
demais perfis 8 h. Expirou mesmo assim? A fila **não é apagada**: a barra mostra "Sessão expirada —
entre de novo" e, depois do login, a fila é enviada sozinha. "Sair" limpa a sessão e os dados baixados,
mas **mantém a fila** (com confirmação se houver pendentes).

## Configuração (`js/config.js`)
- `LOCAL_SERVER_URL`: `https://local.gdtmidia.com.br` em produção; `http://localhost:8787` em
  desenvolvimento; a própria origem se a página foi aberta pelo servidor local (porta 8787).
- `CLOUD_URL`: `https://campori-apv-upload.fly.dev`.
- Trocar sem deploy (console do navegador): `localStorage.campori_local_url = '…'` / `campori_cloud_url`.
- **`JWT_SECRET` e `QR_SECRET` do servidor local precisam ser iguais aos da nuvem.**

## Sincronização automática
Ao abrir o app · evento `online` · aba volta ao foco · a cada 15 s com **backoff** (15 s → 5 min, ±20 %)
enquanto houver pendentes · botão **🔄 Sincronizar agora**. Dados da unidade são atualizados a cada 45 s
(aba visível). A tela mostra servidor ativo, contador de pendentes e "última atualização".

## Limites conhecidos desta fase
- Só o **registro por QR Code** funciona offline. Enviar **comprovação (foto)** continua exigindo a
  nuvem (Firestore/Drive): sem internet o app avisa na hora em vez de travar.
- Servidor local e Firebase **ainda não sincronizam entre si** (próxima fase): scans feitos no
  servidor local só aparecem na nuvem depois dessa sincronização.
- O hash só é conferido no servidor: offline, um QR forjado é aceito na fila e recusado depois.
- HTTPS/certificado de `local.gdtmidia.com.br` fica para o próximo prompt.

## Testes
`cd local-server && npm test` — 43 testes: decisão de sync (idempotência, dois aparelhos, ordem do lote,
rejeições, relógio adiantado, JWT vencido), o **mesmo cenário contra o adaptador Firestore** (com um
Firestore falso em memória), e o módulo de rede do app (fallback local→nuvem, timeouts, corpo travado).
