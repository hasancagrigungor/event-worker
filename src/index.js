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
    etkinlik_mi: { type: "boolean", description: "İçerik gerçekten bir etkinlik duyurusu mu" },
  },
  required: ["isim", "aciklama", "tarih", "saat", "konum", "etkinlik_mi"],
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

    let target = reqUrl.searchParams.get("url");
    if (request.method === "POST") {
      try {
        const body = await request.json();
        target = body?.url || target;
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
      if (source === "instagram") content = await fetchInstagram(target);
      else if (source === "twitter") content = await fetchTweet(target);
      else if (source === "linkedin") content = await fetchLinkedIn(target);
      else content = await fetchWebPage(target);

      const maxImages = Number(env.MAX_IMAGES || 3);
      const imageNotes = [];
      if (source !== "web") {
        for (const img of content.images.slice(0, maxImages)) {
          try {
            const note = await describeImage(env, img);
            if (note) imageNotes.push(note);
          } catch (e) {
            imageNotes.push(`(görsel okunamadı: ${e.message})`);
          }
        }
      }

      const event = await extractEvent(env, { source, url: target, content, imageNotes });

      return json({
        ...event,
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

async function fetchWebPage(url) {
  const r = await fetch(url, {
    headers: { "user-agent": UA_BROWSER, accept: "text/html,*/*;q=0.8", "accept-language": "tr-TR,tr;q=0.9,en;q=0.8" },
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

  return { text: parts.join("\n\n"), images: [], publishedAt: null };
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

async function describeImage(env, imageUrl) {
  const r = await fetch(imageUrl, { headers: { "user-agent": UA_BROWSER } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 6 * 1024 * 1024) throw new Error("görsel çok büyük");
  const ct = r.headers.get("content-type") || "image/jpeg";
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
    // Llama 3.2 vision vb.: messages + data URL
    const b64 = arrayBufferToBase64(buf);
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
      repetition_penalty: 1.3,
    });
  }
  let out = (res?.response || res?.description || "").trim();
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

  const res = await env.AI.run(env.TEXT_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: EVENT_SCHEMA },
    max_tokens: 512,
    temperature: 0.1,
  });

  let raw = res?.response ?? res;
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
    etkinlik_mi: parsed.etkinlik_mi !== false,
  };
}

/* ---------------- yardımcılar ---------------- */

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
