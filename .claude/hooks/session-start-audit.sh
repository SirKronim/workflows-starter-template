#!/usr/bin/env bash
# SessionStart hook (só em sessões novas, matcher "startup").
# Não corre a auditoria diretamente (um script não consegue chamar o subagente):
# injeta uma instrução no contexto do Claude para a fazer antes de qualquer outra tarefa.
# Não lê stdin, não usa a rede e não depende de jq.
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "REGRA DO PROJETO (auditoria no arranque): antes de qualquer outra tarefa nesta sessão, chama o subagente `workers-security-reviewer` para auditar o código atual e mostra ao utilizador o resumo do relatório (tabela de problemas por gravidade). Diz numa frase que esta auditoria corre automaticamente no início de cada sessão. Só depois trata do pedido do utilizador. Se o utilizador pedir explicitamente para saltar a auditoria nesta sessão, respeita."
  }
}
EOF
