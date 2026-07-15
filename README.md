# くらしの電卓 — 毎日使える無料計算ツール集

家計や日常の「これっていくら?」「どっちが得?」を3秒で解決する、
静的サイトの計算ツール集。**依存ライブラリゼロ・ビルド不要・GitHub Pagesで無料公開可能。**

広告(AdSense)+アフィリエイトによる少額収益化を目的として設計。
公開後の手順・運用は **[ROADMAP.md](ROADMAP.md)** を参照。

## 収録ツール

| ツール | ページ | 想定シーン |
|---|---|---|
| ⚡ 電気代計算 | `tools/denkidai.html` | 「エアコンつけっぱなしで月いくら?」 |
| 🛒 単価比較 | `tools/tanka.html` | 「300g398円と500g598円どっちが得?」 |
| 🏷️ 割引計算 | `tools/waribiki.html` | 「30%オフでいくら?還元とどっちが得?」 |
| 🍻 割り勘計算 | `tools/warikan.html` | 「4人で13,470円、キリよく集めたい」 |
| 📅 日数計算 | `tools/hidzuke.html` | 「100日後は何月何日?あと何日?」 |
| 💰 積立シミュレーター | `tools/tsumitate.html` | 「月3万を20年積み立てたらいくら?」 |

ほか、おまけコンテンツとしてブラウザゲーム『STEEL CHAIN』を `game/` に収録
(詳細は [game/README.md](game/README.md))。

## 構成

```
index.html          トップ(ツール一覧)
assets/site.css     共通スタイル(スマホファースト)
assets/tools.js     全計算ロジック(純関数・Node/ブラウザ両対応)
tools/*.html        各ツールページ(ツールUI+解説記事+FAQ+構造化データ)
about.html          サイト概要(AdSense審査用)
privacy.html        プライバシーポリシー(AdSense審査用)
contact.html        お問い合わせ(Googleフォーム埋め込み待ち)
sitemap.xml         サイトマップ(Search Console送信用)
game/               ミニゲーム『STEEL CHAIN』
test/               テスト
ROADMAP.md          公開・収益化の手順書
```

## 開発

```bash
# ローカル起動
python3 -m http.server 8000   # → http://localhost:8000

# テスト
node test/tools.test.js   # 計算ロジック(69アサーション)
node test/smoke.js        # ゲームのスモークテスト
```

- 広告コードは `.ad-slot`、アフィリエイトは `<!-- affiliate-slot -->` の位置に貼る設計。
- GA4は各HTMLの `<head>` のコメントを外して測定IDを記入。
- 新ツール追加の手順: `assets/tools.js` に純関数を追加 → `test/tools.test.js` にテスト追加 →
  `tools/` にページ作成 → `index.html` と `sitemap.xml` にリンク追加。
