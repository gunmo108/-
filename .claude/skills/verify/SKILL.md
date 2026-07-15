---
name: verify
description: くらしの電卓(静的サイト)+ STEEL CHAIN(game/)の起動と実機検証手順
---

# 検証手順

静的サイト。ビルド不要。

## 起動

```bash
python3 -m http.server 8877   # リポジトリルートで
```

## ロジックのテスト(CI相当・検証の代わりにはしない)

```bash
node test/tools.test.js   # assets/tools.js の計算ロジック
node test/smoke.js        # game/ のヘッドレスシミュレーション
```

## ブラウザ実機検証(Playwright)

Playwrightはグローバルにある。`NODE_PATH=/opt/node22/lib/node_modules` を付けて実行し、
chromium は `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'` を明示する
(`/opt/pw-browsers/chromium` はディレクトリ名が違い失敗する)。

代表的なドライブ例: 各 `tools/*.html` を開き、入力欄(`#watts` 等)を fill →
`#calc` をクリック → `#result` のテキストを確認。プリセットチップは `.chip:has-text("...")`。
スマホ表示は viewport 390x844 で確認する。

## 注意

- ゲームページに favicon が無いため `/favicon.ico` への404が1件出るのは既知・無害。
- 傾斜割り勘の結果テーブルは「番号・比率・金額」の3セルなので、textContentを
  連結して読むと数字がつながって見える(例: 比率2+5,000円 → 25,000円に見える)。
