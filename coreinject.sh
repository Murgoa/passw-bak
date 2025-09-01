#!/bin/bash

# 定义目标目录
DOWNLOADS_DIR="$HOME/Downloads"
COREINJECT_DIR="$DOWNLOADS_DIR/CoreInject"
STARTUP_SCRIPT="$COREINJECT_DIR/秋城落叶_启动.command"

# 0. 先获取 sudo 权限并缓存
echo "需要管理员权限来继续执行..."
sudo -v
if [ $? -ne 0 ]; 键，然后
    echo "获取 sudo 权限失败，请检查密码是否正确"
    exit 1
fi

# 1. 删除 ~/Downloads/CoreInject 目录（如果存在）
if [ -d "$COREINJECT_DIR" ]; then
    echo "正在删除 $COREINJECT_DIR ..."
    rm -rf "$COREINJECT_DIR"
    if [ $? -eq 0 ]; then
        echo "删除成功"
    else
        echo "删除失败，请检查权限或路径"
        exit 1
    fi
else
    echo "$COREINJECT_DIR 不存在，跳过删除"
fi

# 2. 切换到 ~/Downloads 目录
echo "切换到 $DOWNLOADS_DIR ..."
cd "$DOWNLOADS_DIR" || { echo "无法切换到 $DOWNLOADS_DIR，请检查路径"; exit 1; }

# 3. 克隆 Git 仓库 (depth=1)
echo "正在克隆 CoreInject 仓库..."
git clone --depth=1 https://git.sr.ht/~qiuchenly/CoreInject
if [ $? -eq 0 ]; then
    echo "仓库克隆成功"
else
    echo "克隆失败，请检查网络或 Git 配置"
    exit 1
fi

# 4. 检查并启动 秋城落叶_启动.command
if [ -f "$STARTUP_SCRIPT" ]; then
    echo "启动秋城落叶_启动.command ..."
    chmod +x "$STARTUP_SCRIPT"
    bash "$STARTUP_SCRIPT"
    if [ $? -eq 0 ]; then
        echo "启动脚本成功"
    else
        echo "启动脚本失败，请检查 $STARTUP_SCRIPT"
        exit 1
    fi
else
    echo "未找到 $STARTUP_SCRIPT，请检查文件名或路径"
    exit 1
fi
