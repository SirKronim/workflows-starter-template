#!/usr/bin/env bash
# PreToolUse hook (Bash).
# Antes de qualquer publicação (wrangler deploy / npm run deploy / wrangler versions upload)
# corre lint, typecheck, testes e auditoria de dependências.
#  - Se algo falhar  -> bloqueia a publicação (exit 2) e mostra o motivo.
#  - Se tudo passar  -> pede confirmação explícita ao utilizador ("ask"),
#                       com o resumo das verificações.
set -uo pipefail

input=$(cat)
if ! command -v jq >/dev/null 2>&1; then
  # Sem jq não conseguimos analisar o comando: só bloqueia se parecer uma publicação.
  if printf '%s' "$input" | grep -q 'deploy\|versions upload'; then
    echo "Publicação bloqueada: 'jq' não está instalado, o pre-deploy gate não pode correr." >&2
    exit 2
  fi
  exit 0
fi
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

# Só intercetar comandos de publicação; o dry-run (npm run check) é permitido.
if ! printf '%s' "$cmd" | grep -Eq '(wrangler([[:space:]]+[^[:space:]]+)*[[:space:]]+(deploy|versions[[:space:]]+(upload|deploy)))|(npm[[:space:]]+run[[:space:]]+deploy)'; then
  exit 0
fi
if printf '%s' "$cmd" | grep -Eq -- '--dry-run'; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 2

fail=""
summary=""
run_check() {
  local label="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    summary+="✅ $label"$'\n'
  else
    summary+="❌ $label"$'\n'
    fail+="--- $label ---"$'\n'"$(printf '%s' "$out" | tail -n 30)"$'\n'
  fi
}

if [ ! -d node_modules ]; then
  echo "Publicação bloqueada: dependências não instaladas (corre 'npm ci' primeiro)." >&2
  exit 2
fi

run_check "Lint (eslint)"                          npx --no-install eslint .
run_check "Typecheck (tsc -b)"                     npx --no-install tsc -b
run_check "Testes (vitest)"                        npx --no-install vitest run
run_check "Auditoria npm (produção, nível high+)"  npm audit --omit=dev --audit-level=high

if [ -n "$fail" ]; then
  {
    echo "Publicação BLOQUEADA pelo pre-deploy gate:"
    printf '%s' "$summary"
    echo
    printf '%s' "$fail" | head -c 6000
  } >&2
  exit 2
fi

reason="Pre-deploy gate: verificações automáticas passaram:"$'\n'"$summary"
reason+="Lembrete: a revisão de segurança do código (/security-review) deve ter sido feita e mostrada ao utilizador antes de publicar."
jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: $r
  }
}'
exit 0
