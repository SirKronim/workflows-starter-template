#!/usr/bin/env bash
# Imprime a "impressão digital" (SHA-256) do código relevante para a segurança.
# Muda sempre que muda o conteúdo, o nome ou a existência de um destes ficheiros,
# incluindo alterações ainda não commitadas e ficheiros novos ainda não adicionados ao git.
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

paths=(worker src wrangler.jsonc index.html package.json package-lock.json)

git ls-files -z --cached --others --exclude-standard -- "${paths[@]}" \
  | sort -z \
  | while IFS= read -r -d '' f; do
      [ -f "$f" ] || continue          # ignora ficheiros apagados mas ainda no índice
      printf '%s\0' "$f"
      sha256sum < "$f"
    done \
  | sha256sum | cut -c1-16
