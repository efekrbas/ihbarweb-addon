// İhbarWeb Gönderi Bildirici - LinkedIn Content Script
// Copyright (c) 2026 Efe Kırbaş. All rights reserved. Proprietary software.
(function () {
  "use strict";

  if (window.__ihbarWebLinkedInInitialized) return;
  window.__ihbarWebLinkedInInitialized = true;

  const POST_CONTAINER_SELECTOR = [
    ".feed-shared-update-v2",
    ".occludable-update",
    "[data-urn*='urn:li:activity:']",
    "[data-urn*='urn:li:ugcPost:']",
    "[data-urn*='urn:li:share:']",
    "[data-id*='urn:li:activity:']",
    "[data-view-name*='feed-full-update']",
    ".profile-creator-shared-feed-update__container",
    ".feed-shared-update-v2__control-menu",
    "article",
    ".artdeco-card"
  ].join(", ");

  let lastClickedPost = null;
  let lastClickedPostAt = 0;

  // ============================================================
  // GÖNDERİ BİLGİLERİNİ ÇIKARMA
  // ============================================================
  function extractPostInfo(postElement) {
    if (!postElement) {
      return { postUrl: location.href, postText: "", author: "", authorProfile: "", hasImage: false, hasVideo: false };
    }

    let postUrl = "";
    // 1. Doğrudan aktivite bağlantısını ara
    const postLink = postElement.querySelector(
      'a[href*="/feed/update/urn:li:"], a[href*="activity-"], a[href*="activity:"], a[href*="/feed/update/"]'
    );
    if (postLink) {
      try {
        postUrl = new URL(postLink.getAttribute("href"), location.origin).href;
      } catch (_) {}
    }

    // 2. data-urn veya data-id üzerinden URN ara
    if (!postUrl) {
      const urnEl = postElement.matches("[data-urn], [data-id]")
        ? postElement
        : postElement.querySelector("[data-urn], [data-id]");
      const urn = urnEl?.getAttribute("data-urn") || urnEl?.getAttribute("data-id") || "";
      if (/^urn:li:(activity|ugcPost|share):/.test(urn)) {
        postUrl = `${location.origin}/feed/update/${urn}/`;
      }
    }

    // 3. Zaman damgası bağlantısını ara
    if (!postUrl) {
      const timeLink = postElement.querySelector("time")?.closest("a");
      if (timeLink?.href) {
        postUrl = timeLink.href;
      }
    }

    if (!postUrl) {
      postUrl = location.href;
    }

    // Gönderi Metni
    const textEl = postElement.querySelector(
      ".update-components-text, .feed-shared-update-v2__description, [class*='feed-shared-text'], [class*='break-words'], p"
    );
    const postText = (textEl?.innerText || "").trim();

    // Gönderi Sahibi
    const authorEl = postElement.querySelector(
      ".update-components-actor__name, .feed-shared-actor__name, [class*='actor__name'], [class*='update-components-actor__title']"
    );
    const authorLink = postElement.querySelector('a[href*="/in/"]');
    const author = (authorEl?.innerText || authorLink?.innerText || "").trim().split("\n")[0];
    const authorProfile = authorLink?.href || "";

    const hasImage = !!postElement.querySelector(
      ".update-components-image, .feed-shared-image, img.feed-shared-article__image"
    );
    const hasVideo = !!postElement.querySelector("video, .feed-shared-video");

    return { postUrl, postText, author, authorProfile, hasImage, hasVideo };
  }

  function buildDescription(info) {
    let description = "LinkedIn'de bulunan aşağıdaki paylaşımın ilgili mevzuat kapsamında incelenmesini rica ederim.\n\n";
    description += `Paylaşım Sahibi: ${info.author || "Belirtilmemiş"}`;
    if (info.authorProfile) description += ` (${info.authorProfile})`;
    description += `\n\nPaylaşım İçeriği:\n"${info.postText}"\n\n`;
    description += `Paylaşım Adresi: ${info.postUrl}\n\n`;
    if (info.hasImage) description += "Not: Paylaşımda görsel içerik bulunmaktadır.\n";
    if (info.hasVideo) description += "Not: Paylaşımda video içerik bulunmaktadır.\n";
    description += `\nTespit Tarihi: ${new Date().toLocaleDateString("tr-TR")}`;
    return description;
  }

  function detectCategoryByKeywords(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    // Atatürk'ü savunan paylaşımları hariç tut
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
      { id: 8, keywords: [
        "atatürkünü sik", "ataturkunu sik", "atatürk'ünü sik", "atatürkü sik", "ataturku sik",
        "sikeyim atatürk", "sikeyim ataturk", "sikeyim senin atatürk", "sikeyim atatürkünü",
        "atatürke söv", "atatürk'e söv", "kamal piç", "selanikli piç", "deccal kamal",
        "put adam", "anitkabirini yik", "anıtkabirini yık", "anıtkabiri yık", "anıtkabir yıkılsın",
        "anıtkabir puthane", "anıtkabir'e dozer", "heykellerini yık", "heykellerini kır",
        "atatürk büstünü kır", "atatürk heykelini devir", "atatürk hain", "atatürke küfür",
        "atatürk orospu", "atatürk piç", "mustafa kemal piç", "atatürk geberdi", "atatürke lanet",
        "atatürke hakaret", "atatürk'e hakaret"
      ] },
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

  async function analyzeWithAI(info) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "analyzePost",
        post: {
          url: info.postUrl,
          text: info.postText,
          author: info.author,
          handle: info.authorProfile,
          hasImage: info.hasImage,
          hasVideo: info.hasVideo
        }
      });
      return response?.ok ? response.result : null;
    } catch (e) {
      console.error("[İhbarWeb LinkedIn] AI analizi yapılamadı:", e);
    }
    return null;
  }

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

  async function sendToIhbarWeb(info) {
    if (!info?.postUrl) {
      showToast("Gönderi bağlantısı bulunamadı. Gönderi menüsünden tekrar deneyin.", "error");
      return;
    }

    // MÜKERRER İHBAR KONTROLÜ
    const reportCheck = await checkAlreadyReported(info.postUrl);
    if (reportCheck?.isReported) {
      const dateStr = reportCheck.data?.reportedAt
        ? new Date(reportCheck.data.reportedAt).toLocaleString("tr-TR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
        : "";
      showToast(`Bu gönderi daha önce (${dateStr || "daha önce"}) İhbarWeb'e bildirilmiş. Mükerrer ihbara gerek yoktur.`, "info");
      return;
    }

    showToast("Gönderi 5651 Sayılı Kanun yönünden analiz ediliyor...", "loading");

    // Kural tabanlı açık ihlal denetimi (Regex / Anahtar kelimeler)
    const keywordCategory = detectCategoryByKeywords(info.postText);

    let category = null;
    let aiDescription = null;

    try {
      const aiResult = await analyzeWithAI(info);
      if (aiResult) {
        if (aiResult.hasViolation === true && aiResult.category > 0) {
          category = aiResult.category;
          aiDescription = aiResult.description;
        } else if (keywordCategory) {
          // AI çekingen davranmış veya argo/küfür karşısında kaçınmışsa kural motoru devreye girer
          category = keywordCategory;
        } else {
          // Hem AI hem kural motoru ihlal unsuru bulamadı
          const reason = aiResult.reason ? ` (${aiResult.reason})` : "";
          showToast(`İhlal Bulunamadı: Bu gönderide 5651 Sayılı Kanun kapsamındaki katalog suçlara dair bir unsur tespit edilemedi.${reason}`, "warning");
          return;
        }
      }
    } catch (err) {
      console.error("[İhbarWeb LinkedIn] AI hatası:", err);
    }

    // AI yanıt vermediyse veya API anahtarı yoksa kural motorunu kullan
    if (!category && keywordCategory) {
      category = keywordCategory;
    }

    if (!category) {
      showToast("İhlal Bulunamadı: Bu gönderide 5651 Sayılı Kanun kapsamındaki katalog suçlara ilişkin bir ihlal unsuru tespit edilemedi. İhbar başlatılmadı.", "warning");
      return;
    }

    chrome.runtime.sendMessage({
      action: "openIhbarWeb",
      data: {
        tweetUrl: info.postUrl,
        tweetText: info.postText,
        tweetAuthor: info.author,
        tweetHandle: info.authorProfile,
        hasImage: info.hasImage,
        hasVideo: info.hasVideo,
        category: category,
        manualCaptcha: true,
        description: aiDescription || buildDescription(info),
      },
    }, (response) => {
      if (chrome.runtime.lastError) {
        showToast("İhbarWeb açılamadı. Eklentiyi yenileyip tekrar deneyin.", "error");
      } else if (response?.success) {
        showToast("İhbarWeb açılıyor, form gönderi bilgileriyle doldurulacak.", "success");
      } else if (response?.error === "pending_report") {
        showToast("Önce açık olan ihbar işlemini tamamlayın.", "warning");
      } else if (response?.error === "already_reported") {
        showToast("Bu gönderi daha önce İhbarWeb'e bildirilmiş.", "info");
      } else if (response) {
        showToast("İhbarWeb açılamadı. Gönderi bağlantısını kontrol edip tekrar deneyin.", "warning");
      }
    });
  }

  function showToast(message, type) {
    document.getElementById("ihbarweb-linkedin-toast")?.remove();
    const toast = document.createElement("div");
    toast.id = "ihbarweb-linkedin-toast";

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

    const iconContainer = document.createElement("span");
    iconContainer.style.cssText = "display:flex; align-items:center; flex-shrink:0;";
    iconContainer.innerHTML = iconSvg;
    const messageElement = document.createElement("span");
    messageElement.style.lineHeight = "1.35";
    messageElement.textContent = String(message ?? "");
    toast.replaceChildren(iconContainer, messageElement);

    if (!document.getElementById("ihbarweb-linkedin-toast-style")) {
      const style = document.createElement("style");
      style.id = "ihbarweb-linkedin-toast-style";
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

  function shieldIconSvg(color = "currentColor", size = 20) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" style="display:block; overflow:visible;">
      <path d="M12 2.5 4.5 5.4v5.5c0 4.9 3.2 9.1 7.5 10.6 4.3-1.5 7.5-5.7 7.5-10.6V5.4L12 2.5Z" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M12 8v4.5m0 3v.5" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
  }

  // ============================================================
  // GÖNDERİ ÜÇ NOKTA MENÜSÜ KONTROLÜ
  // ============================================================
  // Açılan bir menünün gerçekten GÖNDERİ MENÜSÜ olup olmadığını denetler
  function isPostActionMenu(menuElement) {
    if (!menuElement) return false;

    // 1. Yasaklı Navbar, Profil "Ben" menüsü veya kenar çubuğu içindeyse ASLA gönderi menüsü değildir
    const inForbiddenArea = menuElement.closest(
      "header, nav, .global-nav, #global-nav, .global-nav__me, .global-nav__me-content, " +
      ".feed-identity-module, aside, .scaffold-layout__aside, .scaffold-layout__sidebar, " +
      ".msg-overlay-container, .msg-overlay-list-bubble, .search-global-typeahead, " +
      ".ad-banner-container, .premium-upsell"
    );
    if (inForbiddenArea) return false;

    // 2. Profil ("Ben" / "Me") menüsü metinleri kontrolü (Varsa derhal reddet)
    const text = (menuElement.innerText || menuElement.textContent || "").toLowerCase();
    const profilePhrases = [
      "oturum", "sign out", "ayarlar ve gizlilik", "settings & privacy",
      "profili görüntüle", "view profile", "yardım", "help", "premium özellik",
      "şirket: ", "company: ", "iş ilanı yayınlama", "manage posts & activity",
      "gönderiler ve faaliyet", "hesap yönetimi"
    ];
    if (profilePhrases.some((phrase) => text.includes(phrase))) {
      return false;
    }

    // 3. Gönderi menüsü ayırt edici metinleri (Görseldeki gibi: bağlantıyı kopyala, bildir, yerleştir, kaydet)
    const postMenuPhrases = [
      "bağlantıyı kopyala", "bağlantıyı kopyalayın", "copy link", "copy link to post",
      "gönderiyi bildir", "gönderiyi bildirin", "report post", "report this post",
      "bu gönderiyi yerleştir", "yerleştir", "embed this post",
      "gönderileri gizle", "tarafından yayınlanan gönderileri gizle", "hide this post",
      "kaydet", "save", "save for later",
      "ilgilenmiyorum", "not interested",
      "yapay zeka", "ai"
    ];
    if (postMenuPhrases.some((phrase) => text.includes(phrase))) {
      return true;
    }

    // 4. Doğrudan feed kontrol menüsü sınıfı
    if (menuElement.closest(".feed-shared-control-menu, [data-view-name*='control-menu']")) {
      return true;
    }

    return false;
  }

  // ============================================================
  // GÖNDERİ ÜÇ NOKTA MENÜSÜNE "İHBARWEB'E BİLDİR" EKLEME
  // ============================================================
  function addMenuItemToDropdown(menuContainer) {
    if (!menuContainer) return;

    // Sadece gerçek gönderi menüsüyse ekle
    if (!isPostActionMenu(menuContainer)) return;

    // Zaten eklenmiş mi kontrol et
    if (menuContainer.querySelector("[data-ihbarweb-linkedin-menu]")) {
      return;
    }

    const targetList = menuContainer.querySelector("ul") || menuContainer;
    if (targetList.querySelector("[data-ihbarweb-linkedin-menu]")) {
      return;
    }

    // Gönderiyi tespit et
    let post = menuContainer.closest(POST_CONTAINER_SELECTOR);
    if (!post) {
      // Menünün açıldığı aktif tetikleyici butonundan gönderiyi bul
      const activeTrigger = document.querySelector(
        'button[aria-expanded="true"].feed-shared-control-menu__trigger, ' +
        'button[aria-expanded="true"][aria-label*="seçenek"], ' +
        'button[aria-expanded="true"][aria-label*="kontrol"], ' +
        'button[aria-expanded="true"][aria-label*="more"], ' +
        'button[aria-expanded="true"][aria-label*="option"]'
      );
      if (activeTrigger) {
        post = activeTrigger.closest(POST_CONTAINER_SELECTOR);
      }
    }
    if (!post && lastClickedPost && Date.now() - lastClickedPostAt < 15000) {
      post = lastClickedPost;
    }

    const postInfo = extractPostInfo(post);

    // Menü öğesini oluştur
    const itemContainer = document.createElement(targetList.tagName === "UL" ? "li" : "div");
    itemContainer.setAttribute("data-ihbarweb-linkedin-menu", "true");
    itemContainer.style.cssText = "list-style: none; margin: 0; padding: 0;";

    const actionDiv = document.createElement("div");
    actionDiv.setAttribute("role", "button");
    actionDiv.setAttribute("tabindex", "0");
    actionDiv.className = "artdeco-dropdown__item artdeco-dropdown__item--is-dropdown ember-view ihbarweb-linkedin-menu-item";
    actionDiv.style.cssText = `
      display: flex !important;
      align-items: center !important;
      gap: 12px !important;
      padding: 12px 16px !important;
      cursor: pointer !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
      font-size: 14px !important;
      font-weight: 600 !important;
      color: #f4212e !important;
      transition: background-color 0.15s ease !important;
      user-select: none !important;
      text-decoration: none !important;
    `;

    actionDiv.innerHTML = `
      ${shieldIconSvg("#f4212e", 20)}
      <span style="color: #f4212e !important; font-weight: 600 !important;">İhbarWeb'e Bildir</span>
    `;

    actionDiv.addEventListener("mouseenter", () => {
      actionDiv.style.setProperty("background-color", "rgba(244, 33, 46, 0.08)", "important");
    });
    actionDiv.addEventListener("mouseleave", () => {
      actionDiv.style.setProperty("background-color", "transparent", "important");
    });

    const triggerReport = (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();

      // Menüyü kapat
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      setTimeout(() => {
        sendToIhbarWeb(postInfo);
      }, 100);
    };

    actionDiv.addEventListener("click", triggerReport);
    actionDiv.addEventListener("keydown", (e) => {
      if (!e.isTrusted) return;
      if (e.key === "Enter" || e.key === " ") triggerReport(e);
    });

    // Mükerrer ihbar kontrolü
    if (postInfo?.postUrl) {
      checkAlreadyReported(postInfo.postUrl).then((res) => {
        if (res?.isReported) {
          actionDiv.innerHTML = `
            ${shieldIconSvg("#2ecc71", 20)}
            <span style="color: #2ecc71 !important; font-weight: 600 !important;">İhbarWeb'e Bildirildi ✓</span>
          `;
        }
      });
    }

    itemContainer.appendChild(actionDiv);
    targetList.appendChild(itemContainer);
  }

  // ============================================================
  // GÖNDERİ İÇİNE X'TEKİ GİBİ BUTON EKLEME (AKSYİON ÇUBUĞU)
  // ============================================================
  function attachActionButton(bar) {
    if (!bar || bar.querySelector("[data-ihbarweb-linkedin-action]")) return;

    // Yasaklı üst menü veya sidebar içinde olamaz
    if (bar.closest("header, nav, .global-nav, aside, .scaffold-layout__aside")) return;

    // Gönderiyi bul
    const post = bar.closest(POST_CONTAINER_SELECTOR) || bar.closest("div[class*='update'], div[class*='feed'], li, article");

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-ihbarweb-linkedin-action", "true");
    button.setAttribute("aria-label", "İhbarWeb'e bildir");
    button.setAttribute("title", "İhbarWeb'e bildir");
    button.className = "ihbarweb-linkedin-action-btn";

    button.innerHTML = shieldIconSvg("currentColor", 19);

    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
      const info = extractPostInfo(post);
      sendToIhbarWeb(info);
    });

    // Mükerrer ihbar durumu denetimi
    function checkAndApply() {
      const info = extractPostInfo(post);
      if (info.postUrl) {
        checkAlreadyReported(info.postUrl).then((res) => {
          if (res?.isReported) {
            button.setAttribute("data-reported", "true");
            button.setAttribute("title", "İhbarWeb'e Bildirildi ✓");
            button.innerHTML = shieldIconSvg("#2ecc71", 19);
          }
        });
      }
    }

    checkAndApply();
    setTimeout(checkAndApply, 700);

    bar.appendChild(button);
  }

  // Sayfadaki tüm gönderilerin aksiyon çubuklarını bul ve butonu ekle
  function injectActionButtons() {
    // 1. Bilinen sosyal aksiyon çubukları
    const barSelectors = [
      ".feed-shared-social-action-bar",
      ".feed-shared-social-actions",
      ".social-details-social-actions",
      "[data-view-name*='feed-action-bar']",
      "[data-view-name*='feed-full-update-social-actions']",
      "[data-view-name*='social-actions']",
      "div.feed-shared-social-action-bar__action-button"
    ];
    document.querySelectorAll(barSelectors.join(", ")).forEach((bar) => {
      // Eğer tekil action button kapsayıcısıysa onun parent bar'ına ekle
      const targetBar = bar.classList.contains("feed-shared-social-action-bar__action-button")
        ? bar.parentElement
        : bar;
      if (targetBar) attachActionButton(targetBar);
    });

    // 2. Beğen / Yorum / Repost / Gönder butonlarının ebeveyni üzerinden bulma (Garantili yöntem)
    const actionButtons = document.querySelectorAll(
      "button[aria-label*='Beğen'], button[aria-label*='Like'], button.reactions-react-button, " +
      "button[aria-label*='Yorum'], button[aria-label*='Comment'], " +
      "button[aria-label*='Repost'], button[aria-label*='Paylaş'], button[aria-label*='Yeniden'], " +
      "button[aria-label*='Gönder'], button[aria-label*='Send'], button[aria-label*='İlet']"
    );

    actionButtons.forEach((btn) => {
      if (btn.closest("header, nav, .global-nav, aside")) return;
      const bar = btn.closest(
        ".feed-shared-social-action-bar, .feed-shared-social-actions, .social-details-social-actions, " +
        "[data-view-name*='feed-action-bar'], [data-view-name*='social-actions'], [role='toolbar'], [role='group']"
      ) || btn.parentElement;

      if (bar) {
        attachActionButton(bar);
      }
    });
  }

  // ============================================================
  // SAYFA OLAYLARI VE DROPDOWN DİNLEYİCİSİ
  // ============================================================
  function checkOpenDropdowns() {
    const dropdownSelectors = [
      ".artdeco-dropdown__content--is-open",
      ".artdeco-dropdown--is-open .artdeco-dropdown__content",
      ".artdeco-dropdown__content",
      ".feed-shared-control-menu__content",
      "div.artdeco-dropdown__content-inner",
      "[role='menu']"
    ];

    document.querySelectorAll(dropdownSelectors.join(", ")).forEach((dropdown) => {
      if (dropdown.getClientRects().length > 0) {
        addMenuItemToDropdown(dropdown);
      }
    });
  }

  function trackClicks() {
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (!target) return;

      // Kullanıcı herhangi bir gönderinin üç noktasına bastıysa o gönderiyi kaydet
      const trigger = target.closest(
        'button, [role="button"], .feed-shared-control-menu__trigger, .artdeco-dropdown__trigger'
      );
      if (trigger) {
        const post = trigger.closest(POST_CONTAINER_SELECTOR);
        if (post) {
          lastClickedPost = post;
          lastClickedPostAt = Date.now();
        }
      }

      // Menü açılmasını yakala
      setTimeout(checkOpenDropdowns, 30);
      setTimeout(checkOpenDropdowns, 100);
      setTimeout(checkOpenDropdowns, 250);
      setTimeout(checkOpenDropdowns, 500);
    }, true);
  }

  function observePage() {
    injectActionButtons();

    const observer = new MutationObserver((mutations) => {
      let shouldCheckButtons = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          shouldCheckButtons = true;

          // Yeni açılan dropdown varsa
          if (node.matches && (node.matches(".artdeco-dropdown__content, .feed-shared-control-menu__content, [role='menu']"))) {
            setTimeout(() => addMenuItemToDropdown(node), 20);
          }
          const sub = node.querySelector?.(".artdeco-dropdown__content, .feed-shared-control-menu__content, [role='menu']");
          if (sub) {
            setTimeout(() => addMenuItemToDropdown(sub), 20);
          }
        }

        if (mutation.type === "attributes" && (mutation.attributeName === "class" || mutation.attributeName === "aria-hidden")) {
          checkOpenDropdowns();
        }
      }

      if (shouldCheckButtons) {
        injectActionButtons();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-hidden", "aria-expanded"]
    });
  }

  // Canlı senkronizasyon: Yeni bir ihbar onaylandığında sayfadaki butonları yeşil yap
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.reportedPosts) {
        document.querySelectorAll("[data-ihbarweb-linkedin-action]").forEach((btn) => {
          const post = btn.closest(POST_CONTAINER_SELECTOR);
          const info = extractPostInfo(post);
          if (info.postUrl) {
            checkAlreadyReported(info.postUrl).then((res) => {
              if (res?.isReported) {
                btn.setAttribute("data-reported", "true");
                btn.setAttribute("title", "İhbarWeb'e Bildirildi ✓");
                btn.innerHTML = shieldIconSvg("#2ecc71", 19);
              }
            });
          }
        });
      }
    });
  } catch (_) {}

  function init() {
    trackClicks();
    observePage();
    setInterval(injectActionButtons, 1000);
    setInterval(checkOpenDropdowns, 800);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
