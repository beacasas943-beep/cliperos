// ClipControl 2.6.1 FACEBOOK EMBED FIRST
// Meta tokenless oEmbed para preview/metadata + un único embed público para métricas parciales.
// Sin API key, sin access token de usuario, sin cookies y sin proveedor externo.
import { createClient } from "npm:@supabase/supabase-js@^2";
import { corsHeaders as sdkCorsHeaders } from "npm:@supabase/supabase-js@^2/cors";

const corsHeaders = {
  ...sdkCorsHeaders,
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN")?.trim() || "*",
  "Access-Control-Allow-Headers": `${sdkCorsHeaders["Access-Control-Allow-Headers"] ?? "authorization, x-client-info, apikey, content-type"}, x-cron-secret`,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });

const normalizeUsername = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);

const parseDefaultKey = (name: string): string | undefined => {
  try {
    const parsed = JSON.parse(Deno.env.get(name) ?? "{}") as Record<string, unknown>;
    const value = parsed.default ?? Object.values(parsed)[0];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
};

const numberFrom = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  const raw = String(value ?? "").replace(/\u00a0/g, " ").trim().toLowerCase();
  if (!raw) return null;

  const compact = raw.match(/([0-9]+(?:[.,][0-9]+)?)\s*(mill[oó]n(?:es)?|mil|k|m|b)/i);
  if (compact) {
    const amount = Number(compact[1].replace(",", "."));
    const suffix = compact[2].toLowerCase();
    const multiplier = suffix === "k" || suffix === "mil"
      ? 1_000
      : suffix === "m" || suffix.startsWith("mill")
      ? 1_000_000
      : 1_000_000_000;
    if (Number.isFinite(amount)) return Math.max(0, Math.round(amount * multiplier));
  }

  const cleaned = raw.replace(/[^0-9]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

const firstMatch = (html: string, patterns: RegExp[]): number | null => {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const value = numberFrom(match?.[1]);
    if (value !== null) return value;
  }
  return null;
};

const textMatch = (html: string, patterns: RegExp[]): string | null => {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        return match[1].replaceAll("\\u0026", "&").replaceAll("\\/", "/");
      }
    }
  }
  return null;
};

type Metrics = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  title: string | null;
  author: string | null;
  thumbnail: string | null;
  source: string;
  meta?: MetricsMeta;
};

type HtmlResult = {
  html: string;
  finalUrl: string;
  status: number;
};

const PLATFORM_HOSTS: Record<string, string[]> = {
  tiktok: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
  youtube: ["youtube.com", "youtu.be"],
  instagram: ["instagram.com"],
  facebook: ["facebook.com", "fb.watch"],
};

function hostMatches(hostname: string, allowed: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const base = allowed.toLowerCase().replace(/^www\./, "");
  return host === base || host.endsWith(`.${base}`);
}

function isAllowedPlatformUrl(platform: string, value: string): boolean {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".local")) return false;
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    return (PLATFORM_HOSTS[platform] ?? []).some((allowed) => hostMatches(host, allowed));
  } catch {
    return false;
  }
}

function assertPlatformUrl(platform: string, value: string): void {
  if (!isAllowedPlatformUrl(platform, value)) throw new Error(`Enlace ${platform} no válido o dominio no permitido.`);
}

const browserHeaders = (referer?: string): HeadersInit => ({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "es-PE,es;q=0.9,en;q=0.7",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  ...(referer ? { Referer: referer } : {}),
});

async function fetchHtml(url: string, referer?: string): Promise<HtmlResult> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: browserHeaders(referer),
    signal: AbortSignal.timeout(12_000),
  });
  const html = await response.text();
  return { html, finalUrl: response.url || url, status: response.status };
}

function commonMetadata(html: string) {
  return {
    title: textMatch(html, [
      /"title"\s*:\s*"((?:\\.|[^"\\])*)"/i,
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    ]),
    author: textMatch(html, [
      /"author"\s*:\s*"((?:\\.|[^"\\])*)"/i,
      /"uniqueId"\s*:\s*"([^"]+)"/i,
      /"ownerName"\s*:\s*"((?:\\.|[^"\\])*)"/i,
    ]),
    thumbnail: textMatch(html, [
      /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
      /"thumbnailUrl"\s*:\s*\[?"([^"]+)"/i,
    ]),
  };
}

// -----------------------------------------------------------------------------
// SOCIAL METRICS ENGINE.
// Facebook está aislado y usa únicamente superficies públicas de Meta.
// Sin API key, sin token, sin proveedor de pago y sin bucles de reintentos.
// TikTok conserva su lector existente.
// -----------------------------------------------------------------------------

type MetricName = "views" | "likes" | "comments" | "shares";
type MetricEvidence = { value: number; confidence: number; source: string };
type MetricsMeta = {
  content_id?: string | null;
  content_type?: string;
  partial?: boolean;
  availability?: Partial<Record<MetricName, boolean>>;
  readings?: Partial<Record<MetricName, MetricEvidence & { available: boolean }>>;
  thumbnail_source?: string;
  thumbnail_confidence?: number;
  thumbnail_verified_at?: string;
  limited_code?: string | null;
};

function decodePublicMarkup(value: string): string {
  let s = String(value ?? "");
  for (let i = 0; i < 2; i++) {
    s = s
      .replaceAll("&quot;", '"').replaceAll("&#34;", '"').replaceAll("&apos;", "'")
      .replaceAll("&#39;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">").replaceAll("&nbsp;", " ")
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
        try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return " "; }
      })
      .replace(/&#([0-9]+);/g, (_m, dec) => {
        try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return " "; }
      })
      .replace(/\\u0026/gi, "&").replace(/\\u002f/gi, "/").replace(/\\u003a/gi, ":")
      .replace(/\\\//g, "/").replace(/\\"/g, '"');
  }
  return s;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const u = new URL(decodePublicMarkup(value.trim()));
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch { return null; }
}

function scopedMarkup(markup: string, id: string | null, radius = 100_000): string {
  const html = decodePublicMarkup(markup);
  if (!id) return "";
  const chunks: string[] = [];
  let from = 0;
  while (chunks.length < 4) {
    const i = html.indexOf(id, from);
    if (i < 0) break;
    chunks.push(html.slice(Math.max(0, i - radius), Math.min(html.length, i + radius)));
    from = i + id.length;
  }
  return chunks.join("\n");
}

function metricEvidence(
  scope: string,
  source: string,
  confidence: number,
  patterns: Record<MetricName, RegExp[]>,
): Partial<Record<MetricName, MetricEvidence>> {
  const out: Partial<Record<MetricName, MetricEvidence>> = {};
  for (const name of ["views", "likes", "comments", "shares"] as MetricName[]) {
    const value = firstMatch(scope, patterns[name]);
    if (value !== null) out[name] = { value, confidence, source };
  }
  return out;
}

function mergeEvidence(
  store: Record<MetricName, MetricEvidence[]>,
  incoming: Partial<Record<MetricName, MetricEvidence>>,
) {
  for (const name of ["views", "likes", "comments", "shares"] as MetricName[]) {
    const item = incoming[name];
    if (item) store[name].push(item);
  }
}

function bestEvidence(items: MetricEvidence[]): MetricEvidence | null {
  if (!items.length) return null;
  const max = Math.max(...items.map((x) => x.confidence));
  const top = items.filter((x) => x.confidence >= max - 2).sort((a, b) => a.value - b.value);
  return top[Math.floor((top.length - 1) / 2)] ?? null;
}

// ------------------------------- FACEBOOK ------------------------------------
// FACEBOOK PUBLIC RELAY V6 — sin API key, sin login y sin proveedor externo.
// La diferencia con V5 es importante: ya no dependemos solo de regex sobre HTML.
// Los plugins de Facebook devuelven mucho JSON de Relay en <script data-sjs>;
// lo parseamos como JSON y buscamos el objeto ligado al ID exacto del reel/post.
// Red: 2 requests en paralelo para reel/video; 1 fallback móvil SOLO si ambos
// plugins no entregan ninguna métrica. No existe ningún bucle de reintentos HTTP.

type FacebookParsed = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  title: string | null;
  author: string | null;
  thumbnail: string | null;
  canonical: string | null;
  source: string;
  jsonBlocks: number;
  anchors: number;
  hints: Record<string, boolean>;
};

const FB_TEXT_PATTERNS: Record<MetricName, RegExp[]> = {
  views: [
    /\bviewCount\s*:\s*["']([0-9][0-9.,]*)["']/i,
    /video_view_count["']?\s*:\s*([0-9][0-9.,]*)/i,
    /["'](?:play_count|playCount|video_view_count|videoViewCount|video_play_count|videoPlayCount|reel_play_count|reelPlayCount|view_count|viewCount)["']\s*:\s*["']?([0-9][0-9.,]*(?:\s*(?:mil|k|m|b|mill[oó]n(?:es)?))?)/i,
    /([0-9]+(?:[.,][0-9]+)?\s*(?:mil|k|m|b|mill[oó]n(?:es)?)?)\s*(?:reproducciones|visualizaciones|vistas|views|plays)\b/i,
  ],
  likes: [
    /["']likers["']\s*:\s*\{[\s\S]{0,260}?["']count["']\s*:\s*([0-9][0-9.,]*)/i,
    /["']reactors["']\s*:\s*\{[\s\S]{0,420}?["'](?:count|total_count)["']\s*:\s*([0-9][0-9.,]*)/i,
    /["'](?:reactionCount|reaction_count|likeCount|like_count|totalReactionCount|total_reaction_count)["']\s*:\s*["']?([0-9][0-9.,]*)/i,
    /([0-9]+(?:[.,][0-9]+)?\s*(?:mil|k|m|b|mill[oó]n(?:es)?)?)\s*(?:reacciones|me gusta|likes|reactions)\b/i,
  ],
  comments: [
    /["']total_comment_count["']\s*:\s*([0-9][0-9.,]*)/i,
    /["']top_level_comments["']\s*:\s*\{[\s\S]{0,520}?["'](?:total_count|count)["']\s*:\s*([0-9][0-9.,]*)/i,
    /["'](?:commentCount|comment_count|totalCommentCount|total_comment_count)["']\s*:\s*["']?([0-9][0-9.,]*)/i,
    /([0-9]+(?:[.,][0-9]+)?\s*(?:mil|k|m|b|mill[oó]n(?:es)?)?)\s*(?:comentarios|comments)\b/i,
  ],
  shares: [
    /["']reshares["']\s*:\s*\{[\s\S]{0,420}?["'](?:count|total_count)["']\s*:\s*([0-9][0-9.,]*)/i,
    /["'](?:shareCount|share_count|totalShareCount|total_share_count)["']\s*:\s*["']?([0-9][0-9.,]*)/i,
    /["']share_count_reduced["']\s*:\s*["']([^"']+)["']/i,
    /([0-9]+(?:[.,][0-9]+)?\s*(?:mil|k|m|b|mill[oó]n(?:es)?)?)\s*(?:compartidos|veces compartido|shares|reposts)\b/i,
  ],
};

const FB_JSON_KEYS: Record<MetricName, Set<string>> = {
  views: new Set(["viewcount", "videoviewcount", "playcount", "videoplaycount", "reelplaycount", "viewcountreduced", "videoviewcountreduced", "playcountreduced"]),
  likes: new Set(["likecount", "reactioncount", "totalreactioncount", "likecountreduced", "reactioncountreduced"]),
  comments: new Set(["commentcount", "totalcommentcount", "commentcountreduced"]),
  shares: new Set(["sharecount", "totalsharecount", "sharecountreduced", "resharecount", "repostcount"]),
};

function cleanFacebookUrl(value: string): string {
  try {
    const u = new URL(value.trim());
    if (u.hostname === "facebook.com") u.hostname = "www.facebook.com";
    ["fbclid", "mibextid", "ref", "refsrc", "__tn__", "__cft__", "rdid", "locale", "s"].forEach((k) => u.searchParams.delete(k));
    u.hash = "";
    return u.toString();
  } catch { return value.trim(); }
}

function facebookInfo(value: string) {
  try {
    const u = new URL(value), p = u.pathname;
    const key = p.match(/\/(?:reel|reels|posts)\/([^/?#]+)/i)?.[1]
      ?? p.match(/\/videos\/(?:[^/]+\/)?([^/?#]+)/i)?.[1]
      ?? u.searchParams.get("story_fbid") ?? u.searchParams.get("video_id")
      ?? u.searchParams.get("v") ?? u.searchParams.get("fbid") ?? null;
    return {
      key,
      isShare: /\/share\/(?:r|v|p)\//i.test(p) || /fb\.watch/i.test(u.hostname),
      isVideo: /fb\.watch/i.test(u.hostname) || /\/(?:reel|reels|videos|watch)(?:\/|$)/i.test(p)
        || /\/share\/(?:r|v)\//i.test(p) || Boolean(u.searchParams.get("v") || u.searchParams.get("video_id")),
    };
  } catch { return { key: null, isShare: false, isVideo: false }; }
}

function fbKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fbMetricValue(value: unknown): number | null {
  const direct = numberFrom(value);
  if (direct !== null) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  return numberFrom(obj.count ?? obj.total_count ?? obj.totalCount ?? obj.value ?? obj.text ?? obj.number ?? null);
}

function fbPush(store: Record<MetricName, number[]>, name: MetricName, value: unknown): void {
  const parsed = fbMetricValue(value);
  if (parsed !== null && Number.isFinite(parsed)) store[name].push(parsed);
}

function fbCollectMetrics(value: unknown, store: Record<MetricName, number[]>, maxNodes = 10_000): void {
  const stack: unknown[] = [value];
  let nodes = 0;
  while (stack.length && nodes++ < maxNodes) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      current.slice(0, 500).forEach((child) => stack.push(child));
      continue;
    }
    const obj = current as Record<string, unknown>;

    const likers = obj.likers as Record<string, unknown> | undefined;
    const reactors = obj.reactors as Record<string, unknown> | undefined;
    const topComments = (obj.top_level_comments ?? obj.topLevelComments) as Record<string, unknown> | undefined;
    const reshares = obj.reshares as Record<string, unknown> | undefined;
    if (likers) fbPush(store, "likes", likers.count ?? likers.total_count);
    if (reactors) fbPush(store, "likes", reactors.count ?? reactors.total_count);
    if (topComments) fbPush(store, "comments", topComments.total_count ?? topComments.count);
    if (reshares) fbPush(store, "shares", reshares.count ?? reshares.total_count);

    Object.entries(obj).forEach(([rawKey, child]) => {
      const key = fbKey(rawKey);
      (Object.keys(FB_JSON_KEYS) as MetricName[]).forEach((metric) => {
        if (FB_JSON_KEYS[metric].has(key)) fbPush(store, metric, child);
      });
      if (child && typeof child === "object") stack.push(child);
    });
  }
}

function fbObjectReferencesTarget(obj: Record<string, unknown>, targetId: string): boolean {
  const normalizedTarget = String(targetId);
  return Object.entries(obj).some(([rawKey, value]) => {
    if (value === null || value === undefined || typeof value === "object") return false;
    const text = String(value);
    const key = fbKey(rawKey);
    if (["id", "videoid", "videofbid", "storyfbid", "toplevelpostid", "postid", "mediaid"].includes(key) && text === normalizedTarget) return true;
    if (typeof value === "string" && text.includes(normalizedTarget)
      && (key.includes("url") || key.includes("href") || key.includes("permalink") || /facebook\.com|\/reel\/|\/videos\//i.test(text))) return true;
    return false;
  });
}

function fbRelevantCandidates(root: unknown, targetId: string | null): unknown[] {
  if (!targetId || !root || typeof root !== "object") return [];
  const stack: Array<{ value: unknown; parents: unknown[] }> = [{ value: root, parents: [] }];
  const out: unknown[] = [];
  const unique = new Set<unknown>();
  let nodes = 0;
  const add = (value: unknown) => {
    if (value && typeof value === "object" && !unique.has(value)) { unique.add(value); out.push(value); }
  };
  while (stack.length && nodes++ < 60_000) {
    const frame = stack.pop()!;
    const current = frame.value;
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      current.slice(0, 800).forEach((child) => stack.push({ value: child, parents: frame.parents }));
      continue;
    }
    const obj = current as Record<string, unknown>;
    if (fbObjectReferencesTarget(obj, targetId)) {
      add(obj);
      frame.parents.slice(-2).forEach(add);
    }
    const nextParents = [...frame.parents.slice(-3), obj];
    Object.values(obj).forEach((child) => {
      if (child && typeof child === "object") stack.push({ value: child, parents: nextParents });
    });
  }
  return out.slice(0, 24);
}

function fbJsonRoots(markup: string): unknown[] {
  const roots: unknown[] = [];
  const seen = new Set<string>();
  const re = /<script[^>]*(?:data-sjs|type=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  let blocks = 0;
  while ((match = re.exec(markup)) && blocks++ < 100) {
    const raw = String(match[1] ?? "").trim();
    if (!raw || raw.length < 2 || seen.has(raw)) continue;
    seen.add(raw);
    const variants = [raw, decodePublicMarkup(raw)];
    for (const candidate of variants) {
      try {
        const parsed = JSON.parse(candidate);
        roots.push(parsed);
        break;
      } catch {}
    }
  }
  return roots;
}

function fbCanonicalFromAny(value: unknown, original: string): string | null {
  const originalClean = cleanFacebookUrl(original);
  const stack: unknown[] = [value];
  let nodes = 0;
  while (stack.length && nodes++ < 40_000) {
    const current = stack.pop();
    if (typeof current === "string") {
      const decoded = decodePublicMarkup(current);
      const absolute = decoded.match(/https?:\/\/(?:www\.)?facebook\.com\/(?:reel|reels)\/\d{6,30}/i)?.[0]
        ?? decoded.match(/https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]*\/videos\/\d{6,30}/i)?.[0]
        ?? decoded.match(/https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+\/posts\/[^\s"'<>/?#]+/i)?.[0];
      const relative = decoded.match(/\/(?:reel|reels)\/\d{6,30}/i)?.[0]
        ?? decoded.match(/\/[^\s"'<>]*\/videos\/\d{6,30}/i)?.[0];
      const candidate = absolute ?? (relative ? `https://www.facebook.com${relative}` : null);
      if (candidate) {
        const clean = cleanFacebookUrl(candidate);
        if (clean !== originalClean && !facebookInfo(clean).isShare) return clean;
      }
      continue;
    }
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) current.slice(0, 800).forEach((child) => stack.push(child));
    else Object.values(current as Record<string, unknown>).forEach((child) => stack.push(child));
  }
  return null;
}

function fbThumbnailFromCandidates(candidates: unknown[]): string | null {
  const stack = [...candidates];
  let nodes = 0;
  while (stack.length && nodes++ < 12_000) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      current.slice(0, 400).forEach((child) => stack.push(child));
      continue;
    }
    const obj = current as Record<string, unknown>;
    for (const [rawKey, value] of Object.entries(obj)) {
      const key = fbKey(rawKey);
      if (typeof value === "string" && (key.includes("thumbnail") || key === "image" || key === "uri")) {
        const url = safeHttpUrl(value);
        if (url && /fbcdn\.net|fbsbx\.com|facebook\.com/i.test(url)) return url;
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return null;
}

function fbVisibleText(markup: string): string {
  return decodePublicMarkup(markup)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function facebookCanonicalFromMarkup(markup: string, original: string): string | null {
  const full = decodePublicMarkup(markup), originalClean = cleanFacebookUrl(original);
  const metaUrl = safeHttpUrl(textMatch(full, [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i,
  ]));
  const absolute = full.match(/https?:\/\/(?:www\.)?facebook\.com\/(?:reel|reels)\/\d{6,30}/i)?.[0]
    ?? full.match(/https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]*\/videos\/\d{6,30}/i)?.[0]
    ?? full.match(/https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+\/posts\/[^\s"'<>/?#]+/i)?.[0];
  const relative = full.match(/\/(?:reel|reels)\/\d{6,30}/i)?.[0] ?? null;
  const candidates = [metaUrl, absolute, relative ? `https://www.facebook.com${relative}` : null]
    .map((x) => x ? cleanFacebookUrl(x) : null)
    .filter((x): x is string => Boolean(x && isAllowedPlatformUrl("facebook", x)));
  return candidates.find((x) => x !== originalClean && !facebookInfo(x).isShare) ?? null;
}

function parseFacebookSurface(markup: string, source: string, key: string | null, original: string): FacebookParsed {
  const full = decodePublicMarkup(markup);
  const meta = commonMetadata(full);
  const visible = fbVisibleText(full);
  const textSource = `${visible}\n${decodePublicMarkup(meta.title ?? "")}\n${full.slice(0, 750_000)}`;
  const roots = fbJsonRoots(markup);
  const store: Record<MetricName, number[]> = { views: [], likes: [], comments: [], shares: [] };
  let anchors = 0;
  let canonical = facebookCanonicalFromMarkup(full, original);
  const candidates: unknown[] = [];

  roots.forEach((root) => {
    if (!canonical) canonical = fbCanonicalFromAny(root, original);
    const relevant = fbRelevantCandidates(root, key);
    anchors += relevant.length;
    relevant.forEach((candidate) => candidates.push(candidate));
  });
  candidates.forEach((candidate) => fbCollectMetrics(candidate, store));

  const fromStore = (name: MetricName) => store[name].length ? Math.max(...store[name]) : null;
  const fromText = (name: MetricName) => firstMatch(textSource, FB_TEXT_PATTERNS[name]);
  const choose = (name: MetricName) => fromStore(name) ?? fromText(name);

  const thumbnail = safeHttpUrl(meta.thumbnail)
    ?? fbThumbnailFromCandidates(candidates)
    ?? safeHttpUrl(textMatch(full, [
      /["'](?:preferred_thumbnail|thumbnail_url|thumbnailUrl)["']\s*:\s*["']([^"']+)["']/i,
      /["']thumbnailImage["']\s*:\s*\{[\s\S]{0,500}?["']uri["']\s*:\s*["']([^"']+)["']/i,
    ]));

  return {
    views: choose("views"), likes: choose("likes"), comments: choose("comments"), shares: choose("shares"),
    title: meta.title, author: meta.author, thumbnail, canonical, source,
    jsonBlocks: roots.length, anchors,
    hints: {
      viewCount: /\bviewCount\b|video_view_count|playCount/i.test(full),
      reproducciones: /reproducciones|visualizaciones|\bviews\b|\bplays\b/i.test(visible),
      likers: /\blikers\b|\breactors\b/i.test(full),
      comments: /total_comment_count|top_level_comments/i.test(full),
      shares: /share_count_reduced|\breshares\b/i.test(full),
      dataSjs: /data-sjs/i.test(markup),
    },
  };
}

async function facebookGet(url: string, source: string, key: string | null, original: string) {
  try {
    const r = await fetchHtml(url, "https://www.facebook.com/");
    const data = r.status >= 200 && r.status < 400 && r.html.length > 150
      ? parseFacebookSurface(r.html, source, key ?? facebookInfo(r.finalUrl).key, original) : null;
    const found = data ? (["views", "likes", "comments", "shares", "thumbnail", "canonical"] as const)
      .filter((name) => name === "thumbnail" || name === "canonical" ? Boolean(data[name]) : data[name] !== null) : [];
    return {
      data,
      attempt: {
        source, status: r.status, bytes: r.html.length, final_url: r.finalUrl || url, found,
        json_blocks: data?.jsonBlocks ?? 0, anchors: data?.anchors ?? 0, hints: data?.hints ?? {},
      },
    };
  } catch (e) {
    return { data: null, attempt: { source, status: null, bytes: 0, found: [], json_blocks: 0, anchors: 0, hints: {}, error: e instanceof Error ? e.message : "fetch_error" } };
  }
}

function facebookPlugin(kind: "post" | "video", href: string): string {
  const u = new URL(`https://www.facebook.com/plugins/${kind}.php`);
  u.searchParams.set("href", href);
  u.searchParams.set("show_text", "true");
  u.searchParams.set("width", "550");
  return u.toString();
}

function mergeFacebook(items: Array<FacebookParsed | null>) {
  const active = items.filter((item): item is FacebookParsed => Boolean(item));
  const metric = (name: MetricName) => {
    const values = active.map((x) => x[name]).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    return values.length ? Math.max(...values) : null;
  };
  return {
    views: metric("views"), likes: metric("likes"), comments: metric("comments"), shares: metric("shares"),
    title: active.find((x) => x.title)?.title ?? null,
    author: active.find((x) => x.author)?.author ?? null,
    thumbnail: active.find((x) => x.thumbnail)?.thumbnail ?? null,
    canonical: active.find((x) => x.canonical)?.canonical ?? null,
  };
}

type FacebookOEmbedProbe = {
  ok: boolean;
  status: number | null;
  kind: "post" | "video";
  title: string | null;
  author: string | null;
  thumbnail: string | null;
  html: string;
  error?: string;
};

async function facebookTokenlessOEmbed(rawUrl: string, kind: "post" | "video"): Promise<FacebookOEmbedProbe> {
  const endpoint = new URL(`https://graph.facebook.com/v25.0/${kind === "video" ? "oembed_video" : "oembed_post"}`);
  endpoint.searchParams.set("url", rawUrl);
  endpoint.searchParams.set("omitscript", "true");
  endpoint.searchParams.set("maxwidth", "550");
  try {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, kind, title: null, author: null, thumbnail: null, html: "", error: text.slice(0, 500) };
    }
    const data = JSON.parse(text) as Record<string, unknown>;
    return {
      ok: true,
      status: response.status,
      kind,
      title: typeof data.title === "string" ? decodePublicMarkup(data.title) : null,
      author: typeof data.author_name === "string" ? decodePublicMarkup(data.author_name) : null,
      thumbnail: safeHttpUrl(data.thumbnail_url),
      html: typeof data.html === "string" ? data.html : "",
    };
  } catch (error) {
    return {
      ok: false, status: null, kind, title: null, author: null, thumbnail: null, html: "",
      error: error instanceof Error ? error.message : "oembed_error",
    };
  }
}

async function fetchFacebookMetrics(rawUrl: string): Promise<Metrics> {
  assertPlatformUrl("facebook", rawUrl);
  const original = cleanFacebookUrl(rawUrl);
  const info = facebookInfo(original);
  const kind: "post" | "video" = info.isVideo ? "video" : "post";
  const attempts: any[] = [];

  // Camino 1: endpoint oficial tokenless de Meta. Es el equivalente conceptual
  // al oEmbed que ya usamos en TikTok: sirve para comprobar que el contenido
  // público existe y recuperar metadata/HTML de embed sin credenciales.
  const oe = await facebookTokenlessOEmbed(original, kind);
  attempts.push({
    source: "facebook-tokenless-oembed",
    status: oe.status,
    kind,
    ok: oe.ok,
    bytes: oe.html.length,
    found: [
      ...(oe.title ? ["title"] : []),
      ...(oe.author ? ["author"] : []),
      ...(oe.thumbnail ? ["thumbnail"] : []),
    ],
    error: oe.error,
  });

  const oeParsed = oe.html
    ? parseFacebookSurface(oe.html, "facebook-tokenless-oembed-html", info.key, original)
    : null;

  // Camino 2: un solo plugin público. No hay cola, direct fetch ni m.facebook.
  // En videos usamos video.php; en posts usamos post.php.
  const plugin = await facebookGet(facebookPlugin(kind, original), `facebook-${kind}-plugin`, info.key, original);
  attempts.push(plugin.attempt);

  const merged = mergeFacebook([oeParsed, plugin.data]);
  const views = merged.views;
  const likes = merged.likes;
  const comments = merged.comments;
  const shares = merged.shares;
  const title = oe.title ?? merged.title;
  const author = oe.author ?? merged.author;
  const thumbnail = oe.thumbnail ?? merged.thumbnail;
  const canonical = oeParsed?.canonical ?? plugin.data?.canonical ?? original;
  const hasAnyMetric = [views, likes, comments, shares].some((value) => value !== null);
  const embedAvailable = oe.ok || Boolean(plugin.data);
  const partial = hasAnyMetric && [views, likes, comments, shares].some((value) => value === null);
  const bestSource = hasAnyMetric
    ? (plugin.attempt?.found?.some((x: string) => ["views", "likes", "comments", "shares"].includes(x))
      ? `facebook-${kind}-plugin`
      : "facebook-tokenless-oembed-html")
    : embedAvailable ? "facebook-embed-public" : "facebook-public-limited";
  const confidence = bestSource.includes("plugin") ? 86 : 80;
  const reading = (value: number | null) => value === null ? undefined : { value, confidence, source: bestSource, available: true };

  return {
    views, likes, comments, shares, title, author, thumbnail,
    source: hasAnyMetric ? "facebook-embed-partial-v7" : embedAvailable ? "facebook-embed-only-v7" : "facebook-public-limited-v7",
    meta: {
      content_id: info.key,
      content_type: kind,
      partial,
      availability: { views: views !== null, likes: likes !== null, comments: comments !== null, shares: shares !== null },
      readings: { views: reading(views), likes: reading(likes), comments: reading(comments), shares: reading(shares) },
      thumbnail_source: thumbnail ? (oe.thumbnail ? "facebook-tokenless-oembed" : bestSource) : undefined,
      thumbnail_confidence: thumbnail ? (oe.thumbnail ? 100 : 90) : undefined,
      limited_code: hasAnyMetric ? null : embedAvailable ? "FB_EMBED_OK_METRICS_HIDDEN" : "FB_PUBLIC_UNAVAILABLE",
      attempts,
      canonical_url: canonical,
      engine_version: "facebook-embed-first-v7",
      embed_available: embedAvailable,
      embed_kind: kind,
      oembed_status: oe.status,
    } as MetricsMeta & {
      attempts: unknown[];
      canonical_url: string;
      engine_version: string;
      embed_available: boolean;
      embed_kind: string;
      oembed_status: number | null;
    },
  };
}


// -------------------------------- TIKTOK -------------------------------------

function tiktokId(value: string): string | null {
  try {
    const u = new URL(value);
    return u.pathname.match(/\/(?:video|player\/v1)\/(\d{8,25})/i)?.[1] ?? null;
  } catch { return null; }
}

const TT_PATTERNS: Record<MetricName, RegExp[]> = {
  views: [/["'](?:playCount|viewCount)["']\s*:\s*["']?(\d+)/i],
  likes: [/["'](?:diggCount|likeCount)["']\s*:\s*["']?(\d+)/i],
  comments: [/["']commentCount["']\s*:\s*["']?(\d+)/i],
  shares: [/["']shareCount["']\s*:\s*["']?(\d+)/i],
};

function parseTikTokPage(html: string, id: string | null, source: string): Partial<Record<MetricName, MetricEvidence>> {
  const scoped = id ? scopedMarkup(html, id, 140_000) : "";
  const scope = scoped || decodePublicMarkup(html);
  return metricEvidence(scope, source, scoped ? 96 : 72, TT_PATTERNS);
}

async function tiktokOEmbed(url: string) {
  const api = new URL("https://www.tiktok.com/oembed"); api.searchParams.set("url", url);
  try {
    const r = await fetch(api, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const d = await r.json() as Record<string, unknown>;
    return {
      title: typeof d.title === "string" ? d.title : null,
      author: typeof d.author_name === "string" ? d.author_name : null,
      thumbnail: safeHttpUrl(d.thumbnail_url),
      html: String(d.html ?? ""),
    };
  } catch { return null; }
}

async function fetchTikTokMetrics(rawUrl: string): Promise<Metrics> {
  assertPlatformUrl("tiktok", rawUrl);
  let finalUrl = rawUrl, page = "", id = tiktokId(rawUrl);
  const evidence: Record<MetricName, MetricEvidence[]> = { views: [], likes: [], comments: [], shares: [] };
  let title: string | null = null, author: string | null = null, thumbnail: string | null = null;
  let thumbSource = "", thumbConfidence = 0;

  try {
    const r = await fetchHtml(rawUrl);
    if (r.status >= 200 && r.status < 400) {
      finalUrl = r.finalUrl || rawUrl; page = r.html; id = tiktokId(finalUrl) || id;
      const m = commonMetadata(page); title = m.title; author = m.author;
      if (m.thumbnail) { thumbnail = safeHttpUrl(m.thumbnail); thumbSource = "tiktok-page-og"; thumbConfidence = 82; }
      mergeEvidence(evidence, parseTikTokPage(page, id, "tiktok-page"));
    }
  } catch {}

  // oEmbed oficial: fuente principal para título/autor/miniatura.
  const oe = await tiktokOEmbed(finalUrl || rawUrl);
  if (oe) {
    if (oe.title) title = oe.title;
    if (oe.author) author = oe.author;
    if (oe.thumbnail) { thumbnail = oe.thumbnail; thumbSource = "tiktok-oembed"; thumbConfidence = 100; }
    if (oe.html) mergeEvidence(evidence, parseTikTokPage(oe.html, id, "tiktok-oembed"));
  }

  // Player oficial como segundo camino cuando la página pública no trae contadores.
  if (!bestEvidence(evidence.views) && id) {
    try {
      const p = await fetchHtml(`https://www.tiktok.com/player/v1/${id}?description=1&music_info=1`);
      if (p.status >= 200 && p.status < 400) mergeEvidence(evidence, parseTikTokPage(p.html, id, "tiktok-player"));
    } catch {}
  }

  const selected: Partial<Record<MetricName, MetricEvidence>> = {};
  for (const n of ["views", "likes", "comments", "shares"] as MetricName[]) selected[n] = bestEvidence(evidence[n]) ?? undefined;
  const readings: MetricsMeta["readings"] = {};
  for (const n of ["views", "likes", "comments", "shares"] as MetricName[]) if (selected[n]) readings[n] = { ...selected[n]!, available: true };
  const views = selected.views?.value ?? null, likes = selected.likes?.value ?? null, comments = selected.comments?.value ?? null, shares = selected.shares?.value ?? null;
  const hasAny = [views, likes, comments, shares].some((x) => x !== null);
  return {
    views, likes, comments, shares, title, author, thumbnail,
    source: views !== null ? "tiktok-verified-compact" : hasAny ? "tiktok-partial-compact" : "tiktok-metadata-only",
    meta: {
      content_id: id, content_type: "video", partial: views === null && hasAny,
      availability: { views: views !== null, likes: likes !== null, comments: comments !== null, shares: shares !== null },
      readings, thumbnail_source: thumbSource || undefined, thumbnail_confidence: thumbConfidence || undefined,
      limited_code: hasAny ? null : "TT_LIMITED",
    },
  };
}


const PUBLIC_YOUTUBE_CHANNEL_URL =
  Deno.env.get("PUBLIC_YOUTUBE_CHANNEL_URL")?.trim() || "https://www.youtube.com/@rafaellopezaliaga";

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .trim();
}

function xmlTag(block: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match?.[1] ? decodeXmlText(match[1]) : null;
}

async function resolvePublicYoutubeChannelId(channelUrl: string): Promise<string> {
  const configured = Deno.env.get("PUBLIC_YOUTUBE_CHANNEL_ID")?.trim();
  if (configured && /^UC[A-Za-z0-9_-]{20,30}$/.test(configured)) return configured;

  const r = await fetchHtml(channelUrl);
  if (r.status < 200 || r.status >= 400) throw new Error(`YouTube respondió ${r.status} al resolver el canal.`);
  const patterns = [
    /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{20,30})"/,
    /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{20,30})"/,
    /itemprop=["']channelId["'][^>]+content=["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{20,30})/i,
  ];
  for (const pattern of patterns) {
    const id = r.html.match(pattern)?.[1];
    if (id) return id;
  }
  throw new Error("No se pudo resolver el ID público del canal de YouTube.");
}

async function fetchYoutubePublicFeed(limit = 15) {
  const channelUrl = PUBLIC_YOUTUBE_CHANNEL_URL;
  const channelId = await resolvePublicYoutubeChannelId(channelUrl);
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const response = await fetch(feedUrl, {
    headers: browserHeaders(channelUrl),
    signal: AbortSignal.timeout(12_000),
  });
  const xml = await response.text();
  if (!response.ok || xml.length < 100) throw new Error(`El feed público de YouTube respondió ${response.status}.`);

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
  const items = entries.slice(0, Math.min(Math.max(limit, 1), 30)).map((entry) => {
    const id = xmlTag(entry, "yt:videoId") || "";
    const title = xmlTag(entry, "title") || "Video de YouTube";
    const published = xmlTag(entry, "published");
    const thumb = entry.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)?.[1] || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null);
    const viewsRaw = entry.match(/<media:statistics[^>]+views=["'](\d+)["']/i)?.[1];
    const views = viewsRaw ? Number(viewsRaw) : null;
    return {
      id,
      title,
      url: id ? `https://www.youtube.com/watch?v=${id}` : channelUrl,
      thumbnail: thumb,
      published_at: published,
      published_text: null,
      views,
      views_text: views === null ? "métricas al abrir" : null,
      content_type: "video",
      live_status: "none",
      transcript_available: false,
    };
  }).filter((item) => item.id);

  return {
    ok: true,
    source: "youtube-public-rss",
    channel_url: channelUrl,
    channel_id: channelId,
    items,
    checked_at: new Date().toISOString(),
  };
}

async function fetchPublicMetrics(url: string, platform: string): Promise<Metrics> {
  const p = platform.toLowerCase();
  assertPlatformUrl(p, url);
  if (p === "facebook") return fetchFacebookMetrics(url);
  if (p === "tiktok") return fetchTikTokMetrics(url);

  const r = await fetchHtml(url);
  if (r.status < 200 || r.status >= 400 || r.html.length < 300) throw new Error(`La plataforma respondió ${r.status}.`);
  const common = commonMetadata(r.html);
  if (p === "youtube") return {
    views: firstMatch(r.html, [/["']viewCount["']\s*:\s*["'](\d+)["']/i]),
    likes: firstMatch(r.html, [/["']likeCount["']\s*:\s*["']?(\d+)/i, /["']label["']\s*:\s*["']([0-9.,]+)\s+(?:likes|Me gusta)/i]),
    comments: firstMatch(r.html, [/["']commentCount["']\s*:\s*["']?(\d+)/i]), shares: null,
    title: textMatch(r.html, [/["']videoDetails["']\s*:\s*\{[\s\S]{0,700}?["']title["']\s*:\s*["']((?:\\.|[^"'\\])*)["']/i]) ?? common.title,
    author: textMatch(r.html, [/["']videoDetails["']\s*:\s*\{[\s\S]{0,1200}?["']author["']\s*:\s*["']((?:\\.|[^"'\\])*)["']/i]) ?? common.author,
    thumbnail: common.thumbnail, source: "public-youtube",
  };
  return {
    views: firstMatch(r.html, [/["'](?:video_view_count|play_count|view_count)["']\s*:\s*(\d+)/i]),
    likes: firstMatch(r.html, [/["']like_count["']\s*:\s*(\d+)/i]),
    comments: firstMatch(r.html, [/["']comment_count["']\s*:\s*(\d+)/i]),
    shares: null, ...common, source: "public-instagram",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    // Para validar JWT de usuario preferimos la anon JWT legacy si sigue activa.
    // Las nuevas sb_publishable_* son API keys, no JWTs.
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? parseDefaultKey("SUPABASE_PUBLISHABLE_KEYS");
    const serviceRoleKey = parseDefaultKey("SUPABASE_SECRET_KEYS") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return json({ error: "Faltan las llaves internas predeterminadas de Supabase." }, 500);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });


    const FACEBOOK_THUMB_BUCKET = "social-thumbnails";
    let facebookThumbBucketReady: Promise<boolean> | null = null;

    function facebookCdnExpired(value: string | null): boolean {
      if (!value) return false;
      try {
        const u = new URL(value);
        const host = u.hostname.toLowerCase();
        if (!host.includes("fbcdn.net") && !host.includes("fbsbx.com")) return false;
        const oe = u.searchParams.get("oe");
        if (!oe || !/^[0-9a-f]+$/i.test(oe)) return false;
        const seconds = Number.parseInt(oe, 16);
        return Number.isFinite(seconds) && seconds * 1000 < Date.now();
      } catch { return false; }
    }

    async function ensureFacebookThumbBucket(): Promise<boolean> {
      if (facebookThumbBucketReady) return facebookThumbBucketReady;
      facebookThumbBucketReady = (async () => {
        const { data } = await adminClient.storage.getBucket(FACEBOOK_THUMB_BUCKET);
        if (data?.id) return true;
        const { error } = await adminClient.storage.createBucket(FACEBOOK_THUMB_BUCKET, {
          public: true,
          allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/avif"],
          fileSizeLimit: 5 * 1024 * 1024,
        });
        if (!error) return true;
        const msg = String(error.message || "").toLowerCase();
        return msg.includes("already") || msg.includes("exist");
      })().catch(() => false);
      return facebookThumbBucketReady;
    }

    async function cacheFacebookThumbnail(videoId: string, remoteUrl: string): Promise<string | null> {
      try {
        if (!await ensureFacebookThumbBucket()) return null;
        const response = await fetch(remoteUrl, {
          headers: { "User-Agent": String((browserHeaders() as Record<string, string>)["User-Agent"] || "Mozilla/5.0"), Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return null;
        const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!type.startsWith("image/")) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 5 * 1024 * 1024) return null;
        const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("avif") ? "avif" : "jpg";
        const path = `facebook/${videoId}.${ext}`;
        const { error } = await adminClient.storage.from(FACEBOOK_THUMB_BUCKET).upload(path, bytes, {
          contentType: type,
          cacheControl: "3600",
          upsert: true,
        });
        if (error) return null;
        const { data } = adminClient.storage.from(FACEBOOK_THUMB_BUCKET).getPublicUrl(path);
        return data?.publicUrl ? `${data.publicUrl}?v=${Date.now()}` : null;
      } catch { return null; }
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const cronSecret = Deno.env.get("CRON_SECRET");
    const isCronAction = ["sync_due_metrics", "period_maintenance"].includes(action);
    const isCron = Boolean(cronSecret && req.headers.get("x-cron-secret") === cronSecret && isCronAction);

    let caller: { id: string; role: string; active: boolean } | null = null;
    if (!isCron) {
      const authorization = req.headers.get("Authorization");
      if (!authorization?.startsWith("Bearer ")) return json({ error: "Sesión requerida." }, 401);

      const token = authorization.slice("Bearer ".length).trim();
      const userClient = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      // Pasamos el JWT explícitamente. Evita depender de que getUser() herede
      // correctamente un Authorization global cuando se usan las nuevas API keys.
      const { data: authData, error: authError } = await userClient.auth.getUser(token);
      if (authError || !authData.user) {
        console.warn("auth getUser rejected token", { code: authError?.code, status: authError?.status });
        return json({ error: "Sesión inválida. Vuelve a iniciar sesión una vez.", code: "AUTH_USER_JWT_INVALID" }, 401);
      }

      const { data: profile, error: callerError } = await adminClient
        .from("profiles")
        .select("id, role, active")
        .eq("id", authData.user.id)
        .single();
      if (callerError || !profile?.active) return json({ error: "Usuario inactivo o no disponible." }, 403);
      caller = profile;
    }

    const isAdmin = Boolean(caller && ["admin", "superadmin"].includes(caller.role));

    async function removeOwnedStorageObjects(userId: string): Promise<number> {
      const { data, error } = await adminClient.rpc("list_user_storage_objects", { p_user_id: userId });
      if (error) {
        throw new Error(`No se pudo revisar Supabase Storage: ${error.message}. Ejecuta SQL 11 antes de eliminar usuarios.`);
      }

      const rows = (data ?? []) as Array<{ bucket_id: string; object_name: string }>;
      const byBucket = new Map<string, string[]>();
      for (const row of rows) {
        if (!row.bucket_id || !row.object_name) continue;
        const names = byBucket.get(row.bucket_id) ?? [];
        names.push(row.object_name);
        byBucket.set(row.bucket_id, names);
      }

      let removed = 0;
      for (const [bucket, names] of byBucket.entries()) {
        for (let index = 0; index < names.length; index += 100) {
          const batch = names.slice(index, index + 100);
          const { error: removeError } = await adminClient.storage.from(bucket).remove(batch);
          if (removeError) throw new Error(`No se pudieron eliminar archivos del bucket ${bucket}: ${removeError.message}`);
          removed += batch.length;
        }
      }
      return removed;
    }

    if (action === "health") {
      return json({
        ok: true,
        function: "bright-processor",
        version: "2.6.1-facebook-embed-first-v7",
        role: caller?.role ?? "cron",
        youtube_public_feed: true,
        facebook_provider: "public-facebook-relay-json-no-token",
        checked_at: new Date().toISOString(),
      });
    }

    if (action === "youtube_public_feed") {
      const limit = Math.min(Math.max(Number(body.limit ?? 15), 1), 30);
      return json(await fetchYoutubePublicFeed(limit));
    }

    if (action === "facebook_probe") {
      if (!isAdmin) return json({ error: "Acceso reservado para administración." }, 403);
      const url = String(body.url ?? "").trim();
      if (!url) return json({ error: "Falta url." }, 400);
      return json(await fetchFacebookMetrics(url));
    }

    if (action === "create") {
      if (!isAdmin) return json({ error: "Acceso reservado para administración." }, 403);
      const username = normalizeUsername(String(body.username ?? ""));
      const password = String(body.password ?? "");
      const role = body.role === "admin" ? "admin" : "clipper";

      if (username.length < 3) return json({ error: "El usuario debe tener al menos 3 caracteres." }, 400);
      if (password.length < 6) return json({ error: "La contraseña debe tener al menos 6 caracteres." }, 400);
      if (role === "admin" && caller?.role !== "superadmin") {
        return json({ error: "Solo el superadministrador puede crear administradores." }, 403);
      }

      const { data: duplicate } = await adminClient.from("profiles").select("id").ilike("username", username).maybeSingle();
      if (duplicate) return json({ error: "Ese nombre de usuario ya existe." }, 409);

      const internalEmail = `${username}@usuarios.clipcontrol.app`;
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email: internalEmail,
        password,
        email_confirm: true,
        user_metadata: { username },
      });
      if (createError || !created.user) return json({ error: createError?.message ?? "No se pudo crear el usuario." }, 400);

      const { error: profileError } = await adminClient
        .from("profiles")
        .update({
          username,
          role,
          names: null,
          surnames: null,
          phone: null,
          social_alias: null,
          primary_social_url: null,
          onboarding_completed_at: null,
          payment_method: null,
          payment_account: null,
          payment_holder: null,
          payment_required: role === "clipper",
          payment_requested_at: role === "clipper" ? new Date().toISOString() : null,
          payment_completed_at: null,
          active: true,
        })
        .eq("id", created.user.id);

      if (profileError) {
        await adminClient.auth.admin.deleteUser(created.user.id);
        return json({ error: `No se pudo preparar el perfil: ${profileError.message}` }, 500);
      }

      return json({ ok: true, user: { id: created.user.id, username, role } }, 201);
    }

    let metricRuntimeCache: { liveEnabled: boolean; intervalMinutes: number } | null = null;

    async function getMetricRuntime() {
      if (metricRuntimeCache) return metricRuntimeCache;
      const fallback = { liveEnabled: true, intervalMinutes: 15 };
      try {
        const { data, error } = await adminClient
          .from("app_settings")
          .select("metrics_live_enabled,metrics_live_interval_minutes")
          .eq("id", 1)
          .single();
        if (error) return (metricRuntimeCache = fallback);
        return (metricRuntimeCache = {
          liveEnabled: data?.metrics_live_enabled !== false,
          intervalMinutes: Math.max(Math.min(Number(data?.metrics_live_interval_minutes ?? 15), 180), 5),
        });
      } catch {
        return (metricRuntimeCache = fallback);
      }
    }

    type SyncState = {
      video_id: string;
      checked_at: string | null;
      next_check_at: string;
      fail_count: number;
      last_error: string | null;
      last_manual_at: string | null;
      pending_correction: Record<string, unknown> | null;
    };

    async function getSyncState(videoId: string): Promise<SyncState> {
      const { data, error } = await adminClient
        .from("video_metric_sync_state")
        .select("video_id,checked_at,next_check_at,fail_count,last_error,last_manual_at,pending_correction")
        .eq("video_id", videoId)
        .maybeSingle();
      if (error) throw new Error(`Estado de sincronización no disponible: ${error.message}. Ejecuta SQL 27 de ClipControl 2.3.`);
      if (data) return data as SyncState;
      const now = new Date().toISOString();
      const { data: created, error: createError } = await adminClient
        .from("video_metric_sync_state")
        .insert({ video_id: videoId, next_check_at: now })
        .select("video_id,checked_at,next_check_at,fail_count,last_error,last_manual_at,pending_correction")
        .single();
      if (createError || !created) throw new Error(`No se pudo crear estado de sincronización: ${createError?.message ?? "desconocido"}`);
      return created as SyncState;
    }

    async function saveSyncState(videoId: string, patch: Record<string, unknown>) {
      const { error } = await adminClient
        .from("video_metric_sync_state")
        .upsert({ video_id: videoId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "video_id" });
      if (error) throw new Error(`No se pudo guardar el estado de sincronización: ${error.message}`);
    }

    async function dueVideoIds(videoIds: string[], limit: number): Promise<string[]> {
      if (!videoIds.length) return [];
      const now = new Date().toISOString();
      const { data, error } = await adminClient
        .from("video_metric_sync_state")
        .select("video_id,next_check_at")
        .in("video_id", videoIds)
        .lte("next_check_at", now)
        .order("next_check_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`No se pudieron listar métricas pendientes: ${error.message}`);
      return (data ?? []).map((row) => row.video_id);
    }

    function asRecord(value: unknown): Record<string, any> {
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
    }

    function metricReading(metrics: Metrics, name: MetricName): MetricEvidence | null {
      const fromMeta = metrics.meta?.readings?.[name];
      if (fromMeta && Number.isFinite(fromMeta.value)) return { value: fromMeta.value, confidence: fromMeta.confidence, source: fromMeta.source };
      const value = metrics[name];
      if (value === null) return null;
      const confidence = 85;
      return { value, confidence, source: metrics.source };
    }

    function sameNumber(a: unknown, b: unknown): boolean {
      return Number(a ?? 0) === Number(b ?? 0);
    }

    async function syncVideo(
      videoId: string,
      options: { manual?: boolean; force?: boolean; finalSync?: boolean } = {},
    ) {
      const { data: video, error: videoError } = await adminClient
        .from("videos")
        .select("id,user_id,platform,video_url,views,likes,comments,shares,thumbnail_url,external_title,external_author,metrics_source,metrics_status,metrics_error,metrics_meta,deleted_at")
        .eq("id", videoId).is("deleted_at", null).single();
      if (videoError || !video) throw new Error("Video no encontrado.");
      if (!isCron && !isAdmin && video.user_id !== caller?.id) throw new Error("No tienes permiso para actualizar este video.");

      const platform = String(video.platform ?? "").toLowerCase();
      assertPlatformUrl(platform, String(video.video_url ?? ""));
      const runtime = await getMetricRuntime();
      const state = await getSyncState(video.id);
      const now = new Date();

      if (options.manual && !options.force && caller?.role === "clipper" && state.last_manual_at) {
        const elapsed = now.getTime() - new Date(state.last_manual_at).getTime();
        if (elapsed < 3 * 60_000) {
          return { video_id: video.id, ok: true, skipped: true, reason: "manual_cooldown", retry_in_seconds: Math.ceil((3 * 60_000 - elapsed) / 1000) };
        }
      }

      const oldMeta = asRecord(video.metrics_meta);
      const oldReadings = asRecord(oldMeta.readings);
      const pending = asRecord(state.pending_correction);
      const nextPending: Record<string, unknown> = { ...pending };
      const newReadings: Record<string, unknown> = { ...oldReadings };

      const cleanText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
      const savedTitleRaw = cleanText(video.external_title), savedAuthor = cleanText(video.external_author);
      const savedTitle = platform === "facebook" && savedTitleRaw ? decodePublicMarkup(savedTitleRaw) : savedTitleRaw;
      const savedThumbRaw = cleanText(video.thumbnail_url);
      const savedThumb = platform === "facebook" && facebookCdnExpired(savedThumbRaw) ? null : savedThumbRaw;
      const savedMetrics = [video.views, video.likes, video.comments, video.shares].some((v) => Number(v ?? 0) > 0);

      try {
        const metrics = await fetchPublicMetrics(video.video_url, platform);
        const freshTitle = cleanText(metrics.title), freshAuthor = cleanText(metrics.author);
        let freshThumb = cleanText(metrics.thumbnail);
        if (platform === "facebook" && freshThumb) {
          const cachedThumb = await cacheFacebookThumbnail(video.id, freshThumb);
          if (cachedThumb) {
            freshThumb = cachedThumb;
            metrics.meta = { ...(metrics.meta ?? {}), thumbnail_source: "supabase-storage-facebook", thumbnail_confidence: 100 };
          }
        }
        const nextTitle = savedTitle || freshTitle;
        const nextAuthor = savedAuthor || freshAuthor;

        // Facebook CDN usa URLs temporales. Si obtenemos una miniatura nueva, la
        // copiamos a Supabase Storage para que no caduque a los pocos días.
        const thumbConfidence = Number(metrics.meta?.thumbnail_confidence ?? 0);
        const trustedThumb = freshThumb && (platform === "facebook" ? thumbConfidence >= 85 : thumbConfidence >= 94);
        let nextThumbnail = savedThumb;
        let thumbnailAccepted = false;
        if (freshThumb && !savedThumb) { nextThumbnail = freshThumb; thumbnailAccepted = true; }
        else if (trustedThumb && freshThumb !== savedThumb) { nextThumbnail = freshThumb; thumbnailAccepted = true; }

        const hasAny = [metrics.views, metrics.likes, metrics.comments, metrics.shares].some((value) => value !== null);
        const nextMetaBase: Record<string, unknown> = {
          ...oldMeta,
          ...(metrics.meta ?? {}),
          last_source: metrics.source,
        };
        if (thumbnailAccepted || (!oldMeta.thumbnail_source && metrics.meta?.thumbnail_source && nextThumbnail)) {
          nextMetaBase.thumbnail_source = metrics.meta?.thumbnail_source ?? oldMeta.thumbnail_source;
          nextMetaBase.thumbnail_confidence = thumbConfidence || oldMeta.thumbnail_confidence;
          nextMetaBase.thumbnail_verified_at = now.toISOString();
        }

        const metadataChanged = nextTitle !== savedTitle || nextAuthor !== savedAuthor || nextThumbnail !== savedThumbRaw;

        // Incluso si no hay contadores, guardamos miniatura/título/autor. Este era un
        // fallo importante: antes se lanzaba error ANTES de persistir la miniatura.
        if (!hasAny) {
          const failCount = Math.max(0, Number(state.fail_count ?? 0)) + 1;
          const delayMinutes = platform === "facebook"
            ? (metrics.meta?.limited_code === "FB_SHARE_NEEDS_CANONICAL" ? 1440 : 360)
            : platform === "tiktok"
            ? [30, 60, 180, 360][Math.min(failCount - 1, 3)]
            : Math.min(Math.max(runtime.intervalMinutes * Math.pow(2, Math.min(failCount, 4)), 30), 360);
          const publicMessage = platform === "facebook"
            ? (metrics.meta?.limited_code === "FB_SHARE_NEEDS_CANONICAL"
              ? "Facebook no permitió resolver automáticamente este enlace corto /share/. Si puedes, reemplázalo por la URL canónica del reel o publicación."
              : metrics.meta?.limited_code === "FB_EMBED_OK_METRICS_HIDDEN"
              ? "Facebook cargó la publicación, pero Meta no expuso contadores en la respuesta pública."
              : "Facebook no expuso métricas públicas en este intento.")
            : platform === "tiktok"
            ? "TikTok no expuso contadores verificables en este intento."
            : "La plataforma no expuso métricas públicas en este momento.";

          await saveSyncState(video.id, {
            checked_at: now.toISOString(), next_check_at: new Date(now.getTime() + delayMinutes * 60_000).toISOString(),
            fail_count: failCount, last_error: publicMessage,
            last_manual_at: options.manual ? now.toISOString() : state.last_manual_at,
            pending_correction: nextPending,
          });

          const fbEmbedAvailable = platform === "facebook" && Boolean((metrics.meta as any)?.embed_available);
          const status = savedMetrics || fbEmbedAvailable ? "ok" : "error";
          // Si el embed oficial carga pero Meta no publica contadores, lo tratamos como
          // lectura parcial, no como un fallo del video o de Supabase.
          const errorText = savedMetrics && platform === "facebook" ? null
            : fbEmbedAvailable ? publicMessage
            : savedMetrics ? video.metrics_error : publicMessage;
          const semanticChanged = metadataChanged || video.metrics_status !== status || video.metrics_error !== errorText
            || oldMeta.content_id !== nextMetaBase.content_id || oldMeta.thumbnail_source !== nextMetaBase.thumbnail_source
            || oldMeta.engine_version !== nextMetaBase.engine_version;
          if (semanticChanged) {
            const update = {
              metrics_status: status, metrics_source: metrics.source,
              metrics_checked_at: now.toISOString(), metrics_next_check_at: new Date(now.getTime() + delayMinutes * 60_000).toISOString(),
              metrics_error: errorText, external_title: nextTitle, external_author: nextAuthor,
              thumbnail_url: nextThumbnail, metrics_meta: nextMetaBase,
            };
            const { error } = await adminClient.from("videos").update(update).eq("id", video.id);
            if (error) throw error;
          }
          return { video_id: video.id, ok: false, limited: true, platform, metadata_updated: metadataChanged, retry_minutes: delayMinutes, message: `${publicMessage} Se reintentará automáticamente.` };
        }

        const merged: Record<MetricName, number> = {
          views: Math.max(0, Number(video.views ?? 0)), likes: Math.max(0, Number(video.likes ?? 0)),
          comments: Math.max(0, Number(video.comments ?? 0)), shares: Math.max(0, Number(video.shares ?? 0)),
        };

        for (const name of ["views", "likes", "comments", "shares"] as MetricName[]) {
          const fresh = metricReading(metrics, name); if (!fresh) continue;
          const current = merged[name];
          const currentMeta = asRecord(oldReadings[name]);
          const currentConfidence = Number(currentMeta.confidence ?? (current > 0 ? 60 : 0));
          const minimum = platform === "tiktok" ? 70 : 55;
          if (fresh.confidence < minimum) continue;

          let accept = false;
          if (current === 0 || fresh.value >= current) { accept = true; delete nextPending[name]; }
          if (accept) {
            merged[name] = fresh.value;
            newReadings[name] = { ...fresh, available: true, verified_at: now.toISOString() };
          }
        }

        const visibleChanged = !sameNumber(video.views, merged.views) || !sameNumber(video.likes, merged.likes)
          || !sameNumber(video.comments, merged.comments) || !sameNumber(video.shares, merged.shares);
        const partial = Boolean(metrics.meta?.partial);
        const nextMeta: Record<string, unknown> = { ...nextMetaBase, readings: newReadings };
        const qualityChanged = oldMeta.content_id !== nextMeta.content_id
          || oldMeta.engine_version !== nextMeta.engine_version
          || (["views", "likes", "comments", "shares"] as MetricName[]).some((name) => {
            const before = Number(asRecord(oldReadings[name]).confidence ?? 0);
            const after = Number(asRecord(newReadings[name]).confidence ?? 0);
            return after >= before + 5;
          });
        const nextStatus = "ok";
        const partialMessage = partial
          ? (platform === "facebook"
            ? null
            : platform === "tiktok"
            ? "TikTok entregó información parcial; se seguirán intentando las métricas faltantes."
            : "La plataforma entregó información parcial.")
          : null;
        const statusChanged = video.metrics_status !== nextStatus || video.metrics_error !== partialMessage;
        const nextDelayMinutes = platform === "facebook"
          ? Math.max(runtime.intervalMinutes, 60)
          : partial && platform === "tiktok" ? 30 : runtime.intervalMinutes;

        await saveSyncState(video.id, {
          checked_at: now.toISOString(), next_check_at: new Date(now.getTime() + nextDelayMinutes * 60_000).toISOString(),
          fail_count: 0, last_error: null, last_manual_at: options.manual ? now.toISOString() : state.last_manual_at,
          pending_correction: nextPending,
        });

        if (visibleChanged || metadataChanged || statusChanged || qualityChanged) {
          const update = {
            views: merged.views, likes: merged.likes, comments: merged.comments, shares: merged.shares,
            metrics_status: nextStatus, metrics_source: metrics.source,
            metrics_checked_at: now.toISOString(), metrics_next_check_at: new Date(now.getTime() + nextDelayMinutes * 60_000).toISOString(),
            metrics_error: partialMessage, external_title: nextTitle, external_author: nextAuthor,
            thumbnail_url: nextThumbnail, metrics_meta: nextMeta,
          };
          const { error } = await adminClient.from("videos").update(update).eq("id", video.id);
          if (error) throw error;
          return { video_id: video.id, ok: true, changed: true, ...update };
        }
        return { video_id: video.id, ok: true, changed: false, metrics_source: metrics.source };
      } catch (error) {
        const message = error instanceof Error ? error.message : "No se pudieron detectar las métricas.";
        const failCount = Math.max(0, Number(state.fail_count ?? 0)) + 1;
        const delayMinutes = platform === "facebook" ? 360
          : platform === "tiktok" ? [30, 60, 180, 360][Math.min(failCount - 1, 3)]
          : Math.min(Math.max(runtime.intervalMinutes * Math.pow(2, Math.min(failCount, 4)), 30), 360);
        await saveSyncState(video.id, {
          checked_at: now.toISOString(), next_check_at: new Date(now.getTime() + delayMinutes * 60_000).toISOString(),
          fail_count: failCount, last_error: message, last_manual_at: options.manual ? now.toISOString() : state.last_manual_at,
          pending_correction: nextPending,
        });
        if (savedMetrics && video.metrics_status === "error") {
          // Un fallo temporal no debe convertir una lectura histórica válida en "Reintentará".
          await adminClient.from("videos").update({ metrics_status: "ok", metrics_error: null }).eq("id", video.id);
        } else if (!savedMetrics && (video.metrics_status !== "error" || video.metrics_error !== message)) {
          await adminClient.from("videos").update({
            metrics_status: "error", metrics_error: message, metrics_checked_at: now.toISOString(),
            metrics_next_check_at: new Date(now.getTime() + delayMinutes * 60_000).toISOString(),
          }).eq("id", video.id);
        }
        return { video_id: video.id, ok: false, error: message, retry_minutes: delayMinutes };
      }
    }


    async function syncIds(ids: string[], options: { manual?: boolean; force?: boolean; finalSync?: boolean } = {}) {
      const results: unknown[] = [];
      // Lotes pequeños para no saturar la Edge Function.
      for (let i = 0; i < ids.length; i += 3) {
        results.push(...await Promise.all(ids.slice(i, i + 3).map(async (id) => {
          try {
            return await syncVideo(id, options);
          } catch (error) {
            return { video_id: id, ok: false, error: error instanceof Error ? error.message : "No se pudo procesar este video." };
          }
        })));
      }
      return results;
    }

    if (action === "sync_metrics") {
      const videoId = String(body.video_id ?? "");
      if (!videoId) return json({ error: "Falta video_id." }, 400);
      return json(await syncVideo(videoId, { manual: true, force: isAdmin }));
    }

    if (action === "sync_report_metrics") {
      const reportId = String(body.report_id ?? "");
      if (!reportId) return json({ error: "Falta report_id." }, 400);
      const { data: report } = await adminClient.from("weekly_reports").select("id,user_id").eq("id", reportId).single();
      if (!report) return json({ error: "Reporte no encontrado." }, 404);
      if (!isAdmin && report.user_id !== caller?.id) return json({ error: "No tienes acceso al reporte." }, 403);
      const { data: videos } = await adminClient.from("videos").select("id").eq("report_id", reportId).is("deleted_at", null);
      const results = await syncIds((videos ?? []).map((video) => video.id), { manual: true, force: isAdmin });
      return json({ ok: true, total: results.length, results });
    }

    if (action === "sync_metric_batch") {
      if (!isAdmin) return json({ error: "Acceso reservado para administración." }, 403);
      const rawIds = Array.isArray(body.video_ids) ? body.video_ids : [];
      const ids = [...new Set(rawIds.map((id: unknown) => String(id)).filter(Boolean))].slice(0, 100);
      if (!ids.length) return json({ error: "Selecciona al menos un video." }, 400);
      const { data: allowed, error } = await adminClient.from("videos").select("id").in("id", ids).is("deleted_at", null);
      if (error) return json({ error: error.message }, 400);
      const allowedIds = (allowed ?? []).map((video) => video.id);
      const results = await syncIds(allowedIds, { manual: true, force: true });
      const successful = results.filter((result: any) => result?.ok).length;
      return json({ ok: true, total: results.length, successful, failed: results.length - successful, results });
    }

    if (action === "sync_my_due_metrics") {
      if (!caller || caller.role !== "clipper") return json({ error: "Acceso reservado para cliperos." }, 403);
      const runtime = await getMetricRuntime();
      if (!runtime.liveEnabled) return json({ ok: true, total: 0, results: [], reason: "live_disabled" });
      const limit = Math.min(Math.max(Number(body.limit ?? 40), 1), 100);
      const { data: activePeriod, error: activePeriodError } = await adminClient
        .from("reporting_periods").select("id").eq("is_active", true).limit(1).maybeSingle();
      if (activePeriodError) return json({ error: activePeriodError.message }, 400);
      if (!activePeriod) return json({ ok: true, total: 0, results: [], reason: "no_active_period" });
      const { data: report, error: reportError } = await adminClient
        .from("weekly_reports").select("id").eq("period_id", activePeriod.id).eq("user_id", caller.id).limit(1).maybeSingle();
      if (reportError) return json({ error: reportError.message }, 400);
      if (!report) return json({ ok: true, total: 0, results: [], reason: "no_report" });
      const { data: videos, error: videosError } = await adminClient.from("videos").select("id").eq("report_id", report.id).is("deleted_at", null);
      if (videosError) return json({ error: videosError.message }, 400);
      const ids = await dueVideoIds((videos ?? []).map((video) => video.id), limit);
      const results = await syncIds(ids);
      return json({ ok: true, total: results.length, results, live_interval_minutes: runtime.intervalMinutes });
    }

    if (action === "period_maintenance") {
      if (!isCron && !isAdmin) return json({ error: "Acceso reservado para administración o Cron." }, 403);
      const limit = Math.min(Math.max(Number(body.limit ?? 100), 1), 100);
      const nowMs = Date.now();
      const { data: settings, error: settingsError } = await adminClient
        .from("app_settings")
        .select("period_final_sync_enabled,period_final_sync_window_minutes,period_grace_minutes,period_notify_before_hours")
        .eq("id", 1).single();
      if (settingsError) return json({ error: settingsError.message }, 400);
      const { data: activePeriod, error: periodError } = await adminClient
        .from("reporting_periods")
        .select("id,name,start_date,end_date,submission_deadline")
        .eq("is_active", true).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (periodError) return json({ error: periodError.message }, 400);
      if (!activePeriod) return json({ ok: true, maintenance: "no_active_period", total: 0 });

      const deadlineMs = new Date(activePeriod.submission_deadline).getTime();
      const graceMs = Math.max(Number(settings?.period_grace_minutes ?? 0), 0) * 60_000;
      const minutesToDeadline = (deadlineMs - nowMs) / 60_000;
      const createdNotices: string[] = [];
      const notifyHours = Array.isArray(settings?.period_notify_before_hours) ? settings.period_notify_before_hours : [24, 3];
      for (const rawHour of notifyHours) {
        const hour = Number(rawHour);
        if (!Number.isFinite(hour) || hour <= 0) continue;
        if (minutesToDeadline <= hour * 60 && minutesToDeadline > Math.max(0, hour * 60 - 20)) {
          const systemKey = `period:${activePeriod.id}:${hour}h`;
          const { data: existingNotice } = await adminClient.from("announcements").select("id").eq("system_key", systemKey).maybeSingle();
          if (!existingNotice) {
            const kind = hour <= 3 ? "urgent" : "important";
            const title = hour <= 3 ? "El período cierra pronto" : "Recordatorio de cierre";
            const message = hour <= 3
              ? `Faltan aproximadamente ${hour} hora${hour === 1 ? "" : "s"} para el cierre. Revisa tus videos y envía tu reporte.`
              : `El período ${activePeriod.name ?? "actual"} cierra en aproximadamente ${hour} horas.`;
            const { error: noticeError } = await adminClient.from("announcements").insert({
              title, message, kind, audience: "clippers", require_ack: false, show_on_login: true,
              starts_at: new Date().toISOString(), ends_at: new Date(deadlineMs + graceMs).toISOString(), system_key: systemKey, active: true,
            });
            if (!noticeError) createdNotices.push(systemKey);
          }
        }
      }

      const finalSyncWindow = Math.max(Number(settings?.period_final_sync_window_minutes ?? 60), 0);
      const finalSyncEnabled = Boolean(settings?.period_final_sync_enabled);
      const shouldFinalSync = finalSyncEnabled && minutesToDeadline <= finalSyncWindow;
      const finalWindowStart = new Date(deadlineMs - finalSyncWindow * 60_000).toISOString();
      let allVideoIds: string[] = [];
      const results: unknown[] = [];

      if (shouldFinalSync || nowMs >= deadlineMs + graceMs) {
        const { data: reports, error: reportsError } = await adminClient.from("weekly_reports").select("id").eq("period_id", activePeriod.id);
        if (reportsError) return json({ error: reportsError.message }, 400);
        const reportIds = (reports ?? []).map((r) => r.id);
        if (reportIds.length) {
          const { data: videos, error: videosError } = await adminClient.from("videos").select("id").in("report_id", reportIds).is("deleted_at", null);
          if (videosError) return json({ error: videosError.message }, 400);
          allVideoIds = (videos ?? []).map((v) => v.id);
          if (finalSyncEnabled && allVideoIds.length) {
            const { data: stale, error: staleError } = await adminClient
              .from("video_metric_sync_state")
              .select("video_id,checked_at")
              .in("video_id", allVideoIds)
              .or(`checked_at.is.null,checked_at.lt.${finalWindowStart}`)
              .order("checked_at", { ascending: true, nullsFirst: true })
              .limit(limit);
            if (staleError) return json({ error: staleError.message }, 400);
            results.push(...await syncIds((stale ?? []).map((row) => row.video_id), { finalSync: true }));
          }
        }
      }

      let remainingFinalSync = 0;
      if (finalSyncEnabled && allVideoIds.length && nowMs >= deadlineMs + graceMs) {
        const { count, error } = await adminClient
          .from("video_metric_sync_state")
          .select("video_id", { count: "exact", head: true })
          .in("video_id", allVideoIds)
          .or(`checked_at.is.null,checked_at.lt.${finalWindowStart}`);
        if (error) return json({ error: error.message }, 400);
        remainingFinalSync = count ?? 0;
      }

      let rollover: unknown = { rolled: false, reason: "not_due" };
      if (nowMs >= deadlineMs + graceMs) {
        if (finalSyncEnabled && remainingFinalSync > 0) {
          rollover = { rolled: false, reason: "final_sync_pending", remaining: remainingFinalSync };
        } else {
          const { data, error } = await adminClient.rpc("rollover_periods_if_due", { p_force: false });
          if (error) return json({ error: `No se pudo rotar el período: ${error.message}` }, 500);
          rollover = data;
        }
      }

      return json({
        ok: true, period_id: activePeriod.id, minutes_to_deadline: Math.round(minutesToDeadline),
        final_sync: shouldFinalSync, total: results.length, results, remaining_final_sync: remainingFinalSync,
        created_notices: createdNotices, rollover,
      });
    }

    if (action === "sync_due_metrics") {
      if (!isCron && !isAdmin) return json({ error: "Acceso reservado para administración o Cron." }, 403);
      const limit = Math.min(Math.max(Number(body.limit ?? 40), 1), 100);
      if (isCron) {
        const { data: refreshSettings, error: refreshSettingsError } = await adminClient
          .from("app_settings").select("metrics_refresh_mode").eq("id", 1).single();
        if (refreshSettingsError) return json({ error: refreshSettingsError.message }, 400);
        const refreshMode = String(refreshSettings?.metrics_refresh_mode ?? "entry_manual");
        if (refreshMode !== "automatic") return json({ ok: true, total: 0, results: [], reason: `refresh_mode_${refreshMode}` });
      }
      const { data: activePeriod } = await adminClient.from("reporting_periods").select("id").eq("is_active", true).limit(1).maybeSingle();
      if (!activePeriod) return json({ ok: true, total: 0, results: [], reason: "no_active_period" });
      const { data: reports, error: reportsError } = await adminClient.from("weekly_reports").select("id").eq("period_id", activePeriod.id);
      if (reportsError) return json({ error: reportsError.message }, 400);
      const reportIds = (reports ?? []).map((report) => report.id);
      if (!reportIds.length) return json({ ok: true, total: 0, results: [] });
      const { data: videos, error: videosError } = await adminClient.from("videos").select("id").in("report_id", reportIds).is("deleted_at", null);
      if (videosError) return json({ error: videosError.message }, 400);
      const ids = await dueVideoIds((videos ?? []).map((v) => v.id), limit);
      const results = await syncIds(ids);
      return json({ ok: true, total: results.length, results });
    }

    if (!isAdmin) return json({ error: "Acceso reservado para administración." }, 403);

    const adminUserActions = new Set(["reset_password", "set_active", "update_profile", "hard_delete"]);
    if (!adminUserActions.has(action)) {
      return json({ error: `Acción no reconocida: ${action || "(vacía)"}.` }, 400);
    }

    const targetUserId = String(body.user_id ?? "");
    if (!targetUserId) return json({ error: "Falta user_id." }, 400);

    const { data: target, error: targetError } = await adminClient
      .from("profiles")
      .select("id, role, username, active")
      .eq("id", targetUserId)
      .single();
    if (targetError || !target) return json({ error: "Usuario no encontrado." }, 404);
    if (target.role === "superadmin" && caller?.role !== "superadmin") {
      return json({ error: "No puedes modificar al superadministrador." }, 403);
    }

    // Un administrador normal solo administra cliperos. Administradores y
    // superadministrador quedan bajo control exclusivo del superadministrador.
    if (caller?.role === "admin" && target.role !== "clipper") {
      if (!(action === "update_profile" && target.id === caller.id)) {
        return json({ error: "Solo el superadministrador puede modificar accesos administrativos." }, 403);
      }
    }

    if (action === "reset_password") {
      const password = String(body.password ?? "");
      if (password.length < 6) return json({ error: "La contraseña debe tener al menos 6 caracteres." }, 400);
      const { error } = await adminClient.auth.admin.updateUserById(targetUserId, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "set_active") {
      const active = Boolean(body.active);
      const { error } = await adminClient.from("profiles").update({ active }).eq("id", targetUserId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, active });
    }

    if (action === "update_profile") {
      const update: Record<string, unknown> = {};
      if (body.names !== undefined) update.names = String(body.names).trim();
      if (body.surnames !== undefined) update.surnames = String(body.surnames).trim();
      if (body.phone !== undefined) update.phone = String(body.phone).trim();
      if (body.primary_social_url !== undefined) update.primary_social_url = String(body.primary_social_url).trim();
      if (body.social_alias !== undefined) update.social_alias = String(body.social_alias).trim();
      if (body.payment_method !== undefined) update.payment_method = String(body.payment_method || "").trim() || null;
      if (body.payment_account !== undefined) update.payment_account = String(body.payment_account || "").trim() || null;
      if (body.payment_holder !== undefined) update.payment_holder = String(body.payment_holder || "").trim() || null;
      if (body.payment_required !== undefined) {
        update.payment_required = Boolean(body.payment_required);
        if (Boolean(body.payment_required)) update.payment_requested_at = new Date().toISOString();
      }
      if (body.role !== undefined) {
        if (caller?.role !== "superadmin") return json({ error: "Solo el superadministrador cambia roles." }, 403);
        if (!["admin", "clipper"].includes(body.role)) return json({ error: "Rol inválido." }, 400);
        update.role = body.role;
      }
      const { error } = await adminClient.from("profiles").update(update).eq("id", targetUserId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "hard_delete") {
      if (caller?.role !== "superadmin") return json({ error: "Solo el superadministrador puede eliminar definitivamente." }, 403);
      if (targetUserId === caller.id) return json({ error: "No puedes eliminar tu propia cuenta." }, 400);

      let storageObjectsDeleted = 0;
      try {
        storageObjectsDeleted = await removeOwnedStorageObjects(targetUserId);
      } catch (storageError) {
        return json({
          error: storageError instanceof Error ? storageError.message : "No se pudo limpiar Supabase Storage.",
        }, 409);
      }

      const { error } = await adminClient.auth.admin.deleteUser(targetUserId, false);
      if (error) {
        console.error("hard_delete failed", {
          targetUserId,
          message: error.message,
          code: error.code,
          status: error.status,
        });
        const raw = `${error.message ?? ""} ${error.code ?? ""}`.toLowerCase();
        if (raw.includes("database") || raw.includes("foreign") || raw.includes("constraint")) {
          return json({
            error: "La base de datos todavía tiene una relación que bloquea el borrado. Verifica la migración ClipControl 2.0 y las relaciones CASCADE, luego vuelve a intentarlo.",
            detail: error.message,
          }, 409);
        }
        if (raw.includes("storage") || raw.includes("object")) {
          return json({
            error: "El usuario todavía posee archivos en Supabase Storage. Elimina o reasigna esos archivos y vuelve a intentarlo.",
            detail: error.message,
          }, 409);
        }
        return json({ error: error.message || "No se pudo eliminar el usuario." }, 400);
      }
      return json({ ok: true, deleted_user_id: targetUserId, storage_objects_deleted: storageObjectsDeleted });
    }

    return json({ error: "Acción no reconocida." }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Error inesperado." }, 500);
  }
});