#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: reply.sh <pr-number> <comment-id> --body-file PATH [--repo OWNER/REPO]

Posts a reply to a PR review comment thread via the GitHub API.

Arguments:
  pr-number    The pull request number
  comment-id   The comment ID (thread_id from fetch.sh output)
Flags:
  --body-file PATH   Read the reply body from PATH.
  --repo OWNER/REPO  Override the current repo. Defaults to gh repo view.

Examples:
  reply.sh 42 12345 --body-file /tmp/pr_42_thread_12345_reply_a1b2c3.md
  reply.sh 42 12345 --body-file /tmp/pr_42_thread_12345_reply_review2.md --repo owner/repo
EOF
}

PR_NUMBER=""
COMMENT_ID=""
BODY_FILE=""
REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --body-file) [[ $# -lt 2 ]] && { echo "Error: --body-file requires a value" >&2; usage; exit 2; }; BODY_FILE="$2"; shift 2 ;;
    --repo) [[ $# -lt 2 ]] && { echo "Error: --repo requires a value" >&2; usage; exit 2; }; REPO="$2"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    -*)           echo "Unknown flag: $1" >&2; usage; exit 2 ;;
    *)
      if [[ -z "$PR_NUMBER" ]]; then
        PR_NUMBER="$1"
      elif [[ -z "$COMMENT_ID" ]]; then
        COMMENT_ID="$1"
      else
        echo "Unexpected positional argument: $1" >&2
        usage; exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$BODY_FILE" ]]; then
  echo "Error: --body-file is required" >&2
  usage; exit 2
fi

if [[ -z "$PR_NUMBER" || -z "$COMMENT_ID" ]]; then
  echo "Error: Missing required arguments" >&2
  usage; exit 2
fi

if [[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
  :
else
  echo "Error: PR number must be a positive integer, got: $PR_NUMBER" >&2
  exit 2
fi

if [[ "$COMMENT_ID" =~ ^[1-9][0-9]*$ ]]; then
  :
else
  echo "Error: Comment ID must be a positive integer, got: $COMMENT_ID" >&2
  exit 2
fi

BODY_FILE_PATTERN="^/tmp/pr_${PR_NUMBER}_thread_${COMMENT_ID}_reply_[A-Za-z0-9_-]+\\.md$"
if ! [[ "$BODY_FILE" =~ $BODY_FILE_PATTERN ]]; then
  echo "Error: Reply body file must use /tmp/pr_${PR_NUMBER}_thread_${COMMENT_ID}_reply_<unique>.md" >&2
  exit 2
fi

if [[ -L "$BODY_FILE" || ! -f "$BODY_FILE" || ! -r "$BODY_FILE" ]]; then
  echo "Error: Reply body file is not a readable, non-symlink regular file: $BODY_FILE" >&2
  exit 2
fi

BODY="$(<"$BODY_FILE")"
if [[ -z "$BODY" ]]; then
  echo "Error: Reply body file is empty: $BODY_FILE" >&2
  exit 2
fi

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi

if [[ "$BODY" != "[Sesori reply]"* ]]; then
  BODY="[Sesori reply] $BODY"
fi

if ! gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments/${COMMENT_ID}/replies" \
  -f body="$BODY" > /dev/null; then
  echo "Error: failed to post reply to comment ${COMMENT_ID} on PR #${PR_NUMBER} in ${REPO}" >&2
  exit 1
fi

echo "Reply posted to comment ${COMMENT_ID} on PR #${PR_NUMBER}"
