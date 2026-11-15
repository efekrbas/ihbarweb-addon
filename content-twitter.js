// İhbarWeb Gönderi Bildirici - Twitter/X Content Script
// Copyright (c) 2026 Efe Kırbaş. All rights reserved. Proprietary software.

(function () {
  "use strict";

  // Aynı içerik betiği birden fazla kez çalışırsa çoğaltılmış buton/observer oluşturma.
  if (window.__ihbarWebTwitterInitialized) return;
  window.__ihbarWebTwitterInitialized = true;

  // Tweet makalesinden bilgileri çıkar
  function extractTweetInfo(tweetElement) {
    let tweetUrl = "";
    // Öncelik: status linkini bul (zaman damgası üzerindeki link)
    const timeLink = tweetElement.querySelector('a[href*="/status/"] time');
    if (timeLink) {
      const anchor = timeLink.closest("a");
      if (anchor) tweetUrl = anchor.href;
    }
    // Yedek: herhangi bir status linki
    if (!tweetUrl) {
      const statusLinks = tweetElement.querySelectorAll('a[href*="/status/"]');
      for (const link of statusLinks) {
        const href = link.getAttribute("href");
        if (href && href.match(/\/status\/\d+/)) {
          tweetUrl = link.href;
          break;
        }
      }
    }

    let tweetText = "";
    const textElement = tweetElement.querySelector('[data-testid="tweetText"]');
    if (textElement) tweetText = textElement.innerText;

    let tweetAuthor = "";
    let tweetHandle = "";
    const authorElement = tweetElement.querySelector('[data-testid="User-Name"]');
    if (authorElement) {
      const parts = authorElement.innerText.split("\n");
      tweetAuthor = parts[0] || "";
      // @ ile başlayan handle'ı bul
      for (const p of parts) {
        if (p.startsWith("@")) { tweetHandle = p; break; }
      }
    }

    // Tweet'teki medya var mı?
    const hasImage = !!tweetElement.querySelector('[data-testid="tweetPhoto"]');
    const hasVideo = !!tweetElement.querySelector('[data-testid="videoPlayer"]');

    return { tweetUrl, tweetText, tweetAuthor, tweetHandle, hasImage, hasVideo };
  }

  // URL / Tweet ID normalizasyonu
  function normalizePostUrl(url) {
    if (!url) return "";
    try {
      const tweetIdMatch = String(url).match(/\/status\/(\d+)/);
      if (tweetIdMatch) {
        return `x_status_${tweetIdMatch[1]}`;
      }
      const u = new URL(url, "https://x.com");
      let host = u.hostname.replace(/^(www\.)?twitter\.com$/, "x.com").replace(/^www\./, "");
      let path = u.pathname.replace(/\/+$/, "");
      return `https://${host}${path}`;
    } catch (e) {
      return String(url).split("?")[0].split("#")[0].replace(/\/+$/, "");
    }
  }

  // Daha önce ihbar edilip edilmediğini sorgula
  function checkAlreadyReported(url) {
    return new Promise((resolve) => {
      if (!url) {
        resolve({ isReported: false });
        return;
      }
      chrome.runtime.sendMessage({ action: "checkReported", url: url }, (res) => {
        if (chrome.runtime.lastError || !res) {
          resolve({ isReported: false });
        } else {
          resolve(res);
        }
      });
    });
  }

  // Direkt ihbarweb'e gönder (modal yok)
  async function sendToIhbarWeb(tweetInfo) {
    if (!tweetInfo.tweetUrl && !tweetInfo.tweetText) {
      showToast("Tweet bilgileri okunamadı.", "warning");
      return;
    }

    // MÜKERRER İHBAR KONTROLÜ
    const reportCheck = await checkAlreadyReported(tweetInfo.tweetUrl);
    if (reportCheck?.isReported) {
      const dateStr = reportCheck.data?.reportedAt
        ? new Date(reportCheck.data.reportedAt).toLocaleString("tr-TR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
        : "";
      showToast(`Bu gönderi daha önce (${dateStr || "daha önce"}) İhbarWeb'e bildirilmiş. Mükerrer ihbara gerek yoktur.`, "info");
      return;
    }

    // Loading toast göster
    showToast("Gönderi 5651 Sayılı Kanun yönünden analiz ediliyor...", "loading");

    // Kural tabanlı açık ihlal denetimi (Regex / Anahtar kelimeler)
    const keywordCategory = detectCategoryByKeywords(tweetInfo.tweetText);

    // AI ile ihlal kontrolü ve kategori tespiti
    let category = null;
    let aiDescription = null;
    let aiChecked = false;

    try {
      const aiResult = await analyzeWithAI(tweetInfo);
      if (aiResult) {
        if (aiResult.hasViolation === true && aiResult.category > 0) {
          category = aiResult.category;
          aiDescription = aiResult.description;
        } else if (keywordCategory) {
          // AI çekingen davranmış veya küfür/argo karşısında kaçınmışsa kural motoru devreye girer
          category = keywordCategory;
        } else {
          // Hem AI hem kural motoru ihlal unsuru bulamadı
          const reason = aiResult.reason ? ` (${aiResult.reason})` : "";
          showToast(`İhlal Bulunamadı: Bu gönderide 5651 Sayılı Kanun kapsamındaki katalog suçlara dair bir unsur tespit edilemedi.${reason}`, "warning");
          return;
        }
      }
    } catch (err) {
      console.error("[İhbarWeb] AI hatası:", err);
    }

    // AI yanıt vermediyse veya API anahtarı yoksa kural motorunu kullan
    if (!category && keywordCategory) {
      category = keywordCategory;
    }

    // Hem AI hem anahtar kelime filtresi ihlal bulamadıysa şikayete izin verme
    if (!category) {
      showToast("İhlal Bulunamadı: Bu gönderide 5651 Sayılı Kanun kapsamındaki katalog suçlara ilişkin bir ihlal unsuru tespit edilemedi. İhbar başlatılmadı.", "warning");
      return;
    }

    if (!aiDescription) {
      aiDescription = buildDefaultDescription(tweetInfo);
    }

    // Veriyi kaydet ve ihbarweb'i aç
    chrome.runtime.sendMessage({
      action: "openIhbarWeb",
      data: {
        tweetUrl: tweetInfo.tweetUrl,
        tweetText: tweetInfo.tweetText,
        tweetAuthor: tweetInfo.tweetAuthor,
        tweetHandle: tweetInfo.tweetHandle,
        hasImage: tweetInfo.hasImage,
        hasVideo: tweetInfo.hasVideo,
        category: category,
        description: aiDescription,
      },
    }, (response) => {
      if (response && response.success) {
        showToast("İhbarWeb açılıyor, form otomatik dolduruluyor...", "success");
      }
    });
  }

  // ============================================================
  // GEMİNİ API İLE ANALİZ (İhlal Kontrolü + Kategori + Açıklama)
  // ============================================================
  async function analyzeWithAI(apiKey, tweetInfo) {
    const prompt = `Sen 5651 Sayılı Kanun kapsamında internet ortamında işlenen suçları değerlendiren tarafsız ve uzman bir hukuk denetleyicisisin.

Aşağıdaki tweet'i dikkatlice incele. 5651 Sayılı Kanun'un 8. maddesinde sayılan aşağıdaki 9 KATALOG SUÇTAN birini açıkça ihlal edip etmediğini tespit et:

Katalog Suçlar:
1 = İntihara Yönlendirme (TCK m.84)
2 = Çocukların Cinsel İstismarı (TCK m.103)
3 = Uyuşturucu veya Uyarıcı Madde Kullanılmasını Kolaylaştırma (TCK m.190)
4 = Sağlık İçin Tehlikeli Madde Temini (TCK m.194)
5 = Müstehcenlik (TCK m.226)
6 = Fuhuş (TCK m.227)
7 = Kumar Oynanması İçin Yer ve İmkân Sağlama (TCK m.228)
8 = Atatürk Aleyhine İşlenen Suçlar (5816 Sayılı Kanun: Atatürk'ün bizzat hatırasına alenen hakaret, sövme, aşağılama veya montaj)
9 = Yasadışı Bahis (7258 Sayılı Kanun: Yasadışı bahis veya şans oyunu oynatma, teşvik, reklam)

KRİTİK HUKUKİ AYRIM (5816 SAYILI KANUN):
- 8. kategori YALNIZCA ve YALNIZCA bizzat Atatürk'ün şahsına veya manevi hatırasına hakaret/sövme içeriyorsa geçerlidir.
- EĞER tweet Atatürk'ü savunuyorsa, Atatürk sevgisi içeriyorsa ya da Atatürk karşıtlarına/sevmeyenlerine tepki/küfür gösteriyorsa (örneğin "Atatürk'ü sevmeyenlerin...", "Atatürk düşmanlarının..." gibi) bu KESİNLİKLE Atatürk aleyhine bir suç DEĞİLDİR! Bu tarz paylaşımlarda "hasViolation": false, "category": 0 vermek ZORUNDASIN.

ÖNEMLİ KURAL:
Eğer bu tweet yukarıdaki 9 katalog suçtan kesinlikle birini İÇERMİYORSA (sıradan bir paylaşım, mizah/parodi, eleştiri, haber, fikir beyanı veya katalog suç kapsamı dışındaysa):
"hasViolation": false, "category": 0 döndür. Haksız/yersiz ihbarları engellemek zorundasın.

Eğer yukarıdaki katalog suçlardan biri açıkça işlenmişse:
"hasViolation": true, "category": 1-9 arası ilgili suç kodu, "description": BTK İhbarWeb için resmi ve detaylı bir ihbar gerekçesi.

Tweet Bilgileri:
- Yazar: ${tweetInfo.tweetAuthor} (${tweetInfo.tweetHandle})
- İçerik: "${tweetInfo.tweetText}"
- URL: ${tweetInfo.tweetUrl}
${tweetInfo.hasImage ? "- Tweet'te görsel içerik bulunmaktadır." : ""}
${tweetInfo.hasVideo ? "- Tweet'te video içerik bulunmaktadır." : ""}

Cevabını YALNIZCA geçerli bir JSON olarak ver:
{
  "hasViolation": true veya false,
  "category": 0-9,
  "reason": "İhlal yoksa neden olmadığı, varsa hangi suç unsurunun oluştuğu (1-2 cümle)",
  "description": "İhlal varsa resmi ihbar açıklaması metni, ihlal yoksa boş string"
}`;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
          }),
        }
      );

      if (!response.ok) return null;

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) return null;

      // JSON parse et (```json ... ``` bloğu olabilir)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.hasViolation === "boolean" && typeof parsed.category === "number") {
          return parsed;
        }
      }
    } catch (error) {
      console.error("[İhbarWeb] Gemini API hatası:", error);
    }

    return null;
  }

  // ============================================================
  // KEYWORD İLE KATEGORİ TESPİTİ (yedek)
  // ============================================================
  function detectCategoryByKeywords(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    // Atatürk'ü savunan veya karşıtlarına tepki gösteren paylaşımları asla suç sayma
    const ataturkSavunma = [
      "atatürk'ü sevmeyen", "atatürkü sevmeyen", "atatürk düşman", "atatürk karşıt",
      "yaşa mustafa kemal", "atamız", "ulu önder", "atatürkçü", "kemalistim", "canım atam", "atatürk sevgisi"
    ];
    const isDefense = ataturkSavunma.some((kw) => lower.includes(kw));

    // Atatürk'e, Hatırasına, Anıtkabir'e, Kabrine, Heykel ve Büstlerine doğrudan küfür / hakaret / saldırı (5816 Sayılı Kanun - Kategori 8)
    if (!isDefense) {
      const hasAtaturkRef = /(?:atatürk|ataturk|mustafa kemal|anıtkabir|anitkabir|kamal|selanikli|kemalizm)/i.test(lower);
      const hasDirectInsult = /(?:sik(?:ey|ti|er|ec|m|in)?|piç|pic|orospu|fahişe|kahpe|k[oö]pek|it|put|deccal|geber|y[ıi]k(?:al|ac|s)?|lanet|hain|amk|aq)/i.test(lower);

      const directPatterns = [
        /(?:atatürk|ataturk)ün[üu]?\s*sik/i,
        /sik(?:ey)?im\s*(?:senin\s*)?(?:atatürk|ataturk)/i,
        /(?:atatürk|ataturk)e\s*s[öo]v/i,
        /(?:atatürk|ataturk)e\s*k[üu]f[üu]r/i,
        /an[ıi]tkabir(?:i|in|e|ini)?\s*(?:y[ıi]k|dozer|bomba|sald[ıi]r|parçala|yok et|s[öo]v|küf[üu]r|sik|pisle|tahrip|balyoz)/i,
        /an[ıi]tkabir\s*(?:puthane|put evi|yıkılsın|yikilsin)/i,
        /(?:heykellerini|büstlerini|b[üu]st[üu]n[üu]|heykelini)\s*(?:y[ıi]k|k[ıi]r|devir|parçala|balyoz|sald[ıi]r)/i,
        /(?:atatürk|ataturk)\s*(?:heykel|büst|b[üu]st|an[ıi]t)(?:i|lerini|ini)?\s*(?:y[ıi]k|k[ıi]r|parçala|balyoz|yak|sald[ıi]r|devir|kirlet)/i,
        /(?:kabrine|mezar[ıi]na)\s*(?:i[sş]e|s[ıi]ç|s[öo]v|t[üu]k[üu]r|sald[ıi]r)/i,
        /(?:atatürk|ataturk)\s*(?:piç|pic|orospu|fahişe|deccal|put)/i
      ];

      if (directPatterns.some((pattern) => pattern.test(lower)) || (hasAtaturkRef && hasDirectInsult && (lower.includes("atatürkünü") || lower.includes("ataturkunu") || lower.includes("senin atatürk") || lower.includes("anıtkabir") || lower.includes("anitkabir")))) {
        return 8; // Atatürk Aleyhine İşlenen Suçlar (5816)
      }
    }

    const rules = [
      { id: 1, keywords: ["intihar et", "kendini öldür", "yaşamak istemiyorum", "canıma kıyacağım", "intihara teşvik"] },
      { id: 2, keywords: ["çocuk istismar", "pedofili", "çocuk pornosu", "küçük çocuk cinsel"] },
      { id: 3, keywords: ["uyuşturucu sat", "esrar sat", "kokain sat", "metamfetamin sat", "bonzai sat", "madde temin"] },
      { id: 4, keywords: ["zehirli madde temin", "sağlığa zararlı madde sat", "kimyasal zehir"] },
      { id: 5, keywords: ["müstehcen yayın", "çocuk pornografi", "cinsel içerikli video sat"] },
      { id: 6, keywords: ["fuhuşa teşvik", "fuhuş yaptır", "escort bayan ara", "fuhuş aracılık"] },
      { id: 7, keywords: ["kumar oyna", "rulet oyna", "casino sitesi", "canlı casino giriş", "slot oyna"] },
      {
        id: 8, keywords: [
          "atatürkünü sik", "ataturkunu sik", "atatürk'ünü sik", "atatürkü sik", "ataturku sik",
          "sikeyim atatürk", "sikeyim ataturk", "sikeyim senin atatürk", "sikeyim atatürkünü",
          "atatürke söv", "atatürk'e söv", "kamal piç", "selanikli piç", "deccal kamal",
          "put adam", "anitkabirini yik", "anıtkabirini yık", "anıtkabiri yık", "anıtkabir yıkılsın",
          "anıtkabir puthane", "anıtkabir'e dozer", "heykellerini yık", "heykellerini kır",
          "atatürk büstünü kır", "atatürk heykelini devir", "atatürk hain", "atatürke küfür",
          "atatürk orospu", "atatürk piç", "mustafa kemal piç", "atatürk geberdi", "atatürke lanet",
          "atatürke hakaret", "atatürk'e hakaret"
        ]
      },
      { id: 9, keywords: ["yasadışı bahis", "kaçak bahis", "canlı bahis oyna", "kaçak iddaa", "bahis sitesi giriş", "bonus veren bahis"] },
    ];

    for (const rule of rules) {
      if (rule.id === 8 && isDefense) continue;
      for (const kw of rule.keywords) {
        if (lower.includes(kw)) return rule.id;
      }
    }

    return null;
  }

  // ============================================================
  // VARSAYILAN AÇIKLAMA
  // ============================================================
  function buildDefaultDescription(tweetInfo) {
    let desc = `Twitter/X platformunda bulunan aşağıdaki paylaşımın ilgili mevzuat kapsamında incelenmesini rica ederim.\n\n`;
    desc += `Paylaşım Sahibi: ${tweetInfo.tweetAuthor}`;
    if (tweetInfo.tweetHandle) desc += ` (${tweetInfo.tweetHandle})`;
    desc += `\n\n`;
    desc += `Paylaşım İçeriği:\n"${tweetInfo.tweetText}"\n\n`;
    desc += `Paylaşım Adresi: ${tweetInfo.tweetUrl}\n\n`;
    if (tweetInfo.hasImage) desc += `Not: Paylaşımda görsel içerik bulunmaktadır.\n`;
    if (tweetInfo.hasVideo) desc += `Not: Paylaşımda video içerik bulunmaktadır.\n`;
    desc += `\nTespit Tarihi: ${new Date().toLocaleDateString("tr-TR")}`;
    return desc;
  }

  // ============================================================
  // TOAST BİLDİRİM (Anti-Slop / Modern Pill Design)
  // ============================================================
  function showToast(message, type) {
    const existing = document.getElementById("ihbarweb-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "ihbarweb-toast";

    let iconSvg = "";
    let iconColor = "#3b82f6";
    let borderColor = "#2d3542";

    if (type === "loading") {
      iconColor = "#60a5fa";
      iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="${iconColor}" stroke-width="2.5" stroke-linecap="round" style="animation:ihbarweb-spin 0.8s linear infinite;"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>`;
    } else if (type === "success") {
      iconColor = "#10b981";
      borderColor = "rgba(16, 185, 129, 0.3)";
      iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="${iconColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
    } else if (type === "warning") {
      iconColor = "#f59e0b";
      borderColor = "rgba(245, 158, 11, 0.3)";
      iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="${iconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 4.5 5.4v5.5c0 4.9 3.2 9.1 7.5 10.6 4.3-1.5 7.5-5.7 7.5-10.6V5.4L12 2.5Z"/><path d="M12 8v4m0 3v.1"/></svg>`;
    } else {
      iconColor = "#60a5fa";
      iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="${iconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>`;
    }

    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(16px);
      background: rgba(14, 17, 23, 0.94);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid ${borderColor};
      color: #f1f3f7;
      padding: 10px 18px;
      border-radius: 30px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      font-weight: 550;
      letter-spacing: -0.01em;
      z-index: 999999;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.04);
      opacity: 0;
      transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      max-width: 90vw;
      display: flex;
      align-items: center;
      gap: 10px;
      pointer-events: none;
    `;

    toast.innerHTML = `
      <span style="display:flex; align-items:center; flex-shrink:0;">${iconSvg}</span>
      <span style="line-height:1.35;">${message}</span>
    `;

    // Spinner CSS ekle (eğer yoksa)
    if (!document.getElementById("ihbarweb-toast-style")) {
      const style = document.createElement("style");
      style.id = "ihbarweb-toast-style";
      style.textContent = `@keyframes ihbarweb-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
      document.head.appendChild(style);
    }

    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateX(-50%) translateY(0)";
    });

    if (type !== "loading") {
      const duration = type === "warning" ? 4500 : 3200;
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(-50%) translateY(10px)";
        setTimeout(() => toast.remove(), 200);
      }, duration);
    }
  }

  // ============================================================
  // ÜÇ NOKTA MENÜSÜNE BUTON EKLEME (TEK SEFER)
  // ============================================================
  function addIhbarButton(menuElement) {
    // Dropdown ve menü alt düğümlerini tek bir kökte birleştir; öğe yalnızca bir kez eklenir.
    menuElement = menuElement.closest('[data-testid="Dropdown"]') ||
      menuElement.closest('[role="menu"]') || menuElement;

    const existingItems = Array.from(menuElement.querySelectorAll('[data-ihbarweb]'));
    if (existingItems.length) {
      for (const duplicate of existingItems.slice(1)) {
        duplicate.remove();
      }
      return;
    }

    const menuItems = menuElement.querySelectorAll('[role="menuitem"]');
    if (menuItems.length === 0) return;

    // X'in kendi menü öğelerindeki span font özelliklerini referans al
    const referenceSpan = menuItems[0].querySelector("span") || menuItems[0];
    const refStyle = getComputedStyle(referenceSpan);
    const fontFamily = refStyle.fontFamily && !refStyle.fontFamily.includes("Times")
      ? refStyle.fontFamily
      : 'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    const fontSize = refStyle.fontSize || "15px";
    const fontWeight = refStyle.fontWeight || "700";
    const lineHeight = refStyle.lineHeight || "20px";

    const ihbarItem = document.createElement("div");
    ihbarItem.setAttribute("role", "menuitem");
    ihbarItem.setAttribute("data-ihbarweb", "true");
    ihbarItem.tabIndex = 0;
    ihbarItem.style.cssText = `
      padding: 12px 16px;
      cursor: pointer;
      transition: background-color 0.2s ease;
      display: flex;
      align-items: center;
      gap: 12px;
      user-select: none;
      -webkit-font-smoothing: antialiased;
      outline: none;
    `;
    ihbarItem.addEventListener("mouseenter", () => { ihbarItem.style.backgroundColor = "rgba(244, 33, 46, 0.1)"; });
    ihbarItem.addEventListener("mouseleave", () => { ihbarItem.style.backgroundColor = "transparent"; });
    ihbarItem.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:center; width:20px; height:20px; flex-shrink:0;">
        <svg viewBox="0 0 24 24" width="18.75" height="18.75" style="display:block; overflow:visible;">
          <path d="M12 2.5 4.5 5.4v5.5c0 4.9 3.2 9.1 7.5 10.6 4.3-1.5 7.5-5.7 7.5-10.6V5.4L12 2.5Z" 
                fill="none" stroke="#f4212e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M12 8v4.5m0 3v.5" fill="none" stroke="#f4212e" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <span style="
        font-family: ${fontFamily} !important;
        font-size: ${fontSize} !important;
        font-weight: ${fontWeight} !important;
        line-height: ${lineHeight} !important;
        color: #f4212e !important;
        letter-spacing: normal !important;
        font-style: normal !important;
        -webkit-font-smoothing: antialiased !important;
      ">İhbarWeb'e Bildir</span>
    `;

    ihbarItem.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Menüyü kapat
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));

      setTimeout(() => {
        const tweetInfo = getLastClickedTweetInfo();
        if (!tweetInfo.tweetUrl) tweetInfo.tweetUrl = window.location.href;
        sendToIhbarWeb(tweetInfo);
      }, 150);
    });

    // Gönderi daha önce ihbar edilmişse menüde belirt
    if (lastClickedTweetInfo.tweetUrl) {
      checkAlreadyReported(lastClickedTweetInfo.tweetUrl).then((res) => {
        if (res?.isReported) {
          const textSpan = ihbarItem.querySelector("span");
          const svgPaths = ihbarItem.querySelectorAll("path");
          if (textSpan) {
            textSpan.style.setProperty("color", "#2ecc71", "important");
            textSpan.textContent = "İhbarWeb'e Bildirildi ✓";
          }
          svgPaths.forEach((p) => p.setAttribute("stroke", "#2ecc71"));
        }
      });
    }

    const menuContainer = menuElement.querySelector('[role="group"]') || menuElement;
    menuContainer.appendChild(ihbarItem);
  }

  // Son tıklanan tweet bilgisi
  let lastClickedTweetInfo = { tweetUrl: "", tweetText: "", tweetAuthor: "", tweetHandle: "", hasImage: false, hasVideo: false };

  function getLastClickedTweetInfo() {
    return lastClickedTweetInfo;
  }

  function trackMoreButtons() {
    document.addEventListener("click", (e) => {
      const target = e.target instanceof Element ? e.target : e.target?.parentElement;
      const moreButton = target?.closest('[data-testid="caret"]');
      if (moreButton) {
        const article = moreButton.closest("article");
        if (article) lastClickedTweetInfo = extractTweetInfo(article);
      }
    }, true);
  }

  function observeDropdownMenus() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          let dropdown =
            node.matches?.('[data-testid="Dropdown"]') ? node :
              node.closest?.('[data-testid="Dropdown"]') ||
              node.querySelector?.('[data-testid="Dropdown"]');

          if (!dropdown) {
            dropdown =
              node.matches?.('[role="menu"]') ? node :
                node.closest?.('[role="menu"]') ||
                node.querySelector?.('[role="menu"]');
          }

          if (dropdown) {
            setTimeout(() => addIhbarButton(dropdown), 50);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function addTweetActionButton(article) {
    const existingButtons = article.querySelectorAll("[data-ihbarweb-action]");
    if (existingButtons.length) {
      existingButtons.forEach((button, index) => {
        if (index > 0) button.remove();
      });
      return;
    }

    const actionGroups = Array.from(article.querySelectorAll('[role="group"]'));
    const actionGroup = actionGroups.find((group) =>
      group.querySelector('[data-testid="reply"], [data-testid="retweet"], [data-testid="like"], [data-testid="unlike"]')
    ) || actionGroups[0];
    if (!actionGroup) return;

    const reportButton = document.createElement("button");
    reportButton.type = "button";
    reportButton.setAttribute("data-ihbarweb-action", "true");
    reportButton.setAttribute("aria-label", "İhbarWeb'e bildir");
    reportButton.setAttribute("title", "İhbarWeb'e bildir");
    reportButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 2.5 4.5 5.4v5.5c0 4.9 3.2 9.1 7.5 10.6 4.3-1.5 7.5-5.7 7.5-10.6V5.4L12 2.5Z" />
        <path d="M12 8v4.2m0 3.2v.1" />
      </svg>
    `;
    reportButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendToIhbarWeb(extractTweetInfo(article));
    });

    // Daha önce ihbar edilmişse butonu yeşil yap (çift denetim ile kaçırma önleme)
    function checkAndApplyState() {
      const info = extractTweetInfo(article);
      if (info.tweetUrl) {
        checkAlreadyReported(info.tweetUrl).then((res) => {
          if (res?.isReported) {
            reportButton.style.setProperty("color", "#2ecc71", "important");
            reportButton.setAttribute("title", "İhbarWeb'e Bildirildi ✓");
            reportButton.setAttribute("data-ihbarweb-reported", "true");
          }
        });
      }
    }

    checkAndApplyState();
    // Twitter zaman damgası bazen gecikmeli yüklendiği için 350ms sonra teyit et
    setTimeout(checkAndApplyState, 350);

    actionGroup.appendChild(reportButton);
  }

  // Canlı senkronizasyon: Yeni bir ihbar tamamlandığında sayfadaki butonları yenile
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.reportedPosts) {
        document.querySelectorAll("article").forEach((article) => {
          const btn = article.querySelector("[data-ihbarweb-action]");
          const info = extractTweetInfo(article);
          if (btn && info.tweetUrl) {
            checkAlreadyReported(info.tweetUrl).then((res) => {
              if (res?.isReported) {
                btn.style.setProperty("color", "#2ecc71", "important");
                btn.setAttribute("title", "İhbarWeb'e Bildirildi ✓");
              }
            });
          }
        });
      }
    });
  } catch (_) { }

  function observeTweetActions() {
    const addFromNode = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const article = node.matches("article") ? node : node.closest("article");
      if (article) addTweetActionButton(article);
      node.querySelectorAll("article").forEach(addTweetActionButton);
    };

    document.querySelectorAll("article").forEach(addTweetActionButton);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) addFromNode(node);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Başlat
  function init() {
    trackMoreButtons();
    observeDropdownMenus();
    observeTweetActions();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
