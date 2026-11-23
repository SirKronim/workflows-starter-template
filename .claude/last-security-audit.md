<!-- fingerprint: 8f79acb44cd3837a date: 2026-11-23 -->
# Auditoria de segurança: 2026-11-23 (após correção dos pontos baixos)

> Gerada pelo subagente `workers-security-reviewer` (só de leitura) depois de quatro rondas de correções.
> A primeira linha deste ficheiro guarda a impressão digital do código auditado: o hook de início de sessão só volta a auditar quando ela mudar.

## Histórico

| Auditoria | Crítica | Alta | Média | Baixa |
|---|---|---|---|---|
| 1.ª: template original | 0 | 2 | 4 | 7 |
| 2.ª: após a 1.ª ronda de correções | 0 | 0 | 2 | 5 (+2 a verificar) |
| 3.ª: após a 2.ª ronda | 0 | 0 | 1 | 5 |
| Após a 3.ª ronda | 0 | 0 | 0 | 4 |
| **Final: após a correção dos pontos baixos** | **0** | **0** | **0** | **1 (sem impacto de segurança)** |

## Resumo

**Pronto para publicar.** Não há problemas críticos, altos ou médios. Os 4 pontos baixos da auditoria anterior foram corrigidos e testados, e as correções não criaram nenhuma via de acesso indevido. Fica uma única observação de gravidade baixa, de "higiene" e sem impacto de segurança. Mantêm-se os três compromissos aceites, documentados em `CLAUDE.md`.

**Modelo de segurança em vigor:**
- Cada workflow tem uma chave de 256 bits, guardada num cookie `__Host-wf_<id>` (HttpOnly, Secure, SameSite=Strict). O Durable Object guarda só o hash SHA-256 e compara-o em tempo constante.
- Há rate limiting por IPv4 ou por prefixo IPv6 /64, mais um teto de criação de workflows (por localização da Cloudflare).
- A origem (Origin) e o Content-Type são verificados, o corpo do pedido é validado e limitado a 2 KB em stream, e as rotas são exatas, com validação de UUID.
- Qualquer recusa de acesso devolve 403, por isso não se consegue saber se um ID existe.
- WebSocket: no máximo 5 ligações por workflow. Mensagens inesperadas fecham a ligação (1008) e as ligações fecham quando o workflow termina com sucesso ou com erro.
- Limpeza automática do estado: 10 min depois do fim do workflow. Enquanto estiver ativo, verifica de 2 em 2 h, com um teto de cerca de 24 h.
- CSP restritiva e restantes cabeçalhos de segurança, na API e nas páginas.

## Estado dos 4 pontos baixos anteriores

| # | Ponto | Estado | Evidência |
|---|---|---|---|
| 1 | O alarme apagava a chave de um workflow ainda ativo | ✅ Corrigido | `worker/durable-object.ts`: adia enquanto estiver `running` (teto de 24 h por `createdAt`) e antecipa a limpeza para 10 min depois de um estado final. Testes em `test/api.test.ts`. |
| 2 | Eram aceites WebSockets depois do fim do workflow | ✅ Corrigido | `worker/durable-object.ts`: envia o estado final e fecha com 1000. O teste exige que o fecho aconteça em menos de 500 ms. |
| 3 | A interface não tratava o estado `"error"` | ✅ Corrigido | `src/App.tsx` (aviso `role="alert"` com texto fixo e reset ao fim de 5 s) e `WorkflowDiagram.tsx` (passo a vermelho com ✕). |
| 4 | Cookie com 60 min | ✅ Corrigido | `worker/security.ts`: `Max-Age=3900` (65 min). Teste em `test/api.test.ts`. |

## Observação restante

| # | Gravidade | Onde | Observação | Correção possível |
|---|-----------|------|----------|-------------------|
| 1 | ⚪ Baixa (custo/higiene, sem impacto de acesso) | worker/durable-object.ts (alarm) | O teto de 24 h é aproximado: o último reagendamento pode levar a limpeza até cerca de 26 h. Se `MY_WORKFLOW.create` falhar depois de `setOwner` (falha do lado da Cloudflare), o DO órfão só é apagado ao fim de cerca de 24 h. Não dá acesso a ninguém: a resposta é 403 e o DO guarda só um hash. | `setAlarm(Math.min(agora + 2 h, createdAt + 24 h))`. Opcional: limpeza imediata no `catch` de `handleStart`. Aceite por agora. |

## Efeitos secundários analisados (sem problemas)

- O reagendamento não impede a limpeza: quando o workflow termina, o alarme é substituído por um de 10 min, e se o workflow morrer sem avisar aplica-se o teto de 24 h.
- O `setAlarm` repetido pelas re-execuções do `notifyStep` só ocorre com estados finais e é limitado. Um estado final nunca volta a `running`.
- Uma escrita tardia depois do `deleteAll` não dá acesso (sem hash, a resposta é 403) e volta a agendar a limpeza.
- Corrida entre o fim do workflow e uma ligação nova: os input gates do DO serializam os dois, e a ligação nova vê o estado final e fecha.
- Interface nova: o aviso é texto fixo, o React faz o escape e não há reconexão automática em ciclo.

## Teste de ponta a ponta (browser real)

Feito com o build de produção (`vite preview`) e Chromium:
- os cabeçalhos CSP, `X-Frame-Options` e `Permissions-Policy` estão aplicados;
- o fluxo Start → WebSocket → Approve → concluído → Start disponível outra vez funciona;
- o cookie `__Host-wf_…` tem HttpOnly, Secure e SameSite=Strict, e **não é legível por JavaScript**;
- zero erros na consola e nenhuma violação de CSP.

## Compromissos aceites (documentados em CLAUDE.md)

| Ponto | Porque se aceita |
|---|---|
| O teto de criação é por localização da Cloudflare, não global | Um teto exato exige um contador central (DO único) ou Turnstile. É uma decisão do utilizador. |
| Os cookies por instância podem acumular-se durante até 1 h | Só afeta quem inicia muitos workflows. Mitigado pelo limite de 5 por minuto. |
| 5 inícios/min por IPv4 pode limitar redes com NAT partilhado | Compromisso razoável para uma demonstração. |

## Requer ação do utilizador

- **Logs da Cloudflare:** confirmar no painel (Workers → o Worker → Logs) se os registos de invocação guardam os cabeçalhos do pedido. Se guardarem, o cookie com a chave fica visível a quem tiver acesso aos logs durante até 1 h. O código nunca regista o cookie.
- **Safari em desenvolvimento:** o Safari não aceita cookies `Secure` em `http://localhost`, por isso em `npm run dev` o fluxo do dono falha (403). Para desenvolver, usar Chrome ou Firefox. Em produção (HTTPS) funciona.

## Verificado sem problemas

- **Autenticação e autorização:** conhecer o ID não chega para agir sobre o workflow de outra pessoa. `setOwner` é definido uma única vez, com um UUID novo, antes de a instância ser criada.
- **Abuso e custos:** os limites são aplicados antes de qualquer trabalho caro. Não ficam instâncias órfãs.
- **Validação de entrada:** lista fechada de campos permitidos e objeto reconstruído antes de chegar ao workflow.
- **WebSockets e Durable Objects:** `Origin` verificado, limites aplicados e métodos RPC que não ficam expostos ao cliente.
- **Workflows:** o não-determinismo está dentro de `step.do` e o log regista só o booleano `approved`.
- **Segredos:** nenhum no código ou na configuração. `.dev.vars*` e `.env*` estão no `.gitignore`.
- **Respostas e erros:** genéricas, sem detalhes internos. `/status` devolve só `{ status }`.
- **Cabeçalhos e CORS:** CSP, `nosniff`, `X-Frame-Options`, `Referrer-Policy` e `no-store`. Não há cabeçalhos CORS.
- **Frontend:** sem `dangerouslySetInnerHTML` nem `eval`, `encodeURIComponent` nos URLs e `rel="noopener noreferrer"` no link externo.
- **Configuração:** `compatibility_date` 2026-08-01. Os source maps não são públicos.

## Testes

`test/api.test.ts` e `test/workflow.test.ts`: 28 testes, cada um ligado a um problema das auditorias (`[#n]`, `[2.ª #n]`, `[final #n]`, `[baixa #n]`). Passam em execuções consecutivas, e os testes de cada ronda falham com o código anterior a essa ronda.
