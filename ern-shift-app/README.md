# eRN Rounds — 遠隔ICU eRN 勤務管理アプリ

遠隔ICU の eRN が、多拠点・1シフト最大30患者を「二検出器レース（eRN vs 現場）」の
役割分担として管理し、1シフト内で複数回ラウンドしながら介入を記録し、蓄積データから
proactive 選定の精度を経時的に上げるための iPad 向け PWA。

要件定義は [`docs/requirements.md`](docs/requirements.md) を参照。

## 重要な設計前提: ラウンド間隔は可変

ラウンドは固定スケジュール（例: 3時間おき）を持たない。

- eRN が **任意のタイミング**で「ラウンド N を開始」し、任意のタイミングで終了する。
- アプリは各ラウンドの**実測開始・終了時刻**と、**前ラウンドからの実測間隔**を記録・表示する。
- シフト作成時の「ラウンド回数」は既定値（目安）であり、確認の上で**追加ラウンドも開始できる**（回数も可変）。
- 記録された可変間隔はシフトサマリに表示され、エクスポートデータ（Round の started_at）から解析できる。

## 主な機能（MVP）

- **シフト管理**: 日付・拠点（KRC/SMM 複数選択）・既定ラウンド回数を設定。終了後は読み取り専用スナップショット。
- **Roster**: 1行1患者。race 層トグル（proactive/reactive）、シフト内 EWS 軌跡（スパークライン＋ラウンド間差分矢印）、感染フラグ、確認状態。リスク順（最新EWS＋悪化幅＋感染フラグ）自動ソート、ピン留め。
- **ラウンドモード**: 前回値プリフィル。reactive は「変化なし」1タップで carry-forward 確定。proactive は必ず開いて更新（blanket 確定不可）。進捗 12/30 表示。終了時に全患者へ PatientRound を生成。
- **感染治療状況**: 感染源・起因菌・培養・抗菌薬（DOT 自動計算）・de-escalation・device-days（CVC/尿カテ/人工呼吸、開始日から自動加算）。device-days / DOT / de-escalation due の3トリガーを roster に自動点灯（閾値は設定で変更可）。
- **介入クイックログ**: 数タップで trigger source（eRN発/現場発/アラート発/device起因）・category・領域・outcome（介入要/空振り）を記録。現ラウンドに自動紐付け。
- **race フリップ記録**: reactive→proactive 切替時に、選定時点の患者特徴（EWS、device-days、DOT、鎮静、拠点、時間帯）と選定理由タグを自動スナップショット。
- **シフト終了サマリ**: 総介入数、proactive 的中率（フリップと outcome の突合）、取り逃し（現場発×非proactive）、各種内訳、実測ラウンド間隔。
- **蓄積ダッシュボード**: 複数シフト横断の precision 推移、条件別 precision（拠点/時間帯/鎮静/理由タグ）、eRN 先着率、フィードバック提示、CSV/JSON エクスポート。

## 技術

- 素の HTML/CSS/JS（ES modules）。ビルド不要。
- **オフラインファースト**: IndexedDB に全データを端末内保存（クラウド同期なし・PII なし＝匿名化ID のみ）。Service Worker でフルオフライン動作。
- iPad Safari / PWA（ホーム画面追加）対応。Scribble はテキスト入力欄でそのまま利用可能。
- ライト/ダークテーマ両対応。

## 実行

静的ホスティングに `ern-shift-app/` を配置するだけ。ローカル確認は:

```sh
cd ern-shift-app
python3 -m http.server 8000
# → http://localhost:8000 を iPad / ブラウザで開く
```

（Service Worker を使うため `file://` ではなく HTTP 経由で開くこと。本番は HTTPS 必須。）

## テスト

```sh
cd ern-shift-app
node --test test/logic.test.mjs
```

リスクスコア、感染トリガー判定、DOT/device-days 計算、可変ラウンド間隔、
シフトサマリ（precision・取り逃し）などの純粋ロジックを検証する。

## データ構造

`js/logic.js` / `js/db.js` を参照。ストア: `shifts` / `rounds` / `patients` /
`patient_rounds` / `infections` / `interventions` / `raceflips` / `settings`。
EWS と race 層は Patient ではなく PatientRound が持つ（ラウンド時系列）。
Round は `started_at` / `ended_at` の実測時刻を持ち、間隔は固定しない。
