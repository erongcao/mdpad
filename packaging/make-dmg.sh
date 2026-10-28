#!/bin/bash
# 不依赖 Finder 自动化的 DMG 打包脚本。
# Tauri 自带的 bundle_dmg.sh 需要「自动化 → Finder」权限，权限没给就会失败。
# 用法：./packaging/make-dmg.sh [universal|aarch64]

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
TARGET="${1:-universal}"

if [ "$TARGET" = "universal" ]; then
  ARCH_DIR="universal-apple-darwin"
  ARCH_LABEL="universal"
else
  ARCH_DIR="release"
  ARCH_LABEL="$(uname -m)"
fi

APP="$ROOT/src-tauri/target/$ARCH_DIR/release/bundle/macos/mdpad.app"
OUT_DIR="$ROOT/release"
OUT="$OUT_DIR/mdpad-0.1.0-$ARCH_LABEL.dmg"
STAGE="$(mktemp -d)"
VOLNAME="mdpad"

[ -d "$APP" ] || { echo "找不到 $APP，先跑 npm run tauri build -- --target $TARGET"; exit 1; }

mkdir -p "$OUT_DIR"
cp -R "$APP" "$STAGE/"
cp "$ROOT/packaging/使用说明.txt" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

# 清掉可能残留的挂载点
for dev in $(hdiutil info | awk '/mdpad/ && /dev\/disk/ {print $1}'); do
  hdiutil detach "$dev" -quiet || true
done

rm -f "$OUT"
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$OUT" -quiet
rm -rf "$STAGE"

echo "已生成：$OUT"
echo "大小：$(du -h "$OUT" | cut -f1)"
