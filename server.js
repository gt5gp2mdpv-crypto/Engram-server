// ノート復習PWA用 Web Push通知サーバー
// Render.com 無料枠などで動作するシンプルなNode.jsサーバー
const express = require("express");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// ── VAPIDキー管理 ──
// 初回起動時に自動生成し .vapid.json に保存。再起動後も同じキーを使う。
const VAPID_FILE = path.join(__dirname, ".vapid.json");
function loadOrCreateVapidKeys() {
  try {
    if (fs.existsSync(VAPID_FILE)) {
      return JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
    }
  } catch (error) {
    console.warn("[VAPID] キーファイルの読み込みに失敗。再生成します:", error.message);
  }
  const generated = webpush.generateVAPIDKeys();
  const keys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey
  };
  try {
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
    console.log("[VAPID] 新しいVAPIDキーを生成して保存しました。");
  } catch (error) {
    console.error("[VAPID] キーファイルの書き込みに失敗:", error.message);
  }
  return keys;
}

const vapidKeys = loadOrCreateVapidKeys();
console.log("[VAPID] 公開鍵(設定画面に入力):");
console.log(vapidKeys.publicKey);

webpush.setVapidDetails(
  "mailto:note-review-pwa@example.com",
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// ── 購読・スケジュール管理（メモリ上） ──
const subscriptions = new Map(); // endpoint -> subscription
const schedules = new Map(); // endpoint -> [{ time, title, body, sent }]

// ── ヘルスチェック（UptimeRobot用） ──
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    subscriptions: subscriptions.size
  });
});

// ── VAPID公開鍵（アプリが購読登録時に取得） ──
app.get("/vapid-public-key", (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// ── 購読登録 ──
app.post("/subscribe", (req, res) => {
  try {
    const { subscription, schedule } = req.body || {};
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: "subscription情報が不正です" });
    }
    subscriptions.set(subscription.endpoint, subscription);
    const normalized = normalizeSchedule(schedule);
    schedules.set(subscription.endpoint, normalized);
    console.log(`[SUBSCRIBE] 端末を購読登録しました (${subscriptions.size}台)`);
    res.json({ ok: true, scheduled: normalized.length });
  } catch (error) {
    console.error("[SUBSCRIBE] エラー:", error);
    res.status(500).json({ error: "サーバーエラー" });
  }
});

// ── スケジュール更新 ──
app.post("/update-schedule", (req, res) => {
  try {
    const { subscription, schedule } = req.body || {};
    if (!subscription?.endpoint) {
      return res.status(400).json({ error: "endpointがありません" });
    }
    if (!subscriptions.has(subscription.endpoint)) {
      return res.status(404).json({ error: "購読登録されていません。/subscribe を先に呼んでください" });
    }
    const normalized = normalizeSchedule(schedule);
    schedules.set(subscription.endpoint, normalized);
    console.log(`[UPDATE] スケジュールを更新 (${normalized.length}件)`);
    res.json({ ok: true, scheduled: normalized.length });
  } catch (error) {
    console.error("[UPDATE] エラー:", error);
    res.status(500).json({ error: "サーバーエラー" });
  }
});

// ── 購読解除 ──
app.post("/unsubscribe", (req, res) => {
  try {
    const { subscription } = req.body || {};
    if (subscription?.endpoint) {
      subscriptions.delete(subscription.endpoint);
      schedules.delete(subscription.endpoint);
      console.log(`[UNSUBSCRIBE] 購読解除 (残り${subscriptions.size}台)`);
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "サーバーエラー" });
  }
});

// ── テスト送信 ──
app.post("/test", (req, res) => {
  try {
    const { subscription, title, body } = req.body || {};
    if (!subscription?.endpoint) {
      return res.status(400).json({ error: "subscription情報がありません" });
    }
    sendPush(subscription, {
      title: title || "ノート復習",
      body: body || "テスト通知です"
    })
      .then(() => res.json({ ok: true }))
      .catch((error) => {
        console.error("[TEST] 送信失敗:", error.message);
        res.status(500).json({ error: "送信に失敗しました: " + error.message });
      });
  } catch (error) {
    console.error("[TEST] エラー:", error);
    res.status(500).json({ error: "サーバーエラー" });
  }
});

// ── スケジュール正規化 ──
function normalizeSchedule(schedule) {
  if (!Array.isArray(schedule)) return [];
  const now = Date.now();
  return schedule
    .filter((item) => item && typeof item.time === "number" && item.time > now - 60000)
    .map((item) => ({
      time: item.time,
      title: String(item.title || "ノート復習"),
      body: String(item.body || "今日の復習を確認しましょう。"),
      url: String(item.url || "./"),
      sent: false
    }))
    .filter((item) => item.time < now + 30 * 24 * 3600 * 1000) // 30日以内のみ
    .sort((a, b) => a.time - b.time);
}

// ── プッシュ送信 ──
async function sendPush(subscription, payload) {
  const data = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url || "./",
    icon: payload.icon || "./icon-192.png",
    badge: payload.badge || "./icon-192.png"
  });
  return webpush.sendNotification(subscription, data);
}

// ── スケジュール監視ループ（30秒ごと） ──
setInterval(() => {
  const now = Date.now();
  for (const [endpoint, schedule] of schedules.entries()) {
    const subscription = subscriptions.get(endpoint);
    if (!subscription) continue;

    schedule
      .filter((item) => !item.sent && item.time <= now)
      .forEach((item) => {
        item.sent = true; // 先にフラグを立てて二重送信を防ぐ
        console.log(`[PUSH] 送信: "${item.title}"`);
        sendPush(subscription, {
          title: item.title,
          body: item.body,
          url: item.url
        }).catch((error) => {
          console.error(`[PUSH] 失敗: ${error.message}`);
          item.sent = false;
          if (error.statusCode === 410) {
            console.warn("[PUSH] 購読が無効なため削除します");
            subscriptions.delete(endpoint);
            schedules.delete(endpoint);
          } else {
            item.time = Date.now() + 5 * 60 * 1000;
          }
        });
      });

    schedules.set(endpoint, schedule.filter((item) => !item.sent && item.time > now - 60000));
  }
}, 30 * 1000);
console.log("[SERVER] スケジュール監視を開始しました（30秒間隔）");

app.listen(PORT, () => {
  console.log(`[SERVER] Web Push通知サーバー起動: port ${PORT}`);
});