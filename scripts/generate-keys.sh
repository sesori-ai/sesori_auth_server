#!/usr/bin/env bash
set -euo pipefail

KEYS_DIR="${1:-keys}"

mkdir -p "$KEYS_DIR"
PRIVATE_KEY="$KEYS_DIR/private.pem"
PUBLIC_KEY="$KEYS_DIR/public.pem"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$PRIVATE_KEY" 2>/dev/null
chmod 600 "$PRIVATE_KEY"
openssl rsa -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY" 2>/dev/null

echo "Keys written to $PRIVATE_KEY and $PUBLIC_KEY"
echo ""
echo "# --- Inline env vars (paste into .env or Docker config) ---"
echo ""
echo "JWT_PRIVATE_KEY=\"$(awk '{printf "%s\\n", $0}' "$PRIVATE_KEY")\""
echo ""
echo "JWT_PUBLIC_KEY=\"$(awk '{printf "%s\\n", $0}' "$PUBLIC_KEY")\""
