#!/usr/bin/env bash
set -euo pipefail

network="auth-ci-smoke-net"
mongo="auth-ci-smoke-mongo"
auth="auth-ci-smoke-auth"
poll_file="$(mktemp)"
log_file="$(mktemp)"
private_key=""
public_key=""

dump_logs() {
  echo "=== $auth logs ===" >&2
  docker logs "$auth" >&2 || true
  echo "=== $mongo logs ===" >&2
  docker logs "$mongo" >&2 || true
}

cleanup() {
  docker rm -f "$auth" "$mongo" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -f "$poll_file" "$log_file" "$private_key" "$public_key"
}

finish() {
  status="$?"
  if [ "$status" -ne 0 ]; then
    dump_logs
  fi
  cleanup
  exit "$status"
}
trap finish EXIT

docker rm -f "$auth" "$mongo" >/dev/null 2>&1 || true
docker network rm "$network" >/dev/null 2>&1 || true
docker network create "$network" >/dev/null

private_key="$(mktemp)"
public_key="$(mktemp)"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$private_key" 2>/dev/null
openssl rsa -in "$private_key" -pubout -out "$public_key" 2>/dev/null
jwt_private_key="$(awk 'NR>1{printf "\\n"}{printf "%s",$0}' "$private_key")"
jwt_public_key="$(awk 'NR>1{printf "\\n"}{printf "%s",$0}' "$public_key")"
rm -f "$private_key" "$public_key"

analytics_key="$(openssl rand -base64 32)"
fcm_json="$(printf '{"type":"service_account","project_id":"ci","private_key_id":"ci","private_key":"-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----\\n","client_email":"ci@example.com","client_id":"1","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"https://www.googleapis.com/robot/v1/metadata/x509/ci","universe_domain":"googleapis.com"}' | base64 | tr -d '\n')"
session_token="$(openssl rand -hex 32)"

echo "::add-mask::$jwt_private_key" 2>/dev/null || true
echo "::add-mask::$jwt_public_key" 2>/dev/null || true
echo "::add-mask::$analytics_key" 2>/dev/null || true
echo "::add-mask::$fcm_json" 2>/dev/null || true
echo "::add-mask::$session_token" 2>/dev/null || true

docker run --rm -d --name "$mongo" --network "$network" mongo:7 >/dev/null
docker run -d --name "$auth" --network "$network" -p 3001:3001 \
  -e MONGODB_URI="mongodb://$mongo:27017/auth-ci" \
  -e JWT_PRIVATE_KEY="$jwt_private_key" \
  -e JWT_PUBLIC_KEY="$jwt_public_key" \
  -e GITHUB_CLIENT_ID=ci-test \
  -e GITHUB_CLIENT_SECRET=ci-test \
  -e GOOGLE_CLIENT_ID=ci-test \
  -e GOOGLE_CLIENT_SECRET=ci-test \
  -e ALLOWED_REDIRECT_URIS=http://localhost:3000/callback \
  -e RELAY_URL=ws://localhost:8080 \
  -e PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY="$analytics_key" \
  -e OPENAI_API_KEY=ci-test \
  -e ASYNC_TRANSCRIPTION_PROVIDER=openai \
  -e REALTIME_TRANSCRIPTION_ENABLED=false \
  -e FCM_SA_JSON="$fcm_json" \
  -e APPLE_CLIENT_ID=ci-test \
  -e APPLE_IOS_CLIENT_ID=ci-test \
  -e APPLE_TEAM_ID=ci-test \
  -e APPLE_KEY_ID=ci-test \
  -e APPLE_PRIVATE_KEY=ci-test \
  auth-backend:ci >/dev/null

for _ in {1..60}; do
  if curl -fsS http://localhost:3001/health | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const parsed = JSON.parse(data); process.exit(parsed.status === "ok" ? 0 : 1); });'; then
    break
  fi
  sleep 1
done

curl -fsS http://localhost:3001/health | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const parsed = JSON.parse(data); if (parsed.status !== "ok") process.exit(1); });'
curl -fsS http://localhost:3001/voice/capabilities | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const parsed = JSON.parse(data); if (parsed.realtime?.enabled !== false || parsed.realtime?.protocolVersions?.[0] !== 1) process.exit(1); });'
status="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' http://localhost:3001/voice/realtime)"
test "$status" = "404"

(curl -sS -H "X-Sesori-Session-Token: $session_token" http://localhost:3001/auth/session/status >"$poll_file" || true) &
poll_pid="$!"
sleep 1
started_at="$(date +%s)"
docker stop --time 25 "$auth" >/dev/null
elapsed="$(( $(date +%s) - started_at ))"
wait "$poll_pid" || true
docker logs "$auth" >"$log_file" 2>&1 || true
exit_code="$(docker inspect "$auth" --format '{{.State.ExitCode}}')"

test "$exit_code" = "0"
test "$elapsed" -lt 10
node -e 'const fs=require("node:fs"); const parsed=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(parsed.status === "pending" ? 0 : 1);' "$poll_file"
node -e 'const fs=require("node:fs"); const log=fs.readFileSync(process.argv[1], "utf8"); const order=["[Shutdown] start","[Shutdown] waiters released","[Shutdown] MongoDB closed"]; let last=-1; for (const marker of order) { const idx=log.indexOf(marker); if (idx < 0 || idx < last) process.exit(1); last=idx; }' "$log_file"
