---
name: gemini-in-chrome-fix
description: 修复 Chrome 内置 Gemini（GLIC）提示「无法使用 Chrome 中的 Gemini / 正在向更多地区开放，但尚未覆盖所有地区」。当 Chrome 侧边栏 Gemini 报地区不支持、或 Chrome 升级后该功能突然失效时使用。适用于 macOS，Chrome 150+。
---

# Gemini in Chrome 地区限制修复

## 何时使用

- Chrome 侧边栏 Gemini 显示「无法使用 Chrome 中的 Gemini」「正在向更多地区开放，但尚未覆盖所有地区」
- Chrome 大版本升级后，原本可用的 Gemini 侧边栏突然失效
- 网页版 `gemini.google.com` 正常，只有浏览器内置的 Gemini 不可用

## 判断依据（先诊断，别乱改）

Chrome 把地区准入结果缓存在两个地方，先读这两个值：

```bash
# 1) 客户端判定结果：2 = 可用，5 = 地区不支持
python3 -c "
import json,os,glob
base=os.path.expanduser('~/Library/Application Support/Google/Chrome')
for q in sorted(glob.glob(base+'/Profile*/Preferences')):
    p=json.load(open(q)); g=p.get('glic',{})
    print(os.path.basename(os.path.dirname(q)),
          '| ready_state =',(g.get('profile_enablement') or {}).get('last_ready_state'),
          '| not_allowed =',g.get('previously_not_allowed'))
"

# 2) 国家来源（Chrome 157 起这条已不再是决定因素，仅作参考）
python3 -c "
import json,os
d=json.load(open(os.path.expanduser('~/Library/Application Support/Google/Chrome/Local State')))
for k in ('variations_country','variations_permanent_consistency_country','variations_safe_seed_session_consistency_country'):
    print(k,'=',d.get(k))
"
```

`ready_state = 5` + `not_allowed = true` 即为地区拦截。

## 关键结论（2026-11 实测）

| 版本 | 有效手段 |
|---|---|
| 156 及以前 | 改 `Local State` 的 `variations_permanent_consistency_country` 为 `["<当前版本>","jp"]`，清 glic 缓存 |
| **157+** | 上面那套**失效**。必须带 `--disable-features=GlicCountryFiltering,GlicMinorCountryFiltering` 启动 |

157 的源码里把国家过滤移到了 feature 后面，从 Chrome Framework 二进制可验证这三个开关名：

```
GlicCountryFiltering
GlicMinorCountryFiltering
GlicUseSessionCountryForFiltering
```

验证命令：

```bash
LC_ALL=C grep -a -o -E "Glic[A-Za-z]{0,20}Filter[A-Za-z]{0,25}" \
  "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/Current/Google Chrome Framework" | sort -u
```

**不需要改代理/Surge 配置**：实测与出口节点无关，关掉这两个 feature 后即使走国内网络也正常。

## 修复步骤

### 1. 建一个带参数的启动器

```bash
mkdir -p ~/Applications/"Chrome Gemini.app"/Contents/MacOS ~/Applications/"Chrome Gemini.app"/Contents/Resources

cat > ~/Applications/"Chrome Gemini.app"/Contents/MacOS/ChromeGemini <<'SH'
#!/bin/bash
FLAGS=(--disable-features=GlicCountryFiltering,GlicMinorCountryFiltering)
if pgrep -x "Google Chrome" >/dev/null; then
  open -a "Google Chrome"
else
  open -a "Google Chrome" --args "${FLAGS[@]}"
fi
SH
chmod +x ~/Applications/"Chrome Gemini.app"/Contents/MacOS/ChromeGemini

cp "/Applications/Google Chrome.app/Contents/Resources/app.icns" ~/Applications/"Chrome Gemini.app"/Contents/Resources/ 2>/dev/null || true

cat > ~/Applications/"Chrome Gemini.app"/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Chrome Gemini</string>
  <key>CFBundleDisplayName</key><string>Chrome Gemini</string>
  <key>CFBundleIdentifier</key><string>ai.murgo.chromegemini</string>
  <key>CFBundleExecutable</key><string>ChromeGemini</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><false/>
</dict>
</plist>
PLIST
```

### 2. 冷启动必须走启动器

```bash
osascript -e 'quit app "Google Chrome"'; sleep 5
open ~/Applications/"Chrome Gemini.app"
```

**关键限制**：flag 只在冷启动生效。Chrome 已运行时点原版图标只是激活窗口（没问题）；但完全退出后点原版图标冷启动，flag 会丢，功能又变回不可用。所以建议把 `Chrome Gemini.app` 放到 Dock。

### 3. 验证

```bash
# 应大于 0
ps -Ao args= | grep -c "GlicCountryFiltering"

# ready_state 应为 2 / not_allowed 应为 false
python3 -c "
import json,os,glob
base=os.path.expanduser('~/Library/Application Support/Google/Chrome')
for q in sorted(glob.glob(base+'/Profile*/Preferences')):
    p=json.load(open(q)); g=p.get('glic',{})
    print(os.path.basename(os.path.dirname(q)),
          '| ready_state =',(g.get('profile_enablement') or {}).get('last_ready_state'),
          '| not_allowed =',g.get('previously_not_allowed'))
"
```

`ready_state` 有可能是上一轮的缓存值（仍显示 5），以 `not_allowed = false` 和实际打开侧边栏是否正常为准。

## 加 Dock（可选）

```bash
python3 - <<'EOF'
import plistlib, os
p=os.path.expanduser("~/Library/Preferences/com.apple.dock.plist")
d=plistlib.load(open(p,"rb")); apps=d.get("persistent-apps",[])
url="file:///Users/%s/Applications/Chrome%%20Gemini.app/" % os.getlogin()
if not any(url in str(a) for a in apps):
    apps.append({"GUID":0,"tile-data":{"file-data":{"_CFURLString":url,"_CFURLStringType":15},
                 "file-label":"Chrome Gemini"},"tile-type":"file-tile"})
    d["persistent-apps"]=apps; plistlib.dump(d,open(p,"wb"))
EOF
killall Dock
```

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 冷启动后又不可用 | 点了原版 Chrome 图标 | 用 `Chrome Gemini.app` 冷启动 |
| `ps` 里 flag 进程数 = 0 | 同上 | 同上 |
| 带 flag 仍不可用 | Chrome 又改了 feature 名 | 重新从 Framework 二进制 grep `Glic.*Filter.*`，替换 flag |
| 改 Local State 没用 | 157+ 已不看该字段 | 直接用 flag 方案，别再折腾 Local State |

## 注意

- 不要为此修改代理 / Surge 配置，实测无关。
- 备份习惯：动 `~/Library/Application Support/Google/Chrome/Local State` 和 `Profile*/Preferences` 前先 `cp` 一份。
