// İhbarWeb Gönderi Bildirici - Popup Script

// İstatistikleri ve kayıtlı gönderi sayısını yükle
async function loadStats() {
  try {
    const result = await chrome.storage.local.get([
      "totalReports",
      "todayReports",
      "lastReportDate",
      "reportedPosts"
    ]);

    const today = new Date().toISOString().split("T")[0];

    let todayReports = result.todayReports || 0;
    if (result.lastReportDate !== today) {
      await chrome.storage.local.set({ todayReports: 0, lastReportDate: today });
      todayReports = 0;
    }

    const reportedPostsCount = Object.keys(result.reportedPosts || {}).length;

    document.getElementById("totalReports").textContent = result.totalReports || 0;
    document.getElementById("todayReports").textContent = todayReports;
    document.getElementById("savedPosts").textContent = reportedPostsCount;
  } catch (error) {
    console.error("Stats yüklenemedi:", error);
  }
}

// API Key durumunu kontrol et
async function checkApiKey() {
  try {
    const result = await chrome.storage.local.get("geminiApiKey");
    const statusPill = document.getElementById("apiStatus");
    const statusText = document.getElementById("apiStatusText");
    const inputEl = document.getElementById("apiKeyInput");

    if (result.geminiApiKey && result.geminiApiKey.trim().length > 15) {
      statusPill.className = "status-pill connected";
      statusText.textContent = "Aktif";
      inputEl.placeholder = "Kayıtlı anahtar mevcut (değiştirmek için yazın)";
    } else {
      statusPill.className = "status-pill disconnected";
      statusText.textContent = "İsteğe Bağlı";
      inputEl.placeholder = "API anahtarını girin";
    }
  } catch (error) {
    console.error("API key kontrol hatası:", error);
  }
}

// API Key kaydet
document.getElementById("saveApiKey").addEventListener("click", async () => {
  const input = document.getElementById("apiKeyInput");
  const key = input.value.trim();
  const btn = document.getElementById("saveApiKey");

  if (!key) {
    await chrome.storage.local.remove("geminiApiKey");
    checkApiKey();
    return;
  }

  await chrome.storage.local.set({ geminiApiKey: key });
  input.value = "";
  checkApiKey();

  btn.textContent = "Kaydedildi";
  btn.classList.add("saved");
  setTimeout(() => {
    btn.textContent = "Kaydet";
    btn.classList.remove("saved");
  }, 2000);
});

loadStats();
checkApiKey();
