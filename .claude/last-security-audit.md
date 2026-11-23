<!-- fingerprint: 554dcf99fa06f8af date: 2026-11-23 -->
# Auditoria de segurança: 2026-11-23 (versão final)

> Gerada pelo subagente `workers-security-reviewer` (só de leitura) depois de três rondas de correções.
> A primeira linha deste ficheiro guarda a impressão digital do código auditado: o hook de início de sessão só volta a auditar quando ela mudar.

## Histórico

| Auditoria | Crítica | Alta | Média | Baixa |
|---|---|---|---|---|
| 1.ª: template original | 0 | 2 | 4 | 7 |
| 2.ª: após a 1.ª ronda de correções | 0 | 0 | 2 | 5 (+2 a verificar) |
| 3.ª: após a 2.ª ronda | 0 | 0 | 1 | 5 |
| **Final: após a 3.ª ronda** | **0** | **0** | **0** | **4** |

## Resumo

**Pronto para publicar, com reservas menores.** Não há problemas críticos, altos ou médios. Os pontos que restam são de gravidade baixa, sem possibilidade de acesso indevido. A isto somam-se três compromissos aceites conscientemente, documentados em `CLAUDE.md`.

**Modelo de segurança em vigor:**
- Cada workflow tem uma chave de 256 bits, guardada num cookie `__Host-wf_<id>` (HttpOnly, Secure, SameSite=Strict). O Durable Object guarda só o hash SHA-256 e compara-o em tempo constante.
- Há rate limiting por IPv4 ou por prefixo IPv6 /64, mais um teto de criação de workflows (por localização da Cloudflare).
- A origem (Origin) e o Content-Type são verificados, o corpo do pedido é validado e limitado a 2 KB em stream, e as rotas são exatas, com validação de UUID.
- Qualquer recusa de acesso devolve 403, por isso não se consegue saber se um ID existe.
- WebSocket: no máximo 5 ligações por workflow. Mensagens inesperadas fecham a ligação (1008) e as ligações fecham quando o workflow termina com sucesso ou com erro.
- Limpeza automática do estado 2 h depois da criação.
- CSP restritiva e restantes cabeçalhos de segurança, na API e nas páginas.

## Problemas restantes

| # | Gravidade | Onde | Problema | Correção sugerida |
|---|-----------|------|----------|-------------------|
| 1 | ⚪ Baixa | worker/durable-object.ts (alarm/setOwner) | O alarme corre 2 h depois sem ver se o workflow ainda está ativo. Num caso-limite (fila da conta ou repetições do passo final), apaga a chave e depois o estado volta a ser escrito sem alarme. A falha é segura: o resultado é um 403, sem acesso indevido. | No `alarm()`, voltar a agendar se ainda estiver `running`. Agendar uma limpeza curta quando o workflow chega a um estado final. |
| 2 | ⚪ Baixa | worker/durable-object.ts (fetch) | São aceites ligações WebSocket novas depois de o workflow terminar. Ficam abertas até ao alarme. Só o dono o consegue fazer, e com hibernação o custo é desprezável. | Se o workflow já terminou, enviar o estado e fechar a ligação logo a seguir. |
| 3 | ⚪ Baixa (usabilidade) | src/App.tsx, src/components/WorkflowDiagram.tsx, CodeDisplay.tsx | A interface não trata o estado `"error"`: o botão Start fica desativado até recarregar a página. | Fazer reset também com `"error"`, mostrar uma mensagem e dar estilo próprio ao passo em erro. |
| 4 | ⚪ Baixa (cosmético) | worker/security.ts:9 | O cookie (60 min) conta a partir do `/start`, cerca de 3 s antes de começar o prazo de aprovação de 60 min. | `Max-Age` de 65 min. |

## Compromissos aceites (documentados em CLAUDE.md)

| Ponto | Porque se aceita |
|---|---|
| O teto de criação é por localização da Cloudflare, não global | Um teto exato exige um contador central (DO único) ou Turnstile. É uma decisão do utilizador. |
| Os cookies por instância podem acumular-se durante até 1 h | Só afeta quem inicia muitos workflows. Mitigado pelo limite de 5 por minuto. |
| 5 inícios/min por IPv4 pode limitar redes com NAT partilhado | Compromisso razoável para uma demonstração. |

## Requer ação do utilizador

- **Logs da Cloudflare:** confirmar no painel (Workers → o Worker → Logs) se os registos de invocação guardam os cabeçalhos do pedido. Se guardarem, o cookie com a chave fica visível a quem tiver acesso aos logs durante até 1 h. O código nunca regista o cookie.
- **Safari em desenvolvimento:** o Safari não aceita cookies `Secure` em `http://localhost`, por isso em `npm run dev` o fluxo do dono falha (403). Para desenvolver, usar Chrome ou Firefox. Em produção (HTTPS) funciona.

## Correções da 3.ª ronda verificadas

- **`try/catch` no `waitForEvent`:** segue as regras dos Workflows. Só chama o `notifyStep` (idempotente) e volta a lançar o erro. Num replay, o comportamento é o mesmo.
- **Estado `"error"`:** é guardado, transmitido e as ligações fecham.
- **Oráculo de existência:** resolvido. Sem chave, com chave errada ou com ID inexistente, a resposta é sempre 403 com o mesmo corpo. IDs inventados não criam Durable Objects.
- **Alarme de limpeza:** funciona no caso normal e tem teste. Ver o caso-limite no problema 1.

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

`test/api.test.ts` e `test/workflow.test.ts`: 24 testes, cada um ligado a um problema das auditorias (`[#n]`, `[2.ª #n]`, `[final #n]`). Passam em execuções consecutivas, e os testes de cada ronda falham com o código anterior a essa ronda.
