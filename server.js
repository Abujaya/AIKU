import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const APP_AUTH_TOKEN = process.env.APP_AUTH_TOKEN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const BROKER_BASE_URL = (process.env.BROKER_BASE_URL || "").replace(/\/$/, "");
const BROKER_API_KEY = process.env.BROKER_API_KEY || "";
const BROKER_API_SECRET = process.env.BROKER_API_SECRET || "";
const MAX_ORDER_NOTIONAL_USD = Number(process.env.MAX_ORDER_NOTIONAL_USD || 50);
const DAILY_MAX_LOSS_USD = Number(process.env.DAILY_MAX_LOSS_USD || 50);
const LIVE_EXECUTION_ENABLED = process.env.LIVE_EXECUTION_ENABLED === "true";

let realizedPnlTodayUsd = 0;

function signBrokerRequest(payload) {
  return crypto.createHmac("sha256", BROKER_API_SECRET).update(payload).digest("hex");
}

async function askGeminiCoAnalyst(signalPayload) {
  if (!GEMINI_API_KEY) {
    return {
      supportsSignal: true,
      note: "Gemini tidak dikonfigurasi; memakai aturan deterministik server."
    };
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: `Kamu adalah co-analyst risiko trading (bukan pengambil keputusan tunggal). Evaluasi sinyal berikut dan balas JSON valid {"supportsSignal": boolean, "note": string}: ${JSON.stringify(signalPayload)}`
          }]
        }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      })
    });

    if (!res.ok) {
      return {
        supportsSignal: true,
        note: `Gemini HTTP ${res.status}; fallback aturan server.`
      };
    }

    const json = await res.json();
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(raw);
    return {
      supportsSignal: Boolean(parsed.supportsSignal ?? true),
      note: String(parsed.note || "Evaluasi co-analyst selesai.")
    };
  } catch {
    return {
      supportsSignal: true,
      note: "Fallback aturan deterministik server."
    };
  }
}

async function sendTradeOnlyOrderToBroker(order) {
  if (!LIVE_EXECUTION_ENABLED || !BROKER_BASE_URL || !BROKER_API_KEY || !BROKER_API_SECRET) {
    return {
      mode: "PAPER_SERVER",
      orderId: `paper_${Date.now()}`,
      status: "SIMULATED_ON_SERVER"
    };
  }

  const timestamp = Date.now().toString();
  const bodyStr = JSON.stringify({
    symbol: order.symbol,
    side: order.side,
    type: "MARKET",
    quoteOrderQty: order.orderSizeUsd
  });
  const signature = signBrokerRequest(`POST/api/v1/order${timestamp}${bodyStr}`);
  const res = await fetch(`${BROKER_BASE_URL}/api/v1/order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": BROKER_API_KEY,
      "X-TIMESTAMP": timestamp,
      "X-SIGNATURE": signature
    },
    body: bodyStr
  });

  if (!res.ok) {
    throw new Error(`Broker menolak order (HTTP ${res.status})`);
  }

  return await res.json();
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (APP_AUTH_TOKEN) {
    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${APP_AUTH_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: Token aplikasi tidak cocok." }));
      return;
    }
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ONLINE",
      liveExecutionEnabled: LIVE_EXECUTION_ENABLED,
      realizedPnlTodayUsd,
      maxOrderNotionalUsd: MAX_ORDER_NOTIONAL_USD,
      dailyMaxLossUsd: DAILY_MAX_LOSS_USD
    }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/signal") {
    let rawBody = "";
    req.on("data", chunk => { rawBody += chunk; });
    req.on("end", async () => {
      try {
        const body = JSON.parse(rawBody || "{}");
        const orderSizeUsd = Number(body.orderSizeUsd || 0);
        if (orderSizeUsd <= 0 || orderSizeUsd > MAX_ORDER_NOTIONAL_USD) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            executed: false,
            reason: `Ukuran order ($${orderSizeUsd}) melampaui batas server ($${MAX_ORDER_NOTIONAL_USD}).`
          }));
          return;
        }

        if (realizedPnlTodayUsd <= -Math.abs(DAILY_MAX_LOSS_USD)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ executed: false, reason: "Batas rugi harian tercapai." }));
          return;
        }

        const coAnalyst = await askGeminiCoAnalyst(body);
        if (!coAnalyst.supportsSignal) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            executed: false,
            reason: `Ditahan oleh Gemini Co-Analyst: ${coAnalyst.note}`
          }));
          return;
        }

        const brokerResult = await sendTradeOnlyOrderToBroker({
          symbol: String(body.symbol || "BTC/USDT"),
          side: body.side === "SELL" ? "SELL" : "BUY",
          orderSizeUsd
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          executed: true,
          coAnalystNote: coAnalyst.note,
          brokerResult
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ executed: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Endpoint tidak ditemukan" }));
});

server.listen(PORT, () => {
  console.log(`AIKU Live Trading Server berjalan di port ${PORT} (LIVE=${LIVE_EXECUTION_ENABLED})`);
});
