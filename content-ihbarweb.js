// İhbarWeb Gönderi Bildirici - ihbarweb.org.tr Content Script
// Copyright (c) 2026 Efe Kırbaş. All rights reserved. Proprietary software.

(function () {
  "use strict";

  const MAX_CAPTCHA_ATTEMPTS = 6;
  const PENDING_TTL_MS = 10 * 60 * 1000;
  const CANONICAL_HOST = "www.ihbarweb.org.tr";

  const T_FETCH = 8000;    // captcha indirme
  const T_OCR = 25000;     // arka plan + Gemini
  const T_TOTAL = 35000;   // tüm çözüm

  const CATEGORY_NAMES = {
    1: "İntihara Yönlendirme",
    2: "Çocukların Cinsel İstismarı",
    3: "Uyuşturucu",
    4: "Sağlık İçin Tehlikeli",
    5: "Müstehcenlik",
    6: "Fuhuş",
    7: "Kumar",
    8: "Atatürk Aleyhine",
    9: "Yasadışı Bahis",
  };

  function withTimeout(promise, ms, etiket) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(etiket)), ms)),
    ]);
  }

  // ============================================================
  // ANA FONKSİYON
  // ============================================================
  async function main() {
    let store;
    try {
      store = await chrome.runtime.sendMessage({ action: "getIhbarState" });
    } catch (_) {
      return;
    }
    if (!store?.ok) return;
    const data = store.pendingIhbar;

    const pageText = (document.body ? document.body.innerText : "").toLowerCase();

    // 1) HATA EKRANI KONTROLÜ (İhbarınız Kaydedilememiştir)
    const isErrorPage = pageText.includes("kaydedilememiştir") ||
      pageText.includes("güvenlik doğrulaması başarısız") ||
      pageText.includes("teknik bir sorun oluştu");

    if (isErrorPage) {
      console.warn("[İhbarWeb] Hata ekranı tespit edildi: İhbar kaydedilemedi.");
      
      // X'te yanlışlıkla bildirilmiş sayılmaması için varsa mükerrer kaydını temizle
      if (data?.url) {
        chrome.runtime.sendMessage({ action: "cancelReport", url: data.url });
      }

      showStatusBanner("⚠️ Güvenlik doğrulaması / Captcha başarısız oldu. 'Tekrar Dene' butonuna tıklayarak tekrar deneyin.", "warn");

      // "Tekrar Dene" butonuna tıklandığında veri kaybolmasın
      const retryBtn = Array.from(document.querySelectorAll("button, a")).find(b => /tekrar dene/i.test(b.innerText || ""));
      if (retryBtn) {
        retryBtn.addEventListener("click", () => {
          // İhbar verisini koru
          if (store.ihbarCaptchaState) {
            chrome.runtime.sendMessage({ action: "setCaptchaAttempts", attempts: 0 });
          }
        });
      }
      return;
    }

    // 2) BAŞARI EKRANI KONTROLÜ (İhbarınız Başarıyla Alındı / Kaydedildi)
    const isSuccessPage = pageText.includes("kaydedilmiştir") ||
      pageText.includes("başarıyla alınmıştır") ||
      pageText.includes("ihbarınız alınmıştır") ||
      pageText.includes("ihbar numarası");

    const form = document.getElementById("ihbarForm");

    if (isSuccessPage && !form) {
      console.log("[İhbarWeb] Başarı ekranı tespit edildi!");
      if (data?.url) {
        // YALNIZCA BURADA İHBAR BAŞARILI SAYILIP VERİTABANINA İŞLENİR
        try {
          await chrome.runtime.sendMessage({
            action: "confirmReportSuccess",
            data: {
              url: data.url,
              author: data.author,
              category: data.category
            }
          });
        } catch (_) { /* sayfa devam eder; arka plan yanıt vermediyse kayıt yapılmaz */ }
      }
      await chrome.runtime.sendMessage({ action: "clearIhbarState" });
      
      // Başarı banner'ı ve 5 saniyelik geri sayımla sekmeyi otomatik kapatma
      showCountdownAndAutoClose(5);
      return;
    }

    if (!data) return;

    if (data.timestamp && Date.now() - new Date(data.timestamp).getTime() > PENDING_TTL_MS) {
      await chrome.runtime.sendMessage({ action: "clearIhbarState" });
      return;
    }

    // Tek host kuralı: www'suz açıldıysa www'ye taşı.
    if (location.hostname !== CANONICAL_HOST) {
      const u = new URL(location.href);
      u.hostname = CANONICAL_HOST;
      u.search = "";
      location.replace(u.toString());
      return;
    }

    if (!form) {
      return;
    }

    form.action = location.origin + "/";

    const state = store.ihbarCaptchaState || { attempts: 0 };
    const auto = store.autoCaptcha !== false && data.manualCaptcha !== true;

    await sleep(1000);
    showStatusBanner(
      state.attempts > 0
        ? `⏳ Captcha yeniden deneniyor (${state.attempts}/${MAX_CAPTCHA_ATTEMPTS})...`
        : "⏳ Form dolduruluyor..."
    );

    await selectCategory(data.category);
    await sleep(800);
    await fillUrlField(data.url);
    await sleep(200);
    await fillDescriptionField(data.description || buildFallbackDescription(data));
    await sleep(200);
    await fillDateFields();
    await sleep(200);
    await fillSourceDropdown();
    await sleep(200);

    if (!auto) {
      updateStatusBanner("✅ Form dolduruldu! CAPTCHA'yı girip GÖNDER'e basın.", "success");
      focusCaptchaInput();
      return;
    }

    if (state.attempts >= MAX_CAPTCHA_ATTEMPTS) {
      updateStatusBanner("⚠️ Otomatik doğrulanamadı. Lütfen resimdeki kodu girip GÖNDER'e basın.", "warn");
      focusCaptchaInput();
      await chrome.runtime.sendMessage({ action: "setCaptchaAttempts", attempts: 0 });
      return;
    }

    // Arka plan uyanık mı? Değilse boşuna beklemeyelim.
    let uyanik = false;
    try {
      const p = await withTimeout(chrome.runtime.sendMessage({ action: "ping" }), 3000, "ping");
      uyanik = !!p?.ok;
    } catch (e) {
      uyanik = false;
    }
    if (!uyanik) {
      updateStatusBanner("⚠️ Arka plan yanıt vermiyor. Kodu elle girip gönderin.", "warn");
      focusCaptchaInput();
      return;
    }

    updateStatusBanner(`🤖 Güvenlik kodu çözülüyor... (${state.attempts + 1}/${MAX_CAPTCHA_ATTEMPTS})`);

    const sonuc = await withTimeout(solveCaptcha(), T_TOTAL, "toplam_zaman_asimi")
      .catch((e) => ({ ok: false, error: String(e.message || e) }));

    if (!sonuc.ok) {
      updateStatusBanner(`⚠️ CAPTCHA okunamadı. Lütfen kodu girip GÖNDER'e basın.`, "warn");
      console.warn("[İhbarWeb] captcha hatası:", sonuc.error, sonuc.detail || "");
      focusCaptchaInput();
      return;
    }
    const kod = sonuc.code;

    const input = findCaptchaInput();
    if (!input) {
      updateStatusBanner("⚠️ CAPTCHA alanı bulunamadı.", "warn");
      return;
    }

    setNativeValue(input, kod);
    await chrome.runtime.sendMessage({ action: "setCaptchaAttempts", attempts: state.attempts + 1 });

    updateStatusBanner(`🚀 Gönderiliyor... (kod: ${kod})`, "success");
    await sleep(500);

    try {
      // form.submit() yerine butona click yaparak yerel JS/token doğrulamasını çalıştır
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]') ||
        Array.from(form.querySelectorAll("button, a")).find(b => /gönder/i.test(b.innerText || ""));

      if (submitBtn) {
        submitBtn.click();
      } else {
        form.submit();
      }
    } catch (e) {
      updateStatusBanner(`⚠️ Gönderim hatası (${e.message}). Lütfen GÖNDER butonuna basın.`, "warn");
    }
  }

  // ============================================================
  // CAPTCHA ÇÖZME
  // ============================================================
  async function solveCaptcha() {
    const img = document.querySelector("#captchaImg") ||
      document.querySelector('img[src*="captcha"]');

    let blob;
    try {
      blob = await withTimeout(fetchCaptchaBlob(), T_FETCH, "captcha_zaman_asimi");
    } catch (e) {
      return { ok: false, error: "captcha_fetch", detail: String(e.message || e) };
    }

    if (img) img.src = URL.createObjectURL(blob);

    let b64;
    try {
      b64 = await preprocessCaptcha(blob);
    } catch (e) {
      return { ok: false, error: "preprocess", detail: String(e.message || e) };
    }

    let resp;
    try {
      resp = await withTimeout(
        chrome.runtime.sendMessage({ action: "solveCaptcha", imageB64: b64 }),
        T_OCR,
        "ocr_zaman_asimi"
      );
    } catch (e) {
      const m = String(e.message || e);
      if (/context invalidated|Receiving end/i.test(m)) {
        return { ok: false, error: "sw_olu", detail: m };
      }
      return { ok: false, error: m === "ocr_zaman_asimi" ? "timeout" : "messaging", detail: m };
    }

    if (!resp) return { ok: false, error: "bos_yanit" };
    if (!resp.ok) return { ok: false, error: resp.error || "bilinmeyen", detail: resp.detail };

    const kod = String(resp.code).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (kod.length !== 6) return { ok: false, error: "kisa_kod", detail: resp.code };

    return { ok: true, code: kod };
  }

  async function fetchCaptchaBlob() {
    // 1) Aynı origin — göreli yol
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), T_FETCH - 500);
      try {
        const r = await fetch("captcha.php?t=" + Math.random(), {
          credentials: "include",
          cache: "no-store",
          signal: ctl.signal,
        });
        if (r.ok) {
          const mime = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
          const length = Number(r.headers.get("content-length"));
          if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) throw new Error("captcha_mime");
          if (Number.isFinite(length) && length > 1024 * 1024) throw new Error("captcha_size");
          const blob = await r.blob();
          if (blob.size > 1024 * 1024) throw new Error("captcha_size");
          return blob;
        }
        console.warn("[İhbarWeb] göreli captcha HTTP", r.status);
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      console.warn("[İhbarWeb] göreli captcha fetch başarısız", e);
    }

    // 2) Yedek: arka plan üzerinden
    const r2 = await withTimeout(
      chrome.runtime.sendMessage({ action: "fetchCaptcha" }),
      T_FETCH,
      "proxy_zaman_asimi"
    );
    if (!r2 || !r2.ok) throw new Error(r2?.error || "proxy_fetch");

    const bin = atob(r2.base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: r2.mime || "image/png" });
  }

  async function preprocessCaptcha(blob) {
    const bmp = await createImageBitmap(blob);
    if (!bmp.width || !bmp.height || bmp.width > 1000 || bmp.height > 500 || bmp.width * bmp.height > 250000) {
      bmp.close();
      throw new Error("captcha_dimensions");
    }
    const scale = 4;
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width * scale;
    canvas.height = bmp.height * scale;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);

    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
      const v = g < 170 ? 0 : 255;
      p[i] = p[i + 1] = p[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);

    const result = canvas.toDataURL("image/png").split(",")[1];
    bmp.close();
    return result;
  }

  function findCaptchaInput() {
    return document.querySelector('input[name="security_code"]') ||
      document.getElementById("security_code");
  }

  // ============================================================
  // KATEGORİ SEÇME
  // ============================================================
  async function selectCategory(categoryId) {
    if (!categoryId) return;
    const categoryName = CATEGORY_NAMES[categoryId];

    // 1) crime-id veya data-id ile eşleşen kart/buton
    const byId = document.querySelector(`[data-crime-id="${categoryId}"], [data-id="${categoryId}"]`);
    if (byId) {
      byId.click();
    }

    // 2) İsimle eşleşen tıklanabilir kategori kartı
    if (categoryName) {
      const allClickables = document.querySelectorAll(".crime-tab-card, a, button, div[class*='card'], label, div");
      for (const el of allClickables) {
        const text = (el.textContent || "").trim();
        if (text.includes(categoryName) && el.children.length <= 3) {
          el.click();
          break;
        }
      }
    }

    // 3) Form içinde kategori/suç parametresi varsa doğrudan değer ata
    const hiddenCat = document.querySelector('input[name="kategori"], input[name="suc_kategori"], input[name="crime_id"], input[name="suc"]');
    if (hiddenCat && hiddenCat.tagName === "INPUT") {
      setNativeValue(hiddenCat, String(categoryId));
    }
  }

  // ============================================================
  // URL ALANI
  // ============================================================
  async function fillUrlField(url) {
    const byName = document.querySelector('input[name="adres"]');
    if (byName) {
      setNativeValue(byName, url);
      return;
    }

    const inputs = document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])');
    for (const input of inputs) {
      const label = getLabelText(input);
      const placeholder = (input.placeholder || "").toLowerCase();
      const name = (input.name || "").toLowerCase();

      if (
        label.includes("url") || label.includes("adres") || label.includes("internet") ||
        placeholder.includes("http") || placeholder.includes("example") ||
        name.includes("url") || name.includes("adres")
      ) {
        setNativeValue(input, url);
        return;
      }
    }

    const firstInput = document.querySelector('input[type="text"]');
    if (firstInput) setNativeValue(firstInput, url);
  }

  // ============================================================
  // AÇIKLAMA ALANI
  // ============================================================
  async function fillDescriptionField(description) {
    const byName = document.querySelector('textarea[name="detay"]');
    if (byName) {
      setNativeValue(byName, description);
      return;
    }

    const textareas = document.querySelectorAll("textarea");
    for (const textarea of textareas) {
      const label = getLabelText(textarea);
      if (
        label.includes("açıklama") || label.includes("ihbar") ||
        label.includes("tarif") || label.includes("suç")
      ) {
        setNativeValue(textarea, description);
        return;
      }
    }
    if (textareas.length > 0) setNativeValue(textareas[0], description);
  }

  // ============================================================
  // TARİH ALANLARI
  // ============================================================
  async function fillDateFields() {
    const now = new Date();
    const day = now.getDate();
    const month = now.getMonth();
    const year = now.getFullYear();

    const aylar = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
      "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

    const gunSel = document.querySelector('select[name="gun"]');
    const aySel = document.querySelector('select[name="ay"]');
    const yilSel = document.querySelector('select[name="yil"]');

    if (gunSel) selectOptionByValue(gunSel, String(day));
    if (aySel) {
      for (const opt of aySel.options) {
        if (opt.text.trim() === aylar[month]) {
          aySel.value = opt.value;
          aySel.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
      }
    }
    if (yilSel) selectOptionByValue(yilSel, String(year));

    if (gunSel && aySel && yilSel) return;

    for (const select of document.querySelectorAll("select")) {
      const options = Array.from(select.options);
      if (options.some((o) => o.value === "31")) {
        selectOptionByValue(select, String(day));
      } else if (options.some((o) => aylar.includes(o.text.trim()))) {
        for (const opt of options) {
          if (opt.text.trim() === aylar[month]) {
            select.value = opt.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            break;
          }
        }
      } else if (options.some((o) => parseInt(o.value) >= 2020 && parseInt(o.value) <= 2030)) {
        selectOptionByValue(select, String(year));
      }
    }
  }

  // ============================================================
  // KAYNAK DROPDOWN
  // ============================================================
  async function fillSourceDropdown() {
    const select = document.querySelector('select[name="suc"]');
    if (!select) return;

    const options = Array.from(select.options);
    const priorities = ["sosyal medya", "sosyal paylaşım", "sosyal", "twitter", "web"];

    for (const keyword of priorities) {
      const match = options.find((o) => o.text.toLowerCase().includes(keyword));
      if (match) {
        select.value = match.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
    }
  }

  // ============================================================
  // CAPTCHA ALANINA ODAKLAN
  // ============================================================
  function focusCaptchaInput() {
    const input = findCaptchaInput();
    if (!input) return;
    input.focus();
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    input.style.outline = "3px solid #e0245e";
    input.style.outlineOffset = "2px";
  }

  // ============================================================
  // BAŞARI GERİ SAYIMI VE OTOMATİK SEKME KAPATMA
  // ============================================================
  function showCountdownAndAutoClose(seconds = 5) {
    let remaining = seconds;
    let isCancelled = false;

    const banner = document.createElement("div");
    banner.id = "ihbarweb-status";
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
      background: linear-gradient(135deg, #0d2818, #053b17);
      color: #fff; padding: 12px 24px; font-size: 14px; font-weight: 550;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center; gap: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.45);
      border-bottom: 2px solid #2ecc71;
    `;

    const render = () => {
      banner.innerHTML = `
        <div style="display:flex; align-items:center; gap:9px;">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#2ecc71" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
          <span>İhbarınız BTK İhbarWeb sistemine başarıyla kaydedildi!</span>
          <span style="color:#bef264; font-variant-numeric:tabular-nums; font-weight:700;">(${remaining}s sonra kapatılacak)</span>
        </div>
        <button id="ihbarweb-keep-tab-btn" style="
          background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.25);
          color: #fff; padding: 4px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: background 0.15s ease;
        ">Sekmeyi Açık Tut</button>
      `;

      banner.querySelector("#ihbarweb-keep-tab-btn")?.addEventListener("click", () => {
        isCancelled = true;
        banner.innerHTML = `
          <div style="display:flex; align-items:center; gap:9px;">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#2ecc71" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
            <span>İhbarınız başarıyla kaydedildi. Otomatik kapatma iptal edildi, sekme açık bırakıldı.</span>
          </div>
        `;
      });
    };

    render();
    const existing = document.getElementById("ihbarweb-status");
    if (existing) existing.remove();
    document.body.appendChild(banner);

    const timer = setInterval(() => {
      if (isCancelled) {
        clearInterval(timer);
        return;
      }
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timer);
        banner.innerHTML = `<span style="font-weight:600;">Sekme kapatılıyor...</span>`;
        chrome.runtime.sendMessage({ action: "closeCurrentTab" });
      } else {
        render();
      }
    }, 1000);
  }

  // ============================================================
  // BANNER
  // ============================================================
  function showStatusBanner(message) {
    const existing = document.getElementById("ihbarweb-status");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.id = "ihbarweb-status";
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
      background: linear-gradient(135deg, #1a1a3a, #2a1a4a);
      color: #fff; padding: 14px 24px; font-size: 15px; font-weight: 600;
      text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      border-bottom: 2px solid #4a9eff;
    `;
    banner.textContent = message;
    document.body.appendChild(banner);
  }

  function updateStatusBanner(message, type) {
    const banner = document.getElementById("ihbarweb-status");
    if (!banner) {
      showStatusBanner(message);
      return;
    }
    banner.textContent = message;
    if (type === "success") {
      banner.style.background = "linear-gradient(135deg, #1a3a1a, #1a4a2a)";
      banner.style.borderBottomColor = "#2ecc71";
    } else if (type === "warn") {
      banner.style.background = "linear-gradient(135deg, #3a2a1a, #4a3a1a)";
      banner.style.borderBottomColor = "#e0a024";
    }
  }

  // ============================================================
  // YARDIMCILAR
  // ============================================================
  function setNativeValue(element, value) {
    const proto = element.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    if (setter) setter.call(element, value);
    else element.value = value;

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function selectOptionByValue(select, value) {
    for (const option of select.options) {
      if (option.value === value || option.text.trim() === value) {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function getLabelText(element) {
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) return label.textContent.toLowerCase();
    }
    const parentLabel = element.closest("label");
    if (parentLabel) return parentLabel.textContent.toLowerCase();

    let prev = element.previousElementSibling;
    while (prev) {
      if (["LABEL", "SPAN", "DIV"].includes(prev.tagName)) {
        return prev.textContent.toLowerCase();
      }
      prev = prev.previousElementSibling;
    }

    const parent = element.closest("div, td, li, p");
    if (parent) {
      const lbl = parent.querySelector("label, .form-label");
      if (lbl) return lbl.textContent.toLowerCase();
    }

    return ((element.placeholder || "") + " " + (element.name || "")).toLowerCase();
  }

  function buildFallbackDescription(data) {
    let desc = `Twitter/X platformunda 5651 Sayılı Kanun'un 8. maddesi kapsamında suç teşkil eden bir paylaşım tespit edilmiştir.\n\n`;
    desc += `Paylaşım Sahibi: ${data.author || "Bilinmiyor"}`;
    if (data.tweetHandle) desc += ` (${data.tweetHandle})`;
    desc += `\n\nPaylaşım İçeriği:\n"${data.text || ""}"\n\n`;
    desc += `Paylaşım Adresi: ${data.url}\n\n`;
    desc += `Tespit Tarihi: ${new Date().toLocaleDateString("tr-TR")}`;
    return desc;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================================
  // BAŞLAT
  // ============================================================
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
