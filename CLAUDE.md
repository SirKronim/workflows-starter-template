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
| Validar a config de publicação sem publicar | `npm run check` |
| Regenerar tipos do `Env` após mudar `wrangler.jsonc` | `npm run cf-typegen` |
| Publicar | `npm run deploy` ⚠️ ver "Publicação" |

## Estrutura

- `worker/index.ts`: entrada do Worker, com rotas `/api/workflow/start|status/:id|event/:id` e `/ws`.
- `worker/workflow.ts`: `MyWorkflow` (`WorkflowEntrypoint`) com `step.do`, `step.sleep` e `step.waitForEvent("user-approval")`.
- `worker/durable-object.ts`: `WorkflowStatusDO`, que guarda o estado dos passos e transmite-o por WebSocket (API de hibernação).
- `src/`: frontend React 19 + Tailwind 4. `hooks/useWorkflowWebSocket.ts` liga-se a `/ws?instanceId=…`.
- `test/workflow.test.ts`: testes com `introspectWorkflowInstance` (`disableSleeps`, `mockEvent`, `forceEventTimeout`).
- `worker-configuration.d.ts`: **gerado** por `wrangler types`. Não editar à mão.
- Configs TS separadas: `tsconfig.app.json` (src), `tsconfig.worker.json` (worker + test) e `tsconfig.node.json` (vite config).

## Regras do projeto

- **Nomes dos passos**: os nomes em `workflow.ts`, a lista inicial em `durable-object.ts` e `WORKFLOW_STEPS` em `src/types.ts` têm de coincidir exatamente. Ao mudar um, muda os três.
- **Regras dos Workflows**: efeitos secundários e não-determinismo (`Date.now()`, `Math.random()`, chamadas externas) vão **dentro** de `step.do`, porque o código fora dos passos pode ser re-executado. `notifyStep` está fora de propósito e só é seguro porque `updateStep` é idempotente. Ver https://developers.cloudflare.com/workflows/build/rules-of-workflows/
- **Bindings**: ao alterar `wrangler.jsonc` (bindings, workflows, Durable Objects), corre `npm run cf-typegen`. Novas classes de DO exigem uma nova entrada em `migrations`.
- **Versões fixas**: as dependências estão fixas a versões exatas. Não usar `^`/`~` ao adicionar pacotes.
- **Erros**: as respostas da API não devem expor detalhes internos (manter o padrão `{ error: "..." }`).

## Segurança (o template de origem NÃO está pronto para produção)

Pontos conhecidos a resolver antes de publicar para o público:
- Sem autenticação nem rate limiting em `/api/workflow/start` (custos), `/api/workflow/event/:id` (qualquer pessoa pode aprovar) e `/ws`.
- O corpo de `/api/workflow/event/:id` não é validado (deve ser `{ approved: boolean, comment?: string }` com tamanho limitado).
- `/ws` aceita qualquer `instanceId` e cria um Durable Object por ID.
- Sem cabeçalhos de segurança (CSP, X-Content-Type-Options, etc.).

## Publicação

**Nunca publicar sem**: (1) correr uma revisão de segurança do código (o subagente `workers-security-reviewer` e/ou `/security-review`), (2) mostrar o resultado ao utilizador e (3) ter a aprovação explícita dele.

O hook `.claude/hooks/pre-deploy-gate.sh` interceta `wrangler deploy`, `wrangler versions upload|deploy` e `npm run deploy`:
- Corre lint, typecheck, testes e `npm audit --omit=dev --audit-level=high`.
- Se alguma verificação falhar, a publicação é bloqueada.
- Se todas passarem, pede confirmação ao utilizador.

`--dry-run` é sempre permitido.

## Auditoria de segurança no início de cada sessão

**Regra do utilizador:** em cada sessão nova, antes de qualquer outra tarefa, corre o subagente `workers-security-reviewer` e mostra ao utilizador o resumo do relatório (tabela por gravidade). Só depois trata do pedido. Se o utilizador pedir para saltar nesta sessão, respeita. O hook `SessionStart` (`.claude/hooks/session-start-audit.sh`) relembra esta regra automaticamente ao arrancar.

## Hooks ativos (`.claude/settings.json`)

- **No início de cada sessão nova**: instrução para correr a auditoria de segurança (ver acima).

- **Depois de cada edição** de um `.ts`/`.tsx`: ESLint nesse ficheiro e `tsc -b`. Os erros voltam ao Claude para corrigir de imediato.
- **Antes de publicar**: o pre-deploy gate descrito acima.

## Permissões (`.claude/settings.json`)

- **Pré-aprovados** (só leem ou verificam): `npm test`, `npm run lint`, `npx tsc -b`, `npm audit` (sem `fix`), `git status`, `git diff`, `git log`.
- **Proibido ler**: `.dev.vars*` e `.env*`, onde ficam segredos locais. Nunca pedir ao utilizador para os colar no chat.

## Subagente de segurança (`.claude/agents/workers-security-reviewer.md`)

Auditor **só de leitura** (Read, Grep, Glob) com uma lista de verificação para Workers, Workflows, Durable Objects e WebSockets. Usar antes de publicar e depois de alterar `worker/` ou `wrangler.jsonc`. Devolve um relatório em PT-PT, ordenado por gravidade, com `ficheiro:linha`.

## Ambiente na cloud

O ambiente pessoal "workflows-starter-template" corre `npm ci` no arranque de cada sessão. Não é preciso instalar dependências à mão.
