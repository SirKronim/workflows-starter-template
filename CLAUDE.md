# CLAUDE.md

Demonstração interativa de **Cloudflare Workflows**: um frontend React mostra, em tempo real (WebSocket), o progresso de um workflow de 4 passos executado num Worker.

## Comandos

| Objetivo | Comando |
|---|---|
| Instalar dependências | `npm ci` |
| Servidor de desenvolvimento (http://localhost:5173) | `npm run dev` |
| Lint | `npm run lint` |
| Typecheck (as 3 configs TS) | `npx tsc -b` |
| Testes (correm dentro do runtime Workers via miniflare) | `npm test` |
| Validar a config de publicação sem publicar (faz build primeiro) | `npm run check` |
| Regenerar tipos do `Env` após mudar `wrangler.jsonc` | `npm run cf-typegen` |
| Publicar | `npm run deploy` ⚠️ ver "Publicação" |

## Estrutura

- `worker/index.ts`: entrada do Worker, com rotas `/api/workflow/start|status/:id|event/:id` e `/ws`. Todas passam pelas verificações de segurança (ver "Segurança").
- `worker/security.ts`: funções de segurança partilhadas (chaves, cookies, Origin, validação do corpo, cabeçalhos).
- `public/_headers`: cabeçalhos de segurança (CSP, etc.) para os ficheiros estáticos.
- `worker/workflow.ts`: `MyWorkflow` (`WorkflowEntrypoint`) com `step.do`, `step.sleep` e `step.waitForEvent("user-approval")`.
- `worker/durable-object.ts`: `WorkflowStatusDO`, que guarda o estado dos passos e transmite-o por WebSocket (API de hibernação).
- `src/`: frontend React 19 + Tailwind 4. `hooks/useWorkflowWebSocket.ts` liga-se a `/ws?instanceId=…`.
- `test/workflow.test.ts`: testes com `introspectWorkflowInstance` (`disableSleeps`, `mockEvent`, `forceEventTimeout`).
- `test/api.test.ts`: testes de segurança da API (`SELF.fetch`). Cada teste corresponde a um problema da auditoria (`[#n]`). Usa um IP diferente por teste por causa do rate limiting.
- `worker-configuration.d.ts`: **gerado** por `wrangler types`. Não editar à mão.
- Configs TS separadas: `tsconfig.app.json` (src), `tsconfig.worker.json` (worker + test) e `tsconfig.node.json` (vite config).

## Regras do projeto

- **Nomes dos passos**: os nomes em `workflow.ts`, a lista inicial em `durable-object.ts` e `WORKFLOW_STEPS` em `src/types.ts` têm de coincidir exatamente. Ao mudar um, muda os três.
- **Regras dos Workflows**: efeitos secundários e não-determinismo (`Date.now()`, `Math.random()`, chamadas externas) vão **dentro** de `step.do`, porque o código fora dos passos pode ser re-executado. `notifyStep` está fora de propósito e só é seguro porque `updateStep` é idempotente. Ver https://developers.cloudflare.com/workflows/build/rules-of-workflows/
- **Bindings**: ao alterar `wrangler.jsonc` (bindings, workflows, Durable Objects), corre `npm run cf-typegen`. Novas classes de DO exigem uma nova entrada em `migrations`.
- **Versões fixas**: as dependências estão fixas a versões exatas. Não usar `^`/`~` ao adicionar pacotes.
- **Erros**: as respostas da API não devem expor detalhes internos (manter o padrão `{ error: "..." }`).

## Segurança

**Modelo: chave por instância ("capability token").** Não há contas de utilizador.
- `POST /api/workflow/start` gera o ID (`crypto.randomUUID()`) e uma chave aleatória de 256 bits. Regista o hash SHA-256 no Durable Object (`setOwner`, uma única vez) **antes** de criar a instância, para nunca haver instâncias órfãs. Entrega a chave num cookie **por instância**, `__Host-wf_<id>` (HttpOnly, Secure, SameSite=Strict, 1 h), por isso vários workflows no mesmo browser não se apagam uns aos outros.
- `status`, `event` e `/ws` exigem a chave do dono (`isOwner`, comparação em tempo constante).

**Ordem das verificações em cada rota** (as mais baratas primeiro, para recusar abusos antes de gastar recursos pagos): método → `Origin` igual ao da app (POST e WebSocket) → rate limit → formato UUID → tem o cookie desta instância (senão 403, sem revelar se o ID existe) → a instância existe (`MY_WORKFLOW.get`, antes de tocar no DO) → dono.

- **Rate limiting** (`wrangler.jsonc` → `ratelimits`): `START_LIMITER` 5/min por cliente, `GLOBAL_START_LIMITER` 100/min para todos e `API_LIMITER` 60/min por cliente. O "cliente" é o IPv4, ou o prefixo **/64** em IPv6 (`clientKey`). Os contadores são janelas fixas de 60 s por localização da Cloudflare.
- **Corpo do evento**: `Content-Type: application/json`, lido com `readBodyLimited` (nunca guarda mais de 2 KB em memória, com ou sem `Content-Length`), só `{ approved: boolean, comment?: string ≤ 500 }`, reconstruído antes do `sendEvent`.
- **WebSocket**: no máximo 5 ligações por instância. O `ping` é respondido por `setWebSocketAutoResponse`. Qualquer outra mensagem fecha a ligação (1008). Todas as ligações fecham quando o workflow termina.
- **Cabeçalhos**: `worker/security.ts` (API) e `public/_headers` (páginas). A CSP proíbe scripts e estilos inline e recursos externos: **não adicionar CDNs, fontes externas nem `<script>` inline** sem atualizar a CSP.
- **Logs**: nunca registar texto livre do utilizador.

Ao alterar rotas, acrescentar o teste correspondente em `test/api.test.ts`. Testes de rate limiting devem tolerar a mudança de janela (ver `expectRateLimited`).

**A confirmar no painel da Cloudflare:** se os Workers Logs (observability) guardam os cabeçalhos do pedido. Se guardarem, o cookie com a chave fica nos logs durante até 1 h.

**Opcional, se a app for só para uso pessoal:** proteger tudo com Cloudflare Access (configura-se no painel da Cloudflare, não no código).

## Publicação

**Nunca publicar sem**: (1) correr uma revisão de segurança do código (o subagente `workers-security-reviewer` e/ou `/security-review`), (2) mostrar o resultado ao utilizador e (3) ter a aprovação explícita dele.

O hook `.claude/hooks/pre-deploy-gate.sh` interceta `wrangler deploy`, `wrangler versions upload|deploy` e `npm run deploy`:
- Corre lint, typecheck, testes e `npm audit --omit=dev --audit-level=high`.
- Se alguma verificação falhar, a publicação é bloqueada.
- Se todas passarem, pede confirmação ao utilizador.

`--dry-run` é sempre permitido.

## Auditoria de segurança no início de cada sessão

**Regra do utilizador:** no início de cada sessão nova, audita a segurança **só se o código mudou** desde a última auditoria.

- O hook `SessionStart` (`.claude/hooks/session-start-audit.sh`) calcula a impressão digital do código relevante (`.claude/hooks/audit-fingerprint.sh`: `worker/`, `src/`, `wrangler.jsonc`, `index.html`, `package.json`, `package-lock.json`, incluindo alterações não commitadas e ficheiros novos). Compara-a com a primeira linha de `.claude/last-security-audit.md`.
- **Igual**: não auditar. Dizer ao utilizador numa frase e seguir para o pedido.
- **Diferente ou sem relatório**: antes de qualquer outra tarefa, correr o subagente `workers-security-reviewer` e mostrar o resumo (tabela por gravidade). Depois gravar o relatório completo em `.claude/last-security-audit.md` com a primeira linha `<!-- fingerprint: <hash> date: AAAA-MM-DD -->` e incluí-lo no próximo commit.
- O hook dá a instrução exata, com o hash a usar. Se o utilizador pedir para saltar, respeitar e não atualizar o ficheiro.
- Se o relatório não for commitado, a sessão seguinte volta a auditar. É intencional: na dúvida, audita-se.

## Hooks ativos (`.claude/settings.json`)

- **No início de cada sessão nova**: se o código mudou, instrução para correr a auditoria de segurança (ver acima).

- **Depois de cada edição** de um `.ts`/`.tsx`: ESLint nesse ficheiro e `tsc -b`. Os erros voltam ao Claude para corrigir de imediato.
- **Antes de publicar**: o pre-deploy gate descrito acima.

## Permissões (`.claude/settings.json`)

- **Pré-aprovados** (só leem ou verificam): `npm test`, `npm run lint`, `npx tsc -b`, `npm audit` (sem `fix`), `git status`, `git diff`, `git log`.
- **Proibido ler**: `.dev.vars*` e `.env*`, onde ficam segredos locais. Nunca pedir ao utilizador para os colar no chat.

## Subagente de segurança (`.claude/agents/workers-security-reviewer.md`)

Auditor **só de leitura** (Read, Grep, Glob) com uma lista de verificação para Workers, Workflows, Durable Objects e WebSockets. Usar antes de publicar e depois de alterar `worker/` ou `wrangler.jsonc`. Devolve um relatório em PT-PT, ordenado por gravidade, com `ficheiro:linha`.

## Ambiente na cloud

O ambiente pessoal "workflows-starter-template" corre `npm ci` no arranque de cada sessão. Não é preciso instalar dependências à mão.
