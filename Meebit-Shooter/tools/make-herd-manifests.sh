#!/usr/bin/env bash
# Generate manifest.json for every herd folder under assets/civilians/.
#
# Usage (run from Meebit-Shooter/ root):
#   bash tools/make-herd-manifests.sh
#
# Produces, for each folder:
#   assets/civilians/{herdId}/manifest.json
#
# The manifest is a JSON array of .vrm filenames in that folder, sorted.
# The game reads this at bonus-wave start to know which files exist.

set -e

ASSETS_DIR="${1:-assets/civilians}"
if [ ! -d "$ASSETS_DIR" ]; then
  echo "Directory not found: $ASSETS_DIR"
  echo "Run this from the Meebit-Shooter root, or pass the path as argument:"
  echo "  bash tools/make-herd-manifests.sh /path/to/assets/civilians"
  exit 1
fi

for dir in "$ASSETS_DIR"/*/; do
  herd=$(basename "$dir")
  # Skip hidden folders and anything obviously not a herd folder.
  case "$herd" in .* ) continue ;; esac

  # List .vrm files, strip path, sort, wrap in JSON array.
  files=$(cd "$dir" && ls *.vrm 2>/dev/null | sort) || files=""
  if [ -z "$files" ]; then
    echo "skip:  $herd (no .vrm files)"
    continue
  fi

  # Build JSON array
  {
    echo -n "["
    first=1
    while IFS= read -r f; do
      if [ $first -eq 1 ]; then first=0; else echo -n ","; fi
      echo -n "\"$f\""
    done <<< "$files"
    echo "]"
  } > "$dir/manifest.json"

  count=$(echo "$files" | wc -l | tr -d ' ')
  echo "wrote: $herd/manifest.json ($count files)"
done

echo ""
echo "Done. Commit and push the new manifest.json files."
