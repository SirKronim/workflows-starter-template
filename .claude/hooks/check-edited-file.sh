#!/usr/bin/env bash
# PostToolUse hook (Edit|Write|MultiEdit).
# Corre ESLint no ficheiro editado e o typecheck do projeto (tsc -b).
# Se falhar, sai com código 2: o erro volta ao Claude para ele corrigir.
set -uo pipefail

file=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')
[ -z "$file" ] && exit 0

# Só ficheiros TypeScript do projeto (ignora node_modules, dist, tipos gerados).
case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac
case "$file" in
  */node_modules/*|*/dist/*|*worker-configuration.d.ts) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0
[ -d node_modules ] || exit 0   # sem dependências instaladas não há nada a verificar

errors=""
if ! out=$(npx --no-install eslint "$file" 2>&1); then
  errors+=$'ESLint falhou em '"$file"$':\n'"$out"$'\n'
fi
if ! out=$(npx --no-install tsc -b 2>&1); then
  errors+=$'Typecheck (tsc -b) falhou:\n'"$out"$'\n'
fi

if [ -n "$errors" ]; then
  printf '%s' "$errors" | head -c 6000 >&2
  exit 2
fi
exit 0
