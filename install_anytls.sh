#!/bin/bash

# anytls 安装/卸载管理脚本
# 功能：安装 anytls 或彻底卸载（含 systemd 服务清理）
# 支持架构：amd64 (x86_64)、arm64 (aarch64)、armv7 (armv7l)

# 检查 root 权限
if [ "$(id -u)" -ne 0 ]; then
    echo "必须使用 root 或 sudo 运行！"
    exit 1
fi

# 安装必要工具：wget, curl, unzip
function install_dependencies() {
    echo "[初始化] 正在安装必要依赖（wget, curl, unzip）..."
    apt update -y >/dev/null 2>&1

    for dep in wget curl unzip; do
        if ! command -v $dep &>/dev/null; then
            echo "正在安装 $dep..."
            apt install -y $dep || {
                echo "无法安装依赖: $dep，请手动运行 'sudo apt install $dep' 后再继续。"
                exit 1
            }
        fi
    done
}

# 调用依赖安装函数
install_dependencies

# 自动检测系统架构
ARCH=$(uname -m)
case $ARCH in
    x86_64)  BINARY_ARCH="amd64" ;;
    aarch64) BINARY_ARCH="arm64" ;;
    armv7l)  BINARY_ARCH="armv7" ;;
    *)       echo "不支持的架构: $ARCH"; exit 1 ;;
esac

# 配置参数（注意这里去掉了 linux_ 后面多余的空格）
DOWNLOAD_URL="https://github.com/anytls/anytls-go/releases/download/v0.0.8/anytls_0.0.8_linux_${BINARY_ARCH}.zip"
ZIP_FILE="/tmp/anytls_0.0.8_linux_${BINARY_ARCH}.zip"
BINARY_DIR="/usr/local/bin"
BINARY_NAME="anytls-server"
SERVICE_NAME="anytls"

# 改进的IP获取函数
get_ip() {
    local ip=""
    ip=$(ip -o -4 addr show scope global | awk '{print $4}' | cut -d'/' -f1 | head -n1)
    [ -z "$ip" ] && ip=$(ifconfig 2>/dev/null | grep -oP 'inet \K[\d.]+' | grep -v '127.0.0.1' | head -n1)
    [ -z "$ip" ] && ip=$(curl -4 -s --connect-timeout 3 ifconfig.me 2>/dev/null || curl -4 -s --connect-timeout 3 icanhazip.com 2>/dev/null)
    
    if [ -z "$ip" ]; then
        echo "未能自动获取IP，请手动输入服务器IP地址"
        read -p "请输入服务器IP地址: " ip
    fi
    
    echo "$ip"
}

# 显示菜单
function show_menu() {
    clear
    echo "-------------------------------------"
    echo " anytls 服务管理脚本 (${BINARY_ARCH}架构) "
    echo "-------------------------------------"
    echo "1. 安装 anytls"
    echo "2. 卸载 anytls"
    echo "0. 退出"
    echo "-------------------------------------"
    read -p "请输入选项 [0-2]: " choice
    case $choice in
        1) install_anytls ;;
        2) uninstall_anytls ;;
        0) exit 0 ;;
        *) echo "无效选项！" && sleep 1 && show_menu ;;
    esac
}

# 安装功能
function install_anytls() {
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
    read -p "设置 anytls 的密码: " PASSWORD
    [ -z "$PASSWORD" ] && {
        echo "错误：密码不能为空！"
        exit 1
    }

    # 配置服务
    echo "[3/5] 配置 systemd 服务..."
    cat > /etc/systemd/system/$SERVICE_NAME.service <<EOF
[Unit]
Description=anytls Service
After=network.target

[Service]
ExecStart=$BINARY_DIR/$BINARY_NAME -l 0.0.0.0:30602 -p $PASSWORD
Restart=always
User=root
Group=root

[Install]
WantedBy=multi-user.target
EOF

    # 启动服务
    echo "[4/5] 启动服务..."
    systemctl daemon-reload
    systemctl enable $SERVICE_NAME
    systemctl start $SERVICE_NAME

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
    echo -e "  启动: systemctl start $SERVICE_NAME"
    echo -e "  停止: systemctl stop $SERVICE_NAME"
    echo -e "  重启: systemctl restart $SERVICE_NAME"
    echo -e "  状态: systemctl status $SERVICE_NAME"
    
    # 高亮显示连接信息
    echo -e "\n\033[36m\033[1m〓 NekoBox连接信息 〓\033[0m"
    echo -e "\033[30;43m\033[1m anytls://$PASSWORD@$SERVER_IP:30602/?insecure=1 \033[0m"
    echo -e "\033[33m\033[1m请妥善保管此连接信息！\033[0m"
}

# 卸载功能
function uninstall_anytls() {
    echo "正在卸载 anytls..."
    
    # 停止服务
    if systemctl is-active --quiet $SERVICE_NAME; then
        systemctl stop $SERVICE_NAME
        echo "[1/4] 已停止服务"
    fi

    # 禁用服务
    if systemctl is-enabled --quiet $SERVICE_NAME; then
        systemctl disable $SERVICE_NAME
        echo "[2/4] 已禁用开机启动"
    fi

    # 删除文件
    if [ -f "$BINARY_DIR/$BINARY_NAME" ]; then
        rm -f "$BINARY_DIR/$BINARY_NAME"
        echo "[3/4] 已删除二进制文件"
    fi

    # 清理配置
    if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
        rm -f "/etc/systemd/system/$SERVICE_NAME.service"
        systemctl daemon-reload
        echo "[4/4] 已移除服务配置"
    fi

    echo -e "\n\033[32m[结果]\033[0m anytls 已完全卸载！"
}

# 启动菜单
show_menu
