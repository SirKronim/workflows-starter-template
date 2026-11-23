<!-- fingerprint: 6f544d580711a803 date: 2026-11-23 -->
# Auditoria de segurança: 2026-11-23

> Gerada pelo subagente `workers-security-reviewer` (só de leitura). Os pontos 1, 3, 4, 9 e 10 foram confirmados linha a linha no código.
> A primeira linha deste ficheiro guarda a impressão digital do código auditado: o hook de início de sessão só volta a auditar quando ela mudar.

## Resumo
**Não está pronto para publicar.** Como template de demonstração funciona, mas não tem autenticação, autorização nem rate limiting em nenhuma rota. Qualquer pessoa na Internet pode criar instâncias de Workflow e Durable Objects sem limite, e aprovar ou rejeitar o workflow de outra pessoa se souber o ID. Não há segredos expostos nem XSS. Os restantes problemas são de gravidade média ou baixa.

## Problemas
| # | Gravidade | Onde | Problema | Correção sugerida |
|---|-----------|------|----------|-------------------|
| 1 | 🟠 Alta | worker/index.ts:19-37 | `POST /api/workflow/start` não tem autenticação nem rate limiting. Cada pedido cria uma instância de Workflow paga que fica à espera até 60 min (worker/workflow.ts:51-54) | Exigir autenticação e aplicar o binding `ratelimits` (Rate Limiting) por utilizador/IP, ou proteger com Turnstile |
| 2 | 🟠 Alta | worker/index.ts:62-96 | `POST /api/workflow/event/:id` não verifica quem faz o pedido nem se é dono da instância. Basta conhecer o ID para aprovar ou rejeitar o workflow de outro | Associar cada instância a um utilizador (`ownerId`) e confirmá-lo antes do `sendEvent` |
| 3 | 🟡 Média | worker/index.ts:75-84 | O corpo JSON é validado só com um cast `as`. Um payload arbitrário (tipos, tamanho, campos extra) chega ao workflow sem verificação | Validar: `approved` booleano, `comment` string com até N caracteres. Rejeitar o resto com 400 |
| 4 | 🟡 Média | worker/index.ts:99-115 | `/ws` aceita qualquer `instanceId`. `idFromName` instancia um DO para cada string nova, sem limite de ligações | Validar o UUID, confirmar que a instância existe, aplicar rate limit e um máximo de sockets por DO |
| 5 | 🟡 Média | worker/index.ts:19, 62, 75 | Risco de CSRF/abuso entre origens. As rotas POST não verificam `Origin` nem `Content-Type` (`text/plain` não passa por preflight) | Rejeitar `Origin` estrangeiro e exigir `Content-Type: application/json` |
| 6 | 🟡 Média | worker/index.ts:40-59 | `/api/workflow/status/:id` não tem autenticação, aceita qualquer método HTTP e devolve o `status()` completo | Só `GET`, verificar o dono e devolver só `{ status }` |
| 7 | ⚪ Baixa | worker/index.ts:107-115; worker/durable-object.ts:51-61 | `Origin` não é verificado no upgrade WebSocket (CSWSH) | Lista de origens permitidas antes do upgrade |
| 8 | ⚪ Baixa | worker/durable-object.ts:100-102 | `webSocketMessage` responde com o estado completo a cada mensagem, sem limite | Responder só a `ping` com throttling (`setWebSocketAutoResponse`) |
| 9 | ⚪ Baixa | worker/workflow.ts:60 | `console.log` regista `approval.payload` (texto livre do utilizador). Com `observability` ativo fica nos logs | Registar só campos validados |
| 10 | ⚪ Baixa | src/hooks/useWorkflowWebSocket.ts:60; src/components/WorkflowDiagram.tsx:53 | `instanceId` interpolado em URLs sem `encodeURIComponent` | Usar `encodeURIComponent` |
| 11 | ⚪ Baixa | worker/index.ts; não existe `public/_headers` | Faltam CSP, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors`/`X-Frame-Options` | `public/_headers` + helper de cabeçalhos no Worker |
| 12 | ⚪ Baixa | worker/index.ts:41, 66 | ID extraído com `split("/").pop()`. Um ID inexistente devolve 500 em vez de 404 | Match exato da rota (`URLPattern`), validar UUID, devolver 404 |
| 13 | ⚪ Baixa | wrangler.jsonc:9 | `compatibility_date` `2025-10-08`, cerca de 13 meses de atraso | Atualizar e testar |

## Detalhe

### 1. Criação ilimitada de Workflows (custos)
- **Cenário de ataque:** um atacante anónimo corre `while true; do curl -X POST https://<app>/api/workflow/start; done`. Cada pedido cria uma instância de Workflow que corre passos e fica em `waitForEvent` até 60 min, e também cria um DO através de `notifyStep`. O efeito é aumento de custos, esgotamento dos limites de instâncias simultâneas e negação de serviço. Com o ponto 5, o ataque pode ser distribuído pelos browsers de visitantes de um site malicioso.
- **Correção:** sessão autenticada ou Turnstile, mais o binding Rate Limiting (`ratelimits` em `wrangler.jsonc`) por utilizador/IP antes de `MY_WORKFLOW.create`.

### 2. Aprovar ou rejeitar o workflow de outra pessoa
- **Cenário de ataque:** o ID aparece em URLs, no histórico do browser, em logs de proxy ou em capturas de ecrã. Quem o obtiver envia `POST /api/workflow/event/<id>` com `{"approved":true}` e decide o resultado. O código não tem nenhuma noção de dono.
- **Correção:** guardar o `ownerId` autenticado nos `params` do `create` ou no DO e confirmá-lo em `/event`, `/status` e `/ws`.

### 3. Corpo do evento sem validação
- **Cenário de ataque:** `{"approved":"sim","comment":<vários MB>,"x":{...}}` passa pelo cast `as`, vai inteiro para `sendEvent`, fica persistido e é registado em log. Lógica futura pode ser enganada por valores "truthy".
- **Correção:** `typeof body.approved === "boolean"`, `comment` opcional com até 500 caracteres, rejeitar campos extra e montar um payload novo só com os campos validados.

### 4. Durable Objects criados por IDs arbitrários em `/ws`
- **Cenário de ataque:** milhares de ligações para `/ws?instanceId=<aleatório>` instanciam um DO por nome e mantêm WebSockets abertos (custos). Também é possível abrir ligações sem limite para um único DO, que faz broadcast para todas.
- **Correção:** validar o UUID, `await env.MY_WORKFLOW.get(id)` em try/catch (404 se falhar), rate limit e um máximo de sockets por DO.

### 5. CSRF / pedidos entre origens nas rotas POST
- **Cenário de ataque:** um site malicioso faz `fetch(..., {method:"POST", mode:"no-cors", body:'{"approved":true}'})` com `Content-Type: text/plain`. Não há preflight e o Worker faz o parse do corpo na mesma. Hoje o impacto é sobretudo abuso. Com autenticação por cookie passa a ser CSRF clássico.
- **Correção:** verificar `Origin`/`Sec-Fetch-Site` e exigir `Content-Type: application/json`. Com cookies, usar também `SameSite=Strict` e um token anti-CSRF.

### 6. Endpoint de estado aberto
- **Cenário de ataque:** quem souber um ID recebe o objeto completo de `instance.status()`. **A verificar:** em caso de falha, o campo `error` pode trazer mensagens internas.
- **Correção:** só `GET`, verificar o dono e devolver apenas `{ status }`.

### 7. Sem verificação de Origin no upgrade WebSocket
- **Cenário de ataque:** uma página de terceiros abre `new WebSocket("wss://<app>/ws?instanceId=<id>")` e lê o estado em tempo real. O impacto é baixo enquanto não houver autenticação por cookie.
- **Correção:** rejeitar com 403 se o `Origin` não estiver na lista de origens permitidas.

### 8. Respostas a mensagens WS sem limite
- **Cenário de ataque:** um cliente envia mensagens em ciclo e obriga o DO a acordar e a serializar o estado de cada vez (duração faturada).
- **Correção:** ignorar mensagens de clientes ou responder só a `ping` com `ctx.setWebSocketAutoResponse`.

### 9. Dados do utilizador nos logs
- **Cenário de ataque:** o `comment` (texto livre) fica retido nos logs com observability ativo. Permite injetar conteúdo enganador ou guardar dados pessoais sem necessidade.
- **Correção:** registar só `approved` (validado) e o `instanceId`.

### 10. `instanceId` sem escape em URLs
- **Cenário de ataque:** hoje o valor vem do próprio servidor (risco baixo). Se a origem mudar (ex.: link partilhado), um valor como `x&instanceId=y` ou `../start` altera o URL de destino.
- **Correção:** `encodeURIComponent(instanceId)` nos dois sítios.

### 11. Cabeçalhos de segurança em falta
- **Cenário de ataque:** sem `frame-ancestors`, a página pode ser embebida num iframe e o botão "Approve" usado para clickjacking. Sem CSP, um XSS futuro não tem nenhuma barreira.
- **Correção:** `public/_headers` com `Content-Security-Policy: default-src 'self'; connect-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` e `X-Frame-Options: DENY`. Aplicar o mesmo às respostas do Worker.

### 12. Parsing frágil do caminho
- **Cenário:** `/api/workflow/event/qualquer/coisa/<id>` é aceite. Um ID inexistente gera 500, o que confunde a monitorização e esconde enumeração.
- **Correção:** match exato da rota, validar UUID e devolver 404.

### 13. `compatibility_date` desatualizada
- **Cenário:** não há exploração direta. O Worker fica sem os comportamentos e correções de runtime mais recentes.
- **Correção:** atualizar e correr os testes.

## Verificado sem problemas
- **Segredos:** não há segredos no código, no frontend ou em `wrangler.jsonc` (sem `vars`). `.gitignore` exclui `.dev.vars*` e `.env*`.
- **Respostas de erro:** mensagens genéricas, sem stack traces. `Response.json` define o `Content-Type` correto.
- **CORS:** nenhum `Access-Control-Allow-Origin`, por isso fica a política same-origin. A exceção dos "simple requests" está no ponto 5.
- **Frontend (XSS):** sem `dangerouslySetInnerHTML`, `eval`, `innerHTML` nem `new Function`. O link externo tem `rel="noopener noreferrer"`.
- **RPC do Durable Object:** `updateStep` só é chamado internamente pelo workflow, com argumentos literais.
- **Workflows:** os efeitos com retorno estão dentro de `step.do`. `notifyStep` está fora de propósito e é idempotente.
- **`upload_source_maps`:** envia os source maps só para a Cloudflare, sem os expor publicamente. O frontend não gera source maps.
