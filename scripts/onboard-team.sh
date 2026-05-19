#!/bin/bash
# onboard-team.sh — Admin tool to create user accounts and tokens for a team
#
# Usage:
#   ./onboard-team.sh --server URL --admin-token TOKEN --count 5
#   ./onboard-team.sh --server URL --admin-token TOKEN --users team.csv
#
# CSV format (one per line): email,name
#   alice@company.com,Alice Smith
#   bob@company.com,Bob Jones
set -e

SERVER=""
ADMIN_TOKEN=""
COUNT=0
USERS_FILE=""
OUTPUT_FILE="onboarding-results.txt"

# ── Parse arguments ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --server)    SERVER="$2";      shift 2 ;;
    --admin-token) ADMIN_TOKEN="$2"; shift 2 ;;
    --count)     COUNT="$2";       shift 2 ;;
    --users)     USERS_FILE="$2";  shift 2 ;;
    --output)    OUTPUT_FILE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 --server URL --admin-token TOKEN [--count N | --users FILE]"
      echo ""
      echo "Options:"
      echo "  --server URL         Sentinel server URL (e.g. https://sentinel.company.com)"
      echo "  --admin-token TOKEN  Admin API token from server setup"
      echo "  --count N            Number of engineers (interactive name/email entry)"
      echo "  --users FILE         CSV file with email,name per line"
      echo "  --output FILE        Output file (default: onboarding-results.txt)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Validate inputs ──────────────────────────────────────────────────────────

if [ -z "$SERVER" ]; then
  echo "ERROR: --server is required" >&2
  exit 1
fi

if [ -z "$ADMIN_TOKEN" ]; then
  echo "ERROR: --admin-token is required" >&2
  exit 1
fi

if [ "$COUNT" -eq 0 ] && [ -z "$USERS_FILE" ]; then
  echo "ERROR: Specify --count N or --users FILE" >&2
  exit 1
fi

# Strip trailing slash
SERVER="${SERVER%/}"

# ── Validate admin token ────────────────────────────────────────────────────

echo ""
echo "=============================================="
echo "  Sentinel — Team Onboarding"
echo "=============================================="
echo ""
echo "Validating admin token..."

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$SERVER/api/stats" 2>/dev/null || echo "000")

if [ "$HTTP_STATUS" != "200" ]; then
  echo "ERROR: Admin token validation failed (HTTP $HTTP_STATUS)" >&2
  echo "Check your --server URL and --admin-token" >&2
  exit 1
fi

echo "  Admin token valid"
echo ""

# ── Collect user list ────────────────────────────────────────────────────────

declare -a EMAILS
declare -a NAMES

if [ -n "$USERS_FILE" ]; then
  # Read from CSV
  if [ ! -f "$USERS_FILE" ]; then
    echo "ERROR: Users file not found: $USERS_FILE" >&2
    exit 1
  fi

  while IFS=, read -r email name; do
    # Skip empty lines and comments
    [ -z "$email" ] && continue
    [[ "$email" == \#* ]] && continue
    EMAILS+=("$(echo "$email" | xargs)")  # trim whitespace
    NAMES+=("$(echo "$name" | xargs)")
  done < "$USERS_FILE"

  COUNT=${#EMAILS[@]}
  echo "Loaded $COUNT engineers from $USERS_FILE"
else
  # Interactive mode
  echo "Enter details for $COUNT engineers:"
  echo ""
  for i in $(seq 1 "$COUNT"); do
    printf "  Engineer $i email: "
    read -r email
    printf "  Engineer $i name: "
    read -r name
    EMAILS+=("$email")
    NAMES+=("$name")
    echo ""
  done
fi

# ── Create accounts and tokens ──────────────────────────────────────────────

echo "Creating $COUNT accounts..."
echo ""

# Start output file
cat > "$OUTPUT_FILE" <<EOF
# Sentinel Team Onboarding Results
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Server: $SERVER
# Engineers: $COUNT
#
# IMPORTANT: This file contains API tokens. Store securely and delete after distribution.
#
EOF

CREATED=0
FAILED=0

for i in $(seq 0 $((COUNT - 1))); do
  EMAIL="${EMAILS[$i]}"
  NAME="${NAMES[$i]}"

  echo "  [$((i + 1))/$COUNT] $NAME ($EMAIL)"

  # Step 1: Create user account
  USER_RESPONSE=$(curl -s -X POST "$SERVER/api/admin/users" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"name\":\"$NAME\",\"role\":\"developer\"}" 2>/dev/null)

  USER_ID=$(echo "$USER_RESPONSE" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const r=JSON.parse(d); console.log(r.id||''); }
      catch(e) { console.log(''); }
    });
  ")

  if [ -z "$USER_ID" ]; then
    ERROR_MSG=$(echo "$USER_RESPONSE" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        try { const r=JSON.parse(d); console.log(r.error||'Unknown error'); }
        catch(e) { console.log('Failed to parse response'); }
      });
    ")
    echo "    FAILED: $ERROR_MSG"
    FAILED=$((FAILED + 1))
    continue
  fi

  echo "    User created: $USER_ID"

  # Step 2: Generate API token
  TOKEN_RESPONSE=$(curl -s -X POST "$SERVER/api/admin/tokens" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"$USER_ID\",\"name\":\"$NAME Sentinel Agent\"}" 2>/dev/null)

  TOKEN=$(echo "$TOKEN_RESPONSE" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const r=JSON.parse(d); console.log(r.token||''); }
      catch(e) { console.log(''); }
    });
  ")

  if [ -z "$TOKEN" ]; then
    echo "    WARNING: User created but token generation failed"
    FAILED=$((FAILED + 1))
    continue
  fi

  echo "    Token generated"
  CREATED=$((CREATED + 1))

  # Write to output file
  cat >> "$OUTPUT_FILE" <<EOF

## $NAME ($EMAIL)
- User ID: $USER_ID
- Token: $TOKEN
- Setup command:
  SENTINEL_SERVER="$SERVER" SENTINEL_TOKEN="$TOKEN" bash install.sh

EOF

  echo ""
done

# ── Summary ──────────────────────────────────────────────────────────────────

echo "=============================================="
echo "  Onboarding Complete"
echo "=============================================="
echo ""
echo "  Created: $CREATED / $COUNT"
if [ "$FAILED" -gt 0 ]; then
  echo "  Failed:  $FAILED"
fi
echo ""
echo "  Results saved to: $OUTPUT_FILE"
echo ""
echo "  Next steps:"
echo "  1. Send each engineer their setup command from $OUTPUT_FILE"
echo "  2. Each engineer runs the command on their laptop"
echo "  3. They start a Claude Code session — monitoring begins automatically"
echo ""
echo "  IMPORTANT: Delete $OUTPUT_FILE after distributing tokens!"
echo "=============================================="
echo ""
