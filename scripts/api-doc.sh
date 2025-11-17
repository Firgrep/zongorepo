#!/bin/bash

# Paths (edit these to match your actual layout)
SOURCE_FILE="./src/base.repo.ts"
README_FILE="./README.md"

# Temporary file
TEMP_BLOCK=$(mktemp)

# Extract only the first JSDoc comment block and unwrap it
awk '/\/\*\*/,/\*\// { 
    if (/\/\*\*/) next;  # Skip the opening /**
    if (/\*\//) exit;    # Exit at closing */
    gsub(/^[[:space:]]*\*[[:space:]]?/, ""); # Remove leading * and optional space
    if (/^@/) next;      # Skip JSDoc tags like @template, @param, etc.
    print;
}' "$SOURCE_FILE" > "$TEMP_BLOCK"

# Replace content in README.md
awk -v block="$(cat "$TEMP_BLOCK")" '
BEGIN { in_block=0 }
/<!-- API_DOC_START -->/ { print; print block; in_block=1; next }
/<!-- API_DOC_END -->/ { print; in_block=0; next }
!in_block
' "$README_FILE" > "${README_FILE}.tmp"

mv "${README_FILE}.tmp" "$README_FILE"
rm "$TEMP_BLOCK"

echo "✏️ JSDoc content inserted/updated into README.md"
