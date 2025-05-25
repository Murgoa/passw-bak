#!/bin/sh

# anytls 安装/卸载管理脚本 (Alpine 兼容版)
# 功能：安装 anytls 或彻底卸载（含 systemd/openrc 服务清理）
# 支持架构：amd64 (x86_64)、arm64 (aarch64)、armv7 (armv7l)
# 适用于 Alpine Linux，依赖 apk, wget, curl, unzip, openrc

# 检查 root 权限
if [ "$(id -u)" -ne 0 ]; then
    echo "必须使用 root 或 sudo 运行！"
    exit 1
fi

# 安装必要工具：wget, curl, unzip
install_dependencies() {
    echo "[初始化] 正在安装必要依赖（wget, curl, unzip）..."
    apk update >/dev/null 2>&1
    for dep in wget curl unzip; do
        if ! command -v $dep >/dev/null 2>&1; then
            echo "正在安装 $dep..."
            apk add --no-cache $dep || {
                echo "无法安装依赖: $dep，请手动运行 'apk add $dep' 后再继续。"
                exit 1
            }
        fi
    done
}

install_dependencies

# 自动检测系统架构
ARCH=$(uname -m)
case $ARCH in
    x86_64)  BINARY_ARCH="amd64" ;;
    aarch64) BINARY_ARCH="arm64" ;;
    armv7l|armv7)  BINARY_ARCH="armv7" ;;
    *)       echo "不支持的架构: $ARCH"; exit 1 ;;
esac

# 配置参数
DOWNLOAD_URL="https://github.com/anytls/anytls-go/releases/download/v0.0.8/anytls_0.0.8_linux_${BINARY_ARCH}.zip"
ZIP_FILE="/tmp/anytls_0.0.8_linux_${BINARY_ARCH}.zip"
BINARY_DIR="/usr/local/bin"
BINARY_NAME="anytls-server"
SERVICE_NAME="anytls"

# IP获取函数
get_ip() {
    local ip=""
    ip=$(ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}' | cut -d'/' -f1 | head -n1)
    [ -z "$ip" ] && ip=$(ifconfig 2>/dev/null | grep -oE 'inet ([0-9]{1,3}\.){3}[0-9]{1,3}' | grep -v '127.0.0.1' | awk '{print $2}' | head -n1)
    [ -z "$ip" ] && ip=$(curl -4 -s --connect-timeout 3 ifconfig.me 2>/dev/null || curl -4 -s --connect-timeout 3 icanhazip.com 2>/dev/null)
    if [ -z "$ip" ]; then
        echo "未能自动获取IP，请手动输入服务器IP地址"
        printf "请输入服务器IP地址: "
        read ip
    fi
    echo "$ip"
}

show_menu() {
    clear
    echo "-------------------------------------"
    echo " anytls 服务管理脚本 (Alpine/${BINARY_ARCH}) "
    echo "-------------------------------------"
    echo "1. 安装 anytls"
    echo "2. 卸载 anytls"
    echo "0. 退出"
    echo "-------------------------------------"
    printf "请输入选项 [0-2]: "
    read choice
    case $choice in
        1) install_anytls ;;
        2) uninstall_anytls ;;
        0) exit 0 ;;
        *) echo "无效选项！"; sleep 1; show_menu ;;
    esac
}

install_anytls() {
    # 下载
    echo "[1/5] 下载 anytls (${BINARY_ARCH}架构)..."
    wget "$DOWNLOAD_URL" -O "$ZIP_FILE" || {
        echo "下载失败！可能原因："
        echo "1. 网络连接问题"
        echo "2. 该架构的二进制文件不存在"
        exit 1
    }

    # 解压
    echo "[2/5] 解压文件..."
    unzip -o "$ZIP_FILE" -d "$BINARY_DIR" || {
        echo "解压失败！文件可能损坏"
        exit 1
    }
    chmod +x "$BINARY_DIR/$BINARY_NAME"

    # 输入密码
    printf "设置 anytls 的密码: "
    read PASSWORD
    [ -z "$PASSWORD" ] && {
        echo "错误：密码不能为空！"
        exit 1
    }

    # 配置 OpenRC 服务脚本
    echo "[3/5] 配置 openrc 服务..."
    cat > /etc/init.d/$SERVICE_NAME <<EOF
#!/sbin/openrc-run

description="anytls Service"
command="${BINARY_DIR}/${BINARY_NAME}"
command_args="-l 0.0.0.0:30602 -p $PASSWORD"
command_background="yes"
pidfile="/var/run/${SERVICE_NAME}.pid"
EOF

    chmod +x /etc/init.d/$SERVICE_NAME

    # 启动服务
    echo "[4/5] 启动服务..."
    rc-update add $SERVICE_NAME default
    rc-service $SERVICE_NAME restart

    # 清理
    rm -f "$ZIP_FILE"

    # 获取服务器IP
    SERVER_IP=$(get_ip)

    # 验证
    echo -e "\n\033[32m√ 安装完成！\033[0m"
    echo -e "\033[32m√ 架构类型: ${BINARY_ARCH}\033[0m"
    echo -e "\033[32m√ 服务名称: $SERVICE_NAME\033[0m"
    echo -e "\033[32m√ 监听端口: 0.0.0.0:30602\033[0m"
    echo -e "\033[32m√ 密码已设置为: $PASSWORD\033[0m"
    echo -e "\n\033[33m管理命令:\033[0m"
    echo -e "  启动: rc-service $SERVICE_NAME start"
    echo -e "  停止: rc-service $SERVICE_NAME stop"
    echo -e "  重启: rc-service $SERVICE_NAME restart"
    echo -e "  状态: rc-service $SERVICE_NAME status"

    # 高亮显示连接信息
    echo -e "\n\033[36m\033[1m〓 NekoBox连接信息 〓\033[0m"
    echo -e "\033[30;43m\033[1m anytls://$PASSWORD@$SERVER_IP:30602/?insecure=1 \033[0m"
    echo -e "\033[33m\033[1m请妥善保管此连接信息！\033[0m"
}

uninstall_anytls() {
    echo "正在卸载 anytls..."

    # 停止服务
    if rc-service $SERVICE_NAME status | grep -q started; then
        rc-service $SERVICE_NAME stop
        echo "[1/4] 已停止服务"
    fi

    # 移除服务
    if rc-update show | grep -q $SERVICE_NAME; then
        rc-update del $SERVICE_NAME default
        echo "[2/4] 已移除自启"
    fi

    # 删除二进制
    if [ -f "$BINARY_DIR/$BINARY_NAME" ]; then
        rm -f "$BINARY_DIR/$BINARY_NAME"
        echo "[3/4] 已删除二进制文件"
    fi

    # 删除 openrc 脚本
    if [ -f "/etc/init.d/$SERVICE_NAME" ]; then
        rm -f "/etc/init.d/$SERVICE_NAME"
        echo "[4/4] 已删除 openrc 服务脚本"
    fi

    echo -e "\n\033[32m[结果]\033[0m anytls 已完全卸载！"
}

show_menu