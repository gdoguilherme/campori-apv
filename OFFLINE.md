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


---

# Fase 5 — Sincronização do servidor local com o Firebase + painel de status

**Premissa:** durante o evento o servidor local é a fonte de verdade do que acontece em campo. A Starlink pode cair a
qualquer momento, e **nada no servidor local espera pela nuvem**: a sincronização roda num laço em segundo plano
(`local-server/src/sync/`), com prazo em toda chamada, e o SQLite é a única coisa que as rotas tocam.

## Quem vence em cada tipo de dado (regra de verdade)

| Dado | Regra | Por quê |
|---|---|---|
| **Scan de QR** (`submissions` com `source: qr`) | **Vence o `scanTimestamp` mais antigo**, em qualquer caminho (local, nuvem direta, outro aparelho). Aprovação **manual** do admin vence sempre. Só um scan aprovado por (unidade, prova). | Mesma regra de `shared/sync.js` (Fase 3); o primeiro a escanear é quem pontuou. |
| **Aprovação / rejeição** (revisão de uma submissão) | **Vence a revisão mais recente** (`reviewedAt`); empate → nuvem. O grupo (`status`, motivo, quem revisou) vai junto. | "O último a revisar decide." |
| **Disciplina** (`disciplinaryActions`) | Os registros **se somam** (união dos dois lados); **a exclusão vence**. | São eventos; apagar é uma decisão deliberada. |
| **Regiões, unidades, participantes, requisitos, usuários** | **Merge campo a campo (3 vias)**: se só um lado mudou o campo, vale a mudança (nada se perde); se **os dois mudaram o mesmo campo**, **vale a nuvem**. Apagado na nuvem → vale a nuvem. Apagado só no local → apaga se a nuvem não mudou depois. | A nuvem é onde os portais de gestão trabalham; o local raramente edita isso. |
| **Auditoria** (`auditLog`) | Só sobe (append). | Registro histórico. |

- **Nunca se sobrescreve algo do local ainda não enviado**: uma linha com alteração pendente (`dirty`) nunca é trocada
  por dados da nuvem; o envio resolve o conflito pelas regras acima.
- **Base do merge:** cada linha guarda `baseData` = a última versão da nuvem que o PC viu. Sem base (documento novo) é
  merge de 2 vias (conflito → nuvem).
- Cada conflito vira um evento no painel; os que mudam **pontos** (scan duplicado, scan que substituiu outro, revisão
  que perdeu) viram **alerta** ("Pontos que já estavam cadastrados").
- **Riscos conhecidos que a regra não elimina:** (1) uma sanção de disciplina aplicada nos dois lados vira **duas**
  penalidades (são eventos distintos); (2) fotos/comprovantes enviados pelo servidor local ficam **no PC** (o registro
  sobe, o arquivo não) — a nuvem mostraria um link que só funciona na rede do evento.

## Local → nuvem (como o envio funciona)

1. **Fila = linhas `dirty=1`** do SQLite (inclui exclusões). Tudo o que as rotas locais gravam entra nela sozinho.
2. **Laço em segundo plano** (a cada 10 s): teste de conexão (leitura de 1 documento, prazo de 6 s) → envio. Sem internet:
   **backoff 10 s → 20 s → 40 s → 60 s** (teto de 1 min = a volta da Starlink é percebida em até 1 minuto). Só registra
   *transições* ("Nuvem fora do ar" / "Nuvem voltou").
3. **Scans** são enviados pela **mesma decisão** que a nuvem usa em `/sync/scans` (`server/services/syncStore.js` +
   `shared/sync.js`, numa transação do Firestore): trava por unidade e prova, vence o mais antigo, **inclusive contra scans
   que a mesma unidade fez direto pela nuvem**. O resto usa o merge de 3 vias numa transação.
4. **Idempotente** (id do documento = `scan_<id do cliente>` / id da linha): repetir ou interromper a qualquer momento não
   duplica nem perde — testado derrubando a internet no meio, "reiniciando o PC" depois do commit na nuvem e mandando o
   mesmo scan por dois caminhos.
5. **Um item com problema próprio** (ex: permissão) é marcado com o erro e **não trava os demais**; depois de 3 falhas
   entra em descanso de 5 min (o botão manual ignora o descanso). Erro de rede/cota/credencial **para o ciclo** e não
   marca nenhum item como defeituoso.
6. Edição local feita **durante** o envio não se perde (versão por linha estritamente crescente: a linha continua
   pendente e sobe de novo no mesmo ciclo).

### Chaves de segurança
- **`CLOUD_SYNC=1` no `.env` liga** (padrão desligado). **Banco de demonstração nunca sincroniza**
  (`seed-demo` marca `dataset=demo`). Sem credenciais o painel mostra "Nuvem não configurada" e o servidor segue normal.
- Credenciais: as mesmas do `pull-cloud` (`FIREBASE_CREDENTIALS_FILE` ou `server/campori-apv-firebase-adminsdk.json`).
  Essa chave tem poder de administrador do Firebase: **fica só no PC do evento, fora do git** (já ignorada).

## Painel de status — `http://localhost:8787/status`

Para pessoas não técnicas. Abre direto **no próprio PC**; de **outro aparelho** pede o **PIN** (`STATUS_PIN` no `.env`;
5 erros → bloqueia 1 min; sem PIN configurado só abre no PC).

- **Semáforo grande:** 🟢 *Tudo certo* · 🟡 *Sem internet / N itens aguardando envio* · 🔴 *Atenção: há erros* ·
  ⚪ *Funcionando só neste PC* (sincronização desligada). Mais três luzes: **Servidor**, **Nuvem**, **Dados**.
  Se o servidor parar, o painel mostra uma faixa vermelha ("Não consigo falar com o servidor").
- Hora da **última sincronização com sucesso**, **itens aguardando envio**, **itens com erro** (com o motivo).
- Situação **por unidade** e **por requisito**: ✅ Sincronizado · 🕓 Pendente (N) · ❌ Erro. (Um item da *região* conta
  para todas as unidades dela.)
- **🔄 Sincronizar agora** com resposta clara: ✅ sucesso, 📡 sem acesso à nuvem (com a explicação) ou ❌ erro **com o motivo**.
- **⚠️ Pontos que já estavam cadastrados:** aparece quando a sincronização — manual **ou automática** — encontra um
  scan que já tinha pontuação, um scan que substituiu outro ou uma revisão que perdeu; fica na tela até "Entendi".
- Os tempos mostrados usam a hora **do servidor** (um celular com relógio errado não confunde o painel).
- `GET /health` (público) traz um resumo (`sync.cloud`, `sync.pending`, `sync.lastSuccessAt`).

## Testes (Etapa 1)
`cd local-server && npm test` — 103 testes (85 da etapa 1 + recebimento, ranking e painel). Envio: scan com Timestamps reais e idempotência; sem internet com backoff e
detecção automática da volta; **queda no meio do envio**; nuvem **pendurada** (o SQLite segue livre); **PC reiniciado**
depois do commit na nuvem; **mesmo scan por dois caminhos** (nas duas ordens); conflito de unidade+prova (local mais
antigo / mais novo / aprovação manual / perdedor local); revisão mais recente; merge de 3 vias; disciplina; item
envenenado; edição durante o envio; segurança (`CLOUD_SYNC`, demo, sem credenciais); migração de banco antigo.
Painel: nuvem fora do ar, pendências por unidade/requisito, alertas, erros, PIN, `/health`.
Tudo contra um **Firestore falso em memória** (`test/fake-firestore.js`): nada toca a nuvem real.

> ⚠️ **Não testado contra o Firestore real** (não há emulador aqui e não escrevo na sua produção). Faça um teste curto
> antes do evento — roteiro no GUIA-WINDOWS.md.


## Nuvem → local (etapa 2)

Mantém o SQLite do PC atualizado com o que acontece na nuvem: **regiões, unidades, participantes, requisitos (com as
variantes de QR), usuários (para o login), disciplina e submissões** (inclusive o que for criado ou aprovado na nuvem
durante o evento). A auditoria (`auditLog`) só sobe, não desce.

- **Carga inicial e atualização incremental com os *listeners* do Firestore** (`local-server/src/sync/pull.js`): na carga
  vem tudo; depois só chegam as **mudanças** (poucas leituras na cota do Firebase) e as **exclusões** são percebidas.
  Os listeners só ligam quando a nuvem responde; se caírem (erro) ou a internet sumir por muito tempo, são **recriados no
  próximo ciclo** (≤ 1 min depois de a nuvem voltar).
- **Reconciliação:** leitura completa de todas as coleções que corrige qualquer coisa que um listener tenha perdido —
  acontece no botão **"Atualizar dados da nuvem"**, em **"Sincronizar agora"** e a cada **2 h** em segundo plano.
- **Regra de ouro — nunca sobrescrever o que o local alterou e ainda não enviou:** uma linha com alteração pendente
  (`dirty`) é **ignorada** pelo recebimento; o envio resolve o conflito (merge de 3 vias / revisão mais recente / scan mais
  antigo, ver tabela acima). Linhas só-locais (sem base na nuvem) nunca são removidas por uma reconciliação.
- **Exclusão feita na nuvem** é aplicada localmente (inclusive a que aconteceu com o PC desligado), exceto se a linha
  tiver alteração pendente.
- **Convergência dos scans:** se a nuvem substituir um scan do PC por outro mais antigo, o listener traz a substituição e a
  pontuação local passa a ser a da nuvem (testado).
- **Login:** usuários vêm da nuvem (inclusive o que for criado, alterado ou desativado lá durante o evento).
- **Desempenho:** carga inicial de ~6 mil documentos em poucos segundos (testado).
- **Sem internet / nuvem pendurada:** "Atualizar" responde com a explicação, nada local muda, e nenhuma rota do servidor
  espera por isso. Se a carga for interrompida (ex.: PC reiniciado), recomeçar é idempotente.

## Ranking (etapa 2)

O ranking **anônimo** (tela de login e portais) e o **identificado** (admin) são lidos do **servidor local quando o aparelho
está nele** (`GET /ranking?meta=1`, `GET /scores/units?meta=1`) e da **nuvem** (cálculo ao vivo pelo Firestore) caso
contrário (`js/ranking.js`). Sem nenhuma rede, mostra a **última cópia guardada** no aparelho. Sempre aparece a **hora da
atualização** e a fonte: *"Atualizado às 14:32 · servidor local (nuvem sincronizada às 14:30)"* / *"· nuvem"* / *"· sem
conexão — último ranking guardado neste aparelho"*. O portal do Conselheiro mostra a hora do último download do servidor
ativo. Como o ranking local é calculado sobre dados sincronizados com a nuvem, a hora de sincronização mostra quão fresco ele é.

### Testes (etapa 2)
Recebimento (`test/sync-pull.test.js`): **carga inicial** (banco vazio → tudo, sem pendências, origem marcada); **incremental**
(aprovação, variante de QR nova, realocação, exclusão, região/disciplina novas; eco sem mudança não escreve);
**regra de ouro** (pendência local nunca pisada); **exclusão com o PC desligado**; **reconciliação** que acha o que o
listener perdeu; **sem internet** e listener que cai e é refeito; **nuvem pendurada**; **PC reiniciado no meio da
carga**; scan do PC **substituído na nuvem** converge; **login** de usuário criado/desativado na nuvem durante o evento;
**desempenho** (~6 mil documentos). Ranking (`test/ranking.test.js`): servidor local com `?meta=1`, app no local / na
nuvem / sem rede (cópia guardada) / prazo, ranking identificado com token. Painel: botão "Atualizar dados da nuvem".
Rodar `npm test` em máquina muito carregada pode estourar prazos de relógio; os testes conferem comportamento, não tempo.
