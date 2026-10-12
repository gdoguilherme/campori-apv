# Ferramenta de último caso — `npm run dbtool`

Para **listar, ver, alterar e apagar** registros do banco local quando algo precisa ser corrigido na mão durante o evento
(ex.: participante na unidade errada, requisito com pontos errados, comprovação duplicada). **Use só se a tela não resolver.**

Abra o Prompt de Comando em `C:\campori\local-server` (pode ficar com o servidor ligado) e rode:

```
npm run dbtool                                         ← ajuda + quantos registros e quantos pendentes por coleção
npm run dbtool -- list participants                    ← lista (os mais recentes primeiro)
npm run dbtool -- list participants --where unitId=ID  ← só de uma unidade (campos filtráveis: os indexados)
npm run dbtool -- list submissions --dirty             ← só o que ainda não foi enviado à nuvem
npm run dbtool -- show participants ID                 ← o registro inteiro + situação (sincronizado/pendente/erro)
npm run dbtool -- set participants ID --campo unitId=OUTRA --campo name="Fulano de Tal"
npm run dbtool -- set requirements ID --file alteracao.json     ← vários campos, a partir de um arquivo JSON
npm run dbtool -- set requirements ID --json "{...}" --replace  ← troca o registro INTEIRO (cuidado)
npm run dbtool -- delete participants ID               ← apaga (a exclusão também sobe à nuvem)
npm run dbtool -- check                                ← confere JSON e colunas indexadas de TODOS os registros
npm run dbtool -- check --fix                          ← corrige as colunas indexadas fora do JSON
npm run dbtool -- backup                               ← cópia do banco agora
```
Coleções: `regions`, `units`, `participants`, `requirements`, `submissions`, `disciplinaryActions`, `auditLog`, `users`.
Valores em `--campo nome=valor`: `12` vira número, `true/false` vira verdadeiro/falso, o resto é texto.
Para testar sem gravar, acrescente `--dry-run`. Para não perguntar, `--yes`.

## O que a ferramenta garante
1. **Backup do banco inteiro antes de qualquer gravação**, em `backups\dbtool\` (se o backup falhar, **nada** é gravado).
2. **Mostra o que vai mudar** (antes → depois) e **pede confirmação** (digite `SIM`).
3. **Valida**: o conteúdo tem que ser um objeto JSON; o `id` não pode mudar; campos indexados (`unitId`, `regionId`, `status`…)
   só aceitam texto/número/true/false/null; limite de 1 MB.
4. **Grava como o servidor grava:** o registro vira **pendente de envio à nuvem** (`dirty=1`), a hora de atualização só avança,
   as **colunas indexadas são recalculadas a partir do JSON**, e a base de comparação com a nuvem é preservada (o merge de 3 vias
   continua funcionando). A sincronização envia a alteração sozinha.
5. **Confere depois de gravar** (relê o registro e verifica as colunas indexadas) e **registra o evento** (aparece no painel de status).
6. Segredos (`passwordHash`) aparecem mascarados (`***`).

## Como desfazer
Pare o servidor, copie o backup desejado de `backups\dbtool\` por cima de `data\campori-local.db` e inicie de novo.
(Alterações já enviadas à nuvem continuam lá — nesse caso corrija também no painel da nuvem.)
