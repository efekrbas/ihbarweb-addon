# 🛡️ İhbarWeb Gönderi Bildirici

Twitter/X ve LinkedIn üzerindeki gönderileri [ihbarweb.org.tr](https://ihbarweb.org.tr) üzerinden bildirme sürecini kolaylaştıran Chrome eklentisi.

## 📋 Özellikler

- **Otomatik Sekme Kapatma (Geri Sayımlı):** İhbar başarıyla tamamlandığında 5 saniyelik geri sayım başlar ve sekme otomatik kapatılır; dileyen kullanıcı tek tıkla "Sekmeyi Açık Tut" seçeneğini kullanabilir.
- **Mükerrer İhbar Koruması:** Daha önce İhbarWeb'e bildirdiğiniz bir gönderiyi tekrar bildirmeye çalıştığınızda sistem bunu tespit eder, mükerrer ihbarı engeller ve menüde/butonda yeşil tik (`İhbarWeb'e Bildirildi ✓`) ile gösterir.
- **Akıllı İhlal Filtresi (AI Destekli):** Gönderide 5651 Sayılı Kanun kapsamındaki 9 katalog suçtan biri bulunmuyorsa yersiz ihbarları önlemek için ihbar başlatılmaz ve kullanıcı bilgilendirilir.
- **Tek Tıkla İhbar:** Gönderi altındaki kalkan butonuna tıklayarak hızlıca ihbar başlatın
- **Üç Nokta Menü Entegrasyonu:** X ve LinkedIn gönderilerinin ⋯ menüsünde "İhbarWeb'e Bildir" seçeneği
- **LinkedIn Desteği:** LinkedIn gönderi menüsünde ve gönderi işlem çubuğunda İhbarWeb kısayolu
- **Otomatik Form Doldurma:** Gönderi URL'si, içeriği ve açıklaması otomatik olarak ihbarweb formuna aktarılır
- **9 Suç Kategorisi:** 5651 Sayılı Kanun'un 8. maddesindeki tüm katalog suçlar desteklenir
- **Şık Arayüz:** Twitter/X'in karanlık temasıyla uyumlu modern tasarım

## 🏛️ Desteklenen Kategoriler (5651/8)

| # | Kategori |
|---|----------|
| 1 | İntihara Yönlendirme |
| 2 | Çocukların Cinsel İstismarı |
| 3 | Uyuşturucu Veya Uyarıcı Madde Kullanımını Kolaylaştırma |
| 4 | Sağlık İçin Tehlikeli Madde Temini |
| 5 | Müstehcenlik |
| 6 | Fuhuş |
| 7 | Kumar |
| 8 | Atatürk Aleyhine İşlenen Suçlar |
| 9 | Yasadışı Bahis |

## 🚀 Kurulum

1. Bu repoyu klonlayın veya indirin
2. Chrome'da `chrome://extensions` adresine gidin
3. Sağ üstten **"Geliştirici modu"**nu açın
4. **"Paketlenmemiş öğe yükle"** butonuna tıklayın
5. `ihbarweb-addon` klasörünü seçin

## 📖 Kullanım

1. **Twitter/X veya LinkedIn** üzerinde bildirmek istediğiniz gönderiyi bulun
2. Gönderi altındaki **🛡️ kalkan** simgesine ya da ⋯ menüsündeki "İhbarWeb'e Bildir" seçeneğine tıklayın
3. Açılan modalda **ihbar kategorisini** seçin
4. **"İhbar Et"** butonuna basın
5. İhbarweb.org.tr otomatik olarak açılacak ve form doldurulacak
6. Bilgileri kontrol edip **gönderin**

## 📁 Dosya Yapısı

```
ihbarweb-addon/
├── manifest.json          # Eklenti manifest dosyası (Manifest V3)
├── background.js          # Service worker (arka plan)
├── content-twitter.js     # Twitter/X content script
├── content-linkedin.js    # LinkedIn content script
├── content-ihbarweb.js    # ihbarweb.org.tr content script
├── styles.css             # Twitter UI stilleri
├── popup.html             # Eklenti popup arayüzü
├── popup.js               # Popup scripti
├── icons/                 # Eklenti ikonları
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## ⚖️ Yasal Bilgi

Bu eklenti, Bilgi Teknolojileri ve İletişim Kurumu (BTK) tarafından işletilen ihbarweb.org.tr'nin resmi bir ürünü değildir. 5651 Sayılı Kanun kapsamında vatandaşların internet suçlarını bildirme sürecini kolaylaştırmak amacıyla geliştirilmiştir.

## 📄 Telif Hakkı ve Lisans

© 2026 Efe Kırbaş. Tüm Hakları Saklıdır (All Rights Reserved).

Bu yazılımın kaynak kodları, tasarımı, görsel öğeleri ve algoritmaları telif hakkı koruması altındadır. Hak sahibinin açık yazılı izni olmaksızın:
- Kodların kısmen veya tamamen kopyalanması,
- Chrome Web Store veya başka herhangi bir eklenti mağazasında yayınlanması,
- Ticari veya gayriticari amaçla dağıtılması veya yeniden lisanslanması

**kesinlikle yasaktır.** İzinsiz kullanım, dağıtım veya mağaza yüklemeleri durumunda DMCA ve 5846 Sayılı Fikir ve Sanat Eserleri Kanunu kapsamında yasal işlem ve mağazadan kaldırma (takedown) süreci başlatılacaktır.
