/**
 * Event Extractor Worker
 *
 * GET  /?url=<link>
 * POST /  { "url": "<link>" }
 *
 * Kaynak türüne göre içerik toplar:
 *  - Instagram: açıklama (caption) + görseller (vision model ile taranır)
 *  - Twitter/X: tweet metni + görseller (vision model ile taranır)
 *  - Web sayfası: sayfa metni (görsel taranmaz)
 *
 * Çıktı: { isim, aciklama, tarih, saat, konum, ... }
 */

const UA_BOT =
  "Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)";
const UA_BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const EVENT_SCHEMA = {
  type: "object",
  properties: {
    isim: { type: ["string", "null"], description: "Etkinliğin adı" },
    aciklama: { type: ["string", "null"], description: "Etkinliğin kısa açıklaması (1-3 cümle)" },
    tarih: { type: ["string", "null"], description: "Etkinlik tarihi, YYYY-MM-DD formatında" },
    saat: { type: ["string", "null"], description: "Etkinlik başlangıç saati, HH:MM (24 saat) formatında" },
    konum: { type: ["string", "null"], description: "Mekan adı ve/veya şehir/adres" },
    saat_dilimi: {
      type: ["string", "null"],
      description: "Saatin ait olduğu IANA saat dilimi, ör. Europe/Istanbul, Europe/London, America/New_York",
    },
    etkinlik_mi: { type: "boolean", description: "İçerik gerçekten bir etkinlik duyurusu mu" },
  },
  required: ["isim", "aciklama", "tarih", "saat", "konum", "saat_dilimi", "etkinlik_mi"],
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS });

    const reqUrl = new URL(request.url);
    if (reqUrl.pathname === "/health") return json({ ok: true });

    if (env.API_KEY) {
      const auth = request.headers.get("authorization") || "";
      const key = auth.replace(/^Bearer\s+/i, "") || reqUrl.searchParams.get("key");
      if (key !== env.API_KEY) return json({ error: "unauthorized" }, 401);
    }

    // Link listesi için hızlı ön eleme (sayfalar açılmaz, sadece adreslere bakılır)
    // Hacker News içerik akışı: başlık AI ile ilgili mi? (karar modeli)
    if (reqUrl.pathname === "/ai-konu") {
      if (request.method !== "POST") return json({ error: "POST bekleniyor" }, 405);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "geçersiz JSON" }, 400);
      }
      const items = Array.isArray(body?.items) ? body.items.filter((i) => i && typeof i.title === "string").slice(0, 100) : [];
      if (!items.length) return json({ error: "items listesi gerekli: [{id, title, text?}]" }, 400);
      return json({ sonuclar: await classifyAiTopic(env, items) });
    }

    // Hacker News içerik akışı: başlık + açıklama + yorumlardan tek paragraf post yaz, 11 dile çevir
    if (reqUrl.pathname === "/post-yaz") {
      if (request.method !== "POST") return json({ error: "POST bekleniyor" }, 405);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "geçersiz JSON" }, 400);
      }
      if (!body?.baslik) return json({ error: "baslik gerekli" }, 400);
      try {
        // İsteğe bağlı model seçimi (karşılaştırma için), yalnızca izinli yazar modelleri
        const model = WRITER_MODELS.includes(body.model) ? body.model : env.POST_MODEL;
        // Panelden seçilirse Gemini (anahtar ve model adı istekle gelir, saklanmaz)
        const g = body.gemini;
        if (g && typeof g.key === "string" && g.key.trim() && /^[\w.\-]{3,80}$/.test(g.model || "")) {
          return json(await writeSocialPost({ ...env, GEMINI_KEY: g.key.trim(), POST_MODEL: `gemini/${g.model}` }, body));
        }
        return json(await writeSocialPost({ ...env, POST_MODEL: model }, body));
      } catch (e) {
        return json({ error: e.message || String(e) }, 502);
      }
    }

    // Stok görsel: içerikten Pexels için kısa İngilizce arama ifadeleri
    if (reqUrl.pathname === "/gorsel-sorgu") {
      if (request.method !== "POST") return json({ error: "POST bekleniyor" }, 405);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "geçersiz JSON" }, 400);
      }
      const metin = typeof body?.metin === "string" ? body.metin.trim().slice(0, 3000) : "";
      if (!metin) return json({ error: "metin gerekli" }, 400);
      try {
        return json({ sorgular: await stockQueries(env, metin) });
      } catch (e) {
        return json({ error: e.message || String(e) }, 502);
      }
    }

    // Stok görsel: aday görsellerin açıklamalarını (Pexels yolundaki ifade + alt metin) içerikle
    // embedding benzerliğine göre sıralar
    if (reqUrl.pathname === "/gorsel-sec") {
      if (request.method !== "POST") return json({ error: "POST bekleniyor" }, 405);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "geçersiz JSON" }, 400);
      }
      const metin = typeof body?.metin === "string" ? body.metin.trim().slice(0, 2000) : "";
      const adaylar = Array.isArray(body?.adaylar)
        ? body.adaylar.filter((a) => a && a.id != null && typeof a.aciklama === "string" && a.aciklama.trim()).slice(0, 200)
        : [];
      if (!metin || !adaylar.length) return json({ error: "metin ve adaylar [{id, aciklama}] gerekli" }, 400);
      try {
        return json({ model: env.EMBED_MODEL, siralama: await rankByEmbedding(env, metin, adaylar) });
      } catch (e) {
        return json({ error: e.message || String(e) }, 502);
      }
    }

    if (reqUrl.pathname === "/classify") {
      if (request.method !== "POST") return json({ error: "POST bekleniyor" }, 405);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "geçersiz JSON" }, 400);
      }
      const urls = Array.isArray(body?.urls) ? body.urls.filter((u) => typeof u === "string").slice(0, 100) : [];
      if (!urls.length) return json({ error: "urls listesi gerekli (en fazla 100)" }, 400);
      const kind = body?.tur === "sitemap" ? "sitemap" : "sayfa";
      return json({ sonuclar: await classifyUrls(env, urls, kind) });
    }

    let target = reqUrl.searchParams.get("url");
    let provided = null; // POST ile metin/görsel hazır gönderildiyse sayfa tekrar çekilmez
    let skipPrefilter = reqUrl.searchParams.get("prefilter") === "0";
    if (request.method === "POST") {
      try {
        const body = await request.json();
        if (body?.prefilter === false) skipPrefilter = true;
        target = body?.url || target;
        if (typeof body?.text === "string" && body.text.trim()) {
          provided = {
            text: body.text,
            images: Array.isArray(body.images) ? body.images.filter((x) => typeof x === "string") : [],
            publishedAt: body.publishedAt || null,
            author: body.author || undefined,
          };
        }
      } catch {
        /* ignore */
      }
    }
    if (!target) {
      return json(
        {
          error: "url parametresi gerekli",
          usage: { get: "/?url=https://...", post: '{ "url": "https://..." }' },
        },
        400
      );
    }
    try {
      target = new URL(target).toString();
    } catch {
      return json({ error: "geçersiz url" }, 400);
    }

    try {
      const source = detectSource(target);
      let content;
      if (provided) content = provided;
      else if (source === "instagram") content = await fetchInstagram(target);
      else if (source === "twitter") content = await fetchTweet(target);
      else if (source === "linkedin") content = await fetchLinkedIn(target);
      else content = await fetchWebPage(target);

      // Sosyal medya görsellerini bir kez indir; hem ön elemede hem OCR'da kullanılır
      const maxImages = Number(env.MAX_IMAGES || 3);
      const loaded =
        source === "web"
          ? []
          : await Promise.all(content.images.slice(0, maxImages).map((u) => loadImage(u).catch((e) => ({ url: u, error: e.message }))));

      // Ön eleme: OCR ve Gemma'dan önce, metin + ilk görsellere bakarak "etkinlik mi?" diye sor.
      const onEleme = skipPrefilter ? null : await prefilterText(env, source, content, loaded);
      if (onEleme?.elendi) {
        return json({
          isim: null,
          aciklama: null,
          tarih: null,
          saat: null,
          konum: null,
          etkinlik_mi: false,
          kategori: null,
          format: null,
          ucretsiz: null,
          turkiye_mi: null,
          on_eleme: onEleme,
          siniflandirma: null,
          kaynak: source,
          url: target,
          taranan_gorsel: 0,
          ham: { metin: content.text?.slice(0, 2000) || "", gorsel_notlari: [], yayin_tarihi: content.publishedAt || null },
        });
      }

      const imageNotes = [];
      if (source !== "web") {
        for (const img of loaded) {
          try {
            if (img.error) throw new Error(img.error);
            const note = await describeImage(env, img);
            if (note) imageNotes.push(note);
          } catch (e) {
            imageNotes.push(`(görsel okunamadı: ${e.message})`);
          }
        }
      }

      const [event, cls] = await Promise.all([
        extractEvent(env, { source, url: target, content, imageNotes }),
        classifyEvent(env, { source, content, imageNotes }),
      ]);

      // Jev "etkinlik değil" diyorsa (düşük olasılık) Gemma'nın kararını da geçersiz say
      if (cls && cls.etkinlik_olasiligi != null && cls.etkinlik_olasiligi < JEV_EVENT_THRESHOLD) {
        event.etkinlik_mi = false;
      }

      return json({
        ...event,
        kategori: cls?.kategori ?? null,
        format: cls?.format ?? null,
        ucretsiz: cls?.ucretsiz ?? null,
        turkiye_mi: cls?.turkiye_mi ?? null,
        on_eleme: onEleme,
        siniflandirma: cls,
        kaynak: source,
        url: target,
        taranan_gorsel: source === "web" ? 0 : Math.min(content.images.length, maxImages),
        ham: {
          metin: content.text?.slice(0, 2000) || "",
          gorsel_notlari: imageNotes,
          yayin_tarihi: content.publishedAt || null,
        },
      });
    } catch (e) {
      return json({ error: e.message || String(e) }, 502);
    }
  },
};

/* ---------------- kaynak tespiti ---------------- */

function detectSource(url) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") return "instagram";
  if (["twitter.com", "x.com", "mobile.twitter.com", "mobile.x.com", "fxtwitter.com", "vxtwitter.com"].includes(host))
    return "twitter";
  if (host === "linkedin.com" || host.endsWith(".linkedin.com") || host === "lnkd.in") return "linkedin";
  return "web";
}

/* ---------------- Instagram ---------------- */

async function fetchInstagram(url) {
  const m = url.match(/instagram\.com\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("Instagram post linki tanınamadı (p/ veya reel/ bekleniyor)");
  const shortcode = m[2];

  const images = new Set();
  let text = "";
  let publishedAt = null;

  // 1) embed/captioned sayfası: login istemeden caption ve görsel verir
  try {
    const r = await fetch(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
      headers: { "user-agent": UA_BROWSER, "accept-language": "en-US,en;q=0.9" },
    });
    if (r.ok) {
      const html = await r.text();
      const cap = html.match(/<div class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments"/i);
      if (cap) text = htmlToText(cap[1]).replace(/^\S+\s*/, "").trim(); // kullanıcı adını başından at
      const img = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/i);
      if (img) images.add(decodeEntities(img[1]));
      const t = html.match(/datetime="([^"]+)"/i);
      if (t) publishedAt = t[1];
    }
  } catch {
    /* ignore */
  }

  // 2) OG meta (bot UA ile)
  try {
    const r = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
      headers: { "user-agent": UA_BOT, "accept-language": "en-US,en;q=0.9" },
    });
    if (r.ok) {
      const html = await r.text();
      const og = parseOg(html);
      if (og.image) images.add(og.image);
      if (!text && og.description) {
        // "123 likes, 4 comments - user on Date: "caption""
        const q = og.description.match(/:\s*"([\s\S]*)"[\s.]*$/);
        text = q ? q[1] : og.description;
      }
      if (!text && og.title) text = og.title;
    }
  } catch {
    /* ignore */
  }

  if (!text && images.size === 0) throw new Error("Instagram içeriği alınamadı (gizli hesap veya erişim engeli)");
  return { text, images: [...images], publishedAt };
}

/* ---------------- Twitter / X ---------------- */

async function fetchTweet(url) {
  const m = url.match(/status(?:es)?\/(\d+)/);
  if (!m) throw new Error("Tweet linki tanınamadı (status/<id> bekleniyor)");
  const id = m[1];

  // 1) Twitter syndication API
  try {
    const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
    const r = await fetch(
      `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`,
      { headers: { "user-agent": UA_BROWSER } }
    );
    if (r.ok) {
      const d = await r.json();
      if (d?.text) {
        const images = [];
        for (const p of d.photos || []) if (p.url) images.push(p.url);
        for (const me of d.mediaDetails || []) {
          if (me.type === "photo" && me.media_url_https && !images.includes(me.media_url_https))
            images.push(me.media_url_https);
          if (me.type !== "photo" && me.media_url_https && images.length === 0) images.push(me.media_url_https); // video thumbnail
        }
        let text = d.text;
        if (d.quoted_tweet?.text) text += `\n\n[Alıntılanan tweet]: ${d.quoted_tweet.text}`;
        return { text, images, publishedAt: d.created_at || null, author: d.user?.name };
      }
    }
  } catch {
    /* ignore */
  }

  // 2) fxtwitter yedek
  const r = await fetch(`https://api.fxtwitter.com/status/${id}`, { headers: { "user-agent": UA_BROWSER } });
  if (!r.ok) throw new Error(`Tweet alınamadı (${r.status})`);
  const d = await r.json();
  const t = d?.tweet;
  if (!t) throw new Error("Tweet bulunamadı");
  const images = (t.media?.all || [])
    .map((x) => (x.type === "photo" ? x.url : x.thumbnail_url))
    .filter(Boolean);
  let text = t.text || "";
  if (t.quote?.text) text += `\n\n[Alıntılanan tweet]: ${t.quote.text}`;
  return { text, images, publishedAt: t.created_at || null, author: t.author?.name };
}

/* ---------------- LinkedIn ---------------- */

async function fetchLinkedIn(url) {
  // lnkd.in kısa linklerini ve yönlendirmeleri takip et
  const r = await fetch(url, {
    headers: {
      "user-agent": UA_BROWSER,
      accept: "text/html,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9,tr;q=0.8",
    },
    redirect: "follow",
  });
  const html = await r.text();
  if (!r.ok && !html.includes("og:")) throw new Error(`LinkedIn sayfası alınamadı (${r.status})`);

  const og = parseOg(html);
  const images = new Set();
  let text = "";
  let publishedAt = null;

  // Herkese açık gönderilerde tam metin bu blokta gelir
  const seg = html.match(/<p[^>]+class="[^"]*attributed-text-segment-list__content[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  if (seg) text = htmlToText(seg[1]);

  // Etkinlik sayfaları (linkedin.com/events/...)
  const eventDesc = html.match(/<p[^>]+class="[^"]*event-description[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  if (!text && eventDesc) text = htmlToText(eventDesc[1]);
  const eventTime = html.match(/<time[^>]*>([^<]+)<\/time>/i);
  if (eventTime) publishedAt = null, (text += (text ? "\n" : "") + "Zaman: " + htmlToText(eventTime[1]));

  if (!text && og.description) text = og.description;
  if (og.title && !/^(linkedin|sign in|login)/i.test(og.title)) {
    const t = og.title.replace(/\s*\|\s*LinkedIn\s*$/i, "").replace(/^.*? on LinkedIn:\s*/i, "").trim();
    const head = t.replace(/…|\.\.\.$/g, "").slice(0, 40).toLowerCase();
    if (head && !text.toLowerCase().includes(head)) text = `Başlık: ${t}\n${text}`;
  }

  // Gönderi görselleri (feedshare) + og:image
  const imgRe = /data-delayed-url="([^"]+)"/gi;
  let m;
  while ((m = imgRe.exec(html))) {
    const u = decodeEntities(m[1]);
    if (/feedshare-shrink|feedshare|image-shrink_800/i.test(u) && !/profile-displayphoto|company-logo|article-cover/i.test(u)) images.add(u);
  }
  if (og.image && !/static\.licdn\.com\/(aero-v1|sc\/h)/.test(og.image)) images.add(og.image);

  const t = html.match(/datePublished"?\s*[:=]\s*"([^"]+)"/i);
  if (t) publishedAt = t[1];

  const isAuthwall = /authwall|login\.linkedin|Sign in to LinkedIn/i.test(og.title || "") || (!text.trim() && images.size === 0);
  if (isAuthwall) throw new Error("LinkedIn içeriği alınamadı (gönderi herkese açık olmayabilir)");

  return { text, images: [...images], publishedAt };
}

/* ---------------- Web sayfası ---------------- */

// Sayfa metni bundan kısaysa ve JSON-LD etkinlik yoksa sayfa "boş JavaScript iskeleti" sayılır
const THIN_PAGE_CHARS = 200;

async function fetchWebPage(url) {
  let page = await readWebPage(url, UA_BROWSER);
  if (page.thin) {
    // Tek sayfa uygulamaları (Vue/React) bağlantı önizleme botlarına hazır HTML sunar; bir kez öyle dene
    try {
      const alt = await readWebPage(url, UA_BOT);
      if (!alt.thin || alt.length > page.length) page = alt;
    } catch {
      /* ilk sonuçla devam */
    }
  }
  if (page.thin) {
    throw new Error("Sayfa içeriği alınamadı (JavaScript ile yükleniyor olabilir)");
  }
  return { text: page.text, images: [], publishedAt: null };
}

async function readWebPage(url, ua) {
  const r = await fetch(url, {
    headers: { "user-agent": ua, accept: "text/html,*/*;q=0.8", "accept-language": "tr-TR,tr;q=0.9,en;q=0.8" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`Sayfa alınamadı (${r.status})`);
  const html = await r.text();
  const og = parseOg(html);

  // JSON-LD Event varsa en güvenilir kaynak
  const ld = extractJsonLdEvents(html);

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, " ");
  const main = body.match(/<main[\s\S]*?<\/main>/i) || body.match(/<article[\s\S]*?<\/article>/i);
  body = htmlToText(main ? main[0] : body);

  const parts = [];
  if (og.title) parts.push(`Başlık: ${og.title}`);
  if (og.description) parts.push(`Açıklama: ${og.description}`);
  if (ld.length) parts.push(`JSON-LD Event verisi: ${JSON.stringify(ld).slice(0, 3000)}`);
  parts.push(`Sayfa metni:\n${body.slice(0, 6000)}`);

  // Başlıkla aynı olan tek satırlık gövde (ör. "Let's share together | Kommunity") içerik sayılmaz
  const meaningful = body.replace(og.title || "\u0000", "").replace(/\s+/g, " ").trim();
  const thin = !ld.length && meaningful.length + (og.description || "").length < THIN_PAGE_CHARS;
  return { text: parts.join("\n\n"), thin, length: meaningful.length + (ld.length ? 10000 : 0) };
}

function extractJsonLdEvents(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const it of items) {
        const type = String(it?.["@type"] || "");
        if (/Event/i.test(type)) {
          out.push({
            name: it.name,
            description: it.description,
            startDate: it.startDate,
            endDate: it.endDate,
            location: it.location,
          });
        }
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/* ---------------- AI ---------------- */

/** Görseli indirir: { url, ct, buf, b64 } */
async function loadImage(url) {
  const r = await fetch(url, { headers: { "user-agent": UA_BROWSER } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 6 * 1024 * 1024) throw new Error("görsel çok büyük");
  const ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  return { url, ct, buf, b64: arrayBufferToBase64(buf) };
}

async function describeImage(env, img) {
  const { buf, ct } = img;
  const prompt =
    "You are an OCR tool. Transcribe ONLY the text that is actually visible in this image, exactly as written, line by line. " +
    "Do not translate, do not interpret, do not guess, do not add anything that is not written in the image. " +
    "If the image contains no readable text, reply with exactly: NO_TEXT. " +
    "After the transcription, add one short sentence (max 15 words) describing what the image shows.";

  let res;
  if (/llava|uform/i.test(env.VISION_MODEL)) {
    // LLaVA / UForm: ham byte dizisi + prompt
    res = await env.AI.run(env.VISION_MODEL, {
      image: [...new Uint8Array(buf)],
      prompt,
      max_tokens: 300,
      temperature: 0,
    });
  } else {
    // Gemma 4, Llama 3.2 vision vb.: messages + data URL
    const b64 = img.b64;
    res = await env.AI.run(env.VISION_MODEL, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${ct};base64,${b64}` } },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0,
      ...(isLegacyModel(env.VISION_MODEL) ? { repetition_penalty: 1.3 } : { chat_template_kwargs: { enable_thinking: false } }),
    });
  }
  let out = aiText(res).trim();
  // Model tekrara girerse (aynı cümleyi döngüyle yazarsa) kırp
  const sentences = out.split(/(?<=[.!?\n])\s+/);
  const seen = new Set();
  out = sentences.filter((x) => { const k = x.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; }).join(" ");
  if (/^NO_TEXT/i.test(out)) return "";
  return out.slice(0, 1500);
}

async function extractEvent(env, { source, url, content, imageNotes }) {
  const today = new Date().toISOString().slice(0, 10);
  const sourceLabel = { instagram: "Instagram gönderisi", twitter: "Tweet", linkedin: "LinkedIn gönderisi", web: "Web sayfası" }[source];

  const system =
    "Sen bir etkinlik bilgisi çıkarma asistanısın. Verilen içerikten etkinlik bilgilerini çıkarıp SADECE JSON döndürürsün. " +
    "Kurallar: Bilinmeyen alanlar için null kullan, uydurma. Tarihi YYYY-MM-DD, saati HH:MM (24 saat) formatında ver. " +
    "Yıl belirtilmemişse içeriğin yayın tarihinden sonraki en yakın uygun yılı seç. " +
    "Birden fazla tarih varsa başlangıç tarihini ver. Açıklama Türkçe, 1-3 cümle olsun. " +
    "Konum alanına mekan adı ve şehir yaz. " +
    "saat_dilimi alanına saatin ait olduğu IANA saat dilimini yaz: metinde açıkça belirtilmişse (ör. GMT+3, CET, EST, " +
    "\"Türkiye saatiyle\") onu, yoksa etkinliğin şehrine/ülkesine göre (İstanbul -> Europe/Istanbul, Londra -> Europe/London). " +
    "Online etkinlikte saat dilimi belirtilmemişse ve dil/kaynak bir ülkeyi işaret etmiyorsa null bırak. " +
    "ÖNEMLİ: İçerikte konser, tiyatro, söyleşi, festival, workshop, maç, sergi gibi gelecekte yapılacak bir etkinlik duyurusu yoksa " +
    "etkinlik_mi=false yap ve isim, tarih, saat, konum alanlarını null bırak; içeriğin yayın tarihini etkinlik tarihi olarak KULLANMA. " +
    "Görsellerden okunan notlar otomatik OCR çıktısıdır ve sık sık HATALI veya UYDURMA olur: içerik metni her zaman esastır. Metinde tarih/konum/isim varsa görsel notundaki farklı değerleri yok say. Görsel notunu SADECE metinde hiç geçmeyen bir alanı doldurmak için kullan ve ancak notta açıkça yazıyorsa. " +
    "Metinde veya görselde açıkça yazmayan hiçbir bilgiyi uydurma; saat yazmıyorsa (sadece \"akşam\" gibi ifadeler varsa) saat=null.";

  const user =
    `Bugünün tarihi: ${today}\n` +
    `Kaynak: ${sourceLabel}\nURL: ${url}\n` +
    (content.publishedAt ? `İçeriğin yayın tarihi: ${content.publishedAt}\n` : "") +
    (content.author ? `Yazar: ${content.author}\n` : "") +
    `\n=== İÇERİK METNİ ===\n${(content.text || "(metin yok)").slice(0, 8000)}\n` +
    (imageNotes.length
      ? `\n=== GÖRSELLERDEN OKUNAN BİLGİLER ===\n${imageNotes.map((n, i) => `[Görsel ${i + 1}]\n${n}`).join("\n\n")}\n`
      : "") +
    `\nBu bilgilerden etkinliği JSON olarak çıkar.`;

  const legacy = isLegacyModel(env.TEXT_MODEL);
  const res = await env.AI.run(env.TEXT_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: legacy
      ? { type: "json_schema", json_schema: EVENT_SCHEMA }
      : { type: "json_schema", json_schema: { name: "etkinlik", schema: EVENT_SCHEMA } },
    max_tokens: 512,
    temperature: 0.1,
    ...(legacy ? {} : { chat_template_kwargs: { enable_thinking: false } }),
  });

  let raw = res?.response ?? res?.choices?.[0]?.message?.content ?? res;
  let parsed = null;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) parsed = raw;
  else if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (!parsed) throw new Error("Model geçerli JSON döndürmedi");

  const clean = (v) => (typeof v === "string" && v.trim() && !/^(null|none|bilinmiyor|n\/a|-)$/i.test(v.trim()) ? v.trim() : null);
  return {
    isim: clean(parsed.isim),
    aciklama: clean(parsed.aciklama),
    tarih: normalizeDate(clean(parsed.tarih)),
    saat: normalizeTime(clean(parsed.saat)),
    konum: clean(parsed.konum),
    saat_dilimi: validTimeZone(clean(parsed.saat_dilimi)),
    etkinlik_mi: parsed.etkinlik_mi !== false,
  };
}

/* ---------------- Jev sınıflandırma ---------------- */

const JEV_EVENT_THRESHOLD = 0.35;
const CATEGORIES = ["conference", "summit", "meetup", "hackathon", "workshop", "webinar"];

/**
 * TypeSafe Jev ile olasılıklı sınıflandırma: etkinlik mi, kategori, format, ücretsiz mi, Türkiye'de mi.
 * Hata olursa null döner; çıkarma sonucu yine de kullanılır.
 */
async function classifyEvent(env, { source, content, imageNotes }) {
  if (!env.CLASSIFIER_MODEL) return null;
  const text = [
    (content.text || "").slice(0, 6000),
    ...imageNotes.map((n, i) => `[Görsel ${i + 1} metni] ${n}`),
  ].join("\n\n").trim();
  if (!text) return null;

  try {
    const res = await env.AI.run(env.CLASSIFIER_MODEL, {
      ...classifierExtra(env),
      state: { kaynak: source, yayin_tarihi: content.publishedAt || null, bugun: new Date().toISOString().slice(0, 10), icerik: text },
      questions: {
        etkinlik: {
          type: "noul",
          instructions:
            "Does `icerik` announce a specific event (conference, meetup, hackathon, workshop, webinar, summit, concert, festival, talk, competition, bootcamp) that people can attend in the future relative to `bugun`?",
          criteria: {
            true: "Announces a specific upcoming event with an attendable occurrence",
            false: "Not an event announcement, a past event recap, a job post, an ad, or general content",
          },
        },
        kategori: {
          type: "choice",
          instructions: "Which category best describes the event in `icerik`?",
          criteria: {
            conference: "Conference, congress, symposium, talk series, panel",
            summit: "Summit or forum",
            meetup: "Meetup, community gathering, networking",
            hackathon: "Hackathon, datathon, ideathon, coding competition",
            workshop: "Workshop, hands-on training, bootcamp, course",
            webinar: "Webinar or online seminar",
            other: "Concert, festival, exhibition, sports or anything else",
          },
        },
        format: {
          type: "choice",
          instructions: "How will the event in `icerik` take place?",
          criteria: {
            "in-person": "Physical venue only",
            online: "Online only (Zoom, YouTube, Teams, webinar, livestream)",
            hybrid: "Both physical venue and online participation",
          },
        },
        ucretsiz: {
          type: "noul",
          instructions: "Is attending the event in `icerik` free of charge?",
          criteria: { true: "Explicitly free or no ticket price", false: "Paid ticket or price mentioned" },
        },
        turkiye: {
          type: "noul",
          instructions: "Does the event in `icerik` take place in Türkiye, or is it an online event aimed at a Turkish audience?",
          criteria: { true: "In a Turkish city or Turkish-language online event", false: "Outside Türkiye" },
        },
      },
    });
    const a = res?.answers || {};
    const p = (q) => (typeof a[q]?.noul === "number" ? a[q].noul : null);
    const bool = (v, lo = 0.35, hi = 0.65) => (v == null ? null : v >= hi ? true : v <= lo ? false : null);
    const cat = a.kategori?.choice;
    return {
      model: res?.model || env.CLASSIFIER_MODEL,
      etkinlik_olasiligi: p("etkinlik"),
      kategori: CATEGORIES.includes(cat) && (a.kategori?.confidence ?? 1) >= 0.4 ? cat : null,
      kategori_olasiliklari: a.kategori?.probabilities || null,
      format: ["in-person", "online", "hybrid"].includes(a.format?.choice) && (a.format?.confidence ?? 1) >= 0.4 ? a.format.choice : null,
      ucretsiz: bool(p("ucretsiz")),
      ucretsiz_olasiligi: p("ucretsiz"),
      turkiye_mi: bool(p("turkiye")),
      turkiye_olasiligi: p("turkiye"),
    };
  } catch (e) {
    return { hata: e.message || String(e) };
  }
}

/* ---------------- Jev ön eleme ---------------- */

// Ön elemede bu olasılığın altı elenir. Bilerek düşük: şüpheli içerik elenmez, Gemma'ya gider.
const PREFILTER_THRESHOLD = 0.2;
const PREFILTER_MIN_TEXT = 40;
// clef-flash ön elemede en fazla bu kadar görsel (4 MiB'den küçük PNG/JPEG/WebP) görür
const PREFILTER_MAX_IMAGES = 2;
const CLEF_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * Metne bakarak hızlı "etkinlik duyurusu mu?" kontrolü.
 * Döner: null (yapılmadı) | { olasilik, elendi, hata? }. Jev hata verirse elenmez (fail-open).
 */
async function prefilterText(env, source, content, loaded = []) {
  if (!env.CLASSIFIER_MODEL) return null;
  const text = (content.text || "").trim();
  // Görseller yalnızca clef modellerine gönderilebilir (Jev'de görsel beta)
  const images = classifierExtra(env).model
    ? loaded
        .filter((i) => i && !i.error && CLEF_IMAGE_TYPES.includes(i.ct) && i.buf.byteLength <= 4 * 1024 * 1024)
        .slice(0, PREFILTER_MAX_IMAGES)
        .map((i) => `data:${i.ct};base64,${i.b64}`)
    : [];
  // Ne yeterli metin ne görsel varsa karar verilemez: elenmez
  if (text.length < PREFILTER_MIN_TEXT && !images.length) return { yapilmadi: "metin çok kısa, görsel yok", elendi: false };
  try {
    const res = await env.AI.run(env.CLASSIFIER_MODEL, {
      ...classifierExtra(env),
      ...(images.length ? { images } : {}),
      state: {
        kaynak: source,
        bugun: new Date().toISOString().slice(0, 10),
        icerik: text.slice(0, 6000) || "(metin yok, bilgi görselde)",
        not: images.length ? "Görseller (afiş vb.) içeriğin parçasıdır; görseldeki yazıları da değerlendir." : undefined,
      },
      questions: {
        etkinlik: {
          type: "noul",
          instructions:
            "Does this post (`icerik` and any attached images such as posters) announce or promote a specific event (conference, meetup, hackathon, datathon, workshop, " +
            "webinar, summit, bootcamp, talk, competition, concert, festival) that people can attend or register for?",
          criteria: {
            true: "Announces or promotes a specific event people can attend or join",
            false: "General content, opinion, news, job post, product ad, or recap without an attendable event",
          },
        },
      },
    });
    const p = res?.answers?.etkinlik?.noul;
    if (typeof p !== "number") return { hata: "Sınıflandırıcı yanıtı okunamadı", elendi: false };
    return { olasilik: p, elendi: p < PREFILTER_THRESHOLD, gorsel: images.length };
  } catch (e) {
    return { hata: e.message || String(e), elendi: false };
  }
}

/**
 * Link listesini sadece adreslerine bakarak sınıflandırır (sayfalar açılmaz).
 * Her link için { url, olasilik, etkinlik_mi } döner; Jev hata verirse olasilik=null, etkinlik_mi=null.
 */
async function classifyUrls(env, urls, kind = "sayfa") {
  const question =
    kind === "sitemap"
      ? {
          type: "noul",
          instructions:
            "`url` is a sitemap file of a website. Judging from its name and path, is it likely to list pages of " +
            "specific events (conferences, meetups, hackathons, workshops, webinars, bootcamps, competitions)?",
          criteria: {
            true: "Its name suggests events, activities, meetups, bootcamps, hackathons, programs or is a generic/unnamed sitemap",
            false: "Clearly about something else: blog, jobs, users, companies, products, dictionary, static pages, tags",
          },
        }
      : {
          type: "noul",
          instructions:
            "Judging only from `url` (domain and path words), is this page about ONE specific event " +
            "(e.g. a conference, meetup, hackathon, workshop, webinar, summit, bootcamp or competition page)?",
          criteria: {
            true: "A detail page for a single specific event",
            false: "A listing/category/tag page, blog post, news, job post, company, product, profile or other page",
          },
        };
  const one = async (url) => {
    if (!env.CLASSIFIER_MODEL) return { url, olasilik: null, etkinlik_mi: null, hata: "CLASSIFIER_MODEL tanımlı değil" };
    try {
      const res = await env.AI.run(env.CLASSIFIER_MODEL, {
      ...classifierExtra(env),
        state: { url },
        questions: { etkinlik_sayfasi: question },
      });
      const p = res?.answers?.etkinlik_sayfasi?.noul;
      if (typeof p !== "number") return { url, olasilik: null, etkinlik_mi: null, hata: "Jev yanıtı okunamadı" };
      return { url, olasilik: p, etkinlik_mi: p >= 0.5 };
    } catch (e) {
      return { url, olasilik: null, etkinlik_mi: null, hata: e.message || String(e) };
    }
  };
  // Aynı anda en fazla 6 istek
  const out = new Array(urls.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(6, urls.length) }, async () => {
    while (i < urls.length) {
      const k = i++;
      out[k] = await one(urls[k]);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------- Hacker News içerik akışı ---------------- */

// Türkçe dahil 11 büyük dil; post önce İngilizce yazılır, sonra çevrilir
const WRITER_MODELS = [
  "@cf/zai-org/glm-5.3",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/qwen/qwen3.8-27b",
  "@cf/google/gemma-4-26b-a4b-it",
];

const POST_LANGS = {
  en: "English",
  tr: "Turkish",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese (Brazil)",
  it: "Italian",
  ru: "Russian",
  ar: "Arabic",
  ja: "Japanese",
  zh: "Chinese (Simplified)",
};

async function classifyAiTopic(env, items) {
  const one = async (it) => {
    if (!env.CLASSIFIER_MODEL) return { id: it.id, olasilik: null, ai_mi: null, hata: "CLASSIFIER_MODEL tanımlı değil" };
    try {
      const res = await env.AI.run(env.CLASSIFIER_MODEL, {
        ...classifierExtra(env),
        state: { baslik: it.title, metin: (it.text || "").slice(0, 2000) },
        questions: {
          ai: {
            type: "noul",
            instructions:
              "Is this Hacker News post related to artificial intelligence, even loosely? Count AI/ML, LLMs, chatbots, " +
              "AI agents, AI companies and products, AI chips/GPUs/compute for AI, training data, AI policy/regulation/safety, " +
              "AI's impact on jobs, software or society, and robotics or computer vision.",
            criteria: { true: "Related to AI in any way", false: "No connection to AI" },
          },
        },
      });
      const p = res?.answers?.ai?.noul;
      if (typeof p !== "number") return { id: it.id, olasilik: null, ai_mi: null, hata: "yanıt okunamadı" };
      return { id: it.id, olasilik: p, ai_mi: p >= 0.5 };
    } catch (e) {
      return { id: it.id, olasilik: null, ai_mi: null, hata: e.message || String(e) };
    }
  };
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await one(items[k]);
      }
    })
  );
  return out;
}

/* ---------------- Stok görsel (Pexels) ---------------- */

/** İçerikten 3 kısa İngilizce Pexels arama ifadesi (hızlı model) */
async function stockQueries(env, metin) {
  const schema = {
    type: "object",
    properties: { sorgular: { type: "array", items: { type: "string" }, description: "2-4 words each, English" } },
    required: ["sorgular"],
  };
  const legacy = isLegacyModel(env.TEXT_MODEL);
  const res = await env.AI.run(env.TEXT_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "You pick stock photos. Given a text in any language, return 3 short English search queries (2-4 words each) " +
          "for a stock photo site (Pexels) that would find a fitting, realistic cover photo. Put the most specific query first.\n" +
          "Rules:\n" +
          "- Describe concrete visual scenes: people, places, objects. Use nouns a photographer would tag. No brand or product names, no text.\n" +
          "- FIRST decide the story type. If it is about a law, act, regulation, ban, lawsuit, court ruling or government policy " +
          "(even if the subject is AI or tech), this rule wins: the first two queries must be legal/government visuals such as " +
          "'judge gavel', 'courthouse columns', 'parliament building', 'government flags'; the third may be a tech visual.\n" +
          "- AI, machine learning, LLM, software, developer tools, chips or other tech news: use concrete tech visuals such as " +
          "'microchip close up', 'server racks data center', 'code on laptop screen', 'programmer at night', 'robot arm', " +
          "'humanoid robot', 'circuit board light', 'neural network light'. Pick what matches the story (hardware -> chips, " +
          "models/research -> neural network light or code screen, robotics -> robots, infrastructure -> data center).\n" +
          "- Avoid charts, graphs, stock market, business meeting, handshake and generic office scenes unless the text is " +
          "actually about finance, markets or a business deal. Avoid vague words like 'data', 'digital', 'concept', 'abstract' on their own.\n" +
          "- Security or privacy news: 'padlock on keyboard', 'hacker hoodie laptop', 'security camera'.\n" +
          "- Events: show the kind of event (stage and audience, hackathon team with laptops, workshop table, meetup networking).\n" +
          "Return only JSON.",
      },
      { role: "user", content: metin },
    ],
    response_format: legacy
      ? { type: "json_schema", json_schema: schema }
      : { type: "json_schema", json_schema: { name: "sorgular", schema } },
    max_tokens: 200,
    temperature: 0.3,
    ...(legacy ? {} : { chat_template_kwargs: { enable_thinking: false } }),
  });
  const raw = res?.response ?? res?.choices?.[0]?.message?.content ?? res;
  const data = typeof raw === "string" ? parseJsonLoose(raw) : raw;
  const out = (Array.isArray(data?.sorgular) ? data.sorgular : [])
    .filter((q) => typeof q === "string" && q.trim())
    .map((q) => q.trim().replace(/[^\p{L}\p{N} \-]/gu, "").slice(0, 60))
    .filter(Boolean);
  return [...new Set(out)].slice(0, 4);
}

/** bge-m3 sorgu-bağlam modu: her aday için benzerlik puanı, büyükten küçüğe */
async function rankByEmbedding(env, metin, adaylar) {
  const scores = [];
  for (let i = 0; i < adaylar.length; i += 50) {
    const chunk = adaylar.slice(i, i + 50);
    const res = await env.AI.run(env.EMBED_MODEL, {
      query: metin,
      contexts: chunk.map((a) => ({ text: a.aciklama.slice(0, 500) })),
      truncate_inputs: true,
    });
    for (const r of res?.response || []) {
      const a = chunk[r.id];
      if (a) scores.push({ id: a.id, skor: Math.round(r.score * 10000) / 10000 });
    }
  }
  return scores.sort((x, y) => y.skor - x.skor);
}

/** Güçlü modelle sohbet çağrısı; model ailesine göre düşünme kapatılır / azaltılır */
async function runWriter(env, messages, { maxTokens = 1200, schema = null, temperature = 0.6 } = {}) {
  const model = env.POST_MODEL;
  if (env.GEMINI_KEY) return runGemini(env, messages, { maxTokens, schema, temperature });
  const input = { messages, max_tokens: maxTokens, temperature };
  if (schema) input.response_format = { type: "json_schema", json_schema: { name: "cikti", schema } };
  // GLM düşünme modunu kapatma isteğini yok sayıyor: düşünmeyi kısalt ve düşünme için token payı bırak
  if (/zai-org|glm/i.test(model)) {
    input.reasoning_effort = "low";
    input.max_tokens = maxTokens + 3000;
  }
  else if (/kimi|deepseek/i.test(model)) {
    // Düşünme kapatılamazsa da cevap için yer kalsın
    input.chat_template_kwargs = { thinking: false, enable_thinking: false };
    input.max_tokens = maxTokens + 4000;
  }
  else if (/gemma-4|qwen3/i.test(model)) input.chat_template_kwargs = { enable_thinking: false };
  else if (/gpt-oss/i.test(model)) input.reasoning = { effort: "low" };
  const res = await env.AI.run(model, input);
  return aiText(res).trim();
}

/** Gemini (OpenAI uyumlu uç). Düşünen modellerde düşünme kısılır ve ona token payı bırakılır. */
async function runGemini(env, messages, { maxTokens, schema, temperature }) {
  const model = env.POST_MODEL.replace(/^gemini\//, "");
  const input = { model, messages, max_tokens: maxTokens + 3000, temperature, reasoning_effort: "low" };
  if (schema) input.response_format = { type: "json_schema", json_schema: { name: "cikti", schema } };
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.GEMINI_KEY}` },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Array.isArray(data) ? data[0]?.error : data?.error;
    throw new Error(`Gemini ${res.status}: ${err?.message || "istek başarısız"}`.slice(0, 300));
  }
  return aiText(data).trim();
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Model geçerli JSON döndürmedi");
  }
}

async function writeSocialPost(env, body) {
  const comments = (Array.isArray(body.yorumlar) ? body.yorumlar : [])
    .filter((c) => typeof c === "string" && c.trim())
    .slice(0, 60);
  let commentText = "";
  for (const c of comments) {
    if (commentText.length > 9000) break;
    commentText += `- ${c.replace(/\s+/g, " ").slice(0, 700)}\n`;
  }

  const system =
    "You are a sharp AI practitioner who posts on X and LinkedIn. You get a Hacker News title, the post text and the " +
    "community discussion. Write ONE post in English, 40-65 words and 3 sentences at most (hard limit: 70 words; " +
    "count them before answering). Short sentences; one idea per sentence.\n" +
    "What a good post does:\n" +
    "- First sentence is a hook that makes people stop scrolling: a surprising fact, a tension or a bold but defensible " +
    "claim. It names the subject (product, company or topic) so the post makes sense without the headline, but it does " +
    "not announce the news (no \"X just released Y\", no \"a new article says\").\n" +
    "- Then one concrete detail from the material (a number, a mechanism, a specific trade-off) that backs the hook.\n" +
    "- End with the so-what: why it matters for people building or using AI, or a short question worth answering.\n" +
    "- Write in your own voice as an informed person. Do not narrate the thread: never write \"commenters\", " +
    "\"the discussion\", \"people on HN\", \"one user\".\n" +
    "Accuracy:\n" +
    "- Use only facts that are in the material. Do not invent numbers, names, dates or events. Ignore jokes, sarcasm, " +
    "insults and off-topic replies, and do not turn one person's guess into a fact; say \"may\" when it is opinion.\n" +
    "- Every sentence must be clear on its own; no vague references like \"this\" or \"they\" without a subject.\n" +
    "Style: plain words, no clichés (\"game-changer\", \"the real story\", \"here's the thing\", \"buckle up\"), " +
    "no hashtags, emojis, links, quotes, bullet points or title. Output only the post.";
  const user =
    `Title: ${body.baslik}\n` +
    (body.link ? `Linked article (not read): ${body.link}\n` : "") +
    (body.metin ? `\nPost text:\n${String(body.metin).slice(0, 4000)}\n` : "") +
    (commentText ? `\nComments:\n${commentText}` : "\n(No comments yet.)\n");

  let en = await runWriter(env, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], { maxTokens: 600 });
  if (!en || en.length < 30) throw new Error("Post yazılamadı");
  // Uzun kaldıysa bir kez kısalt (anlamı ve kancayı koruyarak)
  if (en.split(/\s+/).length > 75) {
    try {
      const short = await runWriter(env, [
        {
          role: "system",
          content:
            "Shorten this social media post to 40-65 words and at most 3 sentences. Keep the hook, the most concrete " +
            "detail and the closing so-what. Do not add new facts. Output only the post.",
        },
        { role: "user", content: en },
      ], { maxTokens: 400, temperature: 0.3 });
      const n = short.split(/\s+/).length;
      if (n >= 25 && n < en.split(/\s+/).length) en = short;
    } catch {}
  }

  // Kart ve paylaşım için kısa, dikkat çekici başlık (postla tutarlı, abartısız)
  let title = "";
  try {
    title = (
      await runWriter(
        env,
        [
          {
            role: "system",
            content:
              "You write headlines for image cards on social media about AI and tech. The card shows only the headline in " +
              "big letters, so it must be short and instantly clear. Given a post and the original title, write ONE English " +
              "headline of 4-8 words, max 50 characters.\n" +
              "- One idea only. Name the subject (product, company or topic) and say what happened or why it matters, with " +
              "a strong verb or a number from the post. No colon-separated two-part headlines, no filler words.\n" +
              "- It must be true to the post: no exaggeration, no claims that are not in the post, no question-bait. Keep " +
              "technical terms exactly as the post uses them (asymmetric wing is not a two-wing or biplane).\n" +
              "- No quotes, no emojis, no hashtags, no ending period, no \"Breaking\". Title case is not required.\n" +
              "Output only the headline.",
          },
          { role: "user", content: `Original title: ${body.baslik}\n\nPost:\n${en}` },
        ],
        { maxTokens: 80, temperature: 0.7 }
      )
    )
      .split("\n")[0]
      .replace(/^["'“”‘’\s]+|["'“”‘’.\s]+$/g, "")
      .slice(0, 70);
  } catch {
    title = "";
  }
  if (title.length < 8) title = String(body.baslik).slice(0, 90);

  const targets = Object.entries(POST_LANGS).filter(([k]) => k !== "en");
  const translateSystem =
    "You are a professional social media translator. You get a headline and a post. Translate both into each requested " +
    "language so they read like a native tech writer's own news card and post on X or LinkedIn.\n" +
    "- Keep the full meaning of every sentence: no dropped, merged or added claims, and keep hedges like \"may\".\n" +
    "- Translate meaning, not words: idioms and jargon (e.g. \"moat\", \"frontier model\", a drone's \"launch\" meaning " +
    "take-off, not a product launch) must become the natural term a native expert would use.\n" +
    "- The headline is shown alone in big letters on an image: keep it as short as the English one (about the same " +
    "number of words, never longer than 60 characters; for Chinese and Japanese at most 20 characters), natural and " +
    "clear in the target language, not literal.\n" +
    "- Keep product, company and person names unchanged. Do not leave English words in the translation when the language " +
    "has a common native word (e.g. Turkish \"önem\" not \"relevans\"); keep only established tech terms. Keep the same " +
    "tone and similar length.\n" +
    "- Each post must be complete; never stop mid-sentence.\n" +
    "Return a JSON object whose keys are the language codes and values are objects {\"title\": ..., \"post\": ...}.";
  const translate = async (langs) => {
    const schema = {
      type: "object",
      properties: Object.fromEntries(
        langs.map(([k]) => [
          k,
          { type: "object", properties: { title: { type: "string" }, post: { type: "string" } }, required: ["title", "post"] },
        ])
      ),
      required: langs.map(([k]) => k),
    };
    try {
      const raw = await runWriter(
        env,
        [
          { role: "system", content: translateSystem },
          {
            role: "user",
            content: `Languages: ${langs.map(([k, n]) => `${k} = ${n}`).join(", ")}\n\nHeadline:\n${title}\n\nPost:\n${en}`,
          },
        ],
        { maxTokens: 800 * langs.length, schema, temperature: 0.2 }
      );
      return parseJsonLoose(raw);
    } catch {
      return {};
    }
  };
  // Yarıda kesilmiş çeviri: İngilizce noktalama ile bitiyor ama çeviri bitmiyor ya da çok kısa
  const complete = (t) =>
    typeof t === "string" && t.trim().length > en.length * 0.15 && (!/[.!?]$/.test(en) || /[.!?。！？؟…]$/.test(t.trim()));
  const cleanTitle = (t) => (typeof t === "string" ? t.trim().replace(/^["'“”«»「」]+|["'“”«»「」.。]+$/g, "").slice(0, 120) : "");

  const post = { en };
  const titles = { en: title };
  const take = (k, v) => {
    if (v && complete(v.post)) {
      post[k] = v.post.trim();
      titles[k] = cleanTitle(v.title) || title;
    }
  };
  const half = Math.ceil(targets.length / 2);
  const groups = await Promise.all([translate(targets.slice(0, half)), translate(targets.slice(half))]);
  for (const g of groups) for (const [k, v] of Object.entries(g)) if (POST_LANGS[k]) take(k, v);
  const retry = targets.filter(([k]) => !post[k]);
  const again = await Promise.all(retry.map((t) => translate([t])));
  retry.forEach(([k], i) => take(k, again[i][k]));
  for (const [k] of targets) {
    post[k] = post[k] || "";
    titles[k] = post[k] ? titles[k] : "";
  }
  const missing = targets.filter(([k]) => !post[k]).map(([k]) => k);
  return { post, baslik: titles, diller: Object.keys(POST_LANGS), eksik_dil: missing, model: env.POST_MODEL };
}

/* ---------------- yardımcılar ---------------- */

/** Sınıflandırıcıya özel ek alanlar: Cloudflare clef modelleri `model` seçicisi ister, Jev istemez */
function classifierExtra(env) {
  const m = /^@cf\/cloudflare\/(clef(?:-flash)?)$/.exec(env.CLASSIFIER_MODEL || "");
  return m ? { model: m[1] } : {};
}

/** Geçerli bir IANA saat dilimiyse döndürür, değilse null */
function validTimeZone(tz) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** Eski Workers AI formatı (response alanı) kullanan modeller */
function isLegacyModel(model) {
  return /^@cf\/(meta|meta-llama|mistral|llava-hf|unum)\//.test(model || "");
}

/** Model yanıtındaki metni döndürür (eski `response` veya OpenAI `choices` formatı) */
function aiText(res) {
  let t = res?.response ?? res?.choices?.[0]?.message?.content ?? res?.output_text ?? res?.description;
  if (t == null && Array.isArray(res?.output)) {
    // OpenAI Responses biçimi (ör. gpt-oss): output[].content[].text
    t = res.output
      .filter((o) => o?.type === "message")
      .flatMap((o) => o.content || [])
      .map((c) => c?.text || "")
      .join("");
  }
  t = t ?? "";
  return typeof t === "string" ? t : JSON.stringify(t);
}

function normalizeDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const d = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (d) return `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`;
  return s;
}

function normalizeTime(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})[:.](\d{2})/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  return s;
}

function parseOg(html) {
  const get = (prop) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i");
    const m = html.match(re) || html.match(re2);
    return m ? decodeEntities(m[1]) : null;
  };
  return {
    title: get("og:title") || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null,
    description: get("og:description") || get("description"),
    image: get("og:image"),
  };
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: JSON_HEADERS });
}
