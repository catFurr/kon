#!/usr/bin/env bash
set -euo pipefail

# Gaza Stack CLI Installer
# Usage: curl -fsSL https://gazastack.sh/install | bash

# ═══════════════════════════════════════════════════════════════════════════════
# Section 1: Constants & Colors
# ═══════════════════════════════════════════════════════════════════════════════

HOSTINGER_API="https://developers.hostinger.com"
CF_API="https://api.cloudflare.com/client/v4"
GH_API="https://api.github.com"

# Colors (degrade gracefully for non-color terminals)
if [[ -t 1 ]] && [[ "${TERM:-}" != "dumb" ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  DIM='\033[2m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' DIM='' BOLD='' RESET=''
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Section 2: Utility Functions
# ═══════════════════════════════════════════════════════════════════════════════

info()    { echo -e "  ${CYAN}i${RESET} $1"; }
success() { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
error()   { echo -e "  ${RED}✗${RESET} $1"; }
header()  { echo -e "\n${BOLD}── Step $1: $2 ──${RESET}\n"; }

print_banner() {
  echo -e "${BOLD}"
  cat << 'BANNER'

   ╔═══════════════════════════════════════╗
   ║         Gaza Stack Installer          ║
   ╚═══════════════════════════════════════╝

BANNER
  echo -e "${RESET}"
  echo -e "  ${DIM}Cloud dev environments, automated.${RESET}"
  echo ""
}

# All reads must use /dev/tty because stdin is consumed by curl|bash pipe
confirm() {
  local message="$1"
  local default="${2:-Y}"
  local answer

  if [[ "$default" == "Y" ]]; then
    read -rp "$(echo -e "  ${CYAN}$message${RESET} [Y/n] ")" answer < /dev/tty
    [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
  else
    read -rp "$(echo -e "  ${CYAN}$message${RESET} [y/N] ")" answer < /dev/tty
    [[ "$answer" =~ ^[Yy] ]]
  fi
}

confirm_strict() {
  local message="$1"
  local confirm_word="$2"
  local answer
  echo -e "  ${YELLOW}$message${RESET}"
  read -rp "  Type '$confirm_word' to confirm: " answer < /dev/tty
  [[ "$answer" == "$confirm_word" ]]
}

read_secret() {
  local prompt="$1"
  local __resultvar="$2"
  local value
  read -rsp "$(echo -e "  ${CYAN}$prompt: ${RESET}")" value < /dev/tty
  echo "" # newline after hidden input
  # Strip carriage returns and leading/trailing whitespace (common from browser paste)
  value=$(echo "$value" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  eval "$__resultvar=\$value"
}

read_input() {
  local prompt="$1"
  local default="${2:-}"
  local __resultvar="$3"
  local value

  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "  ${CYAN}$prompt${RESET} ${DIM}[$default]${RESET}: ")" value < /dev/tty
    value="${value:-$default}"
  else
    read -rp "$(echo -e "  ${CYAN}$prompt${RESET}: ")" value < /dev/tty
  fi
  # Strip carriage returns and leading/trailing whitespace (common from browser paste)
  value=$(echo "$value" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  eval "$__resultvar=\$value"
}

# Present a numbered list and return the selected index (0-based)
# Usage: select_from_list "item1|item2|item3" RESULT_VAR
select_from_list() {
  local IFS='|'
  local items=($1)
  local __resultvar="$2"
  local count=${#items[@]}
  local choice

  for i in "${!items[@]}"; do
    echo -e "  ${BOLD}$((i + 1)))${RESET} ${items[$i]}"
  done
  echo ""

  while true; do
    read -rp "$(echo -e "  ${CYAN}Select [1-$count]:${RESET} ")" choice < /dev/tty
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= count )); then
      eval "$__resultvar=$((choice - 1))"
      return 0
    fi
    error "Invalid selection. Enter a number between 1 and $count."
  done
}

check_dependencies() {
  local missing=()

  if ! command -v curl &>/dev/null; then missing+=("curl"); fi
  if ! command -v jq &>/dev/null; then missing+=("jq"); fi
  if ! command -v ssh-keygen &>/dev/null; then missing+=("ssh-keygen (openssh)"); fi
  if ! command -v ssh &>/dev/null; then missing+=("ssh (openssh)"); fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    error "Missing required dependencies: ${missing[*]}"
    echo ""
    info "Install them:"
    if [[ "$(uname)" == "Darwin" ]]; then
      info "  brew install ${missing[*]}"
    else
      info "  sudo apt install ${missing[*]}  (Debian/Ubuntu)"
      info "  sudo dnf install ${missing[*]}  (Fedora)"
    fi
    exit 1
  fi

  # Soft check for gh CLI (used for secret encryption)
  if command -v gh &>/dev/null; then
    HAS_GH=true
  else
    HAS_GH=false
  fi

  success "All dependencies found"
  if [[ "$HAS_GH" == true ]]; then
    info "GitHub CLI detected (will use for secret management)"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Section 3: API Wrappers
# ═══════════════════════════════════════════════════════════════════════════════

# Generic API call with error handling
# Returns: body on stdout, sets API_HTTP_CODE
# Usage: api_call METHOD URL [DATA] [AUTH_HEADER]
api_call() {
  local method="$1"
  local url="$2"
  local data="${3:-}"
  local auth_header="${4:-}"
  local response http_code body

  local curl_args=(-sS -w "\n%{http_code}" -X "$method")
  [[ -n "$auth_header" ]] && curl_args+=(-H "$auth_header")
  curl_args+=(-H "Content-Type: application/json")

  if [[ -n "$data" ]]; then
    curl_args+=(--data "$data")
  fi

  local curl_stderr
  curl_stderr=$(mktemp)
  response=$(curl "${curl_args[@]}" "$url" 2>"$curl_stderr") || {
    local curl_err
    curl_err=$(cat "$curl_stderr")
    rm -f "$curl_stderr"
    error "Network error: could not reach $url${curl_err:+ ($curl_err)}" >&2
    return 1
  }
  rm -f "$curl_stderr"

  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')
  API_HTTP_CODE="$http_code"

  if [[ "$http_code" -ge 400 ]]; then
    if [[ "$http_code" == "429" ]]; then
      warn "Rate limited. Waiting 10s..." >&2
      sleep 10
      api_call "$@" # retry once
      return $?
    fi
    local err_msg
    err_msg=$(echo "$body" | jq -r '.message // .errors[0].message // .error // "Unknown error"' 2>/dev/null || echo "HTTP $http_code")
    error "API error ($http_code): $err_msg" >&2
    return 1
  fi

  echo "$body"
}

cf_api() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  api_call "$method" "${CF_API}${path}" "$data" "Authorization: Bearer $CF_TOKEN"
}

gh_api() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  api_call "$method" "${GH_API}${path}" "$data" "Authorization: token $GITHUB_PAT"
}

# GitHub API with response headers (for scope checking)
gh_api_with_headers() {
  local method="$1"
  local path="$2"
  curl -sS -D - -X "$method" \
    -H "Authorization: token $GITHUB_PAT" \
    -H "Content-Type: application/json" \
    "${GH_API}${path}" 2>/dev/null
}

hostinger_api() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  api_call "$method" "${HOSTINGER_API}${path}" "$data" "Authorization: Bearer $HOSTINGER_TOKEN"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Section 4: Step Functions
# ═══════════════════════════════════════════════════════════════════════════════

# ── Step 1: Domain ──────────────────────────────────────────────────────────

step_1_domain() {
  header 1 "Domain"

  info "You'll need a Cloudflare API token with these permissions:"
  info "  Zone : Zone : Read"
  info "  Zone : DNS  : Edit"
  echo ""
  info "Create one at: ${BOLD}https://dash.cloudflare.com/profile/api-tokens${RESET}"
  echo ""

  # Token entry with inline retry
  while true; do
    read_secret "Cloudflare API token" CF_TOKEN

    if [[ -z "$CF_TOKEN" ]]; then
      error "Token cannot be empty."
      echo ""
      continue
    fi

    # Verify token by trying both user-level and account-level verify endpoints,
    # then fall back to listing zones (which confirms the right permissions anyway)
    info "Verifying token..."
    local verify_result verify_ok=false
    # Try user-level token verify first
    if verify_result=$(cf_api GET "/user/tokens/verify" 2>/dev/null); then
      local status
      status=$(echo "$verify_result" | jq -r '.result.status')
      [[ "$status" == "active" ]] && verify_ok=true
    fi
    # If that failed, try listing zones — this confirms the token works AND has the right permissions
    if [[ "$verify_ok" == "false" ]]; then
      if cf_api GET "/zones?per_page=1" >/dev/null 2>&1; then
        verify_ok=true
      fi
    fi
    if [[ "$verify_ok" == "false" ]]; then
      error "Could not verify token. Check that you pasted the full token and it has the correct permissions."
      echo ""
      if ! confirm "Try another token?" "Y"; then
        return 1
      fi
      echo ""
      continue
    fi

    success "Token verified"
    break
  done

  # List zones
  while true; do
    info "Fetching your domains..."
    local zones_result
    zones_result=$(cf_api GET "/zones?per_page=50") || return 1

    local zone_count
    zone_count=$(echo "$zones_result" | jq '.result | length')

    if [[ "$zone_count" -eq 0 ]]; then
      warn "No domains found on this Cloudflare account."
      info "Register a domain and add it to Cloudflare, then press Enter to refresh."
      info "  https://dash.cloudflare.com/"
      read -rp "" < /dev/tty
      continue
    fi

    echo ""
    local zone_list=""
    for i in $(seq 0 $((zone_count - 1))); do
      local name status_z
      name=$(echo "$zones_result" | jq -r ".result[$i].name")
      status_z=$(echo "$zones_result" | jq -r ".result[$i].status")
      echo -e "  ${BOLD}$((i + 1)))${RESET} $name ${DIM}[$status_z]${RESET}"
    done
    echo -e "  ${BOLD}$((zone_count + 1)))${RESET} ${DIM}I need to register a new domain${RESET}"
    echo ""

    local choice
    read -rp "$(echo -e "  ${CYAN}Select a domain [1-$((zone_count + 1))]:${RESET} ")" choice < /dev/tty

    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= zone_count )); then
      local idx=$((choice - 1))
      DOMAIN=$(echo "$zones_result" | jq -r ".result[$idx].name")
      CF_ZONE_ID=$(echo "$zones_result" | jq -r ".result[$idx].id")
      break
    elif [[ "$choice" == "$((zone_count + 1))" ]]; then
      echo ""
      info "Register a domain and add it to Cloudflare:"
      info "  https://dash.cloudflare.com/"
      echo ""
      info "Press Enter when ready to refresh the list..."
      read -rp "" < /dev/tty
      continue
    else
      error "Invalid selection."
    fi
  done

  # Derive project name from domain
  PROJECT_NAME=$(echo "$DOMAIN" | cut -d. -f1)

  echo ""
  success "Domain: ${BOLD}$DOMAIN${RESET}"
  success "Project name: ${BOLD}$PROJECT_NAME${RESET}"
  echo ""

  confirm "Continue with this domain?" "Y" || return 1
}

# ── Step 2: VPS ─────────────────────────────────────────────────────────────

generate_ssh_key() {
  SSH_KEY_PATH="$HOME/.ssh/gaza-stack-$PROJECT_NAME"
  SSH_KEY_PUB_PATH="${SSH_KEY_PATH}.pub"

  if [[ -f "$SSH_KEY_PATH" ]]; then
    warn "SSH key already exists at $SSH_KEY_PATH"
    if confirm "Use existing key?" "Y"; then
      success "Using existing SSH key"
      return 0
    fi
    mv "$SSH_KEY_PATH" "${SSH_KEY_PATH}.bak.$(date +%s)"
    [[ -f "$SSH_KEY_PUB_PATH" ]] && mv "$SSH_KEY_PUB_PATH" "${SSH_KEY_PUB_PATH}.bak.$(date +%s)"
    info "Existing key backed up"
  fi

  ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "gaza-stack-$PROJECT_NAME" -q
  success "SSH key generated: $SSH_KEY_PATH"
}

register_ssh_key_hostinger() {
  local pub_key
  pub_key=$(cat "$SSH_KEY_PUB_PATH")

  info "Registering SSH key with Hostinger..."
  local result
  result=$(hostinger_api POST "/api/vps/v1/public-keys" \
    "{\"name\":\"gaza-stack-$PROJECT_NAME\",\"key\":$(echo "$pub_key" | jq -Rs .)}") || {
    warn "Could not register SSH key via API. You may need to add it manually in hPanel."
    return 0
  }

  HOSTINGER_KEY_ID=$(echo "$result" | jq -r '.id // .data.id // empty')
  if [[ -n "$HOSTINGER_KEY_ID" ]]; then
    success "SSH key registered (ID: $HOSTINGER_KEY_ID)"
  else
    # Key might already exist, try to find it
    warn "Could not extract key ID from response. Continuing..."
  fi
}

attach_ssh_key_hostinger() {
  if [[ -z "${HOSTINGER_KEY_ID:-}" ]]; then
    return 0
  fi

  info "Attaching SSH key to VPS..."
  hostinger_api POST "/api/vps/v1/public-keys/attach/$VPS_ID" \
    "{\"ids\":[$HOSTINGER_KEY_ID]}" >/dev/null 2>&1 || {
    warn "Could not attach key via API. You may need to attach it manually in hPanel."
  }
  success "SSH key attached to VPS"
}

test_ssh_connection() {
  info "Testing SSH connection to $VPS_IPV4..."
  if ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes \
    -i "$SSH_KEY_PATH" "root@$VPS_IPV4" "echo ok" &>/dev/null; then
    success "SSH connection successful"
    return 0
  else
    warn "SSH connection failed. The server may still be initializing."
    info "You can try manually: ssh -i $SSH_KEY_PATH root@$VPS_IPV4"
    return 0 # non-fatal, server might need more time
  fi
}

wait_for_vps_ready() {
  local max_wait=300
  local interval=10
  local elapsed=0

  echo ""
  info "Waiting for VPS to be ready..."

  while [[ $elapsed -lt $max_wait ]]; do
    local details
    details=$(hostinger_api GET "/api/vps/v1/virtual-machines/$VPS_ID" 2>/dev/null) || true

    local state
    state=$(echo "$details" | jq -r '.state // .data.state // "unknown"' 2>/dev/null)

    if [[ "$state" == "running" ]]; then
      echo ""
      success "VPS is running"
      VPS_IPV4=$(echo "$details" | jq -r '.ip // .data.ip // empty')
      VPS_IPV6=$(echo "$details" | jq -r '.ipv6 // .data.ipv6 // empty')
      return 0
    fi

    printf "\r  ${CYAN}⠋${RESET} VPS status: %-20s (%ds elapsed)" "$state" "$elapsed"
    sleep "$interval"
    ((elapsed += interval))
  done

  echo ""
  error "Timed out waiting for VPS after ${max_wait}s."
  info "Check your Hostinger dashboard: https://hpanel.hostinger.com/"
  return 1
}

step_2_vps() {
  header 2 "VPS"

  info "You'll need a Hostinger API token."
  info "Get one at: ${BOLD}https://hpanel.hostinger.com/api${RESET}"
  echo ""

  read_secret "Hostinger API token" HOSTINGER_TOKEN

  # List existing VPS
  info "Checking existing VPS instances..."
  local vps_list
  vps_list=$(hostinger_api GET "/api/vps/v1/virtual-machines") || {
    error "Could not fetch VPS list. Check your token."
    return 1
  }

  local vps_count
  vps_count=$(echo "$vps_list" | jq 'if type == "array" then length else 0 end')

  echo ""

  if [[ "$vps_count" -gt 0 ]]; then
    info "Found $vps_count existing VPS:"
    echo ""

    for i in $(seq 0 $((vps_count - 1))); do
      local hostname ip state
      hostname=$(echo "$vps_list" | jq -r ".[$i].hostname // \"unnamed\"")
      ip=$(echo "$vps_list" | jq -r ".[$i].ip // \"no IP\"")
      state=$(echo "$vps_list" | jq -r ".[$i].state // \"unknown\"")
      echo -e "  ${BOLD}$((i + 1)))${RESET} $hostname ${DIM}($ip)${RESET} - $state"
    done
    echo -e "  ${BOLD}$((vps_count + 1)))${RESET} ${DIM}Provision a new VPS${RESET}"
    echo ""

    local choice
    read -rp "$(echo -e "  ${CYAN}Select [1-$((vps_count + 1))]:${RESET} ")" choice < /dev/tty

    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= vps_count )); then
      local idx=$((choice - 1))
      VPS_ID=$(echo "$vps_list" | jq -r ".[$idx].id")
      VPS_IPV4=$(echo "$vps_list" | jq -r ".[$idx].ip // empty")
      VPS_IPV6=$(echo "$vps_list" | jq -r ".[$idx].ipv6 // empty")

      success "Using VPS: $VPS_IPV4"
      echo ""

      generate_ssh_key
      register_ssh_key_hostinger
      attach_ssh_key_hostinger
      test_ssh_connection
      return 0
    fi
  fi

  # Provision new VPS
  info "Let's provision a new VPS."
  echo ""

  # Select data center
  info "Fetching data centers..."
  local dc_list
  dc_list=$(hostinger_api GET "/api/vps/v1/data-centers") || return 1

  local dc_count
  dc_count=$(echo "$dc_list" | jq 'if type == "array" then length else 0 end')

  if [[ "$dc_count" -eq 0 ]]; then
    error "No data centers available."
    return 1
  fi

  echo ""
  info "Available data centers:"
  echo ""
  local dc_items=""
  for i in $(seq 0 $((dc_count - 1))); do
    local dc_name dc_location
    dc_name=$(echo "$dc_list" | jq -r ".[$i].name // .[$i].location // \"Region $((i+1))\"")
    dc_location=$(echo "$dc_list" | jq -r ".[$i].city // .[$i].country // \"\"")
    echo -e "  ${BOLD}$((i + 1)))${RESET} $dc_name ${DIM}$dc_location${RESET}"
  done
  echo ""

  local dc_choice
  read -rp "$(echo -e "  ${CYAN}Select data center [1-$dc_count]:${RESET} ")" dc_choice < /dev/tty
  local dc_idx=$((dc_choice - 1))
  local DATA_CENTER_ID
  DATA_CENTER_ID=$(echo "$dc_list" | jq -r ".[$dc_idx].id")
  local dc_display
  dc_display=$(echo "$dc_list" | jq -r ".[$dc_idx].name // .[$dc_idx].location // \"selected\"")
  success "Data center: $dc_display"

  # Select plan from catalog
  info "Fetching VPS plans..."
  local catalog
  catalog=$(hostinger_api GET "/api/billing/v1/catalog") || return 1

  # Filter for VPS items
  local vps_plans
  vps_plans=$(echo "$catalog" | jq '[.[] | select(.category == "vps" or .name == "vps" or (.name // "" | test("vps|VPS")))]' 2>/dev/null)
  local plan_count
  plan_count=$(echo "$vps_plans" | jq 'length' 2>/dev/null || echo "0")

  if [[ "$plan_count" -eq 0 ]]; then
    # Fallback: show all catalog items
    vps_plans="$catalog"
    plan_count=$(echo "$vps_plans" | jq 'if type == "array" then length else 0 end')
  fi

  if [[ "$plan_count" -eq 0 ]]; then
    error "No VPS plans found in catalog."
    return 1
  fi

  echo ""
  info "Available plans:"
  echo ""
  for i in $(seq 0 $((plan_count - 1))); do
    local plan_name plan_price
    plan_name=$(echo "$vps_plans" | jq -r ".[$i].name // \"Plan $((i+1))\"")
    plan_price=$(echo "$vps_plans" | jq -r ".[$i].price // .[$i].prices[0].price // \"?\"")
    # Price is in cents
    if [[ "$plan_price" =~ ^[0-9]+$ ]]; then
      plan_price="\$$(echo "scale=2; $plan_price / 100" | bc 2>/dev/null || echo "$plan_price")"
    fi
    echo -e "  ${BOLD}$((i + 1)))${RESET} $plan_name ${DIM}($plan_price)${RESET}"
  done
  echo ""

  local plan_choice
  read -rp "$(echo -e "  ${CYAN}Select plan [1-$plan_count]:${RESET} ")" plan_choice < /dev/tty
  local plan_idx=$((plan_choice - 1))
  local ITEM_ID
  ITEM_ID=$(echo "$vps_plans" | jq -r ".[$plan_idx].id")
  local plan_display
  plan_display=$(echo "$vps_plans" | jq -r ".[$plan_idx].name // \"selected\"")

  # Payment methods
  info "Fetching payment methods..."
  local payments
  payments=$(hostinger_api GET "/api/billing/v1/payment-methods") || return 1

  local pay_count
  pay_count=$(echo "$payments" | jq 'if type == "array" then length else 0 end')

  local PAYMENT_METHOD_ID=""
  if [[ "$pay_count" -gt 0 ]]; then
    echo ""
    info "Payment methods:"
    echo ""
    for i in $(seq 0 $((pay_count - 1))); do
      local pay_name
      pay_name=$(echo "$payments" | jq -r ".[$i].name // .[$i].identifier // \"Method $((i+1))\"")
      echo -e "  ${BOLD}$((i + 1)))${RESET} $pay_name"
    done
    echo ""

    local pay_choice
    read -rp "$(echo -e "  ${CYAN}Select payment method [1-$pay_count]:${RESET} ")" pay_choice < /dev/tty
    local pay_idx=$((pay_choice - 1))
    PAYMENT_METHOD_ID=$(echo "$payments" | jq -r ".[$pay_idx].id")
  else
    info "No payment methods found. Default will be used."
  fi

  # Find Ubuntu 24.04 template
  info "Finding Ubuntu 24.04 template..."
  local templates
  templates=$(hostinger_api GET "/api/vps/v1/templates") || return 1

  local TEMPLATE_ID
  TEMPLATE_ID=$(echo "$templates" | jq -r '[.[] | select(.name // "" | test("Ubuntu 24.04"; "i"))][0].id // empty' 2>/dev/null)

  if [[ -z "$TEMPLATE_ID" ]]; then
    # Fallback: find any Ubuntu template
    TEMPLATE_ID=$(echo "$templates" | jq -r '[.[] | select(.name // "" | test("Ubuntu"; "i"))][0].id // empty' 2>/dev/null)
  fi

  if [[ -z "$TEMPLATE_ID" ]]; then
    error "Could not find Ubuntu template."
    return 1
  fi
  success "Found Ubuntu template"

  # Generate SSH key before purchase
  generate_ssh_key
  register_ssh_key_hostinger

  # Confirm purchase
  echo ""
  echo -e "  ${YELLOW}════════════════════════════════════════${RESET}"
  echo -e "  ${YELLOW}  This will purchase a VPS:${RESET}"
  echo -e "  ${YELLOW}  Plan:        $plan_display${RESET}"
  echo -e "  ${YELLOW}  Data center: $dc_display${RESET}"
  echo -e "  ${YELLOW}════════════════════════════════════════${RESET}"
  echo ""

  if ! confirm_strict "This will charge your payment method." "purchase"; then
    info "Purchase cancelled."
    return 1
  fi

  # Purchase VPS
  info "Purchasing VPS..."
  local purchase_data="{\"item_id\":\"$ITEM_ID\""
  if [[ -n "$PAYMENT_METHOD_ID" ]]; then
    purchase_data="$purchase_data,\"payment_method_id\":\"$PAYMENT_METHOD_ID\""
  fi
  purchase_data="$purchase_data,\"setup\":{\"template_id\":$TEMPLATE_ID,\"data_center_id\":$DATA_CENTER_ID"
  if [[ -n "${HOSTINGER_KEY_ID:-}" ]]; then
    purchase_data="$purchase_data,\"public_key_id\":$HOSTINGER_KEY_ID"
  fi
  purchase_data="$purchase_data}}"

  local purchase_result
  purchase_result=$(hostinger_api POST "/api/vps/v1/virtual-machines" "$purchase_data") || {
    error "Purchase failed."
    info "Try completing setup at: https://hpanel.hostinger.com/"
    return 1
  }

  VPS_ID=$(echo "$purchase_result" | jq -r '.id // .data.id // empty')
  if [[ -z "$VPS_ID" ]]; then
    error "Could not extract VPS ID from purchase response."
    return 1
  fi

  success "VPS purchased (ID: $VPS_ID)"

  # Wait for VPS to be ready
  wait_for_vps_ready || return 1

  if [[ -z "${VPS_IPV4:-}" ]]; then
    error "Could not determine VPS IP address."
    return 1
  fi

  success "VPS IP: $VPS_IPV4"

  # Attach SSH key if not done during setup
  attach_ssh_key_hostinger

  # Wait a bit for SSH to become available, then test
  info "Waiting for SSH to become available..."
  sleep 15
  test_ssh_connection
}

# ── Step 3: GitHub PAT ──────────────────────────────────────────────────────

step_3_github() {
  header 3 "GitHub"

  info "You'll need a GitHub Personal Access Token."
  echo ""
  info "Required permissions (fine-grained token):"
  info "  Actions, Contents, Pull requests, Secrets, Workflows — Read & Write"
  echo ""
  info "Create one at:"
  info "  ${BOLD}https://github.com/settings/personal-access-tokens/new${RESET}"
  echo ""
  info "Or classic token with scopes: repo, workflow, admin:repo_hook"
  info "  ${BOLD}https://github.com/settings/tokens/new?scopes=repo,workflow,admin:repo_hook${RESET}"
  echo ""

  read_secret "GitHub Personal Access Token" GITHUB_PAT

  info "Verifying token..."

  local response
  response=$(gh_api_with_headers GET "/user")

  local http_code
  http_code=$(echo "$response" | head -1 | awk '{print $2}')

  if [[ "$http_code" != "200" ]]; then
    error "Token verification failed (HTTP $http_code)"
    return 1
  fi

  local body
  body=$(echo "$response" | sed '1,/^\r\{0,1\}$/d')
  GITHUB_USER=$(echo "$body" | jq -r '.login')

  if [[ -z "$GITHUB_USER" || "$GITHUB_USER" == "null" ]]; then
    error "Could not extract GitHub username from response."
    return 1
  fi

  # Check scopes for classic tokens
  if [[ "$GITHUB_PAT" == ghp_* ]]; then
    local scopes
    scopes=$(echo "$response" | grep -i 'X-OAuth-Scopes:' | cut -d: -f2 | tr -d '\r')
    if [[ -n "$scopes" ]]; then
      local has_repo has_workflow
      has_repo=$(echo "$scopes" | grep -c "repo" || true)
      has_workflow=$(echo "$scopes" | grep -c "workflow" || true)

      if [[ "$has_repo" -eq 0 || "$has_workflow" -eq 0 ]]; then
        warn "Token may be missing required scopes."
        warn "Detected: $scopes"
        warn "Required: repo, workflow"
        if ! confirm "Continue anyway?" "N"; then
          return 1
        fi
      fi
    fi
  fi

  echo ""
  success "Authenticated as ${BOLD}@$GITHUB_USER${RESET}"
}

# ── Step 4: AI Keys ─────────────────────────────────────────────────────────

step_4_ai_keys() {
  header 4 "AI Coding Tools (optional)"

  info "These keys enable Claude Code and OpenAI Codex on your dev server."
  info "Press Enter to skip either one."
  echo ""

  info "Get an Anthropic key at: ${BOLD}https://console.anthropic.com/settings/keys${RESET}"
  read_secret "Anthropic API key (Enter to skip)" ANTHROPIC_KEY

  echo ""
  info "Get an OpenAI key at: ${BOLD}https://platform.openai.com/api-keys${RESET}"
  read_secret "OpenAI API key (Enter to skip)" OPENAI_KEY

  echo ""
  if [[ -n "$ANTHROPIC_KEY" ]]; then
    success "Anthropic API key: set"
  else
    info "Anthropic API key: skipped"
  fi
  if [[ -n "$OPENAI_KEY" ]]; then
    success "OpenAI API key: set"
  else
    info "OpenAI API key: skipped"
  fi
}

# ── Step 5: DNS + SSH ───────────────────────────────────────────────────────

create_or_update_dns_record() {
  local record_type="$1"
  local record_name="$2"
  local record_content="$3"

  # Check for existing record
  local existing
  existing=$(cf_api GET "/zones/$CF_ZONE_ID/dns_records?type=$record_type&name=$record_name") || return 1

  local existing_count
  existing_count=$(echo "$existing" | jq '.result | length')

  if [[ "$existing_count" -gt 0 ]]; then
    local existing_content
    existing_content=$(echo "$existing" | jq -r '.result[0].content')
    local existing_id
    existing_id=$(echo "$existing" | jq -r '.result[0].id')

    if [[ "$existing_content" == "$record_content" ]]; then
      success "$record_type $record_name → $record_content (already set)"
      return 0
    fi

    warn "$record_type record for $record_name exists, pointing to $existing_content"
    if ! confirm "Update to $record_content?" "N"; then
      info "Skipping $record_name"
      return 0
    fi

    # Update existing record
    cf_api PUT "/zones/$CF_ZONE_ID/dns_records/$existing_id" \
      "{\"type\":\"$record_type\",\"name\":\"$record_name\",\"content\":\"$record_content\",\"ttl\":1,\"proxied\":false}" >/dev/null || return 1
    success "$record_type $record_name → $record_content (updated)"
    return 0
  fi

  # Create new record
  cf_api POST "/zones/$CF_ZONE_ID/dns_records" \
    "{\"type\":\"$record_type\",\"name\":\"$record_name\",\"content\":\"$record_content\",\"ttl\":1,\"proxied\":false}" >/dev/null || return 1
  success "$record_type $record_name → $record_content (created)"
}

verify_dns_propagation() {
  info "Verifying DNS propagation..."
  local max_attempts=6
  local attempt=1

  while [[ $attempt -le $max_attempts ]]; do
    local dns_result
    dns_result=$(curl -sS "https://cloudflare-dns.com/dns-query?name=$DOMAIN&type=A" \
      -H "Accept: application/dns-json" 2>/dev/null)

    local resolved_ip
    resolved_ip=$(echo "$dns_result" | jq -r '.Answer[0].data // empty' 2>/dev/null)

    if [[ "$resolved_ip" == "$VPS_IPV4" ]]; then
      success "DNS verified: $DOMAIN → $VPS_IPV4"
      return 0
    fi

    if [[ $attempt -lt $max_attempts ]]; then
      info "Attempt $attempt/$max_attempts — waiting 10s for propagation..."
      sleep 10
    fi
    ((attempt++))
  done

  warn "DNS may not have propagated yet. This is normal and can take a few minutes."
  info "You can verify manually: dig $DOMAIN"
  return 0 # non-fatal
}

step_5_dns_ssh() {
  header 5 "DNS & SSH Configuration"

  # DNS
  info "Setting DNS records for $DOMAIN → $VPS_IPV4"
  echo ""

  local record_count=2
  [[ -n "${VPS_IPV6:-}" ]] && record_count=4

  if ! confirm "Create $record_count DNS records (A + wildcard) pointing to $VPS_IPV4?" "Y"; then
    info "Skipping DNS setup."
  else
    create_or_update_dns_record "A" "$DOMAIN" "$VPS_IPV4"
    create_or_update_dns_record "A" "*.$DOMAIN" "$VPS_IPV4"

    if [[ -n "${VPS_IPV6:-}" ]]; then
      create_or_update_dns_record "AAAA" "$DOMAIN" "$VPS_IPV6"
      create_or_update_dns_record "AAAA" "*.$DOMAIN" "$VPS_IPV6"
    fi

    echo ""
    verify_dns_propagation
  fi

  # SSH config
  echo ""
  info "Configuring SSH..."

  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"

  local ssh_config="$HOME/.ssh/config"
  local ssh_entry="# Gaza Stack: $DOMAIN
Host $PROJECT_NAME
  HostName $VPS_IPV4
  User root
  IdentityFile $SSH_KEY_PATH"

  if [[ -f "$ssh_config" ]] && grep -q "Host $PROJECT_NAME" "$ssh_config" 2>/dev/null; then
    warn "SSH config entry for '$PROJECT_NAME' already exists."
    if confirm "Replace it?" "N"; then
      # Remove existing block (from "# Gaza Stack" or "Host $PROJECT_NAME" to next Host/EOF)
      local tmp
      tmp=$(mktemp)
      awk -v host="$PROJECT_NAME" '
        /^# Gaza Stack:/ { skip=1; next }
        /^Host / { if ($2 == host) { skip=1; next } else { skip=0 } }
        !skip { print }
      ' "$ssh_config" > "$tmp"
      mv "$tmp" "$ssh_config"
      echo "" >> "$ssh_config"
      echo "$ssh_entry" >> "$ssh_config"
      success "SSH config updated"
    else
      info "Keeping existing SSH config"
    fi
  else
    if confirm "Add SSH config entry for '$PROJECT_NAME'?" "Y"; then
      [[ -f "$ssh_config" ]] && echo "" >> "$ssh_config"
      echo "$ssh_entry" >> "$ssh_config"
      chmod 600 "$ssh_config"
      success "SSH config added — connect with: ${BOLD}ssh $PROJECT_NAME${RESET}"
    fi
  fi

  echo ""
  test_ssh_connection
}

# ── Step 6: Project Configuration ───────────────────────────────────────────

step_6_project_config() {
  header 6 "Project Configuration"

  info "Fetching your repositories..."
  local repos_response
  repos_response=$(gh_api GET "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member") || return 1

  local repo_count
  repo_count=$(echo "$repos_response" | jq 'length')

  if [[ "$repo_count" -eq 0 ]]; then
    error "No repositories found."
    return 1
  fi

  echo ""
  info "Your repositories:"
  echo ""
  for i in $(seq 0 $((repo_count - 1))); do
    local repo_name repo_desc
    repo_name=$(echo "$repos_response" | jq -r ".[$i].full_name")
    repo_desc=$(echo "$repos_response" | jq -r ".[$i].description // \"\" | .[0:50]")
    if [[ -n "$repo_desc" ]]; then
      echo -e "  ${BOLD}$((i + 1)))${RESET} $repo_name ${DIM}— $repo_desc${RESET}"
    else
      echo -e "  ${BOLD}$((i + 1)))${RESET} $repo_name"
    fi
  done
  echo ""

  info "Enter repo numbers to include (space-separated, e.g. 1 3 5):"
  local selections
  read -rp "  > " selections < /dev/tty

  REPOS_JSON="["
  local first=true

  for sel in $selections; do
    if ! [[ "$sel" =~ ^[0-9]+$ ]] || (( sel < 1 || sel > repo_count )); then
      warn "Skipping invalid selection: $sel"
      continue
    fi

    local idx=$((sel - 1))
    local repo_name repo_full repo_url has_submodules
    repo_name=$(echo "$repos_response" | jq -r ".[$idx].name")
    repo_full=$(echo "$repos_response" | jq -r ".[$idx].full_name")
    repo_url=$(echo "$repos_response" | jq -r ".[$idx].html_url")

    echo ""
    echo -e "  ${BOLD}Configuring: $repo_full${RESET}"

    # Submodules
    has_submodules=false
    if confirm "Does this repo use git submodules?" "N"; then
      has_submodules=true
    fi

    # Services
    local services_json="["
    local first_service=true

    while true; do
      local svc_label svc_path svc_cmd svc_type

      if [[ "$first_service" == true ]]; then
        svc_label="$repo_name"
      else
        read_input "Service label" "" svc_label
      fi

      read_input "Dev command (Enter for auto-detect)" "" svc_cmd
      read_input "Service path" "." svc_path

      echo -e "  Service type: ${BOLD}1)${RESET} Dev server  ${BOLD}2)${RESET} Docker Compose"
      local type_choice
      read -rp "$(echo -e "  ${CYAN}Select [1-2]:${RESET} ")" type_choice < /dev/tty
      if [[ "$type_choice" == "2" ]]; then
        svc_type="docker"
      else
        svc_type="dev"
      fi

      [[ "$first_service" != true ]] && services_json="$services_json,"
      first_service=false

      services_json="$services_json{\"label\":$(echo "$svc_label" | jq -Rs .)"
      services_json="$services_json,\"path\":$(echo "$svc_path" | jq -Rs .)"
      services_json="$services_json,\"devCommand\":$(echo "$svc_cmd" | jq -Rs .)"
      services_json="$services_json,\"type\":\"$svc_type\"}"

      if ! confirm "Add another service in this repo?" "N"; then
        break
      fi
    done

    services_json="$services_json]"

    [[ "$first" != true ]] && REPOS_JSON="$REPOS_JSON,"
    first=false

    REPOS_JSON="$REPOS_JSON{\"name\":$(echo "$repo_name" | jq -Rs .)"
    REPOS_JSON="$REPOS_JSON,\"url\":\"$repo_url\""
    REPOS_JSON="$REPOS_JSON,\"submodules\":$has_submodules"
    REPOS_JSON="$REPOS_JSON,\"services\":$services_json}"
  done

  REPOS_JSON="$REPOS_JSON]"

  # Pretty-print and confirm
  echo ""
  info "Project configuration:"
  echo ""
  echo "$REPOS_JSON" | jq '.' 2>/dev/null || echo "$REPOS_JSON"
  echo ""

  confirm "Does this look correct?" "Y" || return 1
}

# ── Step 7: Fork, Secrets & Deploy ──────────────────────────────────────────

fork_kon() {
  info "Checking for existing fork of catFurr/kon..."

  local forks_result
  forks_result=$(gh_api GET "/repos/catFurr/kon/forks?per_page=100") || return 1

  KON_FORK=$(echo "$forks_result" | jq -r ".[] | select(.owner.login == \"$GITHUB_USER\") | .full_name" | head -1)

  if [[ -n "$KON_FORK" ]]; then
    success "Found existing fork: $KON_FORK"
    return 0
  fi

  if ! confirm "Fork catFurr/kon into your account?" "Y"; then
    error "Cannot continue without a kon fork."
    return 1
  fi

  info "Forking catFurr/kon..."
  local fork_result
  fork_result=$(gh_api POST "/repos/catFurr/kon/forks" "{}") || return 1

  KON_FORK=$(echo "$fork_result" | jq -r '.full_name')
  success "Fork created: $KON_FORK"

  # Wait for fork to be ready
  info "Waiting for fork to be ready..."
  local wait=0
  while [[ $wait -lt 30 ]]; do
    if gh_api GET "/repos/$KON_FORK" &>/dev/null; then
      success "Fork is ready"
      return 0
    fi
    sleep 2
    ((wait += 2))
  done

  warn "Fork may still be initializing. Continuing..."
}

set_github_secret() {
  local repo="$1"
  local name="$2"
  local value="$3"

  if [[ "$HAS_GH" == true ]]; then
    # Use gh CLI — handles encryption internally
    echo "$value" | gh secret set "$name" --repo "$repo" 2>/dev/null
    return $?
  fi

  # Fallback: Python + PyNaCl
  # Get repo public key
  local pk_response
  pk_response=$(gh_api GET "/repos/$repo/actions/secrets/public-key") || return 1

  local public_key key_id
  public_key=$(echo "$pk_response" | jq -r '.key')
  key_id=$(echo "$pk_response" | jq -r '.key_id')

  if [[ -z "$public_key" || "$public_key" == "null" ]]; then
    error "Could not get repository public key."
    return 1
  fi

  # Encode value as base64 for safe transport into Python
  local b64_value
  b64_value=$(echo -n "$value" | base64)

  local encrypted
  encrypted=$(python3 << PYEOF 2>/dev/null
import base64
from nacl import encoding, public

secret_bytes = base64.b64decode("$b64_value")
pk = public.PublicKey("$public_key".encode("utf-8"), encoding.Base64Encoder())
sealed = public.SealedBox(pk).encrypt(secret_bytes)
print(base64.b64encode(sealed).decode("utf-8"))
PYEOF
  ) || {
    error "Encryption failed for secret $name"
    return 1
  }

  # Set via API
  gh_api PUT "/repos/$repo/actions/secrets/$name" \
    "{\"encrypted_value\":\"$encrypted\",\"key_id\":\"$key_id\"}" >/dev/null
}

detect_encryption_method() {
  if [[ "$HAS_GH" == true ]]; then
    return 0
  fi

  if command -v python3 &>/dev/null && python3 -c "import nacl" 2>/dev/null; then
    return 0
  fi

  # Offer to install PyNaCl
  warn "GitHub CLI not found. PyNaCl (Python) is needed for secret encryption."
  if command -v python3 &>/dev/null && command -v pip3 &>/dev/null; then
    if confirm "Install PyNaCl via pip? (pip3 install pynacl)" "Y"; then
      pip3 install --user pynacl --quiet 2>/dev/null
      if python3 -c "import nacl" 2>/dev/null; then
        success "PyNaCl installed"
        return 0
      fi
    fi
  fi

  error "No encryption method available."
  error "Install one of: gh CLI (https://cli.github.com) or PyNaCl (pip3 install pynacl)"
  return 1
}

set_all_secrets() {
  info "Setting GitHub Actions secrets on $KON_FORK..."
  echo ""

  local ssh_key_content
  ssh_key_content=$(cat "$SSH_KEY_PATH")

  local secrets_list=(
    "VPS_SSH_KEY:$ssh_key_content"
    "CLOUDFLARE_API_TOKEN:$CF_TOKEN"
    "KON_GITHUB_TOKEN:$GITHUB_PAT"
  )

  [[ -n "$ANTHROPIC_KEY" ]] && secrets_list+=("ANTHROPIC_API_KEY:$ANTHROPIC_KEY")
  [[ -n "$OPENAI_KEY" ]] && secrets_list+=("OPENAI_API_KEY:$OPENAI_KEY")

  if ! confirm "Set ${#secrets_list[@]} secrets on $KON_FORK?" "Y"; then
    return 1
  fi

  local failed=0
  for entry in "${secrets_list[@]}"; do
    local name="${entry%%:*}"
    local value="${entry#*:}"

    printf "  Setting %-25s" "$name..."
    if set_github_secret "$KON_FORK" "$name" "$value"; then
      echo -e " ${GREEN}done${RESET}"
    else
      echo -e " ${RED}failed${RESET}"
      ((failed++))
    fi
  done

  echo ""
  if [[ $failed -gt 0 ]]; then
    error "$failed secret(s) failed to set."
    info "You can set them manually at: https://github.com/$KON_FORK/settings/secrets/actions"
    return 1
  fi

  success "All secrets configured"
}

commit_stack_json() {
  info "Writing stack.json to $KON_FORK..."

  # Build stack.json content
  local stack_content
  stack_content=$(jq -n \
    --arg domain "$DOMAIN" \
    --arg vps_host "$VPS_IPV4" \
    --arg github_user "$GITHUB_USER" \
    --argjson repos "$REPOS_JSON" \
    '{
      domain: $domain,
      vps_host: $vps_host,
      github_user: $github_user,
      repos_dir: "repos",
      ports_per_session: 10,
      port_range_start: 4000,
      port_range_end: 9000,
      repos: $repos
    }')

  # Base64 encode the content
  local b64_content
  b64_content=$(echo "$stack_content" | base64 | tr -d '\n')

  # Check if file already exists (need SHA for update)
  local existing_sha=""
  local existing
  existing=$(gh_api GET "/repos/$KON_FORK/contents/stack.json" 2>/dev/null) || true
  if [[ -n "$existing" ]]; then
    existing_sha=$(echo "$existing" | jq -r '.sha // empty' 2>/dev/null)
  fi

  # Build request body
  local body="{\"message\":\"Update stack configuration\",\"content\":\"$b64_content\""
  if [[ -n "$existing_sha" ]]; then
    body="$body,\"sha\":\"$existing_sha\""
  fi
  body="$body}"

  gh_api PUT "/repos/$KON_FORK/contents/stack.json" "$body" >/dev/null || {
    error "Failed to write stack.json to $KON_FORK"
    return 1
  }

  success "stack.json committed to $KON_FORK"
}

trigger_provision() {
  # Verify workflow exists
  info "Verifying provision workflow..."
  if ! gh_api GET "/repos/$KON_FORK/contents/.github/workflows/provision.yml" &>/dev/null; then
    error "Provision workflow not found in $KON_FORK"
    info "Your fork may be out of date. Sync it with catFurr/kon."
    return 1
  fi
  success "Provision workflow found"

  echo ""
  if ! confirm "Trigger provision workflow? This configures your VPS (takes ~5 min)." "Y"; then
    info "You can trigger it manually at: https://github.com/$KON_FORK/actions"
    return 0
  fi

  info "Triggering provision workflow..."
  gh_api POST "/repos/$KON_FORK/actions/workflows/provision.yml/dispatches" \
    "{\"ref\":\"main\"}" >/dev/null || {
    error "Failed to trigger workflow."
    return 1
  }

  success "Workflow triggered"

  # Wait for run to appear
  sleep 3

  local run_id
  local runs_result
  runs_result=$(gh_api GET "/repos/$KON_FORK/actions/runs?event=workflow_dispatch&per_page=1") || return 1
  run_id=$(echo "$runs_result" | jq -r '.workflow_runs[0].id // empty')

  if [[ -z "$run_id" ]]; then
    warn "Could not find workflow run. Check manually:"
    info "https://github.com/$KON_FORK/actions"
    return 0
  fi

  info "Run #$run_id — https://github.com/$KON_FORK/actions/runs/$run_id"
  echo ""

  # Poll for completion
  local max_wait=600
  local interval=15
  local elapsed=0

  while [[ $elapsed -lt $max_wait ]]; do
    local run_data
    run_data=$(gh_api GET "/repos/$KON_FORK/actions/runs/$run_id" 2>/dev/null) || true

    local status conclusion
    status=$(echo "$run_data" | jq -r '.status // "unknown"' 2>/dev/null)
    conclusion=$(echo "$run_data" | jq -r '.conclusion // empty' 2>/dev/null)

    if [[ "$status" == "completed" ]]; then
      echo ""
      if [[ "$conclusion" == "success" ]]; then
        success "Provision completed successfully!"
        return 0
      else
        error "Provision failed: $conclusion"
        info "Check logs: https://github.com/$KON_FORK/actions/runs/$run_id"
        return 1
      fi
    fi

    local mins=$((elapsed / 60))
    local secs=$((elapsed % 60))
    printf "\r  ${CYAN}⠋${RESET} %s... (%dm %ds elapsed)" "$status" "$mins" "$secs"

    sleep "$interval"
    ((elapsed += interval))
  done

  echo ""
  warn "Still running after $((max_wait / 60))m. Check GitHub Actions for status:"
  info "https://github.com/$KON_FORK/actions/runs/$run_id"
  return 0
}

step_7_fork_deploy() {
  header 7 "Fork, Secrets & Deploy"

  detect_encryption_method || return 1

  fork_kon || return 1
  echo ""
  commit_stack_json || return 1
  echo ""
  set_all_secrets || return 1
  echo ""
  trigger_provision
}

# ── Step 8: Done ────────────────────────────────────────────────────────────

step_8_done() {
  echo ""
  echo -e "${BOLD}"
  cat << EOF

   ╔═══════════════════════════════════════╗
   ║       Gaza Stack is ready!            ║
   ╚═══════════════════════════════════════╝
EOF
  echo -e "${RESET}"

  echo -e "  Domain:     ${BOLD}$DOMAIN${RESET}"
  echo -e "  Server:     ${BOLD}$VPS_IPV4${RESET}"
  echo -e "  SSH:        ${BOLD}ssh $PROJECT_NAME${RESET}"
  echo -e "  Kon fork:   ${BOLD}$KON_FORK${RESET}"
  echo ""
  echo -e "  ${CYAN}Quick start:${RESET}"
  echo -e "    ssh $PROJECT_NAME"
  echo -e "    kon new my-feature"
  echo -e "    ${DIM}# → my-feature.$DOMAIN${RESET}"
  echo ""
  echo -e "  ${CYAN}All sessions:${RESET}"
  echo -e "    kon list"
  echo ""
  echo -e "  ${DIM}Need help? https://github.com/catFurr/kon${RESET}"
  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# Section 5: Main Orchestration
# ═══════════════════════════════════════════════════════════════════════════════

# State variables (populated by steps)
CF_TOKEN=""
CF_ZONE_ID=""
DOMAIN=""
PROJECT_NAME=""
HOSTINGER_TOKEN=""
HOSTINGER_KEY_ID=""
VPS_ID=""
VPS_IPV4=""
VPS_IPV6=""
SSH_KEY_PATH=""
SSH_KEY_PUB_PATH=""
GITHUB_PAT=""
GITHUB_USER=""
ANTHROPIC_KEY=""
OPENAI_KEY=""
REPOS_JSON=""
KON_FORK=""
HAS_GH=false
API_HTTP_CODE=""

on_error() {
  local line=$1
  echo ""
  error "Something went wrong (line $line)."
  info "If this is unexpected, please report it:"
  info "  https://github.com/catFurr/kon/issues"
  exit 1
}

run_step() {
  local step_func="$1"
  local step_name="$2"

  while true; do
    if "$step_func"; then
      return 0
    fi

    echo ""
    if ! confirm "Retry $step_name?" "Y"; then
      error "Setup cancelled at: $step_name"
      exit 1
    fi
    echo ""
  done
}

main() {
  trap 'on_error $LINENO' ERR

  print_banner
  check_dependencies

  run_step step_1_domain   "Domain"
  run_step step_2_vps      "VPS"
  run_step step_3_github   "GitHub"
  run_step step_4_ai_keys  "AI Keys"
  run_step step_5_dns_ssh  "DNS & SSH"
  run_step step_6_project_config "Project Configuration"
  run_step step_7_fork_deploy    "Fork, Secrets & Deploy"
  step_8_done
}

main "$@"
