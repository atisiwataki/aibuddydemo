#!/bin/bash
# ============================================================
# 本番リリース：aibuddydemo(main) の内容を aibuddy(prod) に反映する
#   - demo-data.js（ダミーデータ）と index.html の読み込み行(data-demo)を除外
#   - prod/main の上に「release: <デモ版コミット>」として1コミット積んでpush
# 使い方: bash release.sh        （実行前に git push でデモ版を最新にしておく）
#         bash release.sh --dry  （pushせず、本番に入る差分だけ確認）
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
DRY="${1:-}"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "⚠️  未コミットの変更があります。コミットしてから実行してください。"; exit 1
fi

SRC=$(git rev-parse --short HEAD)
git fetch -q prod
TMP=$(mktemp -d)
trap 'git worktree remove --force "$TMP" >/dev/null 2>&1 || true' EXIT

git worktree add -q --detach "$TMP" prod/main
# 本番の中身を main の内容で丸ごと置き換え（.git以外）
find "$TMP" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive HEAD | tar -x -C "$TMP"

# デモ専用ファイルを除外
rm -f "$TMP/demo-data.js" "$TMP/github-setup.sh" "$TMP/release.sh"
sed -i '' '/data-demo/d' "$TMP/index.html"
if grep -q "DEMO_DATA\s*=" -r "$TMP" --include='*.js' --include='*.html'; then
  echo "⚠️  ダミーデータが残っています。中止します。"; exit 1
fi

cd "$TMP"
git add -A
if git diff --cached --quiet; then
  echo "本番は既に最新です（変更なし）"; exit 0
fi
git --no-pager diff --cached --stat
if [ "$DRY" = "--dry" ]; then
  echo "（--dry のため push しません）"; exit 0
fi
git commit -q -m "release: aibuddydemo ${SRC} を本番反映（ダミーデータ除外）"
git push -q prod HEAD:main
echo "✅ 本番に反映しました → https://atisiwataki.github.io/aibuddy/"
