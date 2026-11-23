#!/usr/bin/env bash
# SessionStart hook (só em sessões novas, matcher "startup").
# Compara a impressão digital atual do código com a da última auditoria guardada
# em .claude/last-security-audit.md e diz ao Claude se deve ou não auditar.
# Não usa a rede e não altera ficheiros.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

report=".claude/last-security-audit.md"
current=$(bash .claude/hooks/audit-fingerprint.sh 2>/dev/null || echo "erro")
stored=$(sed -n 's/^<!-- fingerprint: \([0-9a-f]*\) .*-->$/\1/p' "$report" 2>/dev/null | head -1)
stored_date=$(sed -n 's/^<!-- fingerprint: [0-9a-f]* date: \([^ ]*\) -->$/\1/p' "$report" 2>/dev/null | head -1)

if [ "$current" != "erro" ] && [ -n "$stored" ] && [ "$current" = "$stored" ]; then
  msg="AUDITORIA NO ARRANQUE: o código relevante para a segurança NÃO mudou desde a última auditoria (${stored_date:-data desconhecida}, fingerprint ${current}). Não corras a auditoria. Diz isto ao utilizador numa frase e segue para o pedido dele. O relatório anterior está em ${report}."
else
  if [ -z "$stored" ]; then why="não existe auditoria anterior guardada"; else why="o código mudou (fingerprint ${stored} -> ${current})"; fi
  msg="AUDITORIA NO ARRANQUE: ${why}. Antes de qualquer outra tarefa: (1) chama o subagente workers-security-reviewer e mostra ao utilizador o resumo (tabela por gravidade); (2) grava o relatório completo em ${report}, com esta primeira linha exata: <!-- fingerprint: ${current} date: AAAA-MM-DD --> (data de hoje); (3) inclui esse ficheiro no próximo commit do trabalho da sessão. Diz numa frase porque a auditoria correu. Se o utilizador pedir para saltar, respeita e não atualizes o ficheiro."
fi

jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$m}}' 2>/dev/null \
  || printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AUDITORIA NO ARRANQUE: não foi possível verificar se o código mudou; corre o subagente workers-security-reviewer antes de qualquer outra tarefa."}}\n'
