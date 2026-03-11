#!/bin/bash

# First-time setup for sops + age encrypted environment variables.
# Run once per developer machine:  npm run env:init
#
# What it does:
#   1. Checks/installs sops and age (macOS via brew, Linux via direct download)
#   2. Generates an age keypair if you don't have one
#   3. Adds your public key to .sops.yaml
#   4. Encrypts all existing .env.{env} files into env/app/

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOPS_YAML="$REPO_ROOT/.sops.yaml"
APP_ENV_DIR="$REPO_ROOT/env/app"
if [[ "$OSTYPE" == "darwin"* ]]; then
    AGE_KEY_DIR="$HOME/Library/Application Support/sops/age"
else
    AGE_KEY_DIR="$HOME/.config/sops/age"
fi
AGE_KEY_FILE="$AGE_KEY_DIR/keys.txt"

# ── Colors ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[info]${NC}  $1"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $1"; }
fail()  { echo -e "${RED}[fail]${NC}  $1"; exit 1; }

# ── Step 1: Install dependencies ────────────────────────────────
install_tool() {
    local tool=$1
    if command -v "$tool" &>/dev/null; then
        ok "$tool is installed ($(command -v "$tool"))"
        return
    fi

    warn "$tool is not installed."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        if ! command -v brew &>/dev/null; then
            fail "Homebrew not found. Install $tool manually: https://github.com/getsops/sops"
        fi
        info "Installing $tool via brew..."
        brew install "$tool"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if [ "$tool" = "sops" ]; then
            info "Installing sops from GitHub releases..."
            local sops_version
            sops_version=$(curl -sI https://github.com/getsops/sops/releases/latest | grep -i '^location:' | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)
            if [ -z "$sops_version" ]; then
                fail "Could not determine latest sops version from GitHub"
            fi
            local sops_url="https://github.com/getsops/sops/releases/download/${sops_version}/sops-${sops_version}.linux.amd64"
            info "Downloading sops ${sops_version}..."
            sudo curl -Lo /usr/local/bin/sops "$sops_url"
            sudo chmod +x /usr/local/bin/sops
        elif [ "$tool" = "age" ]; then
            info "Installing age via apt..."
            sudo apt-get update && sudo apt-get install -y age
        fi
    else
        fail "Unsupported OS. Install $tool manually."
    fi

    command -v "$tool" &>/dev/null || fail "Failed to install $tool"
    ok "$tool installed successfully"
}

info "Checking dependencies..."
install_tool "sops"
install_tool "age"
echo ""

# ── Step 2: Generate age keypair ────────────────────────────────
LEGACY_KEY_FILE="$HOME/.config/sops/age/keys.txt"
if [ ! -f "$AGE_KEY_FILE" ] && [ -f "$LEGACY_KEY_FILE" ]; then
    info "Found existing key at $LEGACY_KEY_FILE, copying to $AGE_KEY_FILE"
    mkdir -p "$AGE_KEY_DIR"
    cp "$LEGACY_KEY_FILE" "$AGE_KEY_FILE"
fi

if [ -f "$AGE_KEY_FILE" ]; then
    ok "age key already exists at $AGE_KEY_FILE"
    PUBLIC_KEY=$(grep "public key:" "$AGE_KEY_FILE" | head -1 | awk '{print $NF}')
else
    info "Generating age keypair..."
    mkdir -p "$AGE_KEY_DIR"
    age-keygen -o "$AGE_KEY_FILE" 2>&1
    PUBLIC_KEY=$(grep "public key:" "$AGE_KEY_FILE" | head -1 | awk '{print $NF}')
    ok "Key generated. Public key: $PUBLIC_KEY"
    echo ""
    warn "IMPORTANT: Back up your private key at $AGE_KEY_FILE"
    warn "If you lose it, you will NOT be able to decrypt any secrets."
fi

if [ -z "$PUBLIC_KEY" ]; then
    fail "Could not extract public key from $AGE_KEY_FILE"
fi

info "Your public key: $PUBLIC_KEY"
echo ""

# ── Step 3: Update .sops.yaml with public key ───────────────────
if grep -q "$PUBLIC_KEY" "$SOPS_YAML" 2>/dev/null; then
    ok "Your public key is already in .sops.yaml"
else
    info "Adding your public key to .sops.yaml..."

    read -p "Enter your name/alias for the key comment (e.g., alex): " KEY_ALIAS
    if [ -z "$KEY_ALIAS" ]; then
        KEY_ALIAS="developer"
    fi

    LAST_KEY_LINENUM=$(grep -n "^      age1" "$SOPS_YAML" | tail -1 | cut -d: -f1)

    if [ -n "$LAST_KEY_LINENUM" ]; then
        sed -i.bak "${LAST_KEY_LINENUM}s/\([^,]\)$/\1,/" "$SOPS_YAML"
        rm -f "$SOPS_YAML.bak"

        {
            head -n "$LAST_KEY_LINENUM" "$SOPS_YAML"
            echo "      $PUBLIC_KEY"
            tail -n "+$((LAST_KEY_LINENUM + 1))" "$SOPS_YAML"
        } > "$SOPS_YAML.tmp" && mv "$SOPS_YAML.tmp" "$SOPS_YAML"

        RECIPIENTS_LINENUM=$(grep -n "^    # Recipients:" "$SOPS_YAML" | tail -1 | cut -d: -f1)
        if [ -n "$RECIPIENTS_LINENUM" ]; then
            TOTAL_KEYS=$(grep -c "^      age1" "$SOPS_YAML")
            sed -i.bak "${RECIPIENTS_LINENUM}s|$|  ${TOTAL_KEYS}) $KEY_ALIAS|" "$SOPS_YAML"
            rm -f "$SOPS_YAML.bak"
        fi
    else
        fail "Could not find age keys in .sops.yaml. Verify the file format."
    fi

    ok "Public key added to .sops.yaml"
fi
echo ""

# ── Step 4: Encrypt existing .env files ──────────────────────────
mkdir -p "$APP_ENV_DIR"

ENVIRONMENTS=(local prod)
ENCRYPTED_COUNT=0

for env_name in "${ENVIRONMENTS[@]}"; do
    PLAINTEXT="$REPO_ROOT/.env.$env_name"
    ENCRYPTED="$APP_ENV_DIR/$env_name.env"

    if [ ! -f "$PLAINTEXT" ]; then
        warn "Skipping $env_name — .env.$env_name not found"
        continue
    fi

    if [ -f "$ENCRYPTED" ]; then
        warn "Skipping $env_name — env/app/$env_name.env already exists (decrypt + re-encrypt to update)"
        continue
    fi

    CLEAN_PLAINTEXT=$(mktemp)
    sed 's/^export //' "$PLAINTEXT" > "$CLEAN_PLAINTEXT"

    info "Encrypting .env.$env_name → env/app/$env_name.env"
    sops encrypt --input-type dotenv --output-type dotenv --filename-override "env/app/$env_name.env" "$CLEAN_PLAINTEXT" > "$ENCRYPTED"
    rm -f "$CLEAN_PLAINTEXT"

    ok "env/app/$env_name.env encrypted"
    ENCRYPTED_COUNT=$((ENCRYPTED_COUNT + 1))
done

echo ""
if [ "$ENCRYPTED_COUNT" -gt 0 ]; then
    ok "Encrypted $ENCRYPTED_COUNT environment file(s) into env/app/"
else
    info "No new files to encrypt"
fi

# ── Done ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Verify you can decrypt:   sops decrypt env/app/local.env"
echo "  2. Share your public key with the team: $PUBLIC_KEY"
echo "  3. Commit the encrypted files: git add .sops.yaml env/"
echo "  4. To edit env vars:          npm run env:edit"
echo "  5. To decrypt for local dev:  npm run env:decrypt"
