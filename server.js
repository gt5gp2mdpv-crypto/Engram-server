// ノート復習PWA用 Web Push通知サーバー
// Render.com 無料枠などで動作するシンプルなNode.jsサーバー
const express = require("express");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ── CORS設定 ──
// アプリ（GitHub Pages等）からサーバーへアクセスできるようにする
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

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

// ── 購読・スケジュール管理（永続化付き） ──
// Renderの無料プランはスリープ・再起動時にメモリが消えるため、
// 購読・スケジュールをローカルファイルに保存して復元する。
const DATA_FILE = path.join(__dirname, "data.json");
const subscriptions = new Map(); // endpoint -> subscription
const schedules = new Map(); // endpoint -> [{ time, title, body, url, sent }]

// ── 永続化 ──
let saveTimer = null;
function persistData() {
  // 短時間に多重書き込みされるのを防ぐためデバウンスする
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const payload = {
        subscriptions: Object.fromEntries(subscriptions),
        schedules: Object.fromEntries(
          [...schedules.entries()].map(([endpoint, list]) => [
            endpoint,
            // 送信済みで削除対象になったものは除外して保存
            list.filter((item) => !item.sent || item.time > Date.now() - 60000)
          ])
        )
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
      console.log("[DATA] 状態をファイルに保存しました");
    } catch (error) {
      console.error("[DATA] 保存に失敗:", error.message);
    }
  }, 1000);
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (data.subscriptions) {
      Object.entries(data.subscriptions).forEach(([endpoint, sub]) => {
        if (sub && sub.endpoint) subscriptions.set(endpoint, sub);
      });
    }
    if (data.schedules) {
      Object.entries(data.schedules).forEach(([endpoint, list]) => {
        if (Array.isArray(list)) {
          schedules.set(
            endpoint,
            list.filter((item) => item && typeof item.time === "number")
          );
        }
      });
    }
    console.log(`[DATA] 保存済み状態を復元しました (購読${subscriptions.size}件, スケジュール${schedules.size}件)`);
  } catch (error) {
    console.error("[DATA] 読み込みに失敗:", error.message);
  }
}

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
    persistData();
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
    persistData();
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
      persistData();
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
      title: title || "Engram",
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
      title: String(item.title || "Engram"),
      body: String(item.body || "今日の復習を確認しましょう。"),
      url: String(item.url || "./"),
      sent: false
    }))
    .filter((item) => item.time < now + 35 * 24 * 3600 * 1000) // 35日以内のみ（アプリ側は30日先まで生成するため余裕を持たせる）
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
// 送信を非同期に並行処理すると、送信失敗時の「5分後の再送」が
// スケジュールから漏れて消えてしまう競合バグがあったため、
// 各スケジュールの送信完了を await した上でフィルタする。
async function processSchedule() {
  const now = Date.now();
  for (const [endpoint, schedule] of schedules.entries()) {
    const subscription = subscriptions.get(endpoint);
    if (!subscription) continue;

    const due = schedule.filter((item) => !item.sent && item.time <= now);
    for (const item of due) {
      item.sent = true; // 先にフラグを立てて二重送信を防ぐ
      console.log(`[PUSH] 送信: "${item.title}" (${new Date(item.time).toISOString()})`);
      try {
        await sendPush(subscription, {
          title: item.title,
          body: item.body,
          url: item.url
        });
      } catch (error) {
        console.error(`[PUSH] 失敗: ${error.message}`);
        item.sent = false;
        if (error.statusCode === 410) {
          console.warn("[PUSH] 購読が無効なため削除します");
          subscriptions.delete(endpoint);
          schedules.delete(endpoint);
          persistData();
        } else {
          // 失敗時は5分後に再試行する
          item.time = Date.now() + 5 * 60 * 1000;
        }
      }
    }

    // 送信完了後に、未送信の未来分だけを残して上書き
    const remaining = schedule.filter((item) => !item.sent && item.time > now - 60000);
    // schedules経由で永続化
    if (remaining.length !== schedule.length) {
      schedules.set(endpoint, remaining);
      persistData();
    }
  }
}

// 30秒ごとにチェック
setInterval(checkSchedule, 30 * 1000);
console.log("[SERVER] スケジュール監視を開始しました（30秒間隔）");

// サーバー稼働中でも並行しないようにチェックを直列化
let checking = false;
async function checkSchedule() {
  if (checking) return;
  checking = true;
  try {
    await processSchedule();
  } catch (error) {
    console.error("[SERVER] スケジュールチェックエラー:", error.message);
  } finally {
    checking = false;
  }
}

// ── 起動時キャッチアップ ──
// スリープから復帰した直後・再起動直後に、すでに時刻を過ぎた未送信分を
// まとめて送信する。これで「アプリを開いていない間に届くべき通知」を回収する。
async function flushMissedSchedule() {
  console.log("[DATA] 起動時キャッチアップを実行します…");
  await checkSchedule();
  console.log("[DATA] 起動時キャッチアップ完了");
}

// 起動して永続化データを復元（app.listen の前に実行）
loadData();

// 起動して負荷が落ち着いた頃に一度キャッチアップ実行
setTimeout(flushMissedSchedule, 2000);

// 終了時に未保存の状態を書き込んでからプロセスを終了する（RenderのSIGTERM対応）
function flushDataSync() {
  try {
    const payload = {
      subscriptions: Object.fromEntries(subscriptions),
      schedules: Object.fromEntries(
        [...schedules.entries()].map(([endpoint, list]) => [
          endpoint,
          list.filter((item) => !item.sent || item.time > Date.now() - 60000)
        ])
      )
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
    console.log("[DATA] 終了フラッシュ完了");
  } catch (error) {
    console.error("[DATA] 終了フラッシュ失敗:", error.message);
  }
}
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[SERVER] ${sig}を受信。状態を保存して終了します。`);
    flushDataSync();
    process.exit(0);
  });
}

app.listen(PORT, () => {
  console.log(`[SERVER] Web Push通知サーバー起動: port ${PORT}`);
});