# event-extractor

Instagram postu, tweet, LinkedIn gönderisi veya herhangi bir web sayfası linkinden etkinlik bilgisi çıkaran Cloudflare Worker. Cloudflare Workers AI üzerindeki ucuz modelleri kullanır; harici bir API anahtarı gerektirmez.

Link verirsiniz, şu yapıda JSON alırsınız: **isim, açıklama, tarih, saat, konum**.

- Canlı API: `https://api.aicalendar.com.tr`
- Yedek adres: `https://event-extractor.hasancagrigungor.workers.dev`

## Kullanım

### GET

```bash
curl "https://api.aicalendar.com.tr/?url=https://www.instagram.com/p/DfWxgrrC_Ll/"
```

### POST

```bash
curl -X POST https://api.aicalendar.com.tr/ \
  -H "content-type: application/json" \
  -d '{"url":"https://x.com/biletinial/status/1913358125803180316"}'
```

### Metni hazır göndermek

İçeriği zaten çektiyseniz (ör. Apify ile), metni ve görsel URL'lerini doğrudan gönderebilirsiniz. Bu durumda worker sayfayı tekrar çekmez, sadece görselleri tarar ve etkinliği çıkarır.

```bash
curl -X POST https://api.aicalendar.com.tr/ \
  -H "content-type: application/json" \
  -d '{"url":"https://www.instagram.com/p/XXXX/","text":"Post açıklaması...","images":["https://.../gorsel.jpg"],"publishedAt":"2026-11-10T12:00:00Z"}'
```

### JavaScript

```js
const res = await fetch("https://api.aicalendar.com.tr/", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://www.linkedin.com/posts/..." }),
});
const event = await res.json();
console.log(event.isim, event.tarih, event.saat, event.konum);
```

### Örnek yanıt

```json
{
  "isim": "Bosphorus Open Air Metal Fest",
  "aciklama": "Altıncı yılında yeniden metal müziğin kalesi KüçükÇiftlik Park'ta gerçekleşecek festival.",
  "tarih": "2027-09-18",
  "saat": null,
  "konum": "KüçükÇiftlik Park, İstanbul",
  "etkinlik_mi": true,
  "kaynak": "instagram",
  "url": "https://www.instagram.com/p/DfWxgrrC_Ll/",
  "taranan_gorsel": 1,
  "ham": {
    "metin": "Bosphorus Open Air Metal Fest altıncı yılında yeniden ...",
    "gorsel_notlari": ["BOSPHORUS PRODUCTIONS PRESENTS ..."],
    "yayin_tarihi": null
  }
}
```

### Yanıt alanları

| Alan             | Açıklama |
|------------------|----------|
| `isim`           | Etkinlik adı, bulunamazsa `null` |
| `aciklama`       | 1-3 cümlelik Türkçe özet |
| `tarih`          | `YYYY-MM-DD`, bulunamazsa `null` |
| `saat`           | `HH:MM` (24 saat), bulunamazsa `null` |
| `konum`          | Mekan adı ve şehir |
| `etkinlik_mi`    | İçerik gerçekten bir etkinlik duyurusu mu |
| `kaynak`         | `instagram`, `twitter`, `linkedin` veya `web` |
| `taranan_gorsel` | Vision modeliyle taranan görsel sayısı |
| `kategori`       | Jev: `conference`, `summit`, `meetup`, `hackathon`, `workshop`, `webinar` veya `null` |
| `format`         | Jev: `in-person`, `online`, `hybrid` veya `null` |
| `ucretsiz`       | Jev: ücretsizse `true`, ücretliyse `false`, emin değilse `null` |
| `turkiye_mi`     | Jev: Türkiye'deyse veya Türkçe online etkinlikse `true`, emin değilse `null` |
| `siniflandirma`  | Jev'in olasılıkları, model adı veya hata |
| `ham`            | Debug: çekilen metin, görsellerden okunan notlar, yayın tarihi |

Model bilmediği alanı uydurmaz, `null` bırakır. Görselden okunan bilgi yalnızca metinde olmayan alanları doldurmak için kullanılır; metin her zaman önceliklidir.

### Hata yanıtları

| HTTP | Durum |
|------|-------|
| 400  | `url` eksik veya geçersiz |
| 401  | `API_KEY` tanımlıysa ve anahtar yanlışsa |
| 502  | İçerik çekilemedi (gizli hesap, silinmiş gönderi, erişim engeli) veya model hata verdi |

Sağlık kontrolü: `GET /health` → `{"ok": true}`

## Nasıl çalışır

| Kaynak    | Metin                                          | Görsel tarama |
|-----------|------------------------------------------------|---------------|
| Instagram | embed sayfası caption + og:description         | Evet (ilk `MAX_IMAGES` görsel) |
| Tweet     | Twitter syndication API, yedek fxtwitter       | Evet |
| LinkedIn  | herkese açık gönderi metni + og meta           | Evet |
| Web       | og meta + JSON-LD `Event` verisi + sayfa metni | Hayır (web sayfalarında detay zaten metinde olur) |

Akış:

1. Linkin kaynağı tespit edilir, metin ve görsel URL'leri toplanır.
2. Sosyal medya kaynaklarında her görsel vision modeline gönderilir; model yalnızca görselde yazan metni aktarır (OCR).
3. Metin + görsel notları, JSON şema zorunlu bir metin modeline verilir ve yapılandırılmış sonuç alınır.
4. Aynı anda Jev sınıflandırma modeline etkinlik mi, kategori, format, ücretsiz mi ve Türkiye'de mi soruları sorulur. Jev etkinlik olasılığını 0,35'in altında verirse `etkinlik_mi` false olur.

Modeller (`wrangler.jsonc` > `vars`):

| Değişken       | Varsayılan | Not |
|----------------|------------|-----|
| `TEXT_MODEL`   | `@cf/google/gemma-4-26b-a4b-it` | Bilgi çıkarma. JSON şema destekler, düşünme modu kapalı çalıştırılır. |
| `VISION_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | Afiş okuma. Aynı Gemma 4 modeli. |
| `CLASSIFIER_MODEL` | `typesafe/jev` | Olasılıklı sınıflandırma. Boş bırakılırsa atlanır. |
| `MAX_IMAGES`   | `3` | Gönderi başına taranacak en fazla görsel |

## Kurulum

```bash
git clone https://github.com/hasancagrigungor/event-worker.git
cd event-worker
npx wrangler login
npm run deploy
```

`wrangler.jsonc` içindeki `routes` satırı özel alan adı içindir; kendi hesabınızda kullanacaksanız silin veya kendi alan adınızla değiştirin.

### Jev için AI Gateway kredisi

`typesafe/jev` üçüncü taraf bir modeldir ve Cloudflare hesabındaki AI Gateway kredisiyle ücretlendirilir. Kredi yoksa Jev `2021: Insufficient AI Gateway credits` hatası verir. Worker bu durumda sınıflandırmayı atlar ve Gemma'nın sonucunu döndürür. Hata `siniflandirma.hata` alanında görünür. Kredi Cloudflare panelinde AI > AI Gateway bölümünden yüklenir.

### Llama 3.2 Vision lisans onayı (eski model)

Gemma 4'e geçmeden önce kullanılan `@cf/meta/llama-3.2-11b-vision-instruct` modeli hesap başına bir kez Meta lisans onayı ister. Onay vermeden önce model `5016` hatası döner. Onay için modele ham `agree` prompt'u göndermek gerekir; Cloudflare Playground bunu sohbet formatında gönderdiği için orada çalışmaz. En kolay yol, geçici olarak worker'a şu rotayı ekleyip tarayıcıdan bir kez açmaktır:

```js
if (new URL(request.url).pathname === "/agree-vision") {
  const r = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree" }).catch((e) => e.message);
  return new Response(JSON.stringify(r));
}
```

"You may now use the model" yanıtı başarı demektir. Sonra rotayı kaldırıp tekrar deploy edin. Onay vermek istemiyorsanız `VISION_MODEL` değerini `@cf/llava-hf/llava-1.5-7b-hf` yapın; o model onay istemez ama afiş okuması zayıftır.

### API anahtarı (isteğe bağlı)

```bash
npx wrangler secret put API_KEY
```

Tanımlanırsa istekler `Authorization: Bearer <key>` başlığı veya `?key=<key>` parametresiyle yapılmalıdır. Tanımlanmazsa API herkese açıktır.

### Geliştirme

```bash
npm run dev
```

## Sınırlamalar

- Instagram ve LinkedIn'de yalnızca herkese açık gönderiler çalışır.
- Instagram carousel'lerinde genelde ilk görsel alınır.
- Tweet'lerde video varsa kapak görseli taranır.
- Vision modeli küçük veya düşük çözünürlüklü afiş yazılarını yanlış okuyabilir; bu yüzden metin görsele üstün tutulur.
- Yıl yazmayan tarihlerde model, gönderinin yayın tarihinden sonraki en yakın yılı seçer.

## Lisans

MIT
