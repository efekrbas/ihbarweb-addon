// İhbarWeb Gönderi Bildirici - Background Service Worker
// Copyright (c) 2026 Efe Kırbaş. All rights reserved. Proprietary software.

// ============================================================
// CAPTCHA ÇÖZÜCÜ (Gemini)
// ============================================================
const CAPTCHA_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-flash-latest"];
const MODEL_TIMEOUT = 12000;
const MAX_CAPTCHA_IMAGE_BYTES = 1024 * 1024;
const MAX_ANALYSIS_TEXT_LENGTH = 8000;
const MAX_ANALYSIS_DESCRIPTION_LENGTH = 16000;
const ANALYSIS_MODEL = "gemini-2.0-flash";
const analysisRequestsByTab = new Map();
const storageAccessReady = Promise.resolve()
  .then(() => chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }))
  .catch(() => {});

const CAPTCHA_PROMPT =
  "Bu görsel bir güvenlik captcha'sı. Görseldeki 6 karakteri oku. " +
  "Karakterler küçük harf ve rakamdır. Sadece 6 karakteri yaz: " +
  "boşluk yok, açıklama yok, tırnak yok.";

async function getGeminiKey() {
  try {
    await storageAccessReady;
    const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
    const key = typeof geminiApiKey === "string" ? geminiApiKey.trim() : "";
    return /^AIza[0-9A-Za-z_-]{25,}$/.test(key) ? key : null;
  } catch (_) {
    return null;
  }
}

function extractCode(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join(" ");
  if (!text.trim()) return null;

  for (const token of text.split(/[^a-zA-Z0-9]+/)) {
    if (token.length === 6) return token;
  }

  const flat = text.replace(/[^a-z0-9]/gi, "");
  if (flat.length >= 6) return flat.slice(0, 6);
  return null;
}

async function callGemini(model, key, body) {
  const ctl = new AbortController();
  const zamanlayici = setTimeout(() => ctl.abort(), MODEL_TIMEOUT);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify(body),
        signal: ctl.signal
      }
    );

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch (_) { /* yanıt metni isteğe bağlı */ }
      return { ok: false, error: `http_${res.status}`, detail };
    }

    try {
      return { ok: true, json: await res.json() };
    } catch (_) {
      return { ok: false, error: "bad_json" };
    }
  } catch (e) {
    return {
      ok: false,
      error: ctl.signal.aborted ? "model_timeout" : "network",
      detail: String(e)
    };
  } finally {
    clearTimeout(zamanlayici);
  }
}

async function callModel(model, key, imageB64, dusukDusunme) {
  const generationConfig = { temperature: 0, maxOutputTokens: 256 };
  if (dusukDusunme) generationConfig.thinkingConfig = { thinkingLevel: "low" };

  const body = {
    contents: [{
      parts: [
        { text: CAPTCHA_PROMPT },
        { inline_data: { mime_type: "image/png", data: imageB64 } }
      ]
    }],
    generationConfig
  };

  const result = await callGemini(model, key, body);
  if (!result.ok) return result;

  const code = extractCode(result.json);
  if (!code) {
    return { ok: false, error: "no_code" };
  }
  return { ok: true, code };
}

async function solveCaptchaWithGemini(imageB64) {
  if (typeof imageB64 !== "string" || imageB64.length > MAX_CAPTCHA_IMAGE_BYTES * 1.4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(imageB64)) {
    return { ok: false, error: "invalid_image" };
  }

  const key = await getGeminiKey();
  if (!key) {
    console.warn("[İhbarWeb] Gemini anahtarı storage'da bulunamadı");
    return { ok: false, error: "no_key" };
  }

  let last = { ok: false, error: "unknown" };

  for (const model of CAPTCHA_MODELS) {
    let r = await callModel(model, key, imageB64, true);

    // thinkingConfig desteklenmiyorsa ayarsız bir kez daha dene
    if (!r.ok && r.error === "http_400" && /thinking/i.test(r.detail || "")) {
      r = await callModel(model, key, imageB64, false);
    }

    if (r.ok) {
      return r;
    }

    last = r;
    console.warn(`[İhbarWeb] ${model} başarısız:`, r.error, r.detail || "");

    if (r.error === "http_400" && /API_KEY_INVALID/i.test(r.detail || "")) {
      return { ok: false, error: "bad_key" };
    }
    if (r.error === "http_403") return r;
  }

  return last;
}

function getPostPlatform(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase();
    if (["x.com", "twitter.com"].includes(host) && /^\/[^/]{1,50}\/status\/\d+(?:\/[^/?#]{1,50})*\/?$/.test(u.pathname)) {
      return "x";
    }
    if (["linkedin.com", "www.linkedin.com"].includes(host) &&
        (/^\/feed\/update\/urn:li:(?:activity|ugcPost|share):\d+\/?$/.test(u.pathname) ||
         /^\/posts\/[^/?#]{1,200}activity-\d+(?:-[^/?#]{1,100})?\/?$/.test(u.pathname))) {
      return "linkedin";
    }
    return null;
  } catch (_) {
    return null;
  }
}

function validatePostUrl(rawUrl, expectedPlatform) {
  if (typeof rawUrl !== "string" || rawUrl.length > 2048) return null;
  try {
    const url = new URL(rawUrl);
    if (getPostPlatform(url.href) !== expectedPlatform) return null;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch (_) {
    return null;
  }
}

function getSenderPlatform(sender) {
  if (!sender?.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0) return null;
  try {
    const url = new URL(sender.url);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (["x.com", "twitter.com"].includes(url.hostname.toLowerCase())) return "x";
    if (["linkedin.com", "www.linkedin.com"].includes(url.hostname.toLowerCase())) return "linkedin";
  } catch (_) { /* geçersiz gönderen adresi */ }
  return null;
}

function isIhbarWebSender(sender) {
  if (!sender?.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["ihbarweb.org.tr", "www.ihbarweb.org.tr"].includes(url.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function validateReportData(data, platform) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const url = validatePostUrl(data.tweetUrl, platform);
  const category = data.category;
  if (!url || !Number.isInteger(category) || category < 1 || category > 9) return null;

  const text = typeof data.tweetText === "string" ? data.tweetText : "";
  const author = typeof data.tweetAuthor === "string" ? data.tweetAuthor : "";
  const handle = typeof data.tweetHandle === "string" ? data.tweetHandle : "";
  const description = typeof data.description === "string" ? data.description : "";
  if (text.length > MAX_ANALYSIS_TEXT_LENGTH || author.length > 200 || handle.length > 500 ||
      description.length > MAX_ANALYSIS_DESCRIPTION_LENGTH) return null;

  return {
    url,
    text,
    author,
    tweetHandle: handle,
    hasImage: data.hasImage === true,
    hasVideo: data.hasVideo === true,
    category,
    manualCaptcha: data.manualCaptcha === true,
    description
  };
}

function allowAnalysisForTab(tabId) {
  const now = Date.now();
  for (const [id, times] of analysisRequestsByTab) {
    if (!times.some((time) => now - time < 60_000)) analysisRequestsByTab.delete(id);
  }
  const recent = (analysisRequestsByTab.get(tabId) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 8) return false;
  recent.push(now);
  analysisRequestsByTab.set(tabId, recent);
  return true;
}

function buildAnalysisPrompt(platform, info) {
  const platformName = platform === "x" ? "Twitter/X" : "LinkedIn";
  return `Sen 5651 Sayılı Kanun kapsamında internet ortamında işlenen suçları denetleyen tarafsız ve uzman bir hukuk denetleyicisisin.

Aşağıdaki ${platformName} gönderisini dikkatle incele ve 5651 Sayılı Kanun'un 8. maddesinde belirtilen katalog suçlardan (1: İntihara Yönlendirme, 2: Çocukların Cinsel İstismarı, 3: Uyuşturucu, 4: Sağlık İçin Tehlikeli Madde, 5: Müstehcenlik, 6: Fuhuş, 7: Kumar, 8: Atatürk Aleyhine Suçlar [5816 Sayılı Kanun], 9: Yasadışı Bahis) birini açıkça içerip içermediğini değerlendir.

5816 SAYILI KANUN (8. KATEGORİ) DEĞERLENDİRME KRİTERLERİ:
- Atatürk'ün bizzat şahsına, hatırasına veya Anıtkabir'e yönelik alenen sövme, küfür, hakaret, aşağılama (örneğin "atatürkünü sikeyim", "atatürk'e sövme", "anıtkabirini yıkma", "piç/deccal/put" vb. ithamlar) AÇIKÇA 8. KATALOG SUÇTUR (hasViolation=true, category=8).
- EĞER gönderi Atatürk'ü savunuyorsa, Atatürk sevgisi içeriyorsa ya da Atatürk karşıtlarına/düşmanlarına tepki gösteriyorsa bu KESİNLİKLE Atatürk aleyhine suç DEĞİLDİR (hasViolation=false, category=0).

GENEL KURAL:
Yukarıdaki 9 katalog suçtan biri açıkça varsa: hasViolation=true, category=1-9 arası ilgili suç kodu, description=BTK İhbarWeb için resmi ve net ihbar açıklaması metni (en fazla 1000 karakter).
Katalog suçlardan biri kesinlikle yoksa (sıradan iş/haber/fikir paylaşımı, meşru eleştiri vb.): hasViolation=false, category=0, reason=neden ihlal olmadığı.

Gönderi sahibi: ${info.author} (${info.handle})
Gönderi içeriği:
"${info.text}"
Gönderi adresi: ${info.url}
${info.hasImage ? "Gönderide görsel içerik bulunuyor." : ""}
${info.hasVideo ? "Gönderide video içerik bulunuyor." : ""}

Cevabını YALNIZCA geçerli bir JSON olarak ver:
{
  "hasViolation": true veya false,
  "category": 0-9,
  "reason": "Kısa açıklama",
  "description": "İhlal varsa ihbar gerekçesi metni, yoksa boş string"
}`;
}

async function analyzePostWithGemini(platform, rawInfo) {
  const info = {
    url: validatePostUrl(rawInfo.url, platform),
    text: rawInfo.text,
    author: rawInfo.author,
    handle: rawInfo.handle,
    hasImage: rawInfo.hasImage === true,
    hasVideo: rawInfo.hasVideo === true
  };
  if (!info.url || typeof info.text !== "string" || info.text.length > MAX_ANALYSIS_TEXT_LENGTH ||
      typeof info.author !== "string" || info.author.length > 200 ||
      typeof info.handle !== "string" || info.handle.length > 500) {
    return { ok: false, error: "invalid_post" };
  }

  const key = await getGeminiKey();
  if (!key) return { ok: false, error: "no_key" };
  const response = await callGemini(ANALYSIS_MODEL, key, {
    contents: [{ parts: [{ text: buildAnalysisPrompt(platform, info) }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ]
  });
  if (!response.ok) return response;

  const text = response.json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) return { ok: false, error: "no_result" };
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: "bad_result" };
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.hasViolation !== "boolean" || !Number.isInteger(parsed.category) ||
        parsed.category < 0 || parsed.category > 9 ||
        (parsed.hasViolation && parsed.category === 0) || (!parsed.hasViolation && parsed.category !== 0)) {
      return { ok: false, error: "bad_result" };
    }
    return {
      ok: true,
      result: {
        hasViolation: parsed.hasViolation,
        category: parsed.category,
        reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : "",
        description: typeof parsed.description === "string" ? parsed.description.slice(0, 1000) : ""
      }
    };
  } catch (_) {
    return { ok: false, error: "bad_result" };
  }
}

// ============================================================
// CAPTCHA İNDİRME (CORS yedeği)
// ============================================================
async function fetchCaptchaProxy() {
  const ctl = new AbortController();
  const zamanlayici = setTimeout(() => ctl.abort(), 7000);

  try {
    const res = await fetch(
      "https://www.ihbarweb.org.tr/captcha.php?t=" + Math.random(),
      { credentials: "include", cache: "no-store", signal: ctl.signal }
    );
    if (!res.ok) return { ok: false, error: `http_${res.status}` };

    const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) {
      return { ok: false, error: "invalid_mime" };
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_CAPTCHA_IMAGE_BYTES) {
      return { ok: false, error: "image_too_large" };
    }

    let bytes;
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_CAPTCHA_IMAGE_BYTES) {
            await reader.cancel();
            return { ok: false, error: "image_too_large" };
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_CAPTCHA_IMAGE_BYTES) return { ok: false, error: "image_too_large" };
      bytes = new Uint8Array(buffer);
    }

    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }

    return {
      ok: true,
      base64: btoa(bin),
      mime
    };
  } catch (e) {
    return { ok: false, error: "fetch_" + String(e) };
  } finally {
    clearTimeout(zamanlayici);
  }
}

// ============================================================
// YARDIMCI: URL / TWEET ID NORMALİZASYONU
// ============================================================
function normalizePostUrl(rawUrl) {
  const platform = getPostPlatform(rawUrl);
  if (!platform) return "";
  const safeUrl = validatePostUrl(rawUrl, platform);
  if (!safeUrl) return "";

  const url = new URL(safeUrl);
  if (platform === "x") {
    const tweetId = url.pathname.match(/\/status\/(\d+)/)?.[1];
    return tweetId ? `x_status_${tweetId}` : "";
  }

  const urn = url.pathname.match(/urn:li:(?:activity|ugcPost|share):\d+/)?.[0];
  if (urn) return `li_${urn}`;
  return `li_${url.pathname.replace(/[^a-zA-Z0-9_:]/g, "")}`;
}

// ============================================================
// MESAJ DİNLEYİCİ
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object" || typeof message.action !== "string") {
    sendResponse({ ok: false, error: "invalid_message" });
    return;
  }

  if (message.action === "ping") {
    sendResponse({ ok: !!getSenderPlatform(sender) || isIhbarWebSender(sender) });
    return;
  }

  if (message.action === "getIhbarState") {
    if (!isIhbarWebSender(sender)) {
      sendResponse({ ok: false, error: "unauthorized" });
      return;
    }
    storageAccessReady.then(() => {
      chrome.storage.local.get(["pendingIhbar", "ihbarCaptchaState", "autoCaptcha"], (res) => {
        sendResponse({ ok: true, ...res });
      });
    });
    return true;
  }

  if (message.action === "setCaptchaAttempts") {
    if (!isIhbarWebSender(sender) || !Number.isInteger(message.attempts) || message.attempts < 0 || message.attempts > 6) {
      sendResponse({ ok: false, error: "invalid_request" });
      return;
    }
    storageAccessReady.then(() => {
      chrome.storage.local.set({ ihbarCaptchaState: { attempts: message.attempts } }, () => {
        sendResponse({ ok: !chrome.runtime.lastError });
      });
    });
    return true;
  }

  if (message.action === "clearIhbarState") {
    if (!isIhbarWebSender(sender)) {
      sendResponse({ ok: false, error: "unauthorized" });
      return;
    }
    storageAccessReady.then(() => {
      chrome.storage.local.remove(["pendingIhbar", "ihbarCaptchaState"], () => {
        sendResponse({ ok: !chrome.runtime.lastError });
      });
    });
    return true;
  }

  if (message.action === "checkReported") {
    const platform = getSenderPlatform(sender);
    if (!platform || getPostPlatform(message.url) !== platform) {
      sendResponse({ ok: false, error: "unauthorized" });
      return;
    }
    const normUrl = normalizePostUrl(message.url);
    if (!normUrl) {
      sendResponse({ isReported: false, data: null });
      return;
    }
    chrome.storage.local.get("reportedPosts", (res) => {
      const reported = res.reportedPosts || {};
      sendResponse({ isReported: !!reported[normUrl], data: reported[normUrl] || null });
    });
    return true;
  }

  if (message.action === "openIhbarWeb") {
    const platform = getSenderPlatform(sender);
    const data = validateReportData(message.data, platform);
    if (!platform || !data) {
      sendResponse({ success: false, error: "invalid_report" });
      return;
    }

    storageAccessReady.then(() => {
      chrome.storage.local.get(["pendingIhbar", "reportedPosts"], (stored) => {
        const oldTimestamp = Date.parse(stored.pendingIhbar?.timestamp || "");
        const oldAge = Date.now() - oldTimestamp;
        if (Number.isFinite(oldTimestamp) && oldAge >= 0 && oldAge <= 10 * 60 * 1000) {
          sendResponse({ success: false, error: "pending_report" });
          return;
        }
        if (stored.reportedPosts?.[normalizePostUrl(data.url)]) {
          sendResponse({ success: false, error: "already_reported" });
          return;
        }

        chrome.storage.local.set({
          pendingIhbar: {
            url: data.url,
            text: data.text,
            author: data.author,
            tweetHandle: data.tweetHandle,
            hasImage: data.hasImage,
            hasVideo: data.hasVideo,
            category: data.category,
            manualCaptcha: data.manualCaptcha,
            description: data.description,
            timestamp: new Date().toISOString()
          },
          ihbarCaptchaState: { attempts: 0 }
        }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: "storage_error" });
            return;
          }
          chrome.tabs.create({ url: "https://www.ihbarweb.org.tr/" }, () => {
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, error: "tab_error" });
              return;
            }
            sendResponse({ success: true });
          });
        });
      });
    });

    return true;
  }

  if (message.action === "analyzePost") {
    const platform = getSenderPlatform(sender);
    if (!platform || !allowAnalysisForTab(sender.tab.id)) {
      sendResponse({ ok: false, error: platform ? "rate_limited" : "unauthorized" });
      return;
    }
    const info = message.post;
    if (!info || typeof info !== "object" || Array.isArray(info)) {
      sendResponse({ ok: false, error: "invalid_post" });
      return;
    }
    analyzePostWithGemini(platform, {
      url: info.url,
      text: info.text,
      author: info.author,
      handle: info.handle,
      hasImage: info.hasImage === true,
      hasVideo: info.hasVideo === true
    }).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: "analysis_failed", detail: String(error) });
    });
    return true;
  }

  // Sekmeyi otomatik kapatma (ihbar başarılı olduktan sonra)
  if (message.action === "closeCurrentTab") {
    if (!isIhbarWebSender(sender)) {
      sendResponse({ success: false, error: "unauthorized" });
      return;
    }
    chrome.storage.local.get("lastReportSuccess", (res) => {
      const success = res.lastReportSuccess;
      const age = Date.now() - Number(success?.confirmedAt);
      if (!success || success.tabId !== sender.tab.id || !Number.isFinite(age) || age < 0 || age > 2 * 60 * 1000) {
        sendResponse({ success: false, error: "no_confirmed_report" });
        return;
      }
      chrome.storage.local.remove("lastReportSuccess", () => {
        chrome.tabs.remove(sender.tab.id, () => sendResponse({ success: !chrome.runtime.lastError }));
      });
    });
    return true;
  }

  // İhbar başarıyla tamamlandığında çağrılır
  if (message.action === "confirmReportSuccess") {
    if (!isIhbarWebSender(sender)) {
      sendResponse({ success: false, error: "unauthorized" });
      return;
    }
    const data = message.data || {};
    const normUrl = normalizePostUrl(data.url);

    if (!normUrl) {
      sendResponse({ success: false, error: "invalid_url" });
      return;
    }
    chrome.storage.local.get(["pendingIhbar", "reportedPosts", "totalReports", "todayReports", "lastReportDate"], (res) => {
      const pendingUrl = normalizePostUrl(res.pendingIhbar?.url);
      const pendingTimestamp = Date.parse(res.pendingIhbar?.timestamp || "");
      const pendingAge = Date.now() - pendingTimestamp;
      if (!res.pendingIhbar || !Number.isFinite(pendingTimestamp) || pendingUrl !== normUrl ||
          pendingAge < 0 || pendingAge > 10 * 60 * 1000) {
        sendResponse({ success: false, error: "report_mismatch" });
        return;
      }

      const reported = res.reportedPosts || {};
      if (reported[normUrl]) {
        sendResponse({ success: true, alreadyReported: true });
        return;
      }

      const pending = res.pendingIhbar;
      reported[normUrl] = {
        url: normUrl,
        originalUrl: pending.url,
        author: pending.author || "",
        category: pending.category ?? null,
        reportedAt: new Date().toISOString()
      };

      const today = new Date().toISOString().split("T")[0];
      const todayCount = res.lastReportDate === today ? (res.todayReports || 0) + 1 : 1;

      chrome.storage.local.set({
        reportedPosts: reported,
        totalReports: (res.totalReports || 0) + 1,
        todayReports: todayCount,
        lastReportDate: today,
        lastReportSuccess: { tabId: sender.tab.id, url: normUrl, confirmedAt: Date.now() }
      }, () => {
        sendResponse({ success: !chrome.runtime.lastError });
      });
    });
    return true;
  }

  // İhbar kaydı yalnızca sunucu başarı sayfasında doğrulandığında yapılır.
  if (message.action === "cancelReport") {
    if (!isIhbarWebSender(sender)) {
      sendResponse({ success: false, error: "unauthorized" });
      return;
    }
    sendResponse({ success: true });
    return;
  }

  if (message.action === "solveCaptcha") {
    if (!isIhbarWebSender(sender)) {
      sendResponse({ ok: false, error: "unauthorized" });
      return;
    }
    solveCaptchaWithGemini(message.imageB64).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: "captcha_failed", detail: String(error) });
    });
    return true;
  }

  if (message.action === "fetchCaptcha") {
    if (!isIhbarWebSender(sender)) {
      sendResponse({ ok: false, error: "unauthorized" });
      return;
    }
    fetchCaptchaProxy().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: "captcha_fetch_failed", detail: String(error) });
    });
    return true;
  }

  sendResponse({ ok: false, error: "unknown_action" });
});
