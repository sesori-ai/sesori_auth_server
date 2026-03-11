#!/usr/bin/env bash
set -euo pipefail

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMPDIR/private.pem" 2>/dev/null
openssl rsa -in "$TMPDIR/private.pem" -pubout -out "$TMPDIR/public.pem" 2>/dev/null

echo "# Paste into .env or Docker config"
echo ""
printf 'JWT_PRIVATE_KEY="%s"\n' "$(awk 'NR>1{printf "\\n"}{printf "%s",$0}' "$TMPDIR/private.pem")"
echo ""
printf 'JWT_PUBLIC_KEY="%s"\n' "$(awk 'NR>1{printf "\\n"}{printf "%s",$0}' "$TMPDIR/public.pem")"
