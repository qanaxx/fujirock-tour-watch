# FUJI ROCK Official Tour Watcher

フジロックオフィシャルツアーの指定プランを5分ごとに確認し、予約可能になった場合だけLINE Messaging APIで通知します。

## 監視条件

- 苗場プリンスホテル / 4泊5日
- 苗場・浅貝エリア（民宿） / 4泊5日
- 出発日: 2026-07-23
- 参加人数: 大人2名
- 予約可能判定: 予約APIの `tourItinerary.remainingInventory` が1以上

## セットアップ

```bash
cp .env.example .env
```

`.env` にLINEの設定を入れてください。

```bash
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_TO=...
```

`LINE_TO` が分からない場合、LINE公式アカウントのWebhookで取得する必要があります。個人用で友だち全員に送ってよい場合は、代わりに以下も使えます。

```bash
LINE_BROADCAST=true
```

## 実行

1回だけ確認:

```bash
npm run once
```

5分間隔で常時監視:

```bash
npm start
```

LINE送信テスト:

```bash
npm run test-line
```

## 重複通知

`state/availability-state.json` に前回状態を保存します。同じプランが空き状態のままなら再通知せず、空きなしから空きありに変わった時だけ通知します。

空きがある間ずっと毎回通知したい場合は、以下を設定してください。

```bash
NOTIFY_EVERY_AVAILABLE=true
```
