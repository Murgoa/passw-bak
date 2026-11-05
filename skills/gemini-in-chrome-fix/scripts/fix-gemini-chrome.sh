#!/bin/bash
# 修复 Chrome 内置 Gemini（GLIC）提示"尚未覆盖所有地区"
#
# 实测有效的组合（2026-11-03 于 Chrome 156，对照机 100.121.197.57 可用状态）：
#   1) Local State: variations_permanent_consistency_country = ["<当前版本>", "jp"]
#      —— 不是 variations_country；对照机上它就是 cn 也照样能用
#   2) Preferences: 清掉 glic.profile_enablement / glic.previously_not_allowed，让客户端重新判定
#   3) Preferences: countryid_at_install 改成 17230（对照机取值）
#   4) Surge: Chrome 的 Google 流量必须从受支持地区出去（美国节点/日本家宽）
#
#   5) Chrome 157 起国家过滤挪到了 feature GlicCountryFiltering 后面，必须带
#      --disable-features=GlicCountryFiltering,GlicMinorCountryFiltering 启动，
#      否则 ready_state 恒为 5。日常请用 ~/Applications/Chrome Gemini.app 启动。
#
# 用法: fix-gemini-chrome.sh [jp|us]   默认 jp
set -euo pipefail

COUNTRY="${1:-jp}"
CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome"

VER="$("$CHROME_APP" --version 2>/dev/null | sed -E 's/^Google Chrome //; s/[[:space:]]+$//')"
[ -z "$VER" ] && { echo "✗ 读不到 Chrome 版本号"; exit 1; }

echo "→ 退出 Chrome（版本 ${VER}）"
osascript -e 'quit app "Google Chrome"' 2>/dev/null || true
for _ in $(seq 1 30); do pgrep -x "Google Chrome" >/dev/null || break; sleep 0.5; done
pgrep -x "Google Chrome" >/dev/null && { echo "✗ Chrome 未能退出，请手动 Cmd+Q 后重试"; exit 1; }

STAMP=$(date +%Y%m%d%H%M%S)
cp "$CHROME_DIR/Local State" "$CHROME_DIR/Local State.bak.$STAMP"
for p in "$CHROME_DIR"/Profile*/Preferences; do [ -f "$p" ] && cp "$p" "$p.bak.$STAMP"; done
echo "  备份后缀: .bak.$STAMP"

CHROME_DIR="$CHROME_DIR" COUNTRY="$COUNTRY" VER="$VER" python3 - <<'PY'
import json, os, glob
base, c, ver = os.environ["CHROME_DIR"], os.environ["COUNTRY"], os.environ["VER"]

p = os.path.join(base, "Local State")
d = json.load(open(p))
d["variations_permanent_consistency_country"] = [ver, c]
json.dump(d, open(p, "w"), ensure_ascii=False, separators=(",", ":"))
print(f"   Local State: permanent_consistency_country = [{ver}, {c}]")

for q in sorted(glob.glob(os.path.join(base, "Profile*", "Preferences"))):
    pd = json.load(open(q))
    before = (pd.get("glic", {}).get("profile_enablement") or {}).get("last_ready_state")
    g = pd.get("glic", {})
    g.pop("profile_enablement", None)
    g.pop("previously_not_allowed", None)
    pd["glic"] = g
    pd["countryid_at_install"] = 17230
    json.dump(pd, open(q, "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"   {os.path.basename(os.path.dirname(q))}: glic 状态已清（原 last_ready_state={before}）")
PY

echo "→ 启动 Chrome（带 glic 国家过滤绕过参数）"
open -a "Google Chrome" --args --disable-features=GlicCountryFiltering,GlicMinorCountryFiltering
sleep 20
python3 - <<'PY'
import json, os, glob
base = os.path.expanduser("~/Library/Application Support/Google/Chrome")
l = json.load(open(os.path.join(base, "Local State")))
print("   permanent =", l.get("variations_permanent_consistency_country"),
      "| country =", l.get("variations_country"))
for q in sorted(glob.glob(os.path.join(base, "Profile*", "Preferences"))):
    g = json.load(open(q)).get("glic", {})
    st = (g.get("profile_enablement") or {}).get("last_ready_state")
    print(f"   {os.path.basename(os.path.dirname(q))}: last_ready_state = {st} (2=可用, 5=地区不支持)")
PY
echo "✔ 完成。若仍为 5，检查 Surge 里 Chrome 的 Google 流量是否走美国/日本落地。"
