#!/usr/bin/env bash
set -euo pipefail

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMPDIR/private.pem" 2>/dev/null
openssl rsa -in "$TMPDIR/private.pem" -pubout -out "$TMPDIR/public.pem" 2>/dev/null

echo "# Paste into .env or Docker config"
echo ""
echo "JWT_PRIVATE_KEY=\"$(awk '{printf "%s\\n", $0}' "$TMPDIR/private.pem")\""
echo ""
echo "JWT_PUBLIC_KEY=\"$(awk '{printf "%s\\n", $0}' "$TMPDIR/public.pem")\""
