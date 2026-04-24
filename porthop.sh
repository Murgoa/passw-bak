#!/usr/bin/env bash
set -euo pipefail

DEFAULT_HOP_INTERVAL="30s"
SB_CONF_DIR="/etc/sing-box/conf"
SB_MAIN_JSON="/etc/sing-box/config.json"
NFT_DIR="/etc/nftables.d"
NFT_MAIN="/etc/nftables.conf"
RULE_PREFIX="singbox-porthop"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC} $*" >&2; }

require_root() {
  [ "$(id -u)" -eq 0 ] || { err "请使用 root 运行"; exit 1; }
}

detect_os() {
  if [ -f /etc/alpine-release ]; then
    OS="alpine"
  elif [ -f /etc/os-release ]; then
    . /etc/os-release
    case "${ID:-}" in
      ubuntu) OS="ubuntu" ;;
      debian) OS="debian" ;;
      *)
        if echo "${ID_LIKE:-}" | grep -qi debian; then
          OS="debian"
        else
          err "暂不支持的系统: ${ID:-unknown}"
          exit 1
        fi
      ;;
    esac
  else
    err "无法识别系统"
    exit 1
  fi
  ok "系统: $OS"
}

install_deps() {
  case "$OS" in
    alpine)
      apk update
      apk add --no-cache jq nftables curl
      rc-update add nftables boot >/dev/null 2>&1 || true
      rc-service nftables start || true
      ;;
    debian|ubuntu)
      apt-get update -y
      DEBIAN_FRONTEND=noninteractive apt-get install -y jq nftables curl
      systemctl enable nftables >/dev/null 2>&1 || true
      systemctl start nftables || true
      ;;
  esac
  ok "依赖安装完成"
}

choose_action() {
  echo "请选择操作："
  echo "  1) install   安装端口跳跃"
  echo "  2) uninstall 卸载端口跳跃"
  echo "  3) list      查看当前规则"
  read -rp "输入选项 [1-3]: " action_choice
  case "$action_choice" in
    1) ACTION="install" ;;
    2) ACTION="uninstall" ;;
    3) ACTION="list" ;;
    *) err "无效选项"; exit 1 ;;
  esac
  ok "操作: $ACTION"
}

choose_protocol() {
  echo "请选择协议："
  echo "  1) hysteria2"
  echo "  2) tuic"
  read -rp "输入选项 [1-2]: " choice
  case "$choice" in
    1) PROTOCOL="hysteria2" ;;
    2) PROTOCOL="tuic" ;;
    *) err "无效选项"; exit 1 ;;
  esac
  ok "协议: $PROTOCOL"
}

backup_file() {
  local f="$1"
  [ -f "$f" ] && cp -a "$f" "${f}.bak.$(date +%Y%m%d%H%M%S)"
}

find_inbound_files() {
  FILES=()

  if [ -d "$SB_CONF_DIR" ]; then
    while IFS= read -r -d '' file; do
      FILES+=("$file")
    done < <(find "$SB_CONF_DIR" -maxdepth 1 -type f -name '*.json' -print0 | sort -z)
  fi

  if [ "${#FILES[@]}" -eq 0 ] && [ -f "$SB_MAIN_JSON" ]; then
    FILES+=("$SB_MAIN_JSON")
  fi

  [ "${#FILES[@]}" -gt 0 ] || {
    err "未找到 sing-box 配置文件，已检查: $SB_CONF_DIR/*.json 和 $SB_MAIN_JSON"
    exit 1
  }
}

extract_port_from_filename() {
  local f="$1"
  local base
  base="$(basename "$f")"
  echo "$base" | grep -oE '[0-9]+' | tail -n1 || true
}

scan_inbounds() {
  MATCHED_LINES=()
  INDEX=0

  for f in "${FILES[@]}"; do
    if ! jq empty "$f" >/dev/null 2>&1; then
      continue
    fi

    local_type="$(jq -r '.type // empty' "$f" 2>/dev/null || true)"
    local_tag="$(jq -r '.tag // empty' "$f" 2>/dev/null || true)"
    local_listen="$(jq -r '.listen // "::"' "$f" 2>/dev/null || true)"
    local_port="$(jq -r '.listen_port // empty' "$f" 2>/dev/null || true)"

    if [ -z "$local_port" ] || [ "$local_port" = "null" ]; then
      local_port="$(extract_port_from_filename "$f")"
    fi

    if [ "$local_type" = "$PROTOCOL" ] && echo "$local_port" | grep -Eq '^[0-9]+$'; then
      INDEX=$((INDEX + 1))
      MATCHED_LINES+=("${INDEX}|${f}|${local_type}|${local_tag}|${local_listen}|${local_port}")
    fi

    inbound_count="$(jq '.inbounds | length' "$f" 2>/dev/null || echo 0)"
    if echo "$inbound_count" | grep -Eq '^[0-9]+$' && [ "$inbound_count" -gt 0 ]; then
      while IFS='|' read -r i_tag i_type i_listen i_port; do
        if [ -z "$i_port" ] || [ "$i_port" = "null" ]; then
          i_port="$(extract_port_from_filename "$f")"
        fi
        if [ "$i_type" = "$PROTOCOL" ] && echo "$i_port" | grep -Eq '^[0-9]+$'; then
          INDEX=$((INDEX + 1))
          MATCHED_LINES+=("${INDEX}|${f}|${i_type}|${i_tag}|${i_listen}|${i_port}")
        fi
      done < <(
        jq -r '.inbounds[]? | [(.tag // ""), (.type // ""), (.listen // "::"), (.listen_port // "")] | @tsv' "$f" \
        | awk -F '\t' '{print $1 "|" $2 "|" $3 "|" $4}'
      )
    fi
  done

  if [ "${#MATCHED_LINES[@]}" -eq 0 ]; then
    err "没有找到 type=${PROTOCOL} 的 sing-box 入站"
    exit 1
  fi
}

choose_inbound() {
  echo
  echo "检测到以下 ${PROTOCOL} 入站："
  for line in "${MATCHED_LINES[@]}"; do
    IFS='|' read -r idx f t tag listen port <<< "$line"
    echo "  [$idx] 文件: $f"
    echo "      tag: ${tag:-<无>}"
    echo "      listen: ${listen:-::}"
    echo "      port: $port"
  done
  echo

  if [ "${#MATCHED_LINES[@]}" -eq 1 ]; then
    selected="${MATCHED_LINES[0]}"
    ok "仅检测到一个入站，已自动选中"
  else
    read -rp "请输入要对接的序号: " pick
    selected=""
    for line in "${MATCHED_LINES[@]}"; do
      IFS='|' read -r idx _ <<< "$line"
      if [ "$idx" = "$pick" ]; then
        selected="$line"
        break
      fi
    done
    [ -n "$selected" ] || { err "序号无效"; exit 1; }
  fi

  IFS='|' read -r SEL_IDX SEL_FILE SEL_TYPE SEL_TAG SEL_LISTEN BASE_PORT <<< "$selected"

  ok "已选择文件: $SEL_FILE"
  ok "入站类型: $SEL_TYPE"
  ok "入站标签: ${SEL_TAG:-<无>}"
  ok "监听地址: ${SEL_LISTEN:-::}"
  ok "监听端口: $BASE_PORT"
}

input_jump_range() {
  read -rp "请输入端口跳跃起始端口（如 20000）: " RANGE_START
  read -rp "请输入端口跳跃结束端口（如 40000）: " RANGE_END

  [[ "$RANGE_START" =~ ^[0-9]+$ ]] || { err "起始端口必须为数字"; exit 1; }
  [[ "$RANGE_END" =~ ^[0-9]+$ ]] || { err "结束端口必须为数字"; exit 1; }

  (( RANGE_START >= 1 && RANGE_START <= 65535 )) || { err "起始端口非法"; exit 1; }
  (( RANGE_END >= 1 && RANGE_END <= 65535 )) || { err "结束端口非法"; exit 1; }
  (( RANGE_START <= RANGE_END )) || { err "起始端口不能大于结束端口"; exit 1; }

  if (( BASE_PORT >= RANGE_START && BASE_PORT <= RANGE_END )); then
    warn "真实监听端口位于跳跃范围内，建议避开"
  fi

  ok "跳跃范围: ${RANGE_START}-${RANGE_END}"
}

input_hop_interval() {
  read -rp "请输入跳跃频率（默认 ${DEFAULT_HOP_INTERVAL}，如 10s / 30s / 1m）: " HOP_INTERVAL
  HOP_INTERVAL="${HOP_INTERVAL:-$DEFAULT_HOP_INTERVAL}"
  echo "$HOP_INTERVAL" | grep -Eq '^[0-9]+(s|m|h)$' || {
    err "跳跃频率格式非法"
    exit 1
  }
  ok "跳跃频率: $HOP_INTERVAL"
}

input_iface() {
  DEFAULT_IFACE="$(ip route get 1.1.1.1 2>/dev/null | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
  DEFAULT_IFACE="${DEFAULT_IFACE:-eth0}"
  read -rp "请输入入站网卡名（默认 ${DEFAULT_IFACE}）: " IFACE
  IFACE="${IFACE:-$DEFAULT_IFACE}"
  ok "入站网卡: $IFACE"
}

ensure_nft_include() {
  mkdir -p "$NFT_DIR"

  if [ ! -f "$NFT_MAIN" ]; then
    cat > "$NFT_MAIN" <<'EOF'
#!/usr/sbin/nft -f
flush ruleset
include "/etc/nftables.d/*.nft"
EOF
    ok "已创建 $NFT_MAIN"
    return
  fi

  if ! grep -q '/etc/nftables.d/\*.nft' "$NFT_MAIN"; then
    backup_file "$NFT_MAIN"
    printf '\ninclude "/etc/nftables.d/*.nft"\n' >> "$NFT_MAIN"
    ok "已写入 include 到 $NFT_MAIN"
  fi
}

get_rule_file() {
  echo "${NFT_DIR}/${RULE_PREFIX}-${PROTOCOL}-${BASE_PORT}.nft"
}

get_table_name() {
  echo "${RULE_PREFIX}_${PROTOCOL}_${BASE_PORT}"
}

apply_rule_file_only() {
  local rule_file="$1"
  nft -f "$rule_file"
}

reload_nft_main() {
  nft -f "$NFT_MAIN"
}

write_nft_rule() {
  ensure_nft_include

  RULE_FILE="$(get_rule_file)"
  TABLE_NAME="$(get_table_name)"

  cat > "$RULE_FILE" <<EOF
table inet ${TABLE_NAME} {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    iifname "${IFACE}" udp dport ${RANGE_START}-${RANGE_END} counter redirect to :${BASE_PORT}
  }
}
EOF

  apply_rule_file_only "$RULE_FILE"
  ok "已写入并加载 nftables 规则: $RULE_FILE"
}

uninstall_rule() {
  RULE_FILE="$(get_rule_file)"
  TABLE_NAME="$(get_table_name)"

  if nft list table inet "$TABLE_NAME" >/dev/null 2>&1; then
    nft delete table inet "$TABLE_NAME" || true
    ok "已删除内存中的 nftables table: $TABLE_NAME"
  else
    warn "内存中未发现 table: $TABLE_NAME"
  fi

  if [ -f "$RULE_FILE" ]; then
    rm -f "$RULE_FILE"
    ok "已删除规则文件: $RULE_FILE"
  else
    warn "规则文件不存在: $RULE_FILE"
  fi
}

list_rules() {
  echo
  echo "当前 ${NFT_DIR} 下的端口跳跃规则："
  found=0
  if [ -d "$NFT_DIR" ]; then
    while IFS= read -r -d '' file; do
      found=1
      echo "----------------------------------------"
      echo "文件: $file"
      sed 's/^/  /' "$file"
    done < <(find "$NFT_DIR" -maxdepth 1 -type f -name "${RULE_PREFIX}-*.nft" -print0 | sort -z)
  fi

  if [ "$found" -eq 0 ]; then
    echo "  未找到任何 ${RULE_PREFIX} 规则"
  fi

  echo
  echo "内存中的相关 nftables tables："
  nft list tables 2>/dev/null | grep "$RULE_PREFIX" || true
  echo
}

restart_singbox() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart sing-box 2>/dev/null || true
  else
    rc-service sing-box restart 2>/dev/null || true
  fi
  ok "已尝试重启 sing-box"
}

show_install_result() {
  SERVER_IP="$(curl -4 -s --max-time 5 https://api.ipify.org || true)"
  SERVER_IP="${SERVER_IP:-your_server_ip}"

  echo
  echo "================ 安装完成 ================"
  echo "配置文件: $SEL_FILE"
  echo "协议: $PROTOCOL"
  echo "真实监听端口: $BASE_PORT"
  echo "跳跃范围: ${RANGE_START}-${RANGE_END}"
  echo "跳跃频率: $HOP_INTERVAL"
  echo "规则文件: $(get_rule_file)"
  echo

  if [ "$PROTOCOL" = "hysteria2" ]; then
    cat <<EOF
客户端可参考：
  ${SERVER_IP}:${BASE_PORT},${RANGE_START}-${RANGE_END}

如果客户端是 sing-box，可设置：
  "hop_interval": "${HOP_INTERVAL}"
EOF
  else
    cat <<EOF
TUIC 已将跳跃范围转发到主端口：
  ${SERVER_IP}:${BASE_PORT}

如客户端支持多端口写法，可尝试：
  ${SERVER_IP}:${BASE_PORT},${RANGE_START}-${RANGE_END}
EOF
  fi
  echo "========================================="
}

show_uninstall_result() {
  echo
  echo "================ 卸载完成 ================"
  echo "协议: $PROTOCOL"
  echo "主端口: $BASE_PORT"
  echo "规则文件已删除，内存规则已清理"
  echo "========================================="
}

main_install() {
  choose_protocol
  find_inbound_files
  scan_inbounds
  choose_inbound
  input_jump_range
  input_hop_interval
  input_iface
  write_nft_rule
  restart_singbox
  show_install_result
}

main_uninstall() {
  choose_protocol
  find_inbound_files
  scan_inbounds
  choose_inbound
  uninstall_rule
  show_uninstall_result
}

main() {
  require_root
  detect_os
  install_deps
  choose_action

  case "$ACTION" in
    install) main_install ;;
    uninstall) main_uninstall ;;
    list) list_rules ;;
  esac

  ok "完成"
}

main "$@"
