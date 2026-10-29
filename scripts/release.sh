#!/bin/bash
# 用法: scripts/release.sh <version> [发布说明...]
# 例如: scripts/release.sh 1.2.0 "修复了若干问题"
# 需要: ~/.tauri/mdpad.key（updater 签名私钥，丢失则更新链断裂）
set -euo pipefail

VERSION="${1:?用法: scripts/release.sh <version> [notes]}"
NOTES="${2:-}"
cd "$(dirname "$0")/.."

KEY_FILE="$HOME/.tauri/mdpad.key"
[ -f "$KEY_FILE" ] || { echo "缺少签名私钥 $KEY_FILE"; exit 1; }

# 打包前先清掉残留挂载（disk5 busy 坑）
hdiutil info | grep -q "mdpad" && { echo "检测到残留 dmg 挂载，先弹出"; hdiutil detach "$(hdiutil info | awk '/mdpad/{print $1}' | head -1)" || true; }

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

echo "== 构建 v$VERSION（带 updater 签名）=="
npm run tauri build

BUNDLE="src-tauri/target/release/bundle"
DMG="$BUNDLE/dmg/mdpad_${VERSION}_aarch64.dmg"
TGZ="$BUNDLE/macos/mdpad.app.tar.gz"
SIG="$TGZ.sig"
for f in "$DMG" "$TGZ" "$SIG"; do [ -f "$f" ] || { echo "缺少产物: $f"; exit 1; }; done

echo "== 生成 latest.json =="
SIGNATURE="$(cat "$SIG")"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
URL="https://github.com/erongcao/mdpad/releases/download/v${VERSION}/mdpad.app.tar.gz"
jq -n --arg v "v$VERSION" --arg n "$NOTES" --arg d "$PUB_DATE" --arg s "$SIGNATURE" --arg u "$URL" \
  '{version: $v, notes: $n, pub_date: $d, platforms: {"darwin-aarch64": {signature: $s, url: $u}}}' \
  > "$BUNDLE/latest.json"

echo "== 发布 v$VERSION =="
gh release create "v$VERSION" --title "mdpad v$VERSION" --notes "$NOTES" \
  "$DMG" "$TGZ" "$BUNDLE/latest.json"

echo "完成: https://github.com/erongcao/mdpad/releases/tag/v$VERSION"
