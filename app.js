(() => {
  const CLIPCONTROL_FRONTEND_VERSION = "2.6.4-links-cache-proof";
  window.CLIPCONTROL_FRONTEND_VERSION = CLIPCONTROL_FRONTEND_VERSION;
  "use strict";

  const PLATFORMS = {
    tiktok: { label: "TikTok", icon: "🎵" },
    instagram: { label: "Instagram", icon: "📸" },
    youtube: { label: "YouTube", icon: "▶️" },
    facebook: { label: "Facebook", icon: "🔵" },
  };

  const STATUS_LABELS = {
    draft: "En elaboración",
    sent: "Enviado",
    review: "En revisión",
    observed: "Observado",
    approved: "Aprobado",
    pending_payment: "Pago pendiente",
    paid: "Pagado",
    closed: "Cerrado",
    expired: "Vencido",
  };

  const ADMIN_FUNCTION = window.CLIPCONTROL_SUPABASE?.adminFunction || "admin-user";
  const DEFAULT_BATCH_ROWS = 7;

  async function invokeProcessor(payload) {
    async function invokeWithToken(accessToken) {
      const { data, error } = await state.supabase.functions.invoke(ADMIN_FUNCTION, {
        body: payload,
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (error) {
        let message = error.message || "No se pudo ejecutar la operación del servidor.";
        let code = "";
        try {
          const response = error.context;
          if (response?.clone) {
            const details = await response.clone().json();
            message = details?.error || details?.message || message;
            code = details?.code || "";
          }
        } catch (_) {}
        const wrapped = new Error(message);
        wrapped.code = code;
        throw wrapped;
      }
      if (data?.error) {
        const wrapped = new Error(data.error);
        wrapped.code = data.code || "";
        throw wrapped;
      }
      return data;
    }

    const { data: sessionData, error: sessionError } = await state.supabase.auth.getSession();
    let session = sessionData?.session;
    if (sessionError || !session?.access_token) {
      throw new Error("La sesión no está disponible. Cierra sesión y vuelve a ingresar.");
    }

    try {
      return await invokeWithToken(session.access_token);
    } catch (error) {
      const authFailure = error?.code === "AUTH_USER_JWT_INVALID"
        || /sesión inválida|invalid jwt|jwt expired|token.*expired/i.test(error?.message || "");
      if (!authFailure) throw error;

      // Un único refresco controlado. No hacemos bucles ni reintentos de Facebook.
      const { data: refreshed, error: refreshError } = await state.supabase.auth.refreshSession();
      session = refreshed?.session;
      if (refreshError || !session?.access_token) {
        throw new Error("Tu sesión venció. Cierra sesión y vuelve a ingresar.");
      }
      state.session = session;
      return await invokeWithToken(session.access_token);
    }
  }

  const invokeAdminFunction = invokeProcessor;

  const state = {
    supabase: null,
    session: null,
    profile: null,
    page: "dashboard",
    currentReportId: null,
    currentSummary: null,
    accounts: [],
    videos: [],
    observations: [],
    settings: null,
    selectedClipperId: null,
    selectedClipperTab: "info",
    selectedPlatform: "tiktok",
    adminWeek: currentWeekStartISO(),
    liveVideoMetricCache: new Map(),
    liveReportStatusCache: new Map(),
    liveCounterValues: new Map(),
    liveMetricCacheReady: false,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value = "") => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const num = (value) => new Intl.NumberFormat("es-PE").format(Number(value || 0));
  const money = (value) => new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" }).format(Number(value || 0));
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  function proportionalEquivalent(summary) {
    const target = Number(summary?.target_views || 0);
    const maxBase = Number(summary?.max_base_pay || 0);
    const views = Number(summary?.total_views || 0);
    if (!target || !maxBase) return 0;
    return Math.round((views / target) * maxBase * 100) / 100;
  }

  function suggestedPerformanceBonus(summary) {
    return Math.max(0, Math.round((proportionalEquivalent(summary) - Number(summary?.max_base_pay || 0)) * 100) / 100);
  }

  function nextFreePositions(count) {
    const used = new Set(state.videos.map((video) => Number(video.position)));
    const positions = [];
    let candidate = 1;
    while (positions.length < count && candidate <= 10000) {
      if (!used.has(candidate)) {
        positions.push(candidate);
        used.add(candidate);
      }
      candidate += 1;
    }
    return positions;
  }

  function normalizeUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  }

  function normalizedHostname(hostname = "") {
    return String(hostname || "").trim().toLowerCase().replace(/^www\./, "");
  }

  function inferPlatformFromUrl(value) {
    try {
      const url = new URL(normalizeUrl(value));
      const host = normalizedHostname(url.hostname);
      if (host.includes("youtu.be") || host.includes("youtube.com")) return "youtube";
      if (host.includes("tiktok.com")) return "tiktok";
      if (host.includes("instagram.com")) return "instagram";
      if (host.includes("facebook.com") || host.includes("fb.watch")) return "facebook";
      return null;
    } catch {
      return null;
    }
  }

  function videoUrlValidation(value, expectedPlatform = null) {
    // 2.6.3: el frontend valida solo protocolo + dominio + plataforma elegida.
    // No intentamos adivinar aquí todas las rutas válidas de cada red social:
    // Facebook/TikTok/YouTube cambian y generan enlaces cortos/de share con frecuencia.
    // La Edge Function es la responsable de resolver/redirigir y detectar el contenido.
    const videoUrl = normalizeUrl(value);
    if (!isValidHttpUrl(videoUrl)) return { ok: false, url: videoUrl, reason: "El enlace no es válido." };
    try {
      const platform = inferPlatformFromUrl(videoUrl);
      if (!platform) {
        return { ok: false, url: videoUrl, reason: "Solo se permiten enlaces de TikTok, Instagram, YouTube o Facebook." };
      }
      if (expectedPlatform && platform !== expectedPlatform) {
        return {
          ok: false,
          url: videoUrl,
          reason: `El enlace parece ser de ${platformLabel(platform)}, pero la cuenta elegida es de ${platformLabel(expectedPlatform)}.`,
        };
      }
      return { ok: true, url: videoUrl, platform };
    } catch {
      return { ok: false, url: videoUrl, reason: "No se pudo leer el enlace." };
    }
  }


  function facebookCdnThumbnailExpired(value) {
    if (!value) return false;
    try {
      const url = new URL(value);
      const host = normalizedHostname(url.hostname);
      if (!host.includes("fbcdn.net") && !host.includes("fbsbx.com")) return false;
      const oe = url.searchParams.get("oe");
      if (!oe || !/^[0-9a-f]+$/i.test(oe)) return false;
      const seconds = Number.parseInt(oe, 16);
      return Number.isFinite(seconds) && seconds * 1000 < Date.now();
    } catch { return false; }
  }

  function facebookEmbedKind(value) {
    try {
      const url = new URL(normalizeUrl(value));
      const path = url.pathname.toLowerCase();
      if (/\/share\/p\//.test(path) || /\/(posts|permalink)\//.test(path) || /\/(story\.php|photo(?:\.php)?)$/.test(path)) return "post";
      return "video";
    } catch { return "video"; }
  }

  function facebookEmbedSrc(value, width = 320) {
    const normalized = normalizeUrl(value);
    if (!normalized) return "";
    const kind = facebookEmbedKind(normalized);
    const endpoint = kind === "post" ? "post" : "video";
    const height = kind === "post" ? 240 : 180;
    return `https://www.facebook.com/plugins/${endpoint}.php?href=${encodeURIComponent(normalized)}&show_text=false&width=${width}&height=${height}&autoplay=false`;
  }

  function facebookPreviewMarkup(video, fallbackClass = "clipper-video-thumb-fallback") {
    const fallback = `<span class="${fallbackClass}">${platformLogo("facebook")}</span>`;
    const src = facebookEmbedSrc(video.video_url, 320);
    const thumb = video.thumbnail_url && !facebookCdnThumbnailExpired(video.thumbnail_url) ? video.thumbnail_url : "";
    return `${fallback}${src ? `<iframe class="facebook-card-embed" src="${esc(src)}" title="Vista previa de Facebook" loading="lazy" scrolling="no" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share" tabindex="-1" aria-hidden="true"></iframe>` : ""}${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}`;
  }

  function canonicalVideoUrl(value) {
    try {
      const url = new URL(normalizeUrl(value));
      const host = normalizedHostname(url.hostname);
      const path = url.pathname.replace(/\/+$/, "");
      const platform = inferPlatformFromUrl(value);
      if (platform === "youtube") {
        if (host === "youtu.be") return `youtube:${path.split("/").filter(Boolean)[0] || path}`;
        if (path === "/watch") return `youtube:${url.searchParams.get("v") || url.href}`;
        const segments = path.split("/").filter(Boolean);
        if (["shorts", "live", "clip", "embed"].includes(segments[0])) return `youtube:${segments[1] || url.href}`;
      }
      if (platform === "instagram") return `instagram:${path.toLowerCase()}`;
      if (platform === "facebook") {
        const id = url.searchParams.get("v") || path.toLowerCase();
        return `facebook:${id}`;
      }
      if (platform === "tiktok") {
        const match = path.match(/\/video\/(\d+)/i);
        return `tiktok:${match?.[1] || path.toLowerCase()}`;
      }
      url.hash = "";
      return `${host}${path}${url.search}`;
    } catch {
      return String(value || "").trim().toLowerCase();
    }
  }

  function preferredAccountIdForPlatform(accounts, platform) {
    const available = (accounts || []).filter((account) => account.platform === platform && account.active);
    return available.length === 1 ? available[0].id : "";
  }

  function parseBulkVideoUrls(rawText) {
    return String(rawText || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function isValidHttpUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname);
    } catch {
      return false;
    }
  }

  function reportEditable(summary) {
    if (!summary) return false;
    if (typeof summary.is_editable === "boolean") return summary.is_editable;
    if (!["draft", "sent", "review", "observed"].includes(summary.status)) return false;
    if (summary.allow_late_edit === true) return true;
    if (!summary.submission_deadline) return true;
    return Date.now() <= new Date(summary.submission_deadline).getTime();
  }

  function activeAccounts() {
    return state.accounts.filter((account) => account.active);
  }

  function limaDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  function currentWeekStartISO() {
    const p = limaDateParts();
    const base = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
    const day = base.getUTCDay() || 7;
    base.setUTCDate(base.getUTCDate() - (day - 1));
    return base.toISOString().slice(0, 10);
  }

  function mondayFromISO(isoDate) {
    if (!isoDate) return currentWeekStartISO();
    const date = new Date(`${isoDate}T12:00:00Z`);
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - (day - 1));
    return date.toISOString().slice(0, 10);
  }

  function dateOnlyLabel(isoDate) {
    if (!isoDate) return "—";
    const [y, m, d] = String(isoDate).slice(0, 10).split("-").map(Number);
    return new Intl.DateTimeFormat("es-PE", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(y, m - 1, d)));
  }

  function dateTimeLabel(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("es-PE", {
      timeZone: "America/Lima", dateStyle: "short", timeStyle: "short",
    }).format(new Date(value));
  }

  function dateTimeLocalValue(value) {
    if (!value) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(value));
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
  }

  function weekLabel(start = currentWeekStartISO()) {
    const startDate = new Date(`${start}T12:00:00Z`);
    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + 6);
    const format = new Intl.DateTimeFormat("es-PE", { day: "2-digit", month: "short", timeZone: "UTC" });
    return `${format.format(startDate)} – ${format.format(endDate)}`;
  }

  function platformLabel(platform) {
    const p = PLATFORMS[platform] || { label: platform || "Red" };
    return p.label;
  }

  function platformLogo(platform) {
    const label = platformLabel(platform);
    const glyph = {
      tiktok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3c.7 2.2 2.5 3.8 4.8 4v3.2c-1.7-.1-3.3-.6-4.8-1.5v6.1a5.8 5.8 0 1 1-5.8-5.8c.4 0 .8 0 1.2.1v3.2a2.6 2.6 0 1 0 1.4 2.3V3H14Z" fill="currentColor"/></svg>',
      instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="5" ry="5" fill="none" stroke="currentColor" stroke-width="2"></rect><circle cx="12" cy="12" r="3.6" fill="none" stroke="currentColor" stroke-width="2"></circle><circle cx="17.3" cy="6.8" r="1.1" fill="currentColor"></circle></svg>',
      youtube: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.2 8.2a3 3 0 0 0-2.1-2.1C17.3 5.6 12 5.6 12 5.6s-5.3 0-7.1.5A3 3 0 0 0 2.8 8.2 31.8 31.8 0 0 0 2.4 12c0 1.3.1 2.6.4 3.8a3 3 0 0 0 2.1 2.1c1.8.5 7.1.5 7.1.5s5.3 0 7.1-.5a3 3 0 0 0 2.1-2.1c.3-1.2.4-2.5.4-3.8s-.1-2.6-.4-3.8Z" fill="currentColor"/><path d="m10 15.5 5-3.5-5-3.5v7Z" fill="#fff"/></svg>',
      facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.4 21v-7h2.4l.4-3h-2.8V9.2c0-.9.3-1.5 1.6-1.5H16V5.1c-.4 0-1.1-.1-2-.1-2 0-3.4 1.2-3.4 3.5V11H8v3h2.6v7h2.8Z" fill="currentColor"/></svg>'
    }[platform] || '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="currentColor"/></svg>';
    return `<span class="platform-logo platform-${platform}" aria-label="${esc(label)}">${glyph}</span>`;
  }

  function platformBadge(platform, compact = false) {
    return `<span class="platform-badge ${compact ? "compact" : ""} platform-${platform}">${platformLogo(platform)}<span>${esc(platformLabel(platform))}</span></span>`;
  }

  function statusClass(status) {
    if (["approved"].includes(status)) return "st-approved";
    if (["pending_payment", "review"].includes(status)) return "st-review";
    if (status === "observed") return "st-observed";
    if (status === "paid") return "st-paid";
    if (status === "sent") return "st-sent";
    if (status === "closed") return "st-closed";
    if (status === "expired") return "st-expired";
    return "st-draft";
  }

  function showLoading(show = true) {
    $("#loading").classList.toggle("hidden", !show);
  }

  let toastTimer;
  function toast(message, type = "") {
    const el = $("#toast");
    el.textContent = message;
    el.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; }, 3600);
  }

  function setHeader(title, subtitle = "") {
    $("#pageTitle").textContent = title;
    $("#pageSubtitle").textContent = subtitle;
    $("#weekBadge").textContent = `Semana ${weekLabel()}`;
  }

  function openModal(html, size = "", onOpen = null) {
    const layer = $("#modalLayer");
    layer.innerHTML = `<div class="modal-backdrop"><div class="modal ${size}">${html}</div></div>`;
    // No se cierra tocando fuera ni con Escape. Solo los botones X configurados.
    if (onOpen) onOpen(layer);
  }

  function closeModal() {
    $("#modalLayer").innerHTML = "";
  }


  function errorMessage(error) {
    const msg = error?.message || String(error || "Error inesperado");
    if (/duplicate key|videos_unique_active_url/i.test(msg)) return "Ese enlace de video ya fue registrado.";
    if (/videos_unique_active_position/i.test(msg)) return "Ya existe un video en esa posición.";
    if (/Invalid login credentials/i.test(msg)) return "Usuario o contraseña incorrectos.";
    if (/Email not confirmed/i.test(msg)) return "La cuenta todavía no está confirmada en Supabase.";
    if (/complete_my_profile|update_my_profile_v14|admin_quick_review_report|admin_set_report_deadline/i.test(msg)) return "Falta ejecutar el SQL 07_clipcontrol_integral_v1_4.sql en Supabase.";
    if (/save_video_batch|Could not find the function/i.test(msg)) return "Falta ejecutar las actualizaciones SQL 05 y 07 en Supabase.";
    if (/row-level security|permission denied/i.test(msg)) return "Supabase bloqueó la operación por permisos. Ejecuta el SQL de actualización y vuelve a iniciar sesión.";
    if (/El reporte está cerrado|plazo de envío terminó/i.test(msg)) return "El reporte ya está cerrado. Administración debe habilitar la edición fuera de plazo.";
    return msg;
  }

  // ClipControl 2.4 Operations Center.
  function metricBucket(video = {}) {
    const status = String(video.metrics_status || "").toLowerCase();
    if (status === "syncing") return "syncing";
    if (status === "error") return "error";
    if (video.metrics_error) return "partial";
    if (!video.metrics_checked_at) return "pending";
    return "ok";
  }

  function metricBucketLabel(bucket) {
    return ({ ok:"Verificada", partial:"Parcial", error:"Con error", syncing:"Sincronizando", pending:"Pendiente" })[bucket] || "Pendiente";
  }

  function metricBucketBadge(video) {
    const bucket = metricBucket(video);
    return `<span class="metric-quality metric-quality-${bucket}"><i></i>${metricBucketLabel(bucket)}</span>`;
  }

  function youtubeVideoIdFromUrl(value) {
    try {
      const url = new URL(value);
      if (url.hostname.replace(/^www\./, "") === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
      return url.searchParams.get("v") || url.pathname.match(/\/(?:shorts|live|embed)\/([\w-]{11})/i)?.[1] || null;
    } catch { return null; }
  }

  async function fetchAllAdminVideos(reportIds) {
    if (!reportIds.length) return [];
    const rows = [], pageSize = 700;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await state.supabase.from("videos").select("*")
        .in("report_id", reportIds).is("deleted_at", null).order("created_at", { ascending:false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return rows;
  }

  async function loadAdminVideoCenterData(reports = null, force = false) {
    const cacheKey = String(state.adminWeek || state.activePeriod?.start_date || currentWeekStartISO());
    if (!force && state.adminVideoData?.key === cacheKey) return state.adminVideoData;
    const reportRows = reports || await query(state.supabase.from("weekly_report_summary").select("*").eq("week_start", cacheKey).order("total_views", { ascending:false }));
    const reportIds = reportRows.map(report => report.report_id);
    const userIds = [...new Set(reportRows.map(report => report.user_id).filter(Boolean))];
    const [videos, accounts] = await Promise.all([
      fetchAllAdminVideos(reportIds),
      userIds.length ? query(state.supabase.from("social_accounts").select("*").in("user_id", userIds).order("platform")) : Promise.resolve([]),
    ]);
    const reportMap = Object.fromEntries(reportRows.map(report => [report.report_id, report]));
    const accountMap = Object.fromEntries(accounts.map(account => [account.id, account]));
    const rows = videos.map(video => {
      const report = reportMap[video.report_id] || {}, account = accountMap[video.account_id] || {};
      return {
        ...video,
        user_id: video.user_id || report.user_id,
        username: report.username || "",
        clipper_name: `${report.names || ""} ${report.surnames || ""}`.trim() || report.username || "Clipero",
        report_status: report.status || "draft",
        account_name: account.account_name || "Sin cuenta",
        account_url: account.account_url || account.profile_url || "",
      };
    });
    state.adminVideoData = { key:cacheKey, reports:reportRows, videos:rows, accounts, reportMap, accountMap };
    return state.adminVideoData;
  }

  function adminVideoFilterRows(rows, filters = {}) {
    const search = String(filters.search || "").trim().toLowerCase();
    return rows.filter(video => {
      if (filters.clipper && filters.clipper !== "all" && video.user_id !== filters.clipper) return false;
      if (filters.account && filters.account !== "all" && video.account_id !== filters.account) return false;
      if (filters.platform && filters.platform !== "all" && video.platform !== filters.platform) return false;
      if (filters.status && filters.status !== "all" && metricBucket(video) !== filters.status) return false;
      return !search || `${video.clipper_name} ${video.username} ${video.account_name} ${video.external_title || ""} ${video.video_url || ""}`.toLowerCase().includes(search);
    });
  }

  function adminVideoCard(video, selectable = false) {
    const youtubeId = youtubeVideoIdFromUrl(video.video_url);
    const thumb = video.thumbnail_url || (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : "");
    const globalFallback = `<span class="global-video-media-fallback">${platformLogo(video.platform)}</span>`;
    const mediaPreview = video.platform === "facebook"
      ? facebookPreviewMarkup(video, "global-video-media-fallback")
      : `${globalFallback}${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ""}`;
    return `<article class="global-video-card metric-card-${metricBucket(video)}">
      <div class="global-video-media">${mediaPreview}<span class="global-platform-chip">${platformLogo(video.platform)} ${esc(platformLabel(video.platform))}</span>${selectable ? `<label class="video-select-check"><input type="checkbox" data-metric-select="${video.id}" ${state.metricSelected?.has(video.id)?"checked":""}><span></span></label>` : ""}</div>
      <div class="global-video-body"><div class="global-video-title"><strong>${esc(video.external_title || `Video ${video.position || ""}`)}</strong>${metricBucketBadge(video)}</div><p>${esc(video.clipper_name)} · @${esc(video.username)} · ${esc(video.account_name)}</p>
      <div class="global-video-numbers"><span><b>${num(video.views)}</b><small>vistas</small></span><span><b>${num(video.likes)}</b><small>likes</small></span><span><b>${num(video.comments)}</b><small>coment.</small></span><span><b>${num(video.shares)}</b><small>comp.</small></span></div>
      ${video.metrics_error ? `<div class="metric-error-copy" title="${esc(video.metrics_error)}">${uiIcon("alert",13)} ${esc(video.metrics_error)}</div>` : `<div class="metric-source-copy">${uiIcon("activity",13)} ${esc(metricAvailabilityLabel(video) || "Esperando lectura")}</div>`}
      <div class="global-video-actions"><a class="btn btn-ghost btn-sm" href="${esc(video.video_url)}" target="_blank" rel="noopener">Abrir</a><button class="btn btn-secondary btn-sm" data-admin-report="${video.report_id}">Reporte ${uiIcon("arrow",13)}</button></div></div>
    </article>`;
  }

  function bindAdminVideoCards() {
    $$('[data-admin-report]').forEach(button => button.addEventListener("click", () => openAdminReportDetail(button.dataset.adminReport)));
  }

  async function renderAdminVideoCenter(force = false) {
    setHeader("Centro de videos", "Todo el contenido en una sola vista");
    const data = await loadAdminVideoCenterData(null, force);
    state.videoCenterFilters = state.videoCenterFilters || { search:"", clipper:"all", account:"all", platform:"all", status:"all" };
    const filters = state.videoCenterFilters;
    const visible = adminVideoFilterRows(data.videos, filters);
    const uniqueClippers = [...new Map(data.videos.map(video => [video.user_id, { id:video.user_id, name:video.clipper_name, username:video.username }])).values()].sort((a,b)=>a.name.localeCompare(b.name,"es"));
    const availableAccounts = data.accounts.filter(account => filters.clipper === "all" || account.user_id === filters.clipper);
    const issues = data.videos.filter(video => metricBucket(video) !== "ok").length;
    const totalViews = data.videos.reduce((sum,video)=>sum+Number(video.views||0),0);
    $("#content").innerHTML = `<section class="executive-head"><div><span class="section-eyebrow">BIBLIOTECA OPERATIVA</span><h2>${data.videos.length} videos bajo control</h2><p>${num(totalViews)} vistas detectadas en el período.</p></div><div class="executive-actions"><button id="goMetricInbox" class="btn btn-secondary">${uiIcon("alert",15)} ${issues} incidencias</button><button id="goPublicChannel" class="btn btn-primary">${uiIcon("video",15)} Canal público</button></div></section>
      <section class="video-filter-shell"><div class="video-search-control">${uiIcon("activity",15)}<input id="globalVideoSearch" value="${esc(filters.search)}" placeholder="Buscar video, clipero o cuenta"></div><select id="globalClipperFilter"><option value="all">Todos los cliperos</option>${uniqueClippers.map(item=>`<option value="${item.id}" ${filters.clipper===item.id?"selected":""}>${esc(item.name)} · @${esc(item.username)}</option>`).join("")}</select><select id="globalAccountFilter"><option value="all">Todas las cuentas</option>${availableAccounts.map(account=>`<option value="${account.id}" ${filters.account===account.id?"selected":""}>${esc(account.account_name)} · ${esc(platformLabel(account.platform))}</option>`).join("")}</select><select id="globalPlatformFilter"><option value="all">Todas las redes</option>${Object.keys(PLATFORMS).map(platform=>`<option value="${platform}" ${filters.platform===platform?"selected":""}>${esc(platformLabel(platform))}</option>`).join("")}</select><select id="globalMetricFilter"><option value="all">Todos los estados</option>${["ok","partial","error","syncing","pending"].map(status=>`<option value="${status}" ${filters.status===status?"selected":""}>${metricBucketLabel(status)}</option>`).join("")}</select><button id="refreshVideoCenter" class="btn btn-ghost btn-sm btn-icon-only" title="Recargar">${uiIcon("sync",15)}</button></section>
      <div class="filter-result-line"><span><b>${visible.length}</b> resultados</span>${Object.values(filters).some(value=>value&&value!=="all")?'<button id="clearVideoFilters" class="btn btn-ghost btn-sm">Limpiar filtros</button>':""}</div>
      <section class="global-video-grid">${visible.map(video=>adminVideoCard(video)).join("") || '<div class="empty global-empty">No hay videos con estos filtros.</div>'}</section>`;
    const rerender = () => renderAdminVideoCenter(false);
    $("#globalVideoSearch")?.addEventListener("input", debounce(event => { filters.search=event.target.value; rerender(); },250));
    [["globalClipperFilter","clipper"],["globalAccountFilter","account"],["globalPlatformFilter","platform"],["globalMetricFilter","status"]].forEach(([id,key])=>$("#"+id)?.addEventListener("change",event=>{filters[key]=event.target.value;if(key==="clipper")filters.account="all";rerender();}));
    $("#clearVideoFilters")?.addEventListener("click",()=>{state.videoCenterFilters={search:"",clipper:"all",account:"all",platform:"all",status:"all"};rerender();});
    $("#refreshVideoCenter")?.addEventListener("click",()=>renderAdminVideoCenter(true));
    $("#goMetricInbox")?.addEventListener("click",()=>navigate("metrics"));
    $("#goPublicChannel")?.addEventListener("click",()=>navigate("channel"));
    bindAdminVideoCards();
  }

  async function retryMetricBatch(ids) {
    const clean = [...new Set(ids.filter(Boolean))].slice(0,100);
    if (!clean.length) return toast("Selecciona al menos un video.","error");
    if (!confirm(`¿Reintentar la detección de ${clean.length} video${clean.length===1?"":"s"}?`)) return;
    showLoading(true);
    try {
      const result = await invokeProcessor({ action:"sync_metric_batch", video_ids:clean });
      state.metricSelected = new Set();
      state.adminVideoData = null;
      toast(`${result.successful || 0} lecturas completadas · ${result.failed || 0} por revisar`, result.failed ? "" : "success");
      await renderMetricInbox(true);
    } catch (error) { toast(errorMessage(error),"error"); }
    finally { showLoading(false); }
  }

  async function renderMetricInbox(force = false) {
    setHeader("Bandeja de métricas", "Detecta, selecciona y reintenta");
    const data = await loadAdminVideoCenterData(null, force);
    state.metricSelected = state.metricSelected || new Set();
    state.metricFilters = state.metricFilters || { platform:"all", clipper:"all", status:"all" };
    const baseIssues = data.videos.filter(video => metricBucket(video) !== "ok");
    const issues = adminVideoFilterRows(baseIssues, state.metricFilters);
    const errors = baseIssues.filter(video=>metricBucket(video)==="error").length;
    const partial = baseIssues.filter(video=>metricBucket(video)==="partial").length;
    const pending = baseIssues.filter(video=>["pending","syncing"].includes(metricBucket(video))).length;
    const clippers = [...new Map(baseIssues.map(video=>[video.user_id,{id:video.user_id,name:video.clipper_name}])).values()].sort((a,b)=>a.name.localeCompare(b.name,"es"));
    $("#content").innerHTML = `<section class="metric-inbox-hero"><div><span class="section-eyebrow">CONTROL DE CALIDAD</span><h2>${baseIssues.length ? `${baseIssues.length} lecturas requieren atención` : "Métricas al día"}</h2><p>Los datos guardados nunca disminuyen por un fallo temporal.</p></div><div class="metric-inbox-counts"><span class="danger"><b>${errors}</b> errores</span><span class="warning"><b>${partial}</b> parciales</span><span class="neutral"><b>${pending}</b> pendientes</span></div></section>
      <section class="metric-batch-bar"><div class="metric-batch-filters"><select id="metricPlatformFilter"><option value="all">Todas las redes</option>${Object.keys(PLATFORMS).map(platform=>`<option value="${platform}" ${state.metricFilters.platform===platform?"selected":""}>${platformLabel(platform)}</option>`).join("")}</select><select id="metricClipperFilter"><option value="all">Todos los cliperos</option>${clippers.map(item=>`<option value="${item.id}" ${state.metricFilters.clipper===item.id?"selected":""}>${esc(item.name)}</option>`).join("")}</select><select id="metricStatusFilter"><option value="all">Toda incidencia</option>${["error","partial","pending","syncing"].map(status=>`<option value="${status}" ${state.metricFilters.status===status?"selected":""}>${metricBucketLabel(status)}</option>`).join("")}</select></div><div class="metric-batch-actions"><button id="selectVisibleMetrics" class="btn btn-ghost btn-sm">Seleccionar visibles</button><button id="retrySelectedMetrics" class="btn btn-primary btn-sm">${uiIcon("sync",14)} Reintentar seleccionados</button></div></section>
      <div class="filter-result-line"><span><b>${issues.length}</b> incidencias visibles · <b id="metricSelectedCount">${state.metricSelected.size}</b> seleccionadas</span><button id="retryAllIssues" class="btn btn-secondary btn-sm">Reintentar visibles</button></div>
      <section class="global-video-grid metric-inbox-grid">${issues.map(video=>adminVideoCard(video,true)).join("") || `<div class="metric-clean-state"><span>${uiIcon("check",30)}</span><h3>Todo limpio</h3><p>No hay incidencias con estos filtros.</p></div>`}</section>`;
    const rerender=()=>renderMetricInbox(false);
    [["metricPlatformFilter","platform"],["metricClipperFilter","clipper"],["metricStatusFilter","status"]].forEach(([id,key])=>$("#"+id)?.addEventListener("change",event=>{state.metricFilters[key]=event.target.value;rerender();}));
    $$('[data-metric-select]').forEach(input=>input.addEventListener("change",()=>{input.checked?state.metricSelected.add(input.dataset.metricSelect):state.metricSelected.delete(input.dataset.metricSelect);$("#metricSelectedCount").textContent=state.metricSelected.size;}));
    $("#selectVisibleMetrics")?.addEventListener("click",()=>{issues.forEach(video=>state.metricSelected.add(video.id));rerender();});
    $("#retrySelectedMetrics")?.addEventListener("click",()=>retryMetricBatch([...state.metricSelected]));
    $("#retryAllIssues")?.addEventListener("click",()=>retryMetricBatch(issues.map(video=>video.id)));
    bindAdminVideoCards();
  }

  async function loadPublicYoutubeFeed(force = false) {
    if (!force && state.publicYoutubeFeed?.checkedAt && Date.now()-state.publicYoutubeFeed.checkedAt < 5*60*1000) return state.publicYoutubeFeed;
    const result = await invokeProcessor({ action:"youtube_public_feed", limit:60 });
    state.publicYoutubeFeed = { items:result.items || [], source:result.source || "public", channelUrl:result.channel_url, checkedAt:Date.now(), checkedLabel:result.checked_at };
    return state.publicYoutubeFeed;
  }

  function publicYoutubeCard(item, canImport) {
    const liveLabel = item.live_status === "live" ? "EN VIVO" : item.live_status === "upcoming" ? "PRÓXIMO" : item.content_type === "live" ? "LIVE" : "VIDEO";
    const liveClass = item.live_status === "live" ? "is-live" : item.live_status === "upcoming" ? "is-upcoming" : item.content_type === "live" ? "is-stream" : "";
    const published = item.published_at ? dateOnlyLabel(item.published_at) : item.published_text || "Público";
    return `<article class="youtube-library-card ${liveClass}"><a class="youtube-library-media" href="${esc(item.url)}" target="_blank" rel="noopener"><img src="${esc(item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="youtube-type-badge">${liveLabel}</span><i class="youtube-play">▶</i></a><div class="youtube-library-body"><h3>${esc(item.title)}</h3><p>${esc(published)} · ${item.views!==null&&item.views!==undefined?`${num(item.views)} vistas`:esc(item.views_text||"métricas al abrir")}</p><div class="youtube-library-actions"><a class="btn btn-ghost btn-sm" href="${esc(item.url)}" target="_blank" rel="noopener">Ver</a>${canImport?`<button class="btn btn-primary btn-sm" data-use-youtube="${esc(item.url)}">${uiIcon("plus",13)} Clipear</button>`:""}</div></div></article>`;
  }

  async function usePublicYoutubeVideo(url) {
    if (state.profile.role !== "clipper") return;
    if (!profileComplete(state.profile)) return openProfileModal(true);
    if (!reportEditable(state.currentSummary)) return toast("El período ya no permite agregar videos.","error");
    if (!activeAccounts().some(account=>account.platform==="youtube")) {
      toast("Registra primero tu cuenta de YouTube.","error");
      return navigate("networks");
    }
    openQuickRegisterModal([url]);
  }

  async function renderPublicYoutube(force = false) {
    setHeader("Canal público", "Videos y lives listos para clipear");
    const feed = await loadPublicYoutubeFeed(force);
    state.youtubeLibraryFilters = state.youtubeLibraryFilters || { type:"all", search:"" };
    const filters = state.youtubeLibraryFilters;
    const items = feed.items.filter(item => {
      if (filters.type === "video" && item.content_type !== "video") return false;
      if (filters.type === "live" && item.content_type === "video") return false;
      return !filters.search || String(item.title||"").toLowerCase().includes(filters.search.toLowerCase());
    });
    const canImport = state.profile.role === "clipper";
    const lives = feed.items.filter(item=>item.content_type!=="video").length;
    $("#content").innerHTML = `<section class="youtube-channel-hero"><div class="youtube-channel-mark">${platformLogo("youtube")}</div><div><span class="section-eyebrow">FUENTE COMPARTIDA</span><h2>Rafael López Aliaga</h2><p>${feed.items.length} publicaciones · ${lives} lives visibles · sin acceso a la cuenta</p></div><a class="btn btn-ghost" href="${esc(feed.channelUrl || "https://www.youtube.com/@rafaellopezaliaga")}" target="_blank" rel="noopener">Abrir canal</a></section>
      <section class="youtube-library-tools"><div class="youtube-library-tabs"><button data-youtube-type="all" class="${filters.type==="all"?"active":""}">Todo</button><button data-youtube-type="live" class="${filters.type==="live"?"active":""}">Lives</button><button data-youtube-type="video" class="${filters.type==="video"?"active":""}">Videos</button></div><div class="video-search-control">${uiIcon("activity",14)}<input id="youtubeLibrarySearch" value="${esc(filters.search)}" placeholder="Buscar en el canal"></div><button id="refreshYoutubeLibrary" class="btn btn-secondary btn-sm">${uiIcon("sync",14)} Actualizar</button></section>
      <div class="filter-result-line"><span><b>${items.length}</b> disponibles</span><small>${feed.source.includes("api")?"Datos oficiales + lives públicos":"Lectura pública gratuita"}</small></div>
      <section class="youtube-library-grid">${items.map(item=>publicYoutubeCard(item,canImport)).join("") || '<div class="empty global-empty">No encontramos contenido con ese filtro.</div>'}</section>`;
    $$('[data-youtube-type]').forEach(button=>button.addEventListener("click",()=>{filters.type=button.dataset.youtubeType;renderPublicYoutube(false);}));
    $("#youtubeLibrarySearch")?.addEventListener("input",debounce(event=>{filters.search=event.target.value;renderPublicYoutube(false);},250));
    $("#refreshYoutubeLibrary")?.addEventListener("click",()=>renderPublicYoutube(true));
    $$('[data-use-youtube]').forEach(button=>button.addEventListener("click",()=>usePublicYoutubeVideo(button.dataset.useYoutube)));
  }

  function clipperVideoCenterCard(video, accountMap, editable) {
    const account = accountMap[video.account_id] || {};
    const youtubeId = youtubeVideoIdFromUrl(video.video_url);
    const thumb = video.thumbnail_url || (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : "");
    const clipperFallback = `<span class="clipper-video-thumb-fallback">${platformLogo(video.platform)}</span>`;
    const clipperPreview = video.platform === "facebook"
      ? facebookPreviewMarkup(video, "clipper-video-thumb-fallback")
      : `${clipperFallback}${thumb?`<img src="${esc(thumb)}" alt="" loading="lazy" onerror="this.remove()">`:""}`;
    const availability = video?.metrics_meta && typeof video.metrics_meta === "object" ? (video.metrics_meta.availability || {}) : {};
    const viewsLabel = video.platform === "facebook" && availability.views === false && Number(video.views || 0) === 0 ? "—" : num(video.views);
    return `<article class="clipper-video-card metric-card-${metricBucket(video)}"><div class="clipper-video-thumb">${clipperPreview}<b>${video.position}</b></div><div class="clipper-video-info"><div class="global-video-title"><strong>${esc(video.external_title || `Video ${video.position}`)}</strong>${metricBucketBadge(video)}</div><p>${platformLogo(video.platform)} ${esc(account.account_name||platformLabel(video.platform))} · ${dateTimeLabel(video.created_at)}</p><div class="clipper-video-metrics"><span><b>${viewsLabel}</b> vistas</span><span>${num(video.likes)} likes</span><span>${num(video.comments)} coment.</span></div><div class="global-video-actions"><a class="btn btn-ghost btn-sm" href="${esc(video.video_url)}" target="_blank" rel="noopener">Abrir</a><button class="btn btn-secondary btn-sm" data-clipper-sync="${video.id}">${uiIcon("sync",13)} Métricas</button>${editable?`<button class="btn btn-ghost btn-sm" data-edit-video="${video.id}">Editar</button><button class="btn btn-danger btn-sm" data-delete-video="${video.id}">Anular</button>`:""}</div></div></article>`;
  }

  function renderClipperVideosV240() {
    setHeader("Mis videos", "Busca, revisa y actualiza");
    const editable=reportEditable(state.currentSummary);
    state.clipperVideoFilters=state.clipperVideoFilters||{search:"",platform:"all",status:"all",account:"all"};
    const f=state.clipperVideoFilters, accountMap=Object.fromEntries(state.accounts.map(account=>[account.id,account]));
    const visible=state.videos.filter(video=>{
      if(f.platform!=="all"&&video.platform!==f.platform)return false;
      if(f.account!=="all"&&video.account_id!==f.account)return false;
      if(f.status!=="all"&&metricBucket(video)!==f.status)return false;
      return !f.search||`${video.external_title||""} ${video.video_url} ${accountMap[video.account_id]?.account_name||""}`.toLowerCase().includes(f.search.toLowerCase());
    });
    const totalViews=state.videos.reduce((sum,video)=>sum+Number(video.views||0),0);
    const issues=state.videos.filter(video=>metricBucket(video)!=="ok").length;
    $("#content").innerHTML=`<section class="executive-head clipper-video-head"><div><span class="section-eyebrow">${weekLabel(state.currentSummary.week_start)}</span><h2>${state.videos.length} videos · ${num(totalViews)} vistas</h2><p>${issues?`${issues} métricas en proceso o por revisar`:"Todas las métricas están al día"}</p></div><button id="quickAddBtn" class="btn btn-primary" ${!editable?"disabled":""}>${uiIcon("plus",15)} Agregar videos</button></section>
      <section class="video-filter-shell clipper-video-filters"><div class="video-search-control">${uiIcon("activity",14)}<input id="clipperVideoSearch" value="${esc(f.search)}" placeholder="Buscar video o cuenta"></div><select id="clipperPlatformFilter"><option value="all">Todas las redes</option>${Object.keys(PLATFORMS).map(platform=>`<option value="${platform}" ${f.platform===platform?"selected":""}>${platformLabel(platform)}</option>`).join("")}</select><select id="clipperAccountFilter"><option value="all">Todas las cuentas</option>${activeAccounts().map(account=>`<option value="${account.id}" ${f.account===account.id?"selected":""}>${esc(account.account_name)}</option>`).join("")}</select><select id="clipperMetricFilter"><option value="all">Todos los estados</option>${["ok","partial","error","syncing","pending"].map(status=>`<option value="${status}" ${f.status===status?"selected":""}>${metricBucketLabel(status)}</option>`).join("")}</select></section>
      <div class="filter-result-line"><span><b>${visible.length}</b> resultados</span><button id="openYoutubeFromVideos" class="btn btn-ghost btn-sm">${platformLogo("youtube")} Ver canal público</button></div><section class="clipper-video-grid">${visible.map(video=>clipperVideoCenterCard(video,accountMap,editable)).join("")||'<div class="empty global-empty">No hay videos con estos filtros.</div>'}</section>`;
    $("#quickAddBtn")?.addEventListener("click",handleQuickRegisterAction);
    $("#openYoutubeFromVideos")?.addEventListener("click",()=>navigate("channel"));
    $("#clipperVideoSearch")?.addEventListener("input",debounce(event=>{f.search=event.target.value;renderClipperVideosV240();},250));
    [["clipperPlatformFilter","platform"],["clipperAccountFilter","account"],["clipperMetricFilter","status"]].forEach(([id,key])=>$("#"+id)?.addEventListener("change",event=>{f[key]=event.target.value;renderClipperVideosV240();}));
    $$('[data-edit-video]').forEach(button=>button.addEventListener("click",()=>openEditVideoModal(button.dataset.editVideo)));
    $$('[data-delete-video]').forEach(button=>button.addEventListener("click",()=>deleteClipperVideo(button.dataset.deleteVideo)));
    $$('[data-clipper-sync]').forEach(button=>button.addEventListener("click",async()=>{button.disabled=true;await syncVideoMetrics(button.dataset.clipperSync);await loadClipperCurrentData();renderClipperVideosV240();}));
  }

  function periodIntelligenceMarkup(data) {
    const topVideos=[...data.videos].sort((a,b)=>Number(b.views||0)-Number(a.views||0)).slice(0,3);
    const accountStats=new Map(data.accounts.filter(account=>account.active!==false).map(account=>[account.id,{...account,videos:0,views:0}]));
    data.videos.forEach(video=>{const row=accountStats.get(video.account_id);if(row){row.videos+=1;row.views+=Number(video.views||0);}});
    const weak=[...accountStats.values()].sort((a,b)=>a.views-b.views||a.videos-b.videos).slice(0,3);
    const pending=data.reports.filter(report=>!["paid","closed","expired"].includes(report.status)&&reportDisplayTotal(report)>0).sort((a,b)=>reportDisplayTotal(b)-reportDisplayTotal(a)).slice(0,3);
    const topMarkup=topVideos.map((video,index)=>`<button class="intel-list-row" data-admin-report="${video.report_id}"><span class="intel-rank">${index+1}</span><span><b>${esc(video.external_title||video.clipper_name)}</b><small>${esc(video.clipper_name)} · ${esc(video.account_name)}</small></span><strong>${num(video.views)}</strong></button>`).join("")||'<div class="intel-empty">Aún sin videos.</div>';
    const weakMarkup=weak.map(account=>`<div class="intel-list-row"><span class="intel-dot warning"></span><span><b>${esc(account.account_name||"Cuenta")}</b><small>${esc(platformLabel(account.platform))} · ${account.videos} videos</small></span><strong>${num(account.views)}</strong></div>`).join("")||'<div class="intel-empty">Sin cuentas flojas.</div>';
    const pendingMarkup=pending.map(report=>`<button class="intel-list-row" data-admin-report="${report.report_id}"><span class="intel-dot danger"></span><span><b>${esc(`${report.names||""} ${report.surnames||""}`.trim()||report.username)}</b><small>${report.payment_account?paymentMethodLabel(report.payment_method):"Falta cuenta de pago"}</small></span><strong>${money(reportDisplayTotal(report))}</strong></button>`).join("")||'<div class="intel-empty">No hay pagos pendientes.</div>';
    return `<section class="period-intelligence"><article class="intelligence-card intel-top"><div class="intelligence-head"><div><span>TOP</span><h3>Videos líderes</h3></div>${uiIcon("activity",18)}</div>${topMarkup}</article><article class="intelligence-card intel-weak"><div class="intelligence-head"><div><span>ATENCIÓN</span><h3>Cuentas flojas</h3></div>${uiIcon("alert",18)}</div>${weakMarkup}</article><article class="intelligence-card intel-pay"><div class="intelligence-head"><div><span>PAGOS</span><h3>Pendientes</h3></div>${uiIcon("wallet",18)}</div>${pendingMarkup}</article></section>`;
  }

  async function renderAdminReportsV240() {
    setHeader("Inicio", "Resumen ejecutivo del período");
    try { await state.supabase.rpc("clipcontrol_auto_submit_due_reports_v234"); } catch (_) {}
    const periods=await query(state.supabase.from("reporting_periods").select("*").order("start_date",{ascending:false}).limit(20));
    if(!state.adminWeek)state.adminWeek=state.activePeriod?.start_date||periods?.[0]?.start_date||currentWeekStartISO();
    const reports=await query(state.supabase.from("weekly_report_summary").select("*").eq("week_start",state.adminWeek).order("total_views",{ascending:false}));
    const reportIds=reports.map(report=>report.report_id);
    const [platformRows,data,paymentRules]=await Promise.all([
      reportIds.length?query(state.supabase.from("weekly_report_platform_summary").select("*").in("report_id",reportIds)):Promise.resolve([]),
      loadAdminVideoCenterData(reports,true),
      query(state.supabase.from("platform_payment_rules").select("*")).catch(()=>[]),
    ]);
    state.adminReportIds=reportIds;
    state.adminPlatformRows=platformRows||[];
    state.platformRuleMap=Object.fromEntries((paymentRules||[]).map(rule=>[rule.platform,rule]));
    state.adminRegisteredPlatformsByUser={};
    for(const account of data.accounts||[]){
      if(!state.adminRegisteredPlatformsByUser[account.user_id])state.adminRegisteredPlatformsByUser[account.user_id]=[];
      if(account.active!==false&&!state.adminRegisteredPlatformsByUser[account.user_id].includes(account.platform))state.adminRegisteredPlatformsByUser[account.user_id].push(account.platform);
    }
    const aggregate=aggregatePlatformRows(platformRows||[]);
    const pendingReview=reports.filter(report=>["sent","review","observed"].includes(report.status)).length;
    const projected=reports.reduce((sum,report)=>sum+reportDisplayTotal(report),0);
    const metricIssues=data.videos.filter(video=>metricBucket(video)!=="ok").length;
    const pendingPayments=reports.filter(report=>!["paid","closed","expired"].includes(report.status)&&reportDisplayTotal(report)>0).length;
    const selectedPeriod=periods.find(period=>period.start_date===state.adminWeek);
    const totalViews=data.videos.reduce((sum,video)=>sum+Number(video.views||0),0);
    $("#content").innerHTML=`<section class="admin-command-hero"><div><span class="reports-kicker">PERÍODO ${selectedPeriod?.is_active?"EN VIVO":"HISTÓRICO"}</span><h2>${esc(selectedPeriod?.name||periodRangeLabel(selectedPeriod)||state.adminWeek)}</h2><p>${reports.length} cliperos · ${data.videos.length} videos · ${num(totalViews)} vistas</p></div><div class="admin-command-value"><small>Pago proyectado</small><strong>${money(projected)}</strong><span>${pendingPayments} pagos pendientes</span></div></section>
      <section class="admin-command-actions"><label class="period-select-v224">${uiIcon("history",15)}<select id="reportPeriodSelect">${periods.map(period=>`<option value="${period.start_date}" ${period.start_date===state.adminWeek?"selected":""}>${esc(period.name||periodRangeLabel(period))}${period.is_active?" · ACTIVO":""}</option>`).join("")}</select></label><button id="goAdminVideos" class="command-action">${uiIcon("video",16)}<span>Videos<small>${data.videos.length} totales</small></span></button><button id="goAdminMetrics" class="command-action ${metricIssues?"has-alert":""}">${uiIcon("alert",16)}<span>Métricas<small>${metricIssues} incidencias</small></span></button><button id="goAdminChannel" class="command-action">${uiIcon("network",16)}<span>Canal<small>Videos y lives</small></span></button><button id="exportReportsBtn" class="command-action">${uiIcon("report",16)}<span>Excel<small>Exportar período</small></span></button></section>
      <div class="executive-kpi-grid"><article><span>Reportes</span><b>${reports.length}</b><small>${pendingReview} por revisar</small></article><article><span>Métricas</span><b>${data.videos.length-metricIssues}/${data.videos.length}</b><small>lecturas limpias</small></article><article><span>Pagos pendientes</span><b>${pendingPayments}</b><small>${money(projected)} proyectado</small></article><article><span>Cierre</span><b>${dateOnlyLabel(selectedPeriod?.end_date||reports[0]?.week_end)}</b><small>${selectedPeriod?.is_active?"período activo":"período cerrado"}</small></article></div>
      ${livePlatformCards(aggregate,{})}${periodIntelligenceMarkup(data)}
      <section class="card report-list-card-v224 executive-report-list"><div class="report-list-head-v224"><div><span class="section-eyebrow">OPERACIÓN</span><h2>Evaluar cliperos</h2><p>Avance y pago separados por red.</p></div><span class="report-live-note"><i></i> En vivo</span></div>${adminReportsTable(reports)}</section>`;
    $("#reportPeriodSelect")?.addEventListener("change",event=>{state.adminWeek=event.target.value;state.adminVideoData=null;renderAdminReportsV240();});
    $("#goAdminVideos")?.addEventListener("click",()=>navigate("videos"));
    $("#goAdminMetrics")?.addEventListener("click",()=>navigate("metrics"));
    $("#goAdminChannel")?.addEventListener("click",()=>navigate("channel"));
    $("#exportReportsBtn")?.addEventListener("click",()=>exportWeeklyExcel(reports));
    bindAdminReportButtons();
    bindAdminVideoCards();
    animateDynamicNumbers($("#content"));
  }

  function buildNavV240() {
    if(!state.profile)return;
    const isAdmin=["admin","superadmin"].includes(state.profile.role);
    if(isAdmin&&state.page==="reports")state.page="dashboard";
    const items=isAdmin
      ? [["dashboard","home","Inicio"],["videos","video","Videos"],["metrics","activity","Métricas"],["channel","network","Canal público"],["clippers","users","Accesos"],["payments","wallet","Pagos"],["announcements","megaphone","Comunicados"],["settings","settings","Ajustes"]]
      : [["dashboard","home","Inicio"],["videos","video","Videos"],["channel","network","Canal público"],["networks","network","Redes"],["history","history","Historial"],["profile","user","Perfil"]];
    $("#nav").innerHTML=items.map(([id,icon,label])=>`<button data-page="${id}" class="${state.page===id?"active":""}">${navIcon(icon)}<span class="nav-label">${label}</span></button>`).join("");
    $$('[data-page]',$("#nav")).forEach(button=>button.addEventListener("click",async()=>{state.page=button.dataset.page;state.selectedClipperId=null;$("#sidebar").classList.remove("open");buildNavV240();await touchPresence(true);await renderPage(true);}));
    const mobile=isAdmin
      ? [["dashboard","home","Inicio"],["videos","video","Videos"],["metrics","activity","Métricas"],["channel","network","Canal"],["settings","settings","Más"]]
      : [["dashboard","home","Inicio"],["videos","video","Videos"],["__add","plus","Agregar"],["channel","network","Canal"],["profile","user","Perfil"]];
    const nav=$("#mobileNav");
    if(nav){
      nav.innerHTML=mobile.map(([id,icon,label])=>`<button data-mobile-page="${id}" class="${state.page===id?"active":""} ${id==="__add"?"mobile-add":""}">${uiIcon(icon,18)}${id==="__add"?"":`<span>${label}</span>`}</button>`).join("");
      $$('[data-mobile-page]',nav).forEach(button=>button.addEventListener("click",async()=>{if(button.dataset.mobilePage==="__add")return handleQuickRegisterAction();state.page=button.dataset.mobilePage;state.selectedClipperId=null;buildNavV240();await touchPresence(true);await renderPage(true);}));
    }
  }

  async function renderAdminPageV240() {
    if(state.page==="dashboard"||state.page==="reports")return renderAdminReportsV240();
    if(state.page==="videos")return renderAdminVideoCenter();
    if(state.page==="metrics")return renderMetricInbox();
    if(state.page==="channel")return renderPublicYoutube();
    if(state.page==="clippers")return state.selectedClipperId?renderClipperAdminDetail():renderAdminClippers();
    if(state.page==="payments")return renderAdminPayments();
    if(state.page==="announcements")return renderAdminAnnouncements();
    if(state.page==="settings")return renderAdminSettings();
    state.page="dashboard";
    return renderAdminReportsV240();
  }

  async function renderClipperPageV240() {
    if(["dashboard","videos","networks","channel"].includes(state.page))await loadClipperCurrentData();
    if(state.page==="dashboard")return renderClipperDashboard();
    if(state.page==="videos")return renderClipperVideosV240();
    if(state.page==="channel")return renderPublicYoutube();
    if(state.page==="networks")return renderNetworks();
    if(state.page==="history")return renderClipperHistory();
    if(state.page==="profile")return renderProfilePage();
    state.page="dashboard";
    return renderClipperDashboard();
  }

  async function query(promise) {
    const { data, error } = await promise;
    if (error) throw error;
    return data;
  }

  async function syncVideoMetrics(videoId, silent = false) {
    try {
      const result = await invokeProcessor({ action: "sync_metrics", video_id: videoId });
      if (!silent) {
        toast(result?.ok ? "Métricas actualizadas automáticamente" : (result?.error || "La plataforma será consultada nuevamente"), result?.ok ? "success" : "");
      }
      return result;
    } catch (error) {
      if (!silent) toast(`No se pudieron detectar las métricas: ${errorMessage(error)}`, "error");
      return { ok: false, error: errorMessage(error) };
    }
  }

  async function syncReportMetrics(reportId, silent = false) {
    try {
      const result = await invokeProcessor({ action: "sync_report_metrics", report_id: reportId });
      if (!silent) toast(`Se revisaron ${result?.total || 0} videos`, "success");
      return result;
    } catch (error) {
      if (!silent) toast(`No se pudo actualizar el reporte: ${errorMessage(error)}`, "error");
      return { ok: false, error: errorMessage(error) };
    }
  }

  function metricStatus(video) {
    const status = video?.metrics_status || "pending";
    if (status === "ok") return '<span class="metric-state metric-ok">● Automático</span>';
    if (status === "syncing") return '<span class="metric-state metric-sync">● Detectando</span>';
    if (status === "manual") return '<span class="metric-state metric-manual">● Manual</span>';
    if (status === "error") return '<span class="metric-state metric-error">● Reintentará</span>';
    return '<span class="metric-state metric-pending">● Pendiente</span>';
  }

  async function init() {
    setAuthenticatedShell(false);
    try {
      const cfg = window.CLIPCONTROL_SUPABASE;
      if (!cfg?.url || !cfg?.publishableKey || !window.supabase) {
        $("#connectionText").textContent = "Falta configurar Supabase";
        $("#connectionDot").classList.add("bad");
        return;
      }
      state.supabase = window.supabase.createClient(cfg.url, cfg.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      $("#connectionDot").classList.add("ok");
      $("#connectionText").textContent = "Listo para conectarse con Supabase";

      bindStaticEvents();
      const { data } = await state.supabase.auth.getSession();
      if (data.session) {
        state.session = data.session;
        await loadSignedUser();
      }
      state.supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === "SIGNED_OUT") return showLogin();
        if (session && !state.session) {
          state.session = session;
          await loadSignedUser();
        }
      });
    } catch (error) {
      $("#connectionText").textContent = "No se pudo iniciar la conexión";
      $("#connectionDot").classList.add("bad");
      toast(errorMessage(error), "error");
    }
  }

  function bindStaticEvents() {
    $("#showPass").addEventListener("click", () => {
      const input = $("#loginPass");
      input.type = input.type === "password" ? "text" : "password";
    });
    $("#loginForm").addEventListener("submit", login);
    $("#logoutBtn").addEventListener("click", logout);
    $("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    $("#refreshBtn").addEventListener("click", () => renderPage(true));
  }

  async function login(event) {
    event.preventDefault();
    const userInput = $("#loginUser").value.trim().toLowerCase();
    const password = $("#loginPass").value;
    const normalized = userInput.replace(/[^a-z0-9._-]/g, "");
    const configuredAlias = window.CLIPCONTROL_SUPABASE?.loginAliases?.[userInput];
    const email = configuredAlias || (userInput.includes("@") ? userInput : `${normalized}@usuarios.clipcontrol.app`);
    const button = $("#loginBtn");
    button.disabled = true;
    button.textContent = "Ingresando…";
    try {
      const data = await query(state.supabase.auth.signInWithPassword({ email, password }));
      state.session = data.session;
      await loadSignedUser();
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      button.disabled = false;
      button.textContent = "Ingresar";
    }
  }

  async function loadSignedUser() {
    showLoading(true);
    try {
      const userId = state.session?.user?.id;
      state.profile = await query(state.supabase.from("profiles").select("*").eq("id", userId).single());
      if (!state.profile.active) {
        await state.supabase.auth.signOut();
        throw new Error("Tu cuenta está desactivada. Comunícate con administración.");
      }
      showApp();
      state.page = "dashboard";
      await renderPage(true);
      if (state.profile.role === "clipper" && !profileComplete(state.profile)) openProfileModal(true);
    } catch (error) {
      toast(errorMessage(error), "error");
      await state.supabase.auth.signOut();
    } finally {
      showLoading(false);
    }
  }

  async function logout() {
    showLoading(true);
    await state.supabase.auth.signOut();
    state.session = null;
    state.profile = null;
    state.currentReportId = null;
    showLogin();
    showLoading(false);
  }

  function setAuthenticatedShell(authenticated) {
    const isAuthenticated = Boolean(authenticated);
    const loginView = $("#loginView");
    const appView = $("#appView");

    document.body.classList.toggle("is-authenticated", isAuthenticated);
    document.body.classList.toggle("is-login", !isAuthenticated);

    if (loginView) {
      loginView.hidden = isAuthenticated;
      loginView.classList.toggle("hidden", isAuthenticated);
      loginView.setAttribute("aria-hidden", isAuthenticated ? "true" : "false");
      // Inline !important prevents any future visual rule from reviving the login
      // after a successful authentication.
      loginView.style.setProperty("display", isAuthenticated ? "none" : "grid", "important");
      loginView.style.setProperty("visibility", isAuthenticated ? "hidden" : "visible", "important");
      loginView.style.setProperty("pointer-events", isAuthenticated ? "none" : "auto", "important");
    }

    if (appView) {
      appView.hidden = !isAuthenticated;
      appView.classList.toggle("hidden", !isAuthenticated);
      appView.setAttribute("aria-hidden", isAuthenticated ? "false" : "true");
      // The private application shell is explicitly removed while logged out.
      appView.style.setProperty("display", isAuthenticated ? "block" : "none", "important");
      appView.style.setProperty("visibility", isAuthenticated ? "visible" : "hidden", "important");
      appView.style.setProperty("pointer-events", isAuthenticated ? "auto" : "none", "important");
    }
  }

  function showLogin() {
    setAuthenticatedShell(false);
    closeModal();
  }

  function showApp() {
    setAuthenticatedShell(true);
    const p = state.profile;
    $("#sideRole").textContent = p.role === "clipper" ? "Portal del clipero" : "Administración";
    $("#miniName").textContent = p.names || p.username;
    $("#miniRole").textContent = p.role === "superadmin" ? "Superadministrador" : p.role === "admin" ? "Administrador" : "Clipero";
    $("#miniAvatar").innerHTML = uiIcon("user",18);
    buildNav();
  }

  function buildNav() {
    const isAdmin = ["admin", "superadmin"].includes(state.profile.role);
    const items = isAdmin
      ? [
        ["dashboard", "▦", "Resumen"], ["clippers", "👥", "Cliperos"],
        ["reports", "📋", "Reportes"], ["settings", "⚙️", "Configuración"],
      ]
      : [
        ["dashboard", "▦", "Mi semana"], ["videos", "🎬", "Mis videos"],
        ["networks", "🌐", "Mis redes"], ["history", "🕘", "Historial"],
        ["profile", "👤", "Mi información"],
      ];
    $("#nav").innerHTML = items.map(([id, icon, label]) =>
      `<button data-page="${id}" class="${state.page === id ? "active" : ""}"><span>${icon}</span>${label}</button>`).join("");
    $$('[data-page]').forEach((button) => button.addEventListener("click", async () => {
      state.page = button.dataset.page;
      state.selectedClipperId = null;
      $("#sidebar").classList.remove("open");
      buildNav();
      await renderPage(true);
    }));
  }

  async function renderPage(force = false) {
    if (!state.profile) return;
    showLoading(true);
    try {
      const isAdmin = ["admin", "superadmin"].includes(state.profile.role);
      if (isAdmin) await renderAdminPage();
      else await renderClipperPage();
    } catch (error) {
      console.error(error);
      $("#content").innerHTML = `<div class="alert alert-danger"><div>⚠️</div><div><strong>No se pudo cargar esta sección</strong><p>${esc(errorMessage(error))}</p></div></div>`;
      toast(errorMessage(error), "error");
    } finally {
      showLoading(false);
    }
  }

  function profileComplete(profile) {
    return Boolean(profile?.names && profile?.surnames && profile?.phone && profile?.primary_social_url);
  }

  async function loadClipperCurrentData() {
    const [accounts, settings] = await Promise.all([
      query(state.supabase.from("social_accounts").select("*").eq("user_id", state.profile.id).order("created_at")),
      query(state.supabase.from("app_settings").select("*").eq("id", 1).single()),
    ]);
    state.accounts = accounts;
    state.settings = settings;
    const reportId = await query(state.supabase.rpc("ensure_weekly_report", { p_week_start: null }));
    state.currentReportId = reportId;
    const [summary, videos, observations] = await Promise.all([
      query(state.supabase.from("weekly_report_summary").select("*").eq("report_id", reportId).single()),
      query(state.supabase.from("videos").select("*").eq("report_id", reportId).is("deleted_at", null).order("position")),
      query(state.supabase.from("report_observations").select("*").eq("report_id", reportId).order("created_at", { ascending: false })),
    ]);
    state.currentSummary = summary;
    state.videos = videos;
    state.observations = observations;
    const lastCheck = summary.metrics_last_checked_at ? new Date(summary.metrics_last_checked_at).getTime() : 0;
    if (videos.length && (!lastCheck || Date.now() - lastCheck > 24 * 60 * 60 * 1000)) {
      await syncReportMetrics(reportId, true);
      state.currentSummary = await query(state.supabase.from("weekly_report_summary").select("*").eq("report_id", reportId).single());
      state.videos = await query(state.supabase.from("videos").select("*").eq("report_id", reportId).is("deleted_at", null).order("position"));
    }
  }

  async function renderClipperPage() {
    if (["dashboard", "videos", "networks"].includes(state.page)) await loadClipperCurrentData();
    if (state.page === "dashboard") return renderClipperDashboard();
    if (state.page === "videos") return renderClipperVideos();
    if (state.page === "networks") return renderNetworks();
    if (state.page === "history") return renderClipperHistory();
    if (state.page === "profile") return renderProfilePage();
  }

  function renderClipperDashboard() {
    setHeader("Mi semana", "Tu avance semanal.");
    const s = state.currentSummary;
    const percent = clamp((Number(s.total_views || 0) / Number(s.target_views || 1)) * 100, 0, 100);
    const editable = reportEditable(s);
    const accounts = activeAccounts();
    const hasAccounts = accounts.length > 0;
    const deadlinePassed = s.submission_deadline && Date.now() > new Date(s.submission_deadline).getTime();
    const interactions = Number(s.total_likes || 0) + Number(s.total_comments || 0) + Number(s.total_shares || 0);
    const message = s.target_reached
      ? `<div class="alert alert-success compact-alert"><div>🎉</div><div><strong>Meta alcanzada</strong><p>${num(s.total_views)} vistas acumuladas.</p></div></div>`
      : Number(s.total_views || 0) < Number(s.low_alert || 0) && Number(s.video_count || 0) > 0
        ? `<div class="alert alert-warning compact-alert"><div>📈</div><div><strong>Sigue avanzando</strong><p>Te faltan ${num(Math.max(Number(s.target_views || 0) - Number(s.total_views || 0), 0))} vistas para la meta.</p></div></div>`
        : "";

    $("#content").innerHTML = `
      <section class="dashboard-banner compact-banner clipper-banner">
        <div><span class="eyebrow">${weekLabel(s.week_start)}</span><h2>${esc(state.profile.names || state.profile.username)}</h2><p>${STATUS_LABELS[s.status]} · cierre ${dateTimeLabel(s.submission_deadline)}</p></div>
        <div class="team-goal"><div class="ring-progress small-ring" style="--p:${percent}%"><span>${Math.round(percent)}%</span></div><div><small>Pago estimado</small><strong>${money(s.calculated_base_pay)}</strong><span>Meta general: ${num(s.target_views)} vistas</span></div></div>
      </section>
      ${platformMetricCards(state.videos)}
      <div class="grid grid3 compact-kpis mobile-two-columns" style="margin-top:12px">
        ${kpi("Videos", num(s.video_count), `${accounts.length} cuentas activas`)}
        ${kpi("Interacciones", num(interactions), "Likes + comentarios + compartidos")}
        ${kpi("Pago estimado", money(s.calculated_base_pay), `Máximo visible ${money(s.max_base_pay)}`)}
      </div>
      ${message ? `<div style="margin-top:12px">${message}</div>` : ""}
      <div class="grid grid2 dashboard-actions-grid" style="margin-top:12px">
        <div class="card compact-card">
          <div class="card-head"><div><h2>Agregar videos</h2><p>Pega uno o varios enlaces.</p></div><span class="status ${statusClass(s.status)}">${STATUS_LABELS[s.status]}</span></div>
          ${!hasAccounts ? '<div class="alert alert-warning compact-alert"><div>🌐</div><div><strong>Registra una red</strong><p>Agrega tu primera cuenta para continuar.</p></div></div>' : ""}
          <div class="actions" style="margin-top:10px">
            <button id="quickAddBtn" class="btn btn-primary" ${!editable ? "disabled" : ""}>＋ Agregar videos</button>
            <button id="goNetworksBtn" class="btn btn-ghost">Mis redes</button>
          </div>
          <p class="muted small" style="margin-top:10px">Completa una o varias filas. Puedes agregar más cuando lo necesites.</p>
          ${!editable ? `<p class="small" style="color:var(--danger)">${deadlinePassed ? "El plazo terminó." : "El reporte fue aprobado o cerrado."}</p>` : ""}
        </div>
        <div class="card compact-card">
          <div class="card-head"><div><h2>Reporte semanal</h2><p>Editable hasta la fecha límite.</p></div></div>
          <div class="summary-list compact-summary">
            <div><span>Estado</span><b>${STATUS_LABELS[s.status]}</b></div>
            <div><span>Actualización</span><b>${dateTimeLabel(s.metrics_last_checked_at)}</b></div>
            <div><span>Entrega</span><b>${s.submitted_at ? dateTimeLabel(s.submitted_at) : "Pendiente"}</b></div>
          </div>
          <div class="actions" style="margin-top:10px"><button id="submitReportBtn" class="btn btn-success" ${!editable || s.can_submit === false || Number(s.video_count || 0) < 1 ? "disabled" : ""}>${s.submitted_at ? "Actualizar entrega" : "Enviar reporte"}</button><button id="viewVideosBtn" class="btn btn-ghost">Ver lista</button></div>
        </div>
      </div>
      <div class="card compact-card" style="margin-top:12px"><div class="card-head"><div><h2>Últimos videos</h2><p>${state.videos.length} registrados.</p></div></div>${videosTable(state.videos.slice(0, 8), state.accounts, false, editable)}</div>`;

    $("#quickAddBtn")?.addEventListener("click", handleQuickRegisterAction);
    $("#goNetworksBtn").addEventListener("click", () => navigate("networks"));
    $("#viewVideosBtn").addEventListener("click", () => navigate("videos"));
    $("#submitReportBtn")?.addEventListener("click", submitCurrentReport);
    bindClipperVideoActions();
  }

  function kpi(label, value, foot) {
    return `<div class="card kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-foot">${foot}</div></div>`;
  }

  function summarizeVideosByPlatform(videos = []) {
    const summary = Object.fromEntries(Object.keys(PLATFORMS).map((platform) => [platform, { videos: 0, views: 0, likes: 0, comments: 0, shares: 0 }]));
    for (const video of videos || []) {
      const platform = video.platform;
      if (!summary[platform]) continue;
      summary[platform].videos += 1;
      summary[platform].views += Number(video.views || 0);
      summary[platform].likes += Number(video.likes || 0);
      summary[platform].comments += Number(video.comments || 0);
      summary[platform].shares += Number(video.shares || 0);
    }
    return summary;
  }

  function platformMetricCards(videos = []) {
    const summary = summarizeVideosByPlatform(videos);
    return `<div class="platform-metrics-grid">${Object.entries(PLATFORMS).map(([platform]) => {
      const metric = summary[platform];
      return `<div class="card platform-metric-card platform-metric-${platform}"><div class="platform-metric-head">${platformBadge(platform, true)}<span>${metric.videos} video${metric.videos === 1 ? "" : "s"}</span></div><strong>${num(metric.views)}</strong><small>vistas</small><div class="platform-metric-foot">❤ ${num(metric.likes)} · 💬 ${num(metric.comments)} · ↗ ${num(metric.shares)}</div></div>`;
    }).join("")}</div>`;
  }

  function videosTable(videos, accounts, admin = false, editable = false) {
    const accountMap = Object.fromEntries(accounts.map((a) => [a.id, a]));
    if (!videos.length) return `<div class="empty">Todavía no hay videos registrados.</div>`;
    return `<div class="table-wrap compact-table video-table"><table><thead><tr><th>N.°</th><th>Red / Cuenta</th><th>Enlace</th><th>Vistas</th><th>Me gusta</th><th>Estado</th>${admin ? "<th>Fecha</th>" : ""}<th></th></tr></thead><tbody>
      ${videos.map((video) => {
        const account = accountMap[video.account_id] || {};
        const canManage = admin || editable;
        const syncButton = admin ? `<button class="btn btn-secondary btn-sm" data-sync-video="${video.id}" title="Volver a detectar métricas">↻</button>` : "";
        const actions = `<div class="actions table-actions">${syncButton}${canManage ? `<button class="btn btn-ghost btn-sm" data-edit-video="${video.id}">Editar</button><button class="btn btn-danger btn-sm" data-delete-video="${video.id}">Anular</button>` : ""}</div>`;
        const viewsValue = Number(video.views || 0) > 0 ? num(video.views) : '<span class="muted">Pendiente</span>';
        return `<tr><td><b>${video.position}</b></td><td>${platformBadge(video.platform, true)}<br><small class="muted">${esc(account.account_name || "—")}</small></td><td class="link-cell"><a href="${esc(video.video_url)}" target="_blank" rel="noopener">Abrir video</a></td><td><b>${viewsValue}</b></td><td><b>${num(video.likes || 0)}</b><br><small class="muted">💬 ${num(video.comments || 0)} · ↗ ${num(video.shares || 0)}</small></td><td>${metricStatus(video)}<br><small class="muted">${dateTimeLabel(video.metrics_checked_at)}</small></td>${admin ? `<td>${dateTimeLabel(video.created_at)}</td>` : ""}<td>${actions}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  }

  function bindClipperVideoActions() {
    $$('[data-edit-video]').forEach((button) => button.addEventListener("click", () => openEditVideoModal(button.dataset.editVideo)));
    $$('[data-delete-video]').forEach((button) => button.addEventListener("click", () => deleteClipperVideo(button.dataset.deleteVideo)));
    $$('[data-sync-video]').forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      await syncVideoMetrics(button.dataset.syncVideo);
      await renderPage(true);
    }));
  }

  async function deleteClipperVideo(videoId) {
    const video = state.videos.find((item) => item.id === videoId);
    if (!video) return;
    if (!reportEditable(state.currentSummary)) return toast("El reporte ya no permite modificaciones.", "error");
    if (!confirm(`¿Anular el video de la fila ${video.position}? El administrador podrá ver el registro en la auditoría.`)) return;
    showLoading(true);
    try {
      await query(state.supabase.rpc("soft_delete_video", { p_video_id: videoId, p_reason: "Anulado por el clipero" }));
      toast("Video anulado correctamente", "success");
      await renderPage(true);
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      showLoading(false);
    }
  }

  async function handleQuickRegisterAction() {
    if (!profileComplete(state.profile)) {
      openProfileModal(true);
      return;
    }
    if (!reportEditable(state.currentSummary)) {
      toast("El reporte está cerrado. Solicita a administración habilitar la edición.", "error");
      return;
    }
    if (!activeAccounts().length) {
      state.page = "networks";
      buildNav();
      await renderPage(true);
      openAccountModal("tiktok", null, true);
      return;
    }
    openQuickRegisterModal();
  }

  function navigate(page) {
    state.page = page;
    buildNav();
    renderPage(true);
  }

  async function submitCurrentReport() {
    if (!confirm("¿Enviar el reporte semanal? Podrás seguir editando hasta la fecha límite mientras no haya sido aprobado o pagado.")) return;
    showLoading(true);
    try {
      await query(state.supabase.rpc("submit_my_report", { p_report_id: state.currentReportId }));
      toast("Reporte enviado correctamente", "success");
      await renderPage(true);
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally { showLoading(false); }
  }

  function renderClipperVideos() {
    setHeader("Mis videos", "Registra y revisa la semana actual.");
    const editable = reportEditable(state.currentSummary);
    const hasAccounts = activeAccounts().length > 0;
    $("#content").innerHTML = `
      <div class="card compact-card">
        <div class="card-head"><div><h2>${weekLabel(state.currentSummary.week_start)}</h2><p>${state.currentSummary.video_count} videos · ${num(state.currentSummary.total_views)} vistas · ${num(state.currentSummary.total_likes || 0)} me gusta</p></div><div class="actions"><button id="quickAddBtn" class="btn btn-primary" ${!editable ? "disabled" : ""}>＋ Agregar videos</button></div></div>
        ${!hasAccounts ? `<div class="alert alert-warning compact-alert"><div>🌐</div><div><strong>Primero registra una cuenta</strong><p>Agrega TikTok, Instagram, YouTube o Facebook.</p></div></div>` : ""}
        ${videosTable(state.videos, state.accounts, false, editable)}
      </div>`;
    $("#quickAddBtn")?.addEventListener("click", handleQuickRegisterAction);
    bindClipperVideoActions();
  }

  function openAddVideoModal() {
    openQuickRegisterModal();
  }

  function openQuickRegisterModal(initialUrls = []) {
    const s = state.currentSummary;
    const registeredAccounts = activeAccounts();
    if (!registeredAccounts.length) return toast("Primero registra una cuenta social.", "error");
    const draftKey = `clipcontrol_quick_draft_v15_${s.report_id}`;
    let draftRows = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(draftKey) || "[]");
      if (Array.isArray(parsed)) draftRows = parsed;
    } catch { draftRows = []; }

    const usedPositions = new Set(state.videos.map((video) => Number(video.position)));
    draftRows = draftRows.filter((row) => !usedPositions.has(Number(row.position)));
    const preparedUrls = [...new Set((Array.isArray(initialUrls) ? initialUrls : [initialUrls])
      .map((value) => normalizeUrl(value))
      .filter((value) => videoUrlValidation(value).ok && !(state.videos || []).some((video) => canonicalVideoUrl(video.video_url) === canonicalVideoUrl(value))))];
    if (preparedUrls.length) {
      const positions = nextFreePositions(preparedUrls.length);
      draftRows = preparedUrls.map((video_url, index) => {
        const platform = inferPlatformFromUrl(video_url) || "youtube";
        return { position: positions[index], platform, account_id: preferredAccountIdForPlatform(registeredAccounts, platform), video_url };
      });
    }
    if (!draftRows.length) {
      const initialCount = Math.max(1, Number(state.settings?.default_slots || DEFAULT_BATCH_ROWS));
      draftRows = nextFreePositions(initialCount).map((position) => ({ position, platform: registeredAccounts[0]?.platform || "tiktok", account_id: "", video_url: "" }));
    }

    openModal(`
      <div class="modal-head"><div><h2>Agregar videos</h2><p>Pega enlaces y guarda. Las métricas se detectan solas.</p></div><button id="quickX" class="modal-close" title="Cerrar">×</button></div>
      <div class="modal-body">
        <div class="quick-import-panel">
          <div class="quick-import-copy"><strong>Pegado masivo</strong><small>Un enlace por línea.</small></div>
          <div class="quick-import-box">
            <textarea id="bulkUrlInput" rows="4" placeholder="https://www.youtube.com/watch?v=...\nhttps://www.tiktok.com/@usuario/video/...\nhttps://www.instagram.com/reel/..."></textarea>
            <div class="quick-import-actions"><button id="pasteRowsBtn" class="btn btn-secondary btn-sm">Crear filas</button><span id="bulkImportState" class="draft-note">Se completará cuenta si solo existe una para esa red.</span></div>
          </div>
        </div>
        <div class="batch-toolbar"><span id="rowCounter" class="chip">${draftRows.length} filas</span><button id="addBatchRowBtn" class="btn btn-secondary btn-sm">＋ Fila</button></div>
        <div class="quick-table table-wrap"><table><thead><tr><th>N.°</th><th>Plataforma</th><th>Cuenta</th><th>Enlace del video</th><th>Detección</th><th></th></tr></thead><tbody id="quickRows">${draftRows.map((row) => quickRow(row.position, row.platform, row.account_id, row.video_url, registeredAccounts)).join("")}</tbody></table></div>
      </div>
      <div class="modal-foot"><div id="draftState" class="draft-note">Borrador automático activo.</div><div class="actions"><button id="clearDraftBtn" class="btn btn-ghost">Limpiar</button><button id="saveQuickBtn" class="btn btn-primary">Guardar y detectar</button></div></div>`, "", (layer) => {
        const tbody = $("#quickRows", layer);
        const updateCounter = () => { $("#rowCounter", layer).textContent = `${$$('tr[data-position]', tbody).length} filas`; };
        const serialize = () => $$('tr[data-position]', tbody).map((tr) => ({
          position: Number(tr.dataset.position),
          platform: $("[data-field=platform]", tr).value,
          account_id: $("[data-field=account]", tr).value,
          video_url: $("[data-field=url]", tr).value.trim(),
        }));
        const saveDraft = debounce(() => {
          localStorage.setItem(draftKey, JSON.stringify(serialize()));
          $("#draftState", layer).textContent = "Borrador guardado automáticamente";
        }, 250);
        const addRow = () => {
          const currentPositions = new Set([...usedPositions, ...$$('tr[data-position]', tbody).map((tr) => Number(tr.dataset.position))]);
          let position = 1;
          while (currentPositions.has(position)) position += 1;
          tbody.insertAdjacentHTML("beforeend", quickRow(position, registeredAccounts[0]?.platform || "tiktok", "", "", registeredAccounts));
          updateCounter();
          saveDraft();
          tbody.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        };
        const importBulkUrls = () => {
          const input = $("#bulkUrlInput", layer);
          const status = $("#bulkImportState", layer);
          const entries = parseBulkVideoUrls(input.value);
          if (!entries.length) {
            status.textContent = "Pega al menos un enlace para crear filas.";
            return;
          }
          const currentRows = $$('tr[data-position]', tbody);
          const currentUrls = new Set(currentRows.map((tr) => canonicalVideoUrl($("[data-field=url]", tr).value)).filter(Boolean));
          const existingUrls = new Set((state.videos || []).map((video) => canonicalVideoUrl(video.video_url)).filter(Boolean));
          const currentPositions = new Set([...usedPositions, ...currentRows.map((tr) => Number(tr.dataset.position))]);
          const results = { added: 0, duplicates: 0, invalid: 0 };

          for (const rawEntry of entries) {
            const validation = videoUrlValidation(rawEntry);
            if (!validation.ok) {
              results.invalid += 1;
              continue;
            }
            const canonical = canonicalVideoUrl(validation.url);
            if (!canonical || currentUrls.has(canonical) || existingUrls.has(canonical)) {
              results.duplicates += 1;
              continue;
            }
            let position = 1;
            while (currentPositions.has(position)) position += 1;
            currentPositions.add(position);
            currentUrls.add(canonical);
            const platform = validation.platform || registeredAccounts[0]?.platform || "tiktok";
            const accountId = preferredAccountIdForPlatform(registeredAccounts, platform);
            tbody.insertAdjacentHTML("beforeend", quickRow(position, platform, accountId, validation.url, registeredAccounts));
            results.added += 1;
          }

          updateCounter();
          saveDraft();
          input.value = "";
          status.textContent = results.added
            ? `${results.added} enlace(s) agregado(s)${results.duplicates ? ` · ${results.duplicates} repetido(s)` : ""}${results.invalid ? ` · ${results.invalid} inválido(s)` : ""}`
            : "No se agregó ningún enlace nuevo.";
        };

        tbody.addEventListener("change", (event) => {
          const tr = event.target.closest("tr[data-position]");
          if (event.target.dataset.field === "platform") {
            $("[data-field=account]", tr).innerHTML = accountOptions(registeredAccounts, event.target.value, "");
          }
          saveDraft();
        });
        tbody.addEventListener("input", saveDraft);
        tbody.addEventListener("click", (event) => {
          const remove = event.target.closest("[data-remove-row]");
          if (!remove) return;
          const rows = $$('tr[data-position]', tbody);
          if (rows.length === 1) {
            const tr = remove.closest("tr");
            $("[data-field=account]", tr).value = "";
            $("[data-field=url]", tr).value = "";
          } else remove.closest("tr")?.remove();
          updateCounter();
          saveDraft();
        });
        $("#addBatchRowBtn", layer).addEventListener("click", addRow);
        $("#pasteRowsBtn", layer).addEventListener("click", importBulkUrls);
        $("#quickX", layer).addEventListener("click", closeModal);
        $("#clearDraftBtn", layer).addEventListener("click", () => {
          if (!confirm("¿Limpiar las filas sin guardar?")) return;
          localStorage.removeItem(draftKey);
          closeModal();
          openQuickRegisterModal();
        });
        $("#saveQuickBtn", layer).addEventListener("click", () => saveQuickRows(layer, registeredAccounts, draftKey));
      });
  }

  function quickRow(position, platform, accountId, url, accounts) {
    const availablePlatforms = [...new Set(accounts.filter((account) => account.active).map((account) => account.platform))];
    const selectedPlatform = availablePlatforms.includes(platform) ? platform : (availablePlatforms[0] || platform);
    return `<tr data-position="${position}">
      <td><b>${position}</b></td>
      <td><select data-field="platform">${availablePlatforms.map((key) => `<option value="${key}" ${selectedPlatform === key ? "selected" : ""}>${PLATFORMS[key].label}</option>`).join("")}</select></td>
      <td><select data-field="account">${accountOptions(accounts, selectedPlatform, accountId)}</select></td>
      <td><input data-field="url" type="text" inputmode="url" placeholder="Pega el enlace del video" value="${esc(url)}"></td>
      <td><span class="pill pill-blue">Automática</span></td>
      <td><button type="button" class="icon-btn row-remove" data-remove-row title="Quitar fila">×</button></td>
    </tr>`;
  }

  function accountOptions(accounts, platform, selectedId) {
    const available = accounts.filter((a) => a.platform === platform && (a.active || a.id === selectedId));
    const effectiveSelected = selectedId || (available.length === 1 ? available[0].id : "");
    return `<option value="">Seleccionar cuenta</option>${available.map((a) => `<option value="${a.id}" ${a.id === effectiveSelected ? "selected" : ""}>${esc(a.account_name)}</option>`).join("")}`;
  }

  async function saveQuickRows(layer, registeredAccounts, draftKey) {
    const button = $("#saveQuickBtn", layer);
    const rows = [];
    const seenUrls = new Set();
    const existingUrls = new Set((state.videos || []).map((video) => canonicalVideoUrl(video.video_url)).filter(Boolean));
    for (const tr of $$("tr[data-position]", layer)) {
      const position = Number(tr.dataset.position);
      const accountId = $("[data-field=account]", tr).value;
      const urlInput = $("[data-field=url]", tr);
      const rawUrl = urlInput.value.trim();
      if (!accountId && !rawUrl) continue;
      if (!accountId || !rawUrl) {
        toast(`Completa cuenta y enlace en la fila ${position}.`, "error");
        tr.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const account = registeredAccounts.find((item) => item.id === accountId);
      if (!account) return toast(`Cuenta inválida en la fila ${position}.`, "error");
      const validation = videoUrlValidation(rawUrl, account.platform);
      if (!validation.ok) return toast(`Fila ${position}: ${validation.reason}`, "error");
      const videoUrl = validation.url;
      const canonical = canonicalVideoUrl(videoUrl);
      if (seenUrls.has(canonical)) return toast(`El enlace de la fila ${position} está repetido en esta carga.`, "error");
      if (existingUrls.has(canonical)) return toast(`El enlace de la fila ${position} ya fue registrado en este período.`, "error");
      seenUrls.add(canonical);
      urlInput.value = videoUrl;
      rows.push({ position, account_id: accountId, video_url: videoUrl, views: 0, likes: 0 });
    }
    if (!rows.length) return toast("Completa al menos una fila para guardar.", "error");
    button.disabled = true;
    button.textContent = "Guardando…";
    try {
      // Antes de insertar, intentamos recuperar una fila anulada con el mismo
      // video. Esto evita que un soft-delete deje bloqueado el enlace o el
      // número de posición. Si el RPC todavía no está instalado, simplemente
      // continuamos con el comportamiento anterior.
      const rowsToInsert = [];
      const restoredIds = [];
      let restoreRpcAvailable = true;
      for (const row of rows) {
        if (!restoreRpcAvailable) {
          rowsToInsert.push(row);
          continue;
        }
        try {
          const restored = await query(state.supabase.rpc("restore_deleted_video", {
            p_report_id: state.currentReportId,
            p_position: row.position,
            p_account_id: row.account_id,
            p_video_url: row.video_url,
          }));
          const restoredRow = Array.isArray(restored) ? restored[0] : restored;
          const restoredId = restoredRow?.video_id || restoredRow?.id || (typeof restoredRow === "string" ? restoredRow : null);
          if (restoredId) restoredIds.push(restoredId);
          else rowsToInsert.push(row);
        } catch (restoreError) {
          const restoreMessage = String(restoreError?.message || restoreError || "");
          if (/restore_deleted_video|function .* does not exist|PGRST202/i.test(restoreMessage)) {
            restoreRpcAvailable = false;
            rowsToInsert.push(row);
          } else {
            throw restoreError;
          }
        }
      }

      if (rowsToInsert.length) {
        await query(state.supabase.rpc("save_video_batch", { p_report_id: state.currentReportId, p_rows: rowsToInsert }));
      }
      const positions = rows.map((r) => r.position);
      const savedVideos = await query(state.supabase.from("videos").select("id,position").eq("report_id", state.currentReportId).in("position", positions).is("deleted_at", null));
      localStorage.removeItem(draftKey);
      closeModal();
      const restoredCount = restoredIds.length;
      toast(restoredCount
        ? `${rows.length} video${rows.length === 1 ? "" : "s"} listo${rows.length === 1 ? "" : "s"} · ${restoredCount} recuperado${restoredCount === 1 ? "" : "s"}. Detectando métricas…`
        : `${rows.length} video${rows.length === 1 ? "" : "s"} guardado${rows.length === 1 ? "" : "s"}. Detectando métricas…`, "success");
      const savedList = savedVideos || [];
      for (let index = 0; index < savedList.length; index += 4) {
        await Promise.all(savedList.slice(index, index + 4).map((video) => syncVideoMetrics(video.id, true)));
      }
      await renderPage(true);
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      button.disabled = false;
      button.textContent = "Guardar y detectar";
    }
  }

  function debounce(fn, wait) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
  }

  function openEditVideoModal(videoId, adminMode = false) {
    const video = state.videos.find((v) => v.id === videoId);
    if (!video) return;
    const ownerAccounts = state.accounts.filter((a) => a.active || a.id === video.account_id);
    openModal(`
      <div class="modal-head"><div><h2>Editar video</h2><p>Cambia la cuenta o el enlace. Las métricas seguirán siendo automáticas.</p></div><button id="editX" class="modal-close">×</button></div>
      <form id="editVideoForm"><div class="modal-body"><div class="form-grid compact-form">
        <label>Plataforma<select id="editPlatform">${Object.entries(PLATFORMS).map(([key,p]) => `<option value="${key}" ${video.platform === key ? "selected" : ""}>${p.label}</option>`).join("")}</select></label>
        <label>Cuenta<select id="editAccount">${accountOptions(ownerAccounts, video.platform, video.account_id)}</select></label>
        <label class="full">Enlace del video<input id="editUrl" type="url" inputmode="url" required value="${esc(video.video_url)}"></label>
      </div><div class="auto-metrics-panel"><div><span>Vistas</span><b>${num(video.views || 0)}</b></div><div><span>Me gusta</span><b>${num(video.likes || 0)}</b></div><div><span>Comentarios</span><b>${num(video.comments || 0)}</b></div><div><span>Compartidos</span><b>${num(video.shares || 0)}</b></div></div><p class="muted small" style="margin-top:10px">Última detección: ${dateTimeLabel(video.metrics_checked_at)}. Al cambiar el enlace se programará una nueva detección.</p></div>
      <div class="modal-foot"><button type="button" id="detectAgain" class="btn btn-secondary">↻ Detectar ahora</button><div class="actions"><button type="button" id="editCancel" class="btn btn-ghost">Cancelar</button><button class="btn btn-primary">Guardar cambios</button></div></div></form>`, "small", (layer) => {
        $("#editX", layer).addEventListener("click", closeModal);
        $("#editCancel", layer).addEventListener("click", closeModal);
        $("#editPlatform", layer).addEventListener("change", (e) => { $("#editAccount", layer).innerHTML = accountOptions(ownerAccounts, e.target.value, ""); });
        $("#detectAgain", layer).addEventListener("click", async () => {
          $("#detectAgain", layer).disabled = true;
          const result = await syncVideoMetrics(video.id);
          if (result?.ok) {
            closeModal();
            if (adminMode) await openAdminReportDetail(video.report_id); else await renderPage(true);
          } else $("#detectAgain", layer).disabled = false;
        });
        $("#editVideoForm", layer).addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            const accountId = $("#editAccount", layer).value;
            const videoUrl = normalizeUrl($("#editUrl", layer).value);
            if (!accountId) throw new Error("Selecciona una cuenta.");
            if (!isValidHttpUrl(videoUrl)) throw new Error("Ingresa un enlace válido.");
            await query(state.supabase.from("videos").update({ account_id: accountId, video_url: videoUrl, metrics_status: "pending", metrics_error: null, metrics_next_check_at: new Date().toISOString() }).eq("id", video.id));
            closeModal();
            toast("Video actualizado. Detectando métricas…", "success");
            await syncVideoMetrics(video.id, true);
            if (adminMode) await openAdminReportDetail(video.report_id); else await renderPage(true);
          } catch (error) { toast(errorMessage(error), "error"); }
        });
      });
  }

  function renderNetworks() {
    setHeader("Mis redes", "Registra una o varias cuentas por plataforma.");
    const grouped = Object.keys(PLATFORMS).map((platform) => {
      const accounts = state.accounts.filter((a) => a.platform === platform);
      return `<div class="card network-card"><div class="card-head"><div><div class="platform-title">${platformBadge(platform)}</div><p>${accounts.filter((a) => a.active).length} cuentas activas</p></div><button class="btn btn-secondary btn-sm" data-add-account="${platform}">＋ Agregar</button></div>
        ${accounts.length ? accounts.map((a) => `<div style="padding:12px 0;border-top:1px solid var(--line)"><div class="card-head" style="margin:0"><div><b>${esc(a.account_name)}</b><p class="small"><a href="${esc(a.channel_url)}" target="_blank" rel="noopener">${esc(a.channel_url)}</a></p></div><div class="actions"><span class="pill ${a.active ? "pill-green" : "pill-red"}">${a.active ? "Activa" : "Inactiva"}</span><button class="btn btn-ghost btn-sm" data-edit-account="${a.id}">Editar</button></div></div></div>`).join("") : `<p class="muted">No registraste cuentas en esta plataforma.</p>`}
      </div>`;
    }).join("");
    $("#content").innerHTML = `<div class="alert alert-info" style="margin-bottom:18px"><div>ℹ️</div><div><strong>Registra tus perfiles una sola vez</strong><p>Luego podrás seleccionarlos rápidamente al cargar cada video. Debes pegar el enlace del perfil o canal, no un video.</p></div></div>${activeAccounts().length ? `<div class="actions" style="margin-bottom:18px"><button id="continueQuickBtn" class="btn btn-primary">🎬 Continuar al registro de videos</button></div>` : ""}<div class="grid grid2">${grouped}</div>`;
    $$('[data-add-account]').forEach((b) => b.addEventListener("click", () => openAccountModal(b.dataset.addAccount)));
    $$('[data-edit-account]').forEach((b) => b.addEventListener("click", () => openAccountModal(null, b.dataset.editAccount)));
    $("#continueQuickBtn")?.addEventListener("click", handleQuickRegisterAction);
  }

  function openAccountModal(platform = null, accountId = null, continueToQuick = false) {
    const account = accountId ? state.accounts.find((a) => a.id === accountId) : null;
    const selectedPlatform = account?.platform || platform || "tiktok";
    openModal(`
      <div class="modal-head"><div><h2>${account ? "Editar" : "Agregar"} cuenta social</h2><p>Coloca el enlace completo de tu perfil o canal.</p></div><button id="accountX" class="modal-close">×</button></div>
      <form id="accountForm"><div class="modal-body"><div class="form-grid">
        ${account
          ? `<label>Plataforma<input type="hidden" name="platform" value="${selectedPlatform}"><input value="${platformLabel(selectedPlatform)}" disabled></label>`
          : `<label>Plataforma<select name="platform">${Object.entries(PLATFORMS).map(([key,p]) => `<option value="${key}" ${selectedPlatform === key ? "selected" : ""}>${p.icon} ${p.label}</option>`).join("")}</select></label>`}
        <label>Nombre o apelativo de la cuenta<input name="account_name" required value="${esc(account?.account_name || "")}" placeholder="Ejemplo: @clipsjuan"></label>
        <label class="full">Enlace del perfil o canal<input name="channel_url" type="text" inputmode="url" required value="${esc(account?.channel_url || "")}" placeholder="https://..."></label>
        ${account ? `<label class="full"><span><input name="active" type="checkbox" style="width:auto" ${account.active ? "checked" : ""}> Cuenta activa</span></label>` : ""}
      </div></div><div class="modal-foot"><span></span><div class="actions"><button type="button" id="accountCancel" class="btn btn-ghost">Cancelar</button><button class="btn btn-primary">Guardar cuenta</button></div></div></form>`, "small", (layer) => {
        $("#accountX", layer).addEventListener("click", closeModal);
        $("#accountCancel", layer).addEventListener("click", closeModal);
        $("#accountForm", layer).addEventListener("submit", async (event) => {
          event.preventDefault();
          const f = Object.fromEntries(new FormData(event.target));
          const channelUrl = normalizeUrl(f.channel_url);
          if (!isValidHttpUrl(channelUrl)) return toast("Ingresa un enlace válido del perfil o canal.", "error");
          const payload = { platform: String(f.platform), account_name: String(f.account_name).trim(), channel_url: channelUrl, active: account ? f.active === "on" : true };
          try {
            if (account) await query(state.supabase.from("social_accounts").update(payload).eq("id", account.id));
            else await query(state.supabase.from("social_accounts").insert({ user_id: state.profile.id, ...payload }));
            closeModal();
            toast("Cuenta guardada", "success");
            await renderPage(true);
            if (continueToQuick) openQuickRegisterModal();
          } catch (error) { toast(errorMessage(error), "error"); }
        });
      });
  }

  async function renderClipperHistory() {
    setHeader("Historial semanal", "Consulta nuevamente los enlaces y resultados de semanas anteriores.");
    const reports = await query(state.supabase.from("weekly_report_summary").select("*").eq("user_id", state.profile.id).order("week_start", { ascending: false }));
    $("#content").innerHTML = `<div class="card"><div class="card-head"><div><h2>Mis reportes</h2><p>${reports.length} semanas registradas</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>Semana</th><th>Videos</th><th>Vistas</th><th>Pago calculado</th><th>Estado</th><th></th></tr></thead><tbody>
      ${reports.map((r) => `<tr><td>${dateOnlyLabel(r.week_start)} – ${dateOnlyLabel(r.week_end)}</td><td>${r.video_count}</td><td>${num(r.total_views)}</td><td>${money(r.total_pay ?? r.approved_base_pay ?? r.calculated_base_pay)}</td><td><span class="status ${statusClass(r.status)}">${STATUS_LABELS[r.status]}</span></td><td><button class="btn btn-secondary btn-sm" data-history-report="${r.report_id}">Ver detalle</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty">No existen reportes.</td></tr>`}
      </tbody></table></div></div>`;
    $$('[data-history-report]').forEach((b) => b.addEventListener("click", () => openReportDetail(b.dataset.historyReport, false)));
  }

  async function openReportDetail(reportId, adminMode = false) {
    showLoading(true);
    try {
      const summary = await query(state.supabase.from("weekly_report_summary").select("*").eq("report_id", reportId).single());
      const [videos, accounts] = await Promise.all([
        query(state.supabase.from("videos").select("*").eq("report_id", reportId).is("deleted_at", null).order("position")),
        query(state.supabase.from("social_accounts").select("*").eq("user_id", summary.user_id).order("platform")),
      ]);
      openModal(`<div class="modal-head"><div><h2>Reporte ${dateOnlyLabel(summary.week_start)} – ${dateOnlyLabel(summary.week_end)}</h2><p>${esc(summary.names || summary.username)} ${esc(summary.surnames || "")}</p></div><button id="detailX" class="modal-close">×</button></div>
        <div class="modal-body"><div class="grid grid4">${kpi("Videos", `${summary.video_count}`, "")}${kpi("Vistas", num(summary.total_views), "")}${kpi("Pago", money(summary.total_pay ?? summary.approved_base_pay ?? summary.calculated_base_pay), "")}${kpi("Estado", STATUS_LABELS[summary.status], "")}</div><div style="margin-top:18px">${videosTable(videos, accounts, adminMode)}</div></div>
        <div class="modal-foot"><span></span><button id="detailClose" class="btn btn-primary">Cerrar</button></div>`, "", (layer) => {
          $("#detailX", layer).addEventListener("click", closeModal);
          $("#detailClose", layer).addEventListener("click", closeModal);
        });
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { showLoading(false); }
  }

  function renderProfilePage() {
    setHeader("Mi información", "Actualiza tus datos y tu cuenta principal.");
    const p = state.profile;
    $("#content").innerHTML = `<div class="card compact-card" style="max-width:860px"><div class="card-head"><div><h2>Datos personales</h2><p>Tu usuario de acceso solo lo administra la empresa.</p></div><span class="chip">@${esc(p.username)}</span></div>
      <form id="profileForm" class="form-grid compact-form">
        <label>Nombres<input name="names" required value="${esc(p.names || "")}"></label>
        <label>Apellidos<input name="surnames" required value="${esc(p.surnames || "")}"></label>
        <label>Celular / WhatsApp<input name="phone" required value="${esc(p.phone || "")}"></label>
        <label>Link de cuenta principal<input name="primary_social_url" required type="url" value="${esc(p.primary_social_url || "")}" placeholder="https://www.tiktok.com/@usuario"></label>
        <div class="full actions"><button class="btn btn-primary">Guardar cambios</button></div>
      </form></div>`;
    $("#profileForm").addEventListener("submit", saveOwnProfile);
  }

  function openProfileModal(required = false) {
    const p = state.profile;
    openModal(`<div class="modal-head"><div><h2>Completa tu registro</h2><p>Solo te tomará un momento.</p></div>${required ? "" : '<button id="profileX" class="modal-close">×</button>'}</div>
      <form id="modalProfileForm"><div class="modal-body"><div class="form-grid compact-form">
        <label>Nombres<input name="names" required value="${esc(p.names || "")}"></label>
        <label>Apellidos<input name="surnames" required value="${esc(p.surnames || "")}"></label>
        <label>Celular / WhatsApp<input name="phone" required value="${esc(p.phone || "")}"></label>
        <label>Link de tu cuenta principal<input name="primary_social_url" type="url" required value="${esc(p.primary_social_url || "")}" placeholder="https://www.tiktok.com/@usuario"></label>
      </div><div class="alert alert-info" style="margin-top:14px"><div>ℹ️</div><div><strong>Tu primera red se registra automáticamente</strong><p>Después podrás agregar otras cuentas de TikTok, Instagram, YouTube o Facebook.</p></div></div></div><div class="modal-foot"><span></span><button class="btn btn-primary">Guardar y entrar</button></div></form>`, "small", (layer) => {
        $("#profileX", layer)?.addEventListener("click", closeModal);
        $("#modalProfileForm", layer).addEventListener("submit", async (event) => {
          await saveOwnProfile(event);
          if (profileComplete(state.profile)) closeModal();
        });
      });
  }

  async function saveOwnProfile(event) {
    event.preventDefault();
    const f = Object.fromEntries(new FormData(event.target));
    const url = normalizeUrl(f.primary_social_url);
    if (!isValidHttpUrl(url)) return toast("Ingresa un link válido de TikTok, Instagram, YouTube o Facebook.", "error");
    showLoading(true);
    try {
      const updated = await query(state.supabase.rpc("update_my_profile_v14", {
        p_names: f.names,
        p_surnames: f.surnames,
        p_phone: f.phone,
        p_primary_social_url: url,
      }));
      state.profile = { ...state.profile, ...(Array.isArray(updated) ? (updated[0] || {}) : (updated || {})) };
      showApp();
      toast("Información guardada", "success");
      if (state.page === "profile") await renderPage(true);
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { showLoading(false); }
  }

  /* ================= ADMINISTRACIÓN ================= */

  async function renderAdminPage() {
    if (state.page === "dashboard") return renderAdminDashboard();
    if (state.page === "clippers") return state.selectedClipperId ? renderClipperAdminDetail() : renderAdminClippers();
    if (state.page === "reports") return renderAdminReports();
    if (state.page === "settings") return renderAdminSettings();
  }

  async function renderAdminDashboard() {
    setHeader("Dashboard", "Resumen semanal del equipo.");
    const [clippers, reports, socialAccounts] = await Promise.all([
      query(state.supabase.from("admin_clipper_overview").select("*").eq("role", "clipper").order("names")),
      query(state.supabase.from("weekly_report_summary").select("*").eq("week_start", currentWeekStartISO()).order("total_views", { ascending: false })),
      query(state.supabase.from("social_accounts").select("id,user_id,platform,account_name,channel_url,active").eq("active", true)),
    ]);
    const reportIds = reports.map((report) => report.report_id);
    const weekVideos = reportIds.length
      ? await query(state.supabase.from("videos").select("id,report_id,platform,views,likes,comments,shares").in("report_id", reportIds).is("deleted_at", null))
      : [];
    const active = clippers.filter((c) => c.active);
    const totalVideos = reports.reduce((a, r) => a + Number(r.video_count || 0), 0);
    const totalViews = reports.reduce((a, r) => a + Number(r.total_views || 0), 0);
    const totalLikes = reports.reduce((a, r) => a + Number(r.total_likes || 0), 0);
    const projected = reports.reduce((a, r) => a + Number(r.total_pay ?? r.approved_base_pay ?? r.calculated_base_pay ?? 0), 0);
    const targetViews = reports.reduce((a, r) => a + Number(r.target_views || 0), 0);
    const teamProgress = targetViews ? clamp((totalViews / targetViews) * 100, 0, 100) : 0;
    const pendingReview = reports.filter((r) => ["sent", "review", "observed"].includes(r.status)).length;
    const targetReached = reports.filter((r) => r.target_reached).length;
    const paidCount = reports.filter((r) => r.status === "paid").length;
    const platformCounts = Object.keys(PLATFORMS).map((platform) => ({ platform, count: new Set(socialAccounts.filter((a) => a.platform === platform).map((a) => a.user_id)).size }));
    const maxPlatform = Math.max(...platformCounts.map((p) => p.count), 1);
    const topReports = reports.slice(0, 5);

    $("#content").innerHTML = `
      <section class="dashboard-banner compact-banner">
        <div><span class="eyebrow">SEMANA ${weekLabel(currentWeekStartISO())}</span><h2>Control semanal</h2><p>Rendimiento separado por plataforma.</p></div>
        <div class="team-goal"><div class="ring-progress small-ring" style="--p:${teamProgress}%"><span>${Math.round(teamProgress)}%</span></div><div><small>Pago proyectado</small><strong>${money(projected)}</strong><span>${reports.length} reportes iniciados</span></div></div>
      </section>
      ${platformMetricCards(weekVideos)}
      <div class="grid grid3 compact-kpis mobile-two-columns" style="margin-top:14px">
        ${kpi("Cliperos activos", num(active.length), `${clippers.length} registrados`)}
        ${kpi("Videos", num(totalVideos), `${reports.length} reportes`)}
        ${kpi("Pago proyectado", money(projected), "Cálculo automático")}
      </div>
      <div class="quick-status-grid" style="margin-top:14px">
        <div class="quick-status warning"><b>${pendingReview}</b><span>Por revisar</span></div>
        <div class="quick-status success"><b>${targetReached}</b><span>Meta alcanzada</span></div>
        <div class="quick-status info"><b>${paidCount}</b><span>Pagados</span></div>
        <div class="quick-status neutral"><b>${reports.length}/${active.length || 0}</b><span>Reportes iniciados</span></div>
      </div>
      <div class="grid grid2" style="margin-top:14px">
        <div class="card compact-card">
          <div class="card-head"><div><h2>Mejor rendimiento</h2><p>Top por vistas.</p></div></div>
          <div class="rank-list">${topReports.map((r, index) => `<button class="rank-row rank-button" data-admin-report="${r.report_id}"><div class="rank-left"><span class="rank-index">${index + 1}</span><div><strong>${esc(r.names || r.username)} ${esc(r.surnames || "")}</strong><small>${r.video_count} videos</small></div></div><div class="rank-right"><b>${num(r.total_views)}</b><small>${money(r.total_pay ?? r.approved_base_pay ?? r.calculated_base_pay)}</small></div></button>`).join("") || '<div class="empty">Sin reportes esta semana.</div>'}</div>
        </div>
        <div class="card compact-card">
          <div class="card-head"><div><h2>Redes del equipo</h2><p>Cuentas activas.</p></div></div>
          <div class="bar-list">${platformCounts.map((item) => `<button type="button" class="bar-row bar-row-btn" data-team-platform="${item.platform}"><div class="bar-meta">${platformBadge(item.platform, true)}<span class="network-count"><b>${item.count}</b><small>Ver registrados →</small></span></div><div class="bar-track"><span style="width:${(item.count / maxPlatform) * 100}%"></span></div></button>`).join("")}</div>
        </div>
      </div>
      <div class="card compact-card" style="margin-top:14px">
        <div class="card-head"><div><h2>Reportes de la semana</h2><p>Evaluación rápida y pagos.</p></div><div class="actions"><button id="exportWeeklyBtn" class="btn btn-secondary btn-sm">⬇ Excel semanal</button><button id="goReportsBtn" class="btn btn-primary btn-sm">Ver reportes</button></div></div>
        ${adminReportsTable(reports.slice(0, 10))}
      </div>`;
    $("#exportWeeklyBtn").addEventListener("click", () => exportWeeklyExcel(reports));
    $("#goReportsBtn").addEventListener("click", () => navigate("reports"));
    $$('[data-team-platform]').forEach((button) => button.addEventListener("click", () => openTeamPlatformModal(button.dataset.teamPlatform, socialAccounts, clippers)));
    bindAdminReportButtons();
  }

  function openTeamPlatformModal(platform, socialAccounts, clippers) {
    const accounts = (socialAccounts || []).filter((account) => account.platform === platform && account.active);
    const clipperMap = Object.fromEntries((clippers || []).map((clipper) => [clipper.user_id, clipper]));
    const rows = accounts.map((account) => {
      const clipper = clipperMap[account.user_id] || {};
      const displayName = clipper.names ? `${clipper.names} ${clipper.surnames || ""}`.trim() : `@${clipper.username || "usuario"}`;
      return `<div class="network-person-row"><div><strong>${esc(displayName)}</strong><small>@${esc(clipper.username || "—")} · ${esc(account.account_name || "Cuenta")}</small></div><div>${account.channel_url ? `<a href="${esc(account.channel_url)}" target="_blank" rel="noopener">Abrir red ↗</a>` : '<span class="muted">Sin enlace</span>'}<button type="button" class="btn btn-secondary btn-sm" data-open-team-clipper="${account.user_id}">Administrar</button></div></div>`;
    }).join("");
    const uniqueClippers = new Set(accounts.map((account) => account.user_id)).size;
    openModal(`<div class="modal-head"><div><h2>${platformLabel(platform)}</h2><p>${uniqueClippers} clipero${uniqueClippers === 1 ? "" : "s"} · ${accounts.length} cuenta${accounts.length === 1 ? "" : "s"} activa${accounts.length === 1 ? "" : "s"}</p></div><button id="teamPlatformX" class="modal-close">×</button></div><div class="modal-body"><div class="network-person-list">${rows || `<div class="empty">No hay cliperos registrados en ${platformLabel(platform)}.</div>`}</div></div><div class="modal-foot"><span></span><button id="teamPlatformClose" class="btn btn-ghost">Cerrar</button></div>`, "small", (layer) => {
      $("#teamPlatformX", layer).addEventListener("click", closeModal);
      $("#teamPlatformClose", layer).addEventListener("click", closeModal);
      $$('[data-open-team-clipper]', layer).forEach((button) => button.addEventListener("click", () => {
        state.selectedClipperId = button.dataset.openTeamClipper;
        state.selectedClipperTab = "networks";
        closeModal();
        navigate("clippers");
      }));
    });
  }

  function adminReportsTable(reports) {
    const rows = reports.map((r) => {
      const progress = clamp((Number(r.total_views || 0) / Number(r.target_views || 1)) * 100, 0, 100);
      return `<tr><td><b>${esc(r.names || r.username)} ${esc(r.surnames || "")}</b><br><small class="muted">@${esc(r.username)}</small></td><td><b>${r.video_count}</b><br><small class="muted">${r.account_count} cuentas</small></td><td><b>👁 ${num(r.total_views)}</b><br><small class="muted">❤ ${num(r.total_likes || 0)}</small></td><td><div class="mini-cell-progress"><span>${Math.round(progress)}%</span><div class="progress"><span style="width:${progress}%"></span></div></div></td><td><b>${money(r.total_pay ?? r.approved_base_pay ?? r.calculated_base_pay)}</b></td><td><span class="status ${statusClass(r.status)}">${STATUS_LABELS[r.status]}</span></td><td><button class="btn btn-secondary btn-sm" data-admin-report="${r.report_id}">Evaluar</button></td></tr>`;
    }).join("");
    const cards = reports.map((r) => {
      const progress = clamp((Number(r.total_views || 0) / Number(r.target_views || 1)) * 100, 0, 100);
      return `<button class="mobile-admin-card" data-admin-report="${r.report_id}"><div class="mobile-admin-card-head"><div><strong>${esc(r.names || r.username)} ${esc(r.surnames || "")}</strong><small>@${esc(r.username)}</small></div><span class="status ${statusClass(r.status)}">${STATUS_LABELS[r.status]}</span></div><div class="mobile-admin-metrics"><span><small>Videos</small><b>${r.video_count}</b></span><span><small>Vistas</small><b>${num(r.total_views)}</b></span><span><small>Likes</small><b>${num(r.total_likes || 0)}</b></span><span><small>Pago</small><b>${money(r.total_pay ?? r.approved_base_pay ?? r.calculated_base_pay)}</b></span></div><div class="progress"><span style="width:${progress}%"></span></div></button>`;
    }).join("");
    if (!reports.length) return `<div class="empty">Todavía no existen reportes esta semana.</div>`;
    return `<div class="desktop-report-table table-wrap compact-table"><table><thead><tr><th>Clipero</th><th>Videos</th><th>Métricas</th><th>Avance</th><th>Pago</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="mobile-report-cards">${cards}</div>`;
  }

  function exportWeeklyExcel(reports) {
    const safe = (value) => String(value ?? "").replace(/[<&]/g, (c) => c === "<" ? "&lt;" : "&amp;");
    const rows = reports.map((r) => [
      r.username, `${r.names || ""} ${r.surnames || ""}`.trim(), r.phone || "", r.primary_social_url || "",
      r.video_count, r.account_count, r.total_views, r.total_likes || 0, r.total_comments || 0, r.total_shares || 0,
      Number(r.calculated_base_pay || 0), proportionalEquivalent(r), suggestedPerformanceBonus(r), Number(r.bonus_pay || 0),
      Number(r.total_pay ?? r.approved_base_pay ?? r.calculated_base_pay ?? 0), STATUS_LABELS[r.status], dateTimeLabel(r.submission_deadline),
    ]);
    const headers = ["Usuario","Clipero","Celular/WhatsApp","Cuenta principal","Videos","Cuentas","Vistas","Me gusta","Comentarios","Compartidos","Pago base visible","Equivalente proporcional","Extra sugerido","Premio aprobado","Pago total","Estado","Fecha límite"];
    const xmlRows = [headers, ...rows].map((row) => `<Row>${row.map((cell) => `<Cell><Data ss:Type="${typeof cell === "number" ? "Number" : "String"}">${safe(cell)}</Data></Cell>`).join("")}</Row>`).join("");
    const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Reporte semanal"><Table>${xmlRows}</Table></Worksheet></Workbook>`;
    const blob = new Blob(["﻿", xml], { type: "application/vnd.ms-excel" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ClipControl_${state.adminWeek}.xls`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Reporte semanal exportado", "success");
  }

  function bindAdminReportButtons() {
    $$('[data-admin-report]').forEach((b) => b.addEventListener("click", () => openAdminReportDetail(b.dataset.adminReport)));
  }

  async function renderAdminClippers() {
    setHeader("Administrar usuarios", "Crea accesos y revisa a cada clipero.");
    const clippers = await query(state.supabase.from("admin_clipper_overview").select("*").eq("role", "clipper").order("username", { ascending: true }));
    const tableRows = clippers.map((c) => `<tr><td><b>@${esc(c.username)}</b><br><small class="muted">${c.names ? esc(`${c.names} ${c.surnames || ""}`) : "Registro pendiente"}</small></td><td>${c.phone ? `📱 ${esc(c.phone)}` : '<span class="pill pill-yellow">Por completar</span>'}</td><td class="link-cell">${c.primary_social_url ? `<a href="${esc(c.primary_social_url)}" target="_blank" rel="noopener">Abrir cuenta</a>` : '<span class="muted">Sin registrar</span>'}</td><td>${c.active_social_accounts}</td><td>${dateOnlyLabel(c.latest_report_week)}</td><td><span class="pill ${c.active ? "pill-green" : "pill-red"}">${c.active ? "Activo" : "Suspendido"}</span></td><td><button class="btn btn-secondary btn-sm" data-open-clipper="${c.user_id}">Administrar</button></td></tr>`).join("");
    const cards = clippers.map((c) => `<button class="clipper-access-card" data-open-clipper="${c.user_id}"><div class="clipper-access-top"><span class="avatar">${uiIcon("user",18)}</span><div><strong>${c.names ? esc(`${c.names} ${c.surnames || ""}`) : `@${esc(c.username)}`}</strong><small>@${esc(c.username)}</small></div><span class="pill ${c.active ? "pill-green" : "pill-red"}">${c.active ? "Activo" : "Suspendido"}</span></div><div class="clipper-access-info"><span><small>WhatsApp</small><b>${esc(c.phone || "Pendiente")}</b></span><span><small>Redes</small><b>${c.active_social_accounts}</b></span><span><small>Último reporte</small><b>${dateOnlyLabel(c.latest_report_week)}</b></span></div><div class="clipper-access-action">Administrar →</div></button>`).join("");
    $("#content").innerHTML = `<div class="card compact-card"><div class="card-head"><div><h2>Cliperos</h2><p>${clippers.length} usuarios registrados</p></div><button id="createClipperBtn" class="btn btn-primary">${uiIcon("plus",15)} Crear acceso</button></div>
      ${clippers.length ? `<div class="desktop-clipper-table table-wrap compact-table"><table><thead><tr><th>Usuario</th><th>Datos</th><th>Cuenta principal</th><th>Redes</th><th>Último reporte</th><th>Acceso</th><th></th></tr></thead><tbody>${tableRows}</tbody></table></div><div class="mobile-clipper-cards">${cards}</div>` : '<div class="empty">No hay cliperos.</div>'}</div>`;
    $("#createClipperBtn").addEventListener("click", openCreateUserModal);
    $$('[data-open-clipper]').forEach((b) => b.addEventListener("click", () => {
      state.selectedClipperId = b.dataset.openClipper;
      state.selectedClipperTab = "info";
      renderPage(true);
    }));
  }

  function openCreateUserModal() {
    const canAdmin = state.profile.role === "superadmin";
    openModal(`<div class="modal-head"><div><h2>Crear acceso</h2><p>El usuario completará sus datos al primer ingreso.</p></div><button id="createX" class="modal-close">×</button></div>
      <form id="createUserForm"><div class="modal-body"><div class="form-grid compact-form">
        <label>Usuario<input name="username" required minlength="3" maxlength="40" placeholder="clipero01"></label>
        <label>Contraseña asignada<input name="password" type="password" required minlength="6" placeholder="Mínimo 6 caracteres"></label>
        ${canAdmin ? `<label class="full">Rol<select name="role"><option value="clipper">Clipero</option><option value="admin">Administrador</option></select></label>` : '<input type="hidden" name="role" value="clipper">'}
      </div><div class="alert alert-info compact-alert" style="margin-top:14px"><div>${uiIcon("user",16)}</div><div><strong>Acceso listo</strong><p>El clipero completa sus datos al ingresar.</p></div></div></div><div class="modal-foot"><span></span><div class="actions"><button type="button" id="createCancel" class="btn btn-ghost">Cancelar</button><button class="btn btn-primary">Crear usuario</button></div></div></form>`, "small", (layer) => {
        $("#createX", layer).addEventListener("click", closeModal);
        $("#createCancel", layer).addEventListener("click", closeModal);
        $("#createUserForm", layer).addEventListener("submit", async (event) => {
          event.preventDefault();
          const payload = { action: "create", ...Object.fromEntries(new FormData(event.target)) };
          showLoading(true);
          try {
            await invokeAdminFunction(payload);
            closeModal();
            toast("Acceso creado correctamente", "success");
            await renderPage(true);
          } catch (error) {
            toast(`No se pudo crear el usuario: ${errorMessage(error)}`, "error");
          } finally { showLoading(false); }
        });
      });
  }

  async function renderClipperAdminDetail() {
    const id = state.selectedClipperId;
    const [profile, accounts, reports, rules] = await Promise.all([
      query(state.supabase.from("profiles").select("*").eq("id", id).single()),
      query(state.supabase.from("social_accounts").select("*").eq("user_id", id).order("created_at")),
      query(state.supabase.from("weekly_report_summary").select("*").eq("user_id", id).order("week_start", { ascending: false })),
      query(state.supabase.from("clipper_rules").select("*").eq("user_id", id).maybeSingle()),
    ]);
    setHeader(`${profile.names || profile.username} ${profile.surnames || ""}`.trim(), `Usuario: ${profile.username}`);
    const tabs = [["info","Información"],["networks","Redes registradas"],["current","Reporte actual"],["history","Historial"],["rules","Reglas"],["access","Acceso"]];
    $("#content").innerHTML = `<div class="actions" style="margin-bottom:14px"><button id="backClippers" class="btn btn-ghost">← Volver</button></div><div class="card"><div class="tabs">${tabs.map(([id,label]) => `<button class="tab ${state.selectedClipperTab === id ? "active" : ""}" data-clipper-tab="${id}">${label}</button>`).join("")}</div><div id="clipperTabContent"></div></div>`;
    $("#backClippers").addEventListener("click", () => { state.selectedClipperId = null; renderPage(true); });
    $$('[data-clipper-tab]').forEach((b) => b.addEventListener("click", () => { state.selectedClipperTab = b.dataset.clipperTab; renderClipperAdminTab(profile, accounts, reports, rules); }));
    renderClipperAdminTab(profile, accounts, reports, rules);
  }

  function renderClipperAdminTab(profile, accounts, reports, rules) {
    const box = $("#clipperTabContent");
    const tab = state.selectedClipperTab;
    if (tab === "info") {
      box.innerHTML = `<div class="profile-admin-grid"><div class="profile-card"><span class="avatar large-avatar">${uiIcon("user",22)}</span><div><h3>${esc(profile.names || profile.username)} ${esc(profile.surnames || "")}</h3><p class="muted">@${esc(profile.username)}</p></div></div><div class="summary-list compact-summary"><div><span>WhatsApp</span><b>${esc(profile.phone || "Pendiente")}</b></div><div><span>Cuenta principal</span><b>${profile.primary_social_url ? `<a href="${esc(profile.primary_social_url)}" target="_blank">Abrir link</a>` : "Pendiente"}</b></div><div><span>Redes activas</span><b>${accounts.filter((a) => a.active).length}</b></div><div><span>Reportes</span><b>${reports.length}</b></div><div><span>Estado</span><b>${profile.active ? "Activo" : "Suspendido"}</b></div></div><div class="actions"><button id="editAdminProfile" class="btn btn-secondary">Editar datos</button></div></div>`;
      $("#editAdminProfile").addEventListener("click", () => openAdminEditProfile(profile));
      return;
    }
    if (tab === "networks") {
      const buttons = Object.keys(PLATFORMS).map((p) => `<button class="platform-btn ${state.selectedPlatform === p ? "active" : ""}" data-admin-platform="${p}">${platformBadge(p, true)}</button>`).join("");
      box.innerHTML = `<div class="platforms" style="margin-bottom:14px">${buttons}</div><div id="adminNetworkList"></div>`;
      $$('[data-admin-platform]').forEach((b) => b.addEventListener("click", () => { state.selectedPlatform = b.dataset.adminPlatform; renderClipperAdminTab(profile, accounts, reports, rules); }));
      renderAdminNetworkList(profile.id, accounts);
      return;
    }
    if (tab === "current") {
      const current = reports.find((r) => r.week_start === currentWeekStartISO());
      box.innerHTML = current ? `<div class="report-metric-grid"><div><span>Videos</span><b>${current.video_count}</b></div><div><span>Vistas</span><b>${num(current.total_views)}</b></div><div><span>Me gusta</span><b>${num(current.total_likes || 0)}</b></div><div><span>Pago</span><b>${money(current.total_pay ?? current.approved_base_pay ?? current.calculated_base_pay)}</b></div><div><span>Estado</span><b>${STATUS_LABELS[current.status]}</b></div><div><span>Cierre</span><b>${dateTimeLabel(current.submission_deadline)}</b></div></div><div class="actions" style="margin-top:14px"><button id="openCurrentAdminReport" class="btn btn-primary">Evaluar reporte</button><button id="editCurrentRules" class="btn btn-secondary">⚙ Reglas y fecha</button></div>` : `<div class="empty">El clipero todavía no inició un reporte.</div>`;
      $("#openCurrentAdminReport")?.addEventListener("click", () => openAdminReportDetail(current.report_id));
      $("#editCurrentRules")?.addEventListener("click", () => openCurrentReportRules(current));
      return;
    }
    if (tab === "history") {
      box.innerHTML = `<div class="table-wrap compact-table"><table><thead><tr><th>Semana</th><th>Videos</th><th>Métricas</th><th>Pago</th><th>Estado</th><th></th></tr></thead><tbody>${reports.map((r) => `<tr><td>${dateOnlyLabel(r.week_start)} – ${dateOnlyLabel(r.week_end)}</td><td>${r.video_count}</td><td>👁 ${num(r.total_views)}<br><small>❤ ${num(r.total_likes || 0)}</small></td><td>${money(r.total_pay ?? r.approved_base_pay ?? r.calculated_base_pay)}</td><td><span class="status ${statusClass(r.status)}">${STATUS_LABELS[r.status]}</span></td><td><button class="btn btn-secondary btn-sm" data-admin-report="${r.report_id}">Abrir</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty">Sin historial.</td></tr>`}</tbody></table></div>`;
      bindAdminReportButtons();
      return;
    }
    if (tab === "rules") { renderAdminRulesTab(profile, rules); return; }
    if (tab === "access") {
      box.innerHTML = `<div class="grid grid2"><div><h3>Acceso</h3><p class="muted">Puedes suspender o cambiar la contraseña fija.</p><div class="actions"><button id="toggleActive" class="btn ${profile.active ? "btn-danger" : "btn-success"}">${profile.active ? "Suspender" : "Activar"}</button><button id="resetPassword" class="btn btn-secondary">Cambiar contraseña</button></div></div>${state.profile.role === "superadmin" ? `<div><h3>Eliminar usuario</h3><p class="muted">Elimina definitivamente todos sus datos.</p><button id="hardDelete" class="btn btn-danger">Eliminar definitivamente</button></div>` : ""}</div>`;
      $("#toggleActive").addEventListener("click", () => adminUserAction({ action: "set_active", user_id: profile.id, active: !profile.active }, "Estado actualizado"));
      $("#resetPassword").addEventListener("click", () => openResetPassword(profile));
      $("#hardDelete")?.addEventListener("click", () => hardDeleteUser(profile));
    }
  }

  async function renderAdminNetworkList(userId, allAccounts) {
    const box = $("#adminNetworkList");
    const accounts = allAccounts.filter((account) => account.platform === state.selectedPlatform);
    if (!accounts.length) { box.innerHTML = `<div class="empty">No tiene cuentas registradas en ${platformLabel(state.selectedPlatform)}.</div>`; return; }
    const videos = await query(state.supabase.from("videos").select("*").eq("user_id", userId).eq("platform", state.selectedPlatform).is("deleted_at", null).order("created_at", { ascending: false }));
    state.videos = videos;
    state.accounts = allAccounts;
    box.innerHTML = accounts.map((a) => {
      const accountVideos = videos.filter((v) => v.account_id === a.id);
      const views = accountVideos.reduce((sum, v) => sum + Number(v.views || 0), 0);
      const likes = accountVideos.reduce((sum, v) => sum + Number(v.likes || 0), 0);
      return `<div class="card compact-card" style="margin-bottom:12px"><div class="card-head"><div><h3>${esc(a.account_name)}</h3><p><a href="${esc(a.channel_url)}" target="_blank" rel="noopener">Abrir perfil</a></p></div><div><b>${accountVideos.length} videos</b><br><small>${num(views)} vistas · ${num(likes)} me gusta</small></div></div>${videosTable(accountVideos.slice(0, 30), accounts, true)}</div>`;
    }).join("");
    $$('[data-edit-video]', box).forEach((b) => b.addEventListener("click", () => openEditVideoModal(b.dataset.editVideo, true)));
    $$('[data-delete-video]', box).forEach((b) => b.addEventListener("click", () => {
      const v = videos.find((item) => item.id === b.dataset.deleteVideo);
      if (v) adminSoftDeleteVideo(v.id, v.report_id);
    }));
    $$('[data-sync-video]', box).forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      await syncVideoMetrics(b.dataset.syncVideo);
      await renderAdminNetworkList(userId, allAccounts);
    }));
  }

  function openCurrentReportRules(summary) {
    openModal(`<div class="modal-head"><div><h2>Reglas y fecha</h2><p>Solo para este reporte.</p></div><button id="currentRulesX" class="modal-close">×</button></div>
      <form id="currentRulesForm"><div class="modal-body"><div class="form-grid compact-form">
        <label>Filas iniciales / referencia<input name="slots" type="number" min="1" max="100" required value="${summary.slots_required}"><small>No limita la cantidad de videos.</small></label>
        <label>Meta de vistas<input name="target_views" type="number" min="1" required value="${summary.target_views}"></label>
        <label>Alerta de vistas bajas<input name="low_alert" type="number" min="0" required value="${summary.low_alert}"></label>
        <label>Pago base máximo<input name="max_base_pay" type="number" min="0" step="0.01" required value="${summary.max_base_pay}"></label>
        <label class="full">Fecha y hora límite<input name="submission_deadline" type="datetime-local" required value="${dateTimeLocalValue(summary.submission_deadline)}"></label>
        <label>Edición fuera de plazo<select name="allow_late_edit"><option value="false" ${summary.allow_late_edit ? "" : "selected"}>No</option><option value="true" ${summary.allow_late_edit ? "selected" : ""}>Sí</option></select></label>
        <label>Puede enviar<select name="can_submit"><option value="true" ${summary.can_submit === false ? "" : "selected"}>Sí</option><option value="false" ${summary.can_submit === false ? "selected" : ""}>No</option></select></label>
      </div></div><div class="modal-foot"><span></span><button class="btn btn-primary">Guardar cambios</button></div></form>`, "small", (layer) => {
        $("#currentRulesX", layer).addEventListener("click", closeModal);
        $("#currentRulesForm", layer).addEventListener("submit", async (event) => {
          event.preventDefault();
          const form = Object.fromEntries(new FormData(event.target));
          const low = Number(form.low_alert);
          const target = Number(form.target_views);
          if (low > target) return toast("La alerta no puede superar la meta.", "error");
          showLoading(true);
          try {
            await query(state.supabase.rpc("admin_update_report_rules", {
              p_report_id: summary.report_id,
              p_slots: Number(form.slots),
              p_target_views: target,
              p_low_alert: low,
              p_max_base_pay: Number(form.max_base_pay),
              p_payment_mode: "per_report",
              p_allow_late_edit: form.allow_late_edit === "true",
              p_can_submit: form.can_submit === "true",
            }));
            const localDate = new Date(form.submission_deadline);
            await query(state.supabase.rpc("admin_set_report_deadline", {
              p_report_id: summary.report_id,
              p_deadline: localDate.toISOString(),
              p_allow_late_edit: form.allow_late_edit === "true",
            }));
            closeModal();
            toast("Reglas y fecha actualizadas", "success");
            await renderPage(true);
          } catch (error) { toast(errorMessage(error), "error"); }
          finally { showLoading(false); }
        });
      });
  }

  function renderAdminRulesTab(profile, rules) {
    const box = $("#clipperTabContent");
    box.innerHTML = `<div class="alert alert-info compact-alert" style="margin-bottom:14px"><div>⚙️</div><div><strong>Reglas individuales</strong><p>Los campos vacíos usan la configuración general.</p></div></div><form id="rulesForm" class="form-grid compact-form">
      <label>Videos requeridos<input name="slots_override" type="number" min="1" max="100" value="${rules?.slots_override ?? ""}" placeholder="General"></label>
      <label>Meta de vistas<input name="target_views_override" type="number" min="1" value="${rules?.target_views_override ?? ""}" placeholder="General"></label>
      <label>Alerta de vistas bajas<input name="low_alert_override" type="number" min="0" value="${rules?.low_alert_override ?? ""}" placeholder="General"></label>
      <label>Pago base máximo<input name="max_base_pay_override" type="number" min="0" step="0.01" value="${rules?.max_base_pay_override ?? ""}" placeholder="General"></label>
      <label>Edición fuera de plazo<select name="allow_late_edit"><option value="">Usar general</option><option value="true" ${rules?.allow_late_edit === true ? "selected" : ""}>Permitir</option><option value="false" ${rules?.allow_late_edit === false ? "selected" : ""}>No permitir</option></select></label>
      <label>Puede enviar reporte<select name="can_submit"><option value="">Usar general</option><option value="true" ${rules?.can_submit === true ? "selected" : ""}>Sí</option><option value="false" ${rules?.can_submit === false ? "selected" : ""}>No</option></select></label>
      <label class="full">Nota administrativa<textarea name="admin_notes" rows="2">${esc(rules?.admin_notes || "")}</textarea></label>
      <div class="full actions"><button class="btn btn-primary">Guardar reglas</button><button type="button" id="resetRules" class="btn btn-ghost">Usar reglas generales</button></div></form>`;
    $("#rulesForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const f = Object.fromEntries(new FormData(event.target));
      const nullableNumber = (v) => v === "" ? null : Number(v);
      const nullableBool = (v) => v === "" ? null : v === "true";
      const payload = {
        user_id: profile.id,
        slots_override: nullableNumber(f.slots_override), target_views_override: nullableNumber(f.target_views_override),
        low_alert_override: nullableNumber(f.low_alert_override), max_base_pay_override: nullableNumber(f.max_base_pay_override),
        payment_mode_override: "per_report", allow_late_edit: nullableBool(f.allow_late_edit),
        can_submit: nullableBool(f.can_submit), admin_notes: f.admin_notes || null, updated_by: state.profile.id,
      };
      try { await query(state.supabase.from("clipper_rules").upsert(payload, { onConflict: "user_id" })); toast("Reglas guardadas", "success"); await renderPage(true); }
      catch (error) { toast(errorMessage(error), "error"); }
    });
    $("#resetRules").addEventListener("click", async () => {
      if (!confirm("¿Volver a la configuración general?")) return;
      try { await query(state.supabase.from("clipper_rules").delete().eq("user_id", profile.id)); toast("Reglas restablecidas", "success"); await renderPage(true); }
      catch (error) { toast(errorMessage(error), "error"); }
    });
  }

  function openAdminEditProfile(profile) {
    openModal(`<div class="modal-head"><div><h2>Editar datos</h2><p>@${esc(profile.username)}</p></div><button id="adminEditX" class="modal-close">×</button></div><form id="adminEditForm"><div class="modal-body"><div class="form-grid compact-form"><label>Nombres<input name="names" value="${esc(profile.names || "")}"></label><label>Apellidos<input name="surnames" value="${esc(profile.surnames || "")}"></label><label>Celular / WhatsApp<input name="phone" value="${esc(profile.phone || "")}"></label><label>Link de cuenta principal<input name="primary_social_url" type="url" value="${esc(profile.primary_social_url || "")}"></label></div></div><div class="modal-foot"><span></span><button class="btn btn-primary">Guardar</button></div></form>`, "small", (layer) => {
      $("#adminEditX", layer).addEventListener("click", closeModal);
      $("#adminEditForm", layer).addEventListener("submit", async (e) => { e.preventDefault(); await adminUserAction({ action: "update_profile", user_id: profile.id, ...Object.fromEntries(new FormData(e.target)) }, "Información actualizada", true); });
    });
  }

  function openResetPassword(profile) {
    openModal(`<div class="modal-head"><div><h2>Nueva contraseña asignada</h2><p>${esc(profile.username)}</p></div><button id="passwordX" class="modal-close">×</button></div><form id="passwordForm"><div class="modal-body"><label>Nueva contraseña<input name="password" type="password" minlength="6" required></label></div><div class="modal-foot"><span></span><button class="btn btn-primary">Cambiar contraseña</button></div></form>`, "small", (layer) => {
      $("#passwordX", layer).addEventListener("click", closeModal);
      $("#passwordForm", layer).addEventListener("submit", async (e) => { e.preventDefault(); await adminUserAction({ action: "reset_password", user_id: profile.id, password: new FormData(e.target).get("password") }, "Contraseña actualizada", true); });
    });
  }

  async function adminUserAction(payload, successMessage, close = false) {
    showLoading(true);
    try {
      await invokeAdminFunction(payload);
      if (close) closeModal();
      toast(successMessage, "success");
      await renderPage(true);
    } catch (error) { toast(`Error de administración: ${errorMessage(error)}`, "error"); }
    finally { showLoading(false); }
  }

  async function hardDeleteUser(profile) {
    if (!confirm(`¿Eliminar definitivamente a ${profile.username}? Esta acción no se puede deshacer.`)) return;
    state.selectedClipperId = null;
    await adminUserAction({ action: "hard_delete", user_id: profile.id }, "Usuario eliminado");
  }

  async function renderAdminReports() {
    setHeader("Reportes", "Evaluación semanal del equipo.");
    const reports = await query(state.supabase.from("weekly_report_summary").select("*").eq("week_start", state.adminWeek).order("total_views", { ascending: false }));
    const pending = reports.filter((r) => ["sent", "review", "observed"].includes(r.status)).length;
    const totalViews = reports.reduce((sum, r) => sum + Number(r.total_views || 0), 0);
    const projected = reports.reduce((sum, r) => sum + Number(r.total_pay ?? r.approved_base_pay ?? r.calculated_base_pay ?? 0), 0);
    const defaultDeadline = reports[0]?.submission_deadline ? dateTimeLocalValue(reports[0].submission_deadline) : "";
    $("#content").innerHTML = `<div class="grid grid3 compact-kpis mobile-two-columns">
      ${kpi("Reportes", reports.length, `${pending} por revisar`)}
      ${kpi("Vistas", num(totalViews), "Suma de la semana")}
      ${kpi("Pago proyectado", money(projected), "Base + premios")}
    </div>
    <div class="card compact-card report-controls-card" style="margin-top:12px"><div class="card-head"><div><h2>Evaluar cliperos</h2><p>${weekLabel(state.adminWeek)}</p></div><button id="exportReportsBtn" class="btn btn-secondary btn-sm">⬇ Excel</button></div><div class="report-control-grid"><label>Semana<input id="adminWeekInput" type="date" value="${state.adminWeek}"></label><label>Fecha límite de esta semana<input id="bulkDeadlineInput" type="datetime-local" value="${defaultDeadline}"></label><button id="applyDeadlineBtn" class="btn btn-primary" ${reports.length ? "" : "disabled"}>Aplicar fecha</button></div></div>
    <div class="card compact-card" style="margin-top:12px">${adminReportsTable(reports)}</div>`;
    $("#adminWeekInput").addEventListener("change", (e) => { state.adminWeek = mondayFromISO(e.target.value); renderPage(true); });
    $("#exportReportsBtn").addEventListener("click", () => exportWeeklyExcel(reports));
    $("#applyDeadlineBtn").addEventListener("click", () => applyDeadlineToReports(reports));
    bindAdminReportButtons();
  }

  async function applyDeadlineToReports(reports) {
    const input = $("#bulkDeadlineInput");
    if (!input?.value) return toast("Selecciona una fecha y hora límite.", "error");
    const deadline = new Date(input.value);
    if (Number.isNaN(deadline.getTime())) return toast("La fecha límite no es válida.", "error");
    if (!confirm(`¿Aplicar ${dateTimeLabel(deadline.toISOString())} como cierre para ${reports.length} reportes?`)) return;
    const button = $("#applyDeadlineBtn");
    button.disabled = true;
    button.textContent = "Aplicando…";
    try {
      for (const report of reports) {
        await query(state.supabase.rpc("admin_set_report_deadline", { p_report_id: report.report_id, p_deadline: deadline.toISOString(), p_allow_late_edit: false }));
      }
      toast("Fecha límite aplicada a toda la semana", "success");
      await renderPage(true);
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { button.disabled = false; button.textContent = "Aplicar fecha"; }
  }

  async function openAdminReportDetail(reportId) {
    showLoading(true);
    try {
      let summary = await query(state.supabase.from("weekly_report_summary").select("*").eq("report_id", reportId).single());
      const lastCheck = summary.metrics_last_checked_at ? new Date(summary.metrics_last_checked_at).getTime() : 0;
      if (!lastCheck || Date.now() - lastCheck > 24 * 60 * 60 * 1000) {
        await syncReportMetrics(reportId, true);
        summary = await query(state.supabase.from("weekly_report_summary").select("*").eq("report_id", reportId).single());
      }
      const [videos, accounts, observations] = await Promise.all([
        query(state.supabase.from("videos").select("*").eq("report_id", reportId).is("deleted_at", null).order("position")),
        query(state.supabase.from("social_accounts").select("*").eq("user_id", summary.user_id).order("platform")),
        query(state.supabase.from("report_observations").select("*").eq("report_id", reportId).order("created_at", { ascending: false })),
      ]);
      state.videos = videos;
      state.accounts = accounts;
      const progress = clamp((Number(summary.total_views || 0) / Number(summary.target_views || 1)) * 100, 0, 100);
      const equivalentPay = proportionalEquivalent(summary);
      const suggestedBonus = suggestedPerformanceBonus(summary);
      openModal(`<div class="modal-head sticky-modal-head"><div><h2>${esc(summary.names || summary.username)} ${esc(summary.surnames || "")}</h2><p>${weekLabel(summary.week_start)} · @${esc(summary.username)}</p></div><div class="actions"><span class="status ${statusClass(summary.status)}">${STATUS_LABELS[summary.status]}</span><button id="adminReportX" class="modal-close">×</button></div></div>
        <div class="admin-action-bar">
          <div class="action-summary"><span><small>Vistas</small><b>${num(summary.total_views)}</b></span><span><small>Pago base</small><b>${money(summary.calculated_base_pay)}</b></span><span><small>Equivalente</small><b>${money(equivalentPay)}</b></span></div>
          <div class="actions"><button data-review-action="review" class="btn btn-secondary btn-sm">En revisión</button><button data-review-action="observe" class="btn btn-warning btn-sm">Observar</button><button data-review-action="approve" class="btn btn-success btn-sm">Aprobar</button><button data-review-action="paid" class="btn btn-dark btn-sm">Marcar pagado</button></div>
        </div>
        <div class="modal-body compact-modal-body">
          <div class="report-metric-grid">
            <div><span>Videos</span><b>${summary.video_count}</b></div>
            <div><span>Vistas</span><b>${num(summary.total_views)}</b></div>
            <div><span>Likes</span><b>${num(summary.total_likes || 0)}</b></div>
            <div><span>Comentarios</span><b>${num(summary.total_comments || 0)}</b></div>
            <div><span>Compartidos</span><b>${num(summary.total_shares || 0)}</b></div>
            <div><span>Avance</span><b>${Math.round(progress)}%</b></div>
          </div>
          <div class="progress" style="margin:10px 0 14px"><span style="width:${progress}%"></span></div>
          <div class="review-options">
            <label>Premio adicional por desempeño<div class="input-with-action"><input id="bonusPayInput" type="number" min="0" step="0.01" value="${summary.bonus_pay ?? 0}" placeholder="0.00"><button id="useSuggestedBonus" type="button" class="btn btn-secondary btn-sm" ${suggestedBonus > 0 ? "" : "disabled"}>Usar ${money(suggestedBonus)}</button></div><small class="muted">Sugerencia proporcional opcional; el clipero solo ve un máximo base de ${money(summary.max_base_pay)}.</small></label>
            <label>Número de operación<input id="transactionInput" value="${esc(summary.transaction_number || "")}" placeholder="Opcional hasta pagar"></label>
            <label class="full">Observación o nota<textarea id="reviewNote" rows="2" placeholder="Escribe un motivo cuando observes el reporte">${esc(summary.admin_note || "")}</textarea></label>
          </div>
          <div class="card-head" style="margin-top:14px"><div><h3>Videos por cuenta</h3><p>Las métricas se actualizan cada 24 horas y antes de evaluar.</p></div><button id="syncReportNow" class="btn btn-secondary btn-sm">↻ Actualizar métricas</button></div>
          ${videosTable(videos, accounts, true)}
          ${observations.length ? `<div class="divider"></div><h3>Observaciones</h3>${observations.map((o) => `<div class="alert ${o.resolved ? "alert-info" : "alert-danger"} compact-alert" style="margin-bottom:8px"><div>📝</div><div><strong>${o.resolved ? "Resuelta" : "Pendiente"}</strong><p>${esc(o.message)} · ${dateTimeLabel(o.created_at)}</p></div></div>`).join("")}` : ""}
        </div><div class="modal-foot"><span class="small muted">Última métrica: ${dateTimeLabel(summary.metrics_last_checked_at)}</span><button id="adminReportClose" class="btn btn-ghost">Cerrar</button></div>`, "", (layer) => {
          $("#adminReportX", layer).addEventListener("click", closeModal);
          $("#adminReportClose", layer).addEventListener("click", closeModal);
          $("#useSuggestedBonus", layer)?.addEventListener("click", () => { $("#bonusPayInput", layer).value = suggestedBonus.toFixed(2); });
          $("#syncReportNow", layer).addEventListener("click", async () => {
            $("#syncReportNow", layer).disabled = true;
            await syncReportMetrics(reportId);
            closeModal();
            await openAdminReportDetail(reportId);
          });
          $$('[data-edit-video]', layer).forEach((b) => b.addEventListener("click", () => openEditVideoModal(b.dataset.editVideo, true)));
          $$('[data-delete-video]', layer).forEach((b) => b.addEventListener("click", () => adminSoftDeleteVideo(b.dataset.deleteVideo, reportId)));
          $$('[data-sync-video]', layer).forEach((b) => b.addEventListener("click", async () => {
            b.disabled = true;
            await syncVideoMetrics(b.dataset.syncVideo);
            closeModal();
            await openAdminReportDetail(reportId);
          }));
          $$('[data-review-action]', layer).forEach((button) => button.addEventListener("click", async () => {
            const action = button.dataset.reviewAction;
            const note = $("#reviewNote", layer).value.trim();
            const bonus = Number($("#bonusPayInput", layer).value || 0);
            const transaction = $("#transactionInput", layer).value.trim();
            if (action === "observe" && !note) return toast("Escribe el motivo de la observación.", "error");
            const labels = { review: "poner en revisión", observe: "observar", approve: "aprobar", paid: "marcar como pagado" };
            if (!confirm(`¿Deseas ${labels[action]} este reporte?`)) return;
            showLoading(true);
            try {
              if (["approve", "paid"].includes(action)) await syncReportMetrics(reportId, true);
              await query(state.supabase.rpc("admin_quick_review_report", {
                p_report_id: reportId,
                p_action: action,
                p_bonus_pay: bonus,
                p_note: note || null,
                p_transaction_number: transaction || null,
              }));
              closeModal();
              toast("Evaluación guardada", "success");
              await renderPage(true);
            } catch (error) { toast(errorMessage(error), "error"); }
            finally { showLoading(false); }
          }));
        });
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { showLoading(false); }
  }

  async function adminSoftDeleteVideo(videoId, reportId) {
    const reason = prompt("Motivo para anular el video:");
    if (reason === null) return;
    try {
      await query(state.supabase.rpc("soft_delete_video", { p_video_id: videoId, p_reason: reason || "Anulado por administración" }));
      toast("Video anulado", "success");
      closeModal();
      await openAdminReportDetail(reportId);
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  async function renderAdminSettings() {
    setHeader("Configuración", "Reglas generales del sistema.");
    const settings = await query(state.supabase.from("app_settings").select("*").eq("id", 1).single());
    $("#content").innerHTML = `<div class="grid grid2 settings-grid">
      <div class="card compact-card"><div class="card-head"><div><h2>Reglas generales</h2><p>Aplican a reportes nuevos.</p></div><span class="chip">Versión ${esc(settings.schema_version || "1.5")}</span></div>
        <form id="settingsForm" class="form-grid compact-form settings-form">
          <label>Filas iniciales al cargar<input name="default_slots" type="number" min="1" max="100" value="${settings.default_slots}"><small>No limita la cantidad final de videos.</small></label>
          <label>Meta de vistas<input name="target_views" type="number" min="1" value="${settings.target_views}"></label>
          <label>Alerta de vistas bajas<input name="low_alert" type="number" min="0" value="${settings.low_alert}"></label>
          <label>Pago base máximo visible<input name="max_base_pay" type="number" min="0" step="0.01" value="${settings.max_base_pay}"></label>
          <label>Hora predeterminada de cierre<input name="submission_cutoff" type="time" step="1" value="${String(settings.submission_cutoff).slice(0,8)}"><small>La fecha exacta se define en Reportes.</small></label>
          <label>Modalidad<input value="Pago proporcional por reporte" disabled><input type="hidden" name="payment_mode" value="per_report"></label>
          <label class="full checkbox-label"><input name="possible_bonus_enabled" type="checkbox" ${settings.possible_bonus_enabled ? "checked" : ""}> Habilitar premio adicional opcional por desempeño</label>
          <div class="full actions"><button class="btn btn-primary">Guardar cambios</button></div>
        </form>
      </div>
      <div class="card compact-card"><h2>Pago y control semanal</h2>
        <div class="formula-box"><b>Base visible = vistas ÷ meta × pago máximo</b><span>El clipero nunca verá más de ${money(settings.max_base_pay)} como pago base.</span></div>
        <div class="formula-box" style="margin-top:10px"><b>Equivalente del administrador</b><span>Si supera la meta, el sistema muestra cuánto representaría el rendimiento sin tope y sugiere un extra opcional.</span></div>
        <div class="summary-list compact-summary" style="margin-top:12px"><div><span>Meta</span><b>${num(settings.target_views)}</b></div><div><span>Alerta</span><b>${num(settings.low_alert)}</b></div><div><span>Filas iniciales</span><b>${settings.default_slots}</b></div><div><span>Métricas</span><b>Cada 24 h</b></div></div>
        <div class="divider"></div><h3>Fecha de cierre</h3><p class="muted small">Selecciona la semana y aplica la fecha exacta desde la sección Reportes. Al iniciar una nueva semana, el panel del clipero aparece limpio y lo anterior queda en Historial.</p>
        <div class="divider"></div><h3>Diagnóstico</h3><button id="runDiagnosticsBtn" class="btn btn-dark">${uiIcon("activity",15)} Revisar sistema</button><div id="diagnosticsBox" style="margin-top:12px"></div>
      </div>
    </div>`;
    $("#runDiagnosticsBtn").addEventListener("click", runSystemDiagnostics);
    $("#settingsForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const f = Object.fromEntries(new FormData(event.target));
      const payload = {
        default_slots: Number(f.default_slots), target_views: Number(f.target_views), low_alert: Number(f.low_alert),
        max_base_pay: Number(f.max_base_pay), payment_mode: "per_report", submission_cutoff: f.submission_cutoff,
        possible_bonus_enabled: f.possible_bonus_enabled === "on",
      };
      if (payload.low_alert > payload.target_views) return toast("La alerta no puede superar la meta.", "error");
      try { await query(state.supabase.from("app_settings").update(payload).eq("id", 1)); toast("Configuración guardada", "success"); await renderPage(true); }
      catch (error) { toast(errorMessage(error), "error"); }
    });
  }

  async function runSystemDiagnostics() {
    const box = $("#diagnosticsBox");
    const button = $("#runDiagnosticsBtn");
    button.disabled = true;
    button.textContent = "Revisando…";
    const results = [];
    const check = async (name, task) => {
      try {
        const detail = await task();
        results.push({ name, ok: true, detail });
      } catch (error) {
        results.push({ name, ok: false, detail: errorMessage(error) });
      }
    };
    await check("Sesión autenticada", async () => {
      const { data, error } = await state.supabase.auth.getUser();
      if (error || !data.user) throw error || new Error("Sin usuario");
      return data.user.id.slice(0, 8);
    });
    await check("Perfil y rol", async () => {
      const profile = await query(state.supabase.from("profiles").select("username,role,active").eq("id", state.profile.id).single());
      if (!profile.active) throw new Error("Usuario inactivo");
      return `${profile.username} · ${profile.role}`;
    });
    await check("Base de datos y RPC", async () => {
      const health = await query(state.supabase.rpc("system_health_check"));
      return `versión ${health.schema_version || "correcta"}`;
    });
    await check("Edge Function administrativa", async () => {
      const health = await invokeAdminFunction({ action: "health" });
      return health?.role || "activa";
    });
    box.innerHTML = results.map((result) => `<div class="alert ${result.ok ? "alert-success" : "alert-danger"}" style="margin-bottom:8px"><div>${result.ok ? "✓" : "✕"}</div><div><strong>${esc(result.name)}</strong><p>${esc(result.detail || "Correcto")}</p></div></div>`).join("");
    button.disabled = false;
    button.innerHTML = `${uiIcon("activity",15)} Ejecutar diagnóstico`;
  }


  /* ===================================================================
     CLIPCONTROL 2.0 · CONTROL CENTER OVERRIDES
     Mantiene la lógica estable 1.5.4 y moderniza período, pagos y UX.
     =================================================================== */

  function paymentMethodLabel(method) {
    return ({ yape: "Yape", plin: "Plin", bcp: "BCP", cci: "CCI", bank: "Cuenta bancaria", other: "Otro" })[method] || "Sin registrar";
  }

  function paymentMethodOptions(selected = "") {
    const options = [["","Seleccionar"],["yape","Yape"],["plin","Plin"],["bcp","BCP"],["cci","CCI"],["bank","Cuenta bancaria"],["other","Otro"]];
    return options.map(([value,label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
  }

  function maskPayment(value) {
    const raw = String(value || "").replace(/\s+/g, "");
    if (!raw) return "Pendiente";
    if (raw.length <= 4) return raw;
    return `${"•".repeat(Math.min(6, raw.length - 4))} ${raw.slice(-4)}`;
  }

  function periodRangeLabel(source = null) {
    const start = source?.start_date || source?.week_start || state.activePeriod?.start_date || state.currentSummary?.week_start;
    const end = source?.end_date || source?.period_end || source?.week_end || state.activePeriod?.end_date || state.currentSummary?.week_end;
    if (!start) return weekLabel();
    if (!end) return weekLabel(start);
    const fmt = new Intl.DateTimeFormat("es-PE", { day: "2-digit", month: "short", timeZone: "UTC" });
    const startDate = new Date(`${String(start).slice(0,10)}T12:00:00Z`);
    const endDate = new Date(`${String(end).slice(0,10)}T12:00:00Z`);
    return `${fmt.format(startDate)} – ${fmt.format(endDate)}`;
  }

  function animatedNum(value) {
    return `<span class="metric-animate" data-count="${Number(value || 0)}">${num(value)}</span>`;
  }

  function animateDynamicNumbers(root = document) {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    state.liveCounterValues = state.liveCounterValues || new Map();
    $$('[data-count]', root).forEach((el, index) => {
      const requested = Math.max(0, Number(el.dataset.count || 0));
      const key = el.dataset.countKey || `anon:${state.currentReportId || state.adminWeek || "current"}:${index}`;
      const known = state.liveCounterValues.has(key) ? Number(state.liveCounterValues.get(key) || 0) : null;

      // En una misma campaña una métrica pública nunca debe bailar hacia abajo.
      // Si un scraper devuelve temporalmente menos, mantenemos el último valor visible.
      const target = known === null ? requested : Math.max(known, requested);
      const from = known === null ? target : known;
      state.liveCounterValues.set(key, target);

      if (reduce || target <= from) {
        el.textContent = num(target);
        return;
      }

      const startAt = performance.now();
      const duration = 420;
      const delta = target - from;
      el.classList.add("metric-rise");
      const tick = (now) => {
        const p = Math.min((now - startAt) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = num(Math.round(from + delta * eased));
        if (p < 1) requestAnimationFrame(tick);
        else setTimeout(() => el.classList.remove("metric-rise"), 520);
      };
      requestAnimationFrame(tick);
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copiado al portapapeles", "success");
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      toast("Copiado al portapapeles", "success");
    }
  }

  function applySavedTheme() {
    const saved = localStorage.getItem("clipcontrol_theme_v2") || "light";
    document.body.classList.toggle("theme-dark", saved === "dark");
  }

  function toggleTheme() {
    const dark = !document.body.classList.contains("theme-dark");
    document.body.classList.toggle("theme-dark", dark);
    localStorage.setItem("clipcontrol_theme_v2", dark ? "dark" : "light");
  }

  async function loadGlobalContext() {
    const [settings, periods] = await Promise.all([
      query(state.supabase.from("app_settings").select("*").eq("id", 1).single()),
      query(state.supabase.from("reporting_periods").select("*").eq("is_active", true).order("updated_at", { ascending: false }).limit(1)),
    ]);
    state.settings = settings;
    state.activePeriod = periods?.[0] || null;
    if (!state.adminWeek && state.activePeriod?.start_date) state.adminWeek = state.activePeriod.start_date;
    if (state.activePeriod?.start_date && (!state.adminWeek || state.adminWeek === currentWeekStartISO())) state.adminWeek = state.activePeriod.start_date;
  }

  function setHeader(title, subtitle = "") {
    $("#pageTitle").textContent = title;
    $("#pageSubtitle").textContent = subtitle;
    const badge = state.activePeriod ? periodRangeLabel(state.activePeriod) : (state.currentSummary ? periodRangeLabel(state.currentSummary) : weekLabel());
    $("#weekBadge").textContent = badge;
  }

  function bindStaticEvents() {
    applySavedTheme();
    $("#showPass").addEventListener("click", () => {
      const input = $("#loginPass");
      input.type = input.type === "password" ? "text" : "password";
    });
    $("#loginForm").addEventListener("submit", login);
    $("#logoutBtn").addEventListener("click", logout);
    $("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    $("#refreshBtn").addEventListener("click", () => renderPage(true));
    $("#themeBtn")?.addEventListener("click", toggleTheme);
  }

  function showApp() {
    setAuthenticatedShell(true);
    const p = state.profile;
    $("#sideRole").textContent = p.role === "clipper" ? "Portal del clipero" : "Control Center";
    $("#miniName").textContent = p.names || p.username;
    $("#miniRole").textContent = p.role === "superadmin" ? "Superadministrador" : p.role === "admin" ? "Administrador" : "Clipero";
    $("#miniAvatar").innerHTML = uiIcon("user",18);
    buildNav();
  }

  function buildNav() {
    if (!state.profile) return;
    const isAdmin = ["admin", "superadmin"].includes(state.profile.role);
    const items = isAdmin
      ? [["dashboard","▦","Inicio"],["clippers","👥","Accesos"],["reports","📋","Reportes"],["payments","💳","Pagos"],["settings","⚙","Configuración"]]
      : [["dashboard","⌂","Inicio"],["videos","🎬","Videos"],["networks","◎","Redes"],["history","◷","Historial"],["profile","👤","Perfil"]];

    $("#nav").innerHTML = items.map(([id,icon,label]) => `<button data-page="${id}" class="${state.page === id ? "active" : ""}"><span>${icon}</span>${label}</button>`).join("");
    $$('[data-page]', $("#nav")).forEach((button) => button.addEventListener("click", async () => {
      state.page = button.dataset.page;
      state.selectedClipperId = null;
      $("#sidebar").classList.remove("open");
      buildNav();
      await renderPage(true);
    }));

    const mobile = isAdmin
      ? items
      : [["dashboard","⌂","Inicio"],["videos","🎬","Videos"],["__add","＋","Agregar"],["history","◷","Historial"],["profile","👤","Perfil"]];
    const mobileNav = $("#mobileNav");
    if (mobileNav) {
      mobileNav.innerHTML = mobile.map(([id,icon,label]) => `<button data-mobile-page="${id}" class="${state.page === id ? "active" : ""} ${id === "__add" ? "mobile-add" : ""}"><span>${icon}</span>${id === "__add" ? "" : label}</button>`).join("");
      $$('[data-mobile-page]', mobileNav).forEach((button) => button.addEventListener("click", async () => {
        if (button.dataset.mobilePage === "__add") return handleQuickRegisterAction();
        state.page = button.dataset.mobilePage;
        state.selectedClipperId = null;
        buildNav();
        await renderPage(true);
      }));
    }
  }

  async function renderPage(force = false) {
    if (!state.profile) return;
    showLoading(true);
    try {
      await loadGlobalContext();
      const isAdmin = ["admin", "superadmin"].includes(state.profile.role);
      if (isAdmin) await renderAdminPage(); else await renderClipperPage();
      buildNav();
      animateDynamicNumbers($("#content"));
    } catch (error) {
      console.error(error);
      $("#content").innerHTML = `<div class="alert alert-danger"><div>⚠️</div><div><strong>No se pudo cargar esta sección</strong><p>${esc(errorMessage(error))}</p></div></div>`;
      toast(errorMessage(error), "error");
    } finally { showLoading(false); }
  }

  function profileComplete(profile) {
    const core = Boolean(profile?.names && profile?.surnames && profile?.phone && profile?.primary_social_url);
    const payment = !profile?.payment_required || Boolean(profile?.payment_method && profile?.payment_account);
    return core && payment;
  }

  async function loadClipperCurrentData() {
    const [accounts, settings] = await Promise.all([
      query(state.supabase.from("social_accounts").select("*").eq("user_id", state.profile.id).order("created_at")),
      query(state.supabase.from("app_settings").select("*").eq("id", 1).single()),
    ]);
    state.accounts = accounts;
    state.settings = settings;
    const reportId = await query(state.supabase.rpc("ensure_weekly_report", { p_week_start: null }));
    state.currentReportId = reportId;
    const [summary, videos, observations, platformSummary] = await Promise.all([
      query(state.supabase.from("weekly_report_summary").select("*").eq("report_id", reportId).single()),
      query(state.supabase.from("videos").select("*").eq("report_id", reportId).is("deleted_at", null).order("position")),
      query(state.supabase.from("report_observations").select("*").eq("report_id", reportId).order("created_at", { ascending: false })),
      query(state.supabase.from("weekly_report_platform_summary").select("*").eq("report_id", reportId).order("platform")),
    ]);
    state.currentSummary = summary;
    state.videos = videos;
    state.observations = observations;
    state.platformSummary = platformSummary || [];
    const lastCheck = summary.metrics_last_checked_at ? new Date(summary.metrics_last_checked_at).getTime() : 0;
    if (videos.length && (!lastCheck || Date.now() - lastCheck > 24 * 60 * 60 * 1000)) {
      await syncReportMetrics(reportId, true);
      const [newSummary, newVideos, newPlatforms] = await Promise.all([
        query(state.supabase.from("weekly_report_summary").select("*").eq("report_id", reportId).single()),
        query(state.supabase.from("videos").select("*").eq("report_id", reportId).is("deleted_at", null).order("position")),
        query(state.supabase.from("weekly_report_platform_summary").select("*").eq("report_id", reportId).order("platform")),
      ]);
      state.currentSummary = newSummary;
      state.videos = newVideos;
      state.platformSummary = newPlatforms || [];
    }
  }

  function aggregatePlatformRows(rows = []) {
    const map = Object.fromEntries(Object.keys(PLATFORMS).map((platform) => [platform, { platform, video_count:0,views:0,likes:0,comments:0,shares:0,calculated_pay:0,proportional_equivalent:0,suggested_bonus:0,pay_enabled:false,target_views:0,max_base_pay:0 }]));
    for (const row of rows || []) {
      const a = map[row.platform]; if (!a) continue;
      a.video_count += Number(row.video_count || 0); a.views += Number(row.views || 0); a.likes += Number(row.likes || 0); a.comments += Number(row.comments || 0); a.shares += Number(row.shares || 0);
      a.calculated_pay += Number(row.calculated_pay || 0); a.proportional_equivalent += Number(row.proportional_equivalent || 0); a.suggested_bonus += Number(row.suggested_bonus || 0);
      a.pay_enabled = a.pay_enabled || Boolean(row.pay_enabled); a.target_views += row.pay_enabled ? Number(row.target_views || 0) : 0; a.max_base_pay += row.pay_enabled ? Number(row.max_base_pay || 0) : 0;
    }
    return Object.values(map);
  }

  function platformMetricCards(videos = [], platformRows = [], actionable = false) {
    const videoSummary = summarizeVideosByPlatform(videos);
    const rowMap = Object.fromEntries((platformRows || []).map((row) => [row.platform, row]));
    return `<div class="platform-metrics-grid">${Object.keys(PLATFORMS).map((platform) => {
      const fallback = videoSummary[platform];
      const row = rowMap[platform] || { platform, video_count:fallback.videos, views:fallback.views, likes:fallback.likes, comments:fallback.comments, shares:fallback.shares, pay_enabled:false, calculated_pay:0, target_views:0, max_base_pay:0 };
      const target = Number(row.target_views || 0), views = Number(row.views || 0);
      const progress = row.pay_enabled && target ? clamp((views / target) * 100, 0, 100) : 0;
      const tag = actionable ? "button" : "div";
      return `<${tag} ${actionable ? `type="button" data-filter-platform="${platform}"` : ""} class="card platform-metric-card platform-metric-${platform} ${actionable ? "actionable" : ""}">
        <div class="platform-metric-head">${platformBadge(platform, true)}<span>${Number(row.video_count || 0)} video${Number(row.video_count || 0) === 1 ? "" : "s"}</span></div>
        <strong>${animatedNum(views)}</strong><small>vistas</small>
        <div class="platform-metric-foot">❤ ${num(row.likes || 0)} · 💬 ${num(row.comments || 0)} · ↗ ${num(row.shares || 0)}</div>
        ${row.pay_enabled ? `<div class="platform-progress"><span style="--progress:${progress}%"></span></div><div class="platform-payment-line"><span>${Math.round(progress)}% de ${num(target)}</span><b>${money(row.calculated_pay || 0)}</b></div>` : `<div class="platform-payment-line"><span>Métrica informativa</span><b class="not-paid">No remunerado</b></div>`}
      </${tag}>`;
    }).join("")}</div>`;
  }

  function renderClipperDashboard() {
    setHeader("Inicio", "Tu período activo y rendimiento.");
    const s = state.currentSummary;
    const platforms = state.platformSummary || [];
    const paidRows = platforms.filter((row) => row.pay_enabled);
    const target = paidRows.reduce((sum,row) => sum + Number(row.target_views || 0), 0);
    const payableViews = paidRows.reduce((sum,row) => sum + Number(row.views || 0), 0);
    const progress = target ? clamp((payableViews / target) * 100,0,100) : 0;
    const editable = reportEditable(s), accounts = activeAccounts(), hasAccounts = accounts.length > 0;
    const interactions = Number(s.total_likes || 0) + Number(s.total_comments || 0) + Number(s.total_shares || 0);
    const paymentLabel = paidRows.length ? paidRows.map(r => platformLabel(r.platform)).join(" + ") : "Sin plataforma remunerada";
    const deadlinePassed = s.submission_deadline && Date.now() > new Date(s.submission_deadline).getTime();

    $("#content").innerHTML = `
      <section class="dashboard-banner period-hero">
        <div class="period-main"><span class="eyebrow">PERÍODO ACTIVO</span><div class="period-title"><h2>Hola, ${esc(state.profile.names || state.profile.username)} 👋</h2><span class="period-state">${deadlinePassed ? "CERRANDO" : "ABIERTO"}</span></div><p>${periodRangeLabel(s)}</p><div class="period-meta"><span>Cierre <b>${dateTimeLabel(s.submission_deadline)}</b></span><span>${s.video_count} videos</span><span>${accounts.length} cuentas activas</span></div></div>
        <div class="pay-focus"><small>Pago estimado</small><strong>${money(s.calculated_base_pay || 0)}</strong><span>${esc(paymentLabel)} · máximo ${money(s.max_base_pay || 0)}</span></div>
      </section>
      ${platformMetricCards(state.videos, platforms, true)}
      <div class="grid grid3 compact-kpis mobile-two-columns" style="margin-top:12px">
        ${kpi("Videos", num(s.video_count), `${accounts.length} cuentas activas`)}
        ${kpi("Interacciones", num(interactions), "Likes + comentarios + compartidos")}
        ${kpi("Avance remunerado", `${Math.round(progress)}%`, `${num(payableViews)} / ${num(target || 0)} vistas`)}
      </div>
      <div class="grid grid2 dashboard-actions-grid" style="margin-top:12px">
        <div class="card compact-card"><div class="card-head"><div><h2>Registrar contenido</h2><p>Una fila o todas las que necesites.</p></div><span class="status ${statusClass(s.status)}">${STATUS_LABELS[s.status]}</span></div>${!hasAccounts ? '<div class="alert alert-warning compact-alert"><div>🌐</div><div><strong>Registra una red</strong><p>Agrega tu primera cuenta para continuar.</p></div></div>' : ""}<div class="actions" style="margin-top:10px"><button id="quickAddBtn" class="btn btn-primary" ${!editable ? "disabled" : ""}>＋ Agregar videos</button><button id="goNetworksBtn" class="btn btn-ghost">Mis redes</button></div>${!editable ? `<p class="small" style="color:var(--danger);margin-top:9px">${deadlinePassed ? "El plazo terminó." : "El reporte ya fue cerrado."}</p>` : ""}</div>
        <div class="card compact-card"><div class="card-head"><div><h2>Entrega del período</h2><p>Se conserva editable hasta el cierre.</p></div></div><div class="summary-list compact-summary"><div><span>Estado</span><b>${STATUS_LABELS[s.status]}</b></div><div><span>Última métrica</span><b>${dateTimeLabel(s.metrics_last_checked_at)}</b></div><div><span>Entrega</span><b>${s.submitted_at ? dateTimeLabel(s.submitted_at) : "Pendiente"}</b></div></div><div class="actions" style="margin-top:10px"><button id="submitReportBtn" class="btn btn-success" ${!editable || s.can_submit === false || Number(s.video_count || 0) < 1 ? "disabled" : ""}>${s.submitted_at ? "Actualizar entrega" : "Enviar reporte"}</button><button id="viewVideosBtn" class="btn btn-ghost">Ver videos</button></div></div>
      </div>
      <div class="card compact-card" style="margin-top:12px"><div class="card-head"><div><h2>Actividad reciente</h2><p>Últimos videos registrados.</p></div></div>${videosTable(state.videos.slice(0,8),state.accounts,false,editable)}</div>`;

    $("#quickAddBtn")?.addEventListener("click", handleQuickRegisterAction);
    $("#goNetworksBtn")?.addEventListener("click", () => navigate("networks"));
    $("#viewVideosBtn")?.addEventListener("click", () => { state.videoFilterPlatform = "all"; navigate("videos"); });
    $("#submitReportBtn")?.addEventListener("click", submitCurrentReport);
    $$('[data-filter-platform]').forEach((button) => button.addEventListener("click", () => { state.videoFilterPlatform = button.dataset.filterPlatform; navigate("videos"); }));
    bindClipperVideoActions();
    animateDynamicNumbers($("#content"));
  }

  function renderClipperVideos() {
    setHeader("Mis videos", "Contenido del período activo.");
    const editable = reportEditable(state.currentSummary), hasAccounts = activeAccounts().length > 0;
    const filter = state.videoFilterPlatform || "all";
    const filtered = filter === "all" ? state.videos : state.videos.filter(v => v.platform === filter);
    const filters = [`<button class="platform-btn ${filter === "all" ? "active" : ""}" data-video-filter="all">Todos <span class="chip">${state.videos.length}</span></button>`, ...Object.keys(PLATFORMS).map(p => `<button class="platform-btn ${filter === p ? "active" : ""}" data-video-filter="${p}">${platformBadge(p,true)}</button>`)].join("");
    $("#content").innerHTML = `<div class="card compact-card"><div class="card-head"><div><h2>${periodRangeLabel(state.currentSummary)}</h2><p>${state.currentSummary.video_count} videos registrados</p></div><button id="quickAddBtn" class="btn btn-primary" ${!editable ? "disabled" : ""}>＋ Agregar videos</button></div><div class="platforms" style="margin-bottom:12px">${filters}</div>${!hasAccounts ? `<div class="alert alert-warning compact-alert"><div>🌐</div><div><strong>Primero registra una cuenta</strong><p>Agrega TikTok, Instagram, YouTube o Facebook.</p></div></div>` : ""}${videosTable(filtered,state.accounts,false,editable)}</div>`;
    $("#quickAddBtn")?.addEventListener("click", handleQuickRegisterAction);
    $$('[data-video-filter]').forEach(b => b.addEventListener("click", () => { state.videoFilterPlatform = b.dataset.videoFilter; renderClipperVideos(); }));
    bindClipperVideoActions();
  }

  function renderProfilePage() {
    setHeader("Mi perfil", "Datos personales, red principal y pago.");
    const p = state.profile;
    $("#content").innerHTML = `<div class="grid grid2"><div class="card compact-card"><div class="card-head"><div><h2>Información personal</h2><p>Tu usuario de acceso lo administra la empresa.</p></div><span class="chip">@${esc(p.username)}</span></div><form id="profileForm" class="form-grid compact-form"><label>Nombres<input name="names" required value="${esc(p.names || "")}"></label><label>Apellidos<input name="surnames" required value="${esc(p.surnames || "")}"></label><label>Celular / WhatsApp<input name="phone" required value="${esc(p.phone || "")}"></label><label>Cuenta principal<input name="primary_social_url" required type="url" value="${esc(p.primary_social_url || "")}" placeholder="https://www.tiktok.com/@usuario"></label><div class="full actions"><button class="btn btn-primary">Guardar cambios</button></div></form></div><div class="card compact-card"><div class="card-head"><div><h2>Datos de pago</h2><p>Administración usa estos datos para procesar tus pagos.</p></div><span class="pill ${p.payment_account ? "pill-green" : "pill-yellow"}">${p.payment_account ? "Completo" : "Pendiente"}</span></div><form id="paymentProfileForm" class="form-grid compact-form"><label>Método<select name="payment_method">${paymentMethodOptions(p.payment_method || "")}</select></label><label>Número / cuenta<input name="payment_account" value="${esc(p.payment_account || "")}" placeholder="Yape, Plin, cuenta o CCI"></label><label class="full">Titular<input name="payment_holder" value="${esc(p.payment_holder || `${p.names || ""} ${p.surnames || ""}`.trim())}" placeholder="Nombre del titular"></label><div class="full actions"><button class="btn btn-primary">Guardar datos de pago</button></div></form></div></div>`;
    $("#profileForm").addEventListener("submit", saveOwnProfile);
    $("#paymentProfileForm").addEventListener("submit", async (event) => {
      event.preventDefault(); const f = Object.fromEntries(new FormData(event.target));
      const synthetic = { preventDefault(){}, target: { __paymentOnly: true } };
      await saveProfileV20({ names:p.names, surnames:p.surnames, phone:p.phone, primary_social_url:p.primary_social_url, ...f });
    });
  }

  function openProfileModal(required = false) {
    const p = state.profile;
    const paymentRequired = Boolean(p.payment_required);
    const coreComplete = Boolean(p.names && p.surnames && p.phone && p.primary_social_url);
    const title = paymentRequired && coreComplete ? "Completa tus datos de pago" : "Completa tu registro";
    const subtitle = paymentRequired ? "Este dato fue solicitado por administración y es necesario para continuar." : "Solo te tomará un momento.";
    openModal(`<div class="modal-head"><div><h2>${title}</h2><p>${subtitle}</p></div>${required ? "" : '<button id="profileX" class="modal-close">×</button>'}</div><form id="modalProfileForm"><div class="modal-body"><div class="form-grid compact-form"><label>Nombres<input name="names" required value="${esc(p.names || "")}"></label><label>Apellidos<input name="surnames" required value="${esc(p.surnames || "")}"></label><label>Celular / WhatsApp<input name="phone" required value="${esc(p.phone || "")}"></label><label>Cuenta principal<input name="primary_social_url" type="url" required value="${esc(p.primary_social_url || "")}" placeholder="https://www.tiktok.com/@usuario"></label></div><div class="payment-request-box"><h3 class="icon-title">${uiIcon("wallet",16)} Datos de pago ${paymentRequired ? "obligatorios" : ""}</h3><p>Yape es la opción recomendada. También puedes usar Plin, BCP, CCI u otra cuenta.</p><div class="form-grid compact-form" style="margin-top:10px"><label>Método<select name="payment_method" ${paymentRequired ? "required" : ""}>${paymentMethodOptions(p.payment_method || "")}</select></label><label>Número / cuenta<input name="payment_account" ${paymentRequired ? "required" : ""} value="${esc(p.payment_account || "")}" placeholder="987654321"></label><label class="full">Titular<input name="payment_holder" value="${esc(p.payment_holder || `${p.names || ""} ${p.surnames || ""}`.trim())}"></label></div></div>${paymentRequired ? '<div class="mandatory-note">${uiIcon("alert",15)} <span>Completa estos datos para continuar.</span></div>' : ""}</div><div class="modal-foot"><span></span><button class="btn btn-primary">Guardar y continuar</button></div></form>`, "small", (layer) => {
      $("#profileX", layer)?.addEventListener("click", closeModal);
      $("#modalProfileForm", layer).addEventListener("submit", saveOwnProfile);
    });
  }

  async function saveProfileV20(f) {
    const url = normalizeUrl(f.primary_social_url);
    if (!isValidHttpUrl(url)) return toast("Ingresa un link válido de TikTok, Instagram, YouTube o Facebook.", "error");
    showLoading(true);
    try {
      const updated = await query(state.supabase.rpc("update_my_profile_v20", { p_names:f.names, p_surnames:f.surnames, p_phone:f.phone, p_primary_social_url:url, p_payment_method:f.payment_method || null, p_payment_account:f.payment_account || null, p_payment_holder:f.payment_holder || null }));
      state.profile = Array.isArray(updated) ? updated[0] : updated;
      showApp(); closeModal(); toast("Información guardada", "success"); await renderPage(true);
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { showLoading(false); }
  }

  async function saveOwnProfile(event) {
    event.preventDefault();
    const f = Object.fromEntries(new FormData(event.target));
    const p = state.profile;
    await saveProfileV20({ names:f.names ?? p.names, surnames:f.surnames ?? p.surnames, phone:f.phone ?? p.phone, primary_social_url:f.primary_social_url ?? p.primary_social_url, payment_method:f.payment_method ?? p.payment_method, payment_account:f.payment_account ?? p.payment_account, payment_holder:f.payment_holder ?? p.payment_holder });
  }

  async function renderAdminPage() {
    if (state.page === "dashboard") return renderAdminDashboard();
    if (state.page === "clippers") return state.selectedClipperId ? renderClipperAdminDetail() : renderAdminClippers();
    if (state.page === "reports") return renderAdminReports();
    if (state.page === "payments") return renderAdminPayments();
    if (state.page === "settings") return renderAdminSettings();
  }

  async function renderAdminDashboard() {
    setHeader("Control Center", "Lo importante del período, en una sola vista.");
    const activeStart = state.activePeriod?.start_date || currentWeekStartISO();
    const [clippers,reports,socialAccounts] = await Promise.all([
      query(state.supabase.from("admin_clipper_overview").select("*").eq("role","clipper").order("username")),
      query(state.supabase.from("weekly_report_summary").select("*").eq("week_start",activeStart).order("total_views",{ascending:false})),
      query(state.supabase.from("social_accounts").select("id,user_id,platform,account_name,channel_url,active").eq("active",true)),
    ]);
    const reportIds = reports.map(r => r.report_id);
    const [weekVideos, platformRows] = reportIds.length ? await Promise.all([
      query(state.supabase.from("videos").select("id,report_id,platform,views,likes,comments,shares,metrics_status").in("report_id",reportIds).is("deleted_at",null)),
      query(state.supabase.from("weekly_report_platform_summary").select("*").in("report_id",reportIds)),
    ]) : [[],[]];
    state.adminPlatformRows = platformRows;
    const aggregate = aggregatePlatformRows(platformRows);
    const active = clippers.filter(c => c.active);
    const totalVideos = reports.reduce((a,r)=>a+Number(r.video_count||0),0);
    const projected = reports.reduce((a,r)=>a+Number(r.total_pay ?? r.approved_base_pay ?? r.calculated_base_pay ?? 0),0);
    const pendingReview = reports.filter(r => ["sent","review","observed"].includes(r.status)).length;
    const missingPay = active.filter(c => !c.payment_account || c.payment_required).length;
    const metricErrors = weekVideos.filter(v => v.metrics_status === "error").length;
    const startedUsers = new Set(reports.map(r => r.user_id));
    const missingReports = active.filter(c => !startedUsers.has(c.user_id)).length;
    const platformCounts = Object.keys(PLATFORMS).map(platform => ({platform,count:new Set(socialAccounts.filter(a=>a.platform===platform).map(a=>a.user_id)).size}));
    const maxPlatform = Math.max(...platformCounts.map(p=>p.count),1);

    $("#content").innerHTML = `
      <section class="dashboard-banner period-hero"><div class="period-main"><span class="eyebrow">CONTROL DEL PERÍODO</span><div class="period-title"><h2>${esc(state.activePeriod?.name || "Período activo")}</h2><span class="period-state">ABIERTO</span></div><p>${periodRangeLabel(state.activePeriod)}</p><div class="period-meta"><span>Cierre <b>${dateTimeLabel(state.activePeriod?.submission_deadline)}</b></span><span>${active.length} cliperos activos</span><span>${reports.length} reportes iniciados</span></div></div><div class="pay-focus"><small>Pago proyectado</small><strong>${money(projected)}</strong><span>${totalVideos} videos registrados</span></div></section>
      ${platformMetricCards(weekVideos,aggregate,false)}
      <div class="attention-grid" style="margin-top:12px"><button class="attention-card" data-attention="reports"><span class="attention-icon">📋</span><span class="attention-copy"><b>${pendingReview}</b><span>reportes por evaluar</span></span><span class="attention-arrow">→</span></button><button class="attention-card" data-attention="payments"><span class="attention-icon">💳</span><span class="attention-copy"><b>${missingPay}</b><span>cliperos sin datos de pago</span></span><span class="attention-arrow">→</span></button><button class="attention-card" data-attention="errors"><span class="attention-icon">⚡</span><span class="attention-copy"><b>${metricErrors}</b><span>videos con reintento</span></span><span class="attention-arrow">→</span></button></div>
      <div class="grid grid2" style="margin-top:12px"><div class="card compact-card"><div class="card-head"><div><h2>Redes del equipo</h2><p>Toca una red para ver quién está registrado.</p></div></div><div class="bar-list">${platformCounts.map(item=>`<button type="button" class="bar-row bar-row-btn" data-team-platform="${item.platform}"><div class="bar-meta">${platformBadge(item.platform,true)}<span class="network-count"><b>${item.count}</b><small>Ver cliperos →</small></span></div><div class="bar-track"><span style="width:${(item.count/maxPlatform)*100}%"></span></div></button>`).join("")}</div></div><div class="card compact-card"><div class="card-head"><div><h2>Estado operativo</h2><p>Acciones que aún faltan.</p></div></div><div class="summary-list compact-summary"><div><span>Sin reporte iniciado</span><b>${missingReports}</b></div><div><span>Por evaluar</span><b>${pendingReview}</b></div><div><span>Sin datos de pago</span><b>${missingPay}</b></div><div><span>Métricas con reintento</span><b>${metricErrors}</b></div></div></div></div>
      <div class="card compact-card" style="margin-top:12px"><div class="card-head"><div><h2>Reportes recientes</h2><p>Acceso rápido a evaluación.</p></div><div class="actions"><button id="exportWeeklyBtn" class="btn btn-secondary btn-sm">⬇ Excel</button><button id="goReportsBtn" class="btn btn-primary btn-sm">Ver reportes</button></div></div>${adminReportsTable(reports.slice(0,10))}</div>`;
    $("#exportWeeklyBtn").addEventListener("click",()=>exportWeeklyExcel(reports)); $("#goReportsBtn").addEventListener("click",()=>navigate("reports"));
    $$('[data-team-platform]').forEach(button=>button.addEventListener("click",()=>openTeamPlatformModal(button.dataset.teamPlatform,socialAccounts,clippers)));
    $$('[data-attention]').forEach(button=>button.addEventListener("click",()=>{ const a=button.dataset.attention; if(a==="reports") navigate("reports"); else if(a==="payments") navigate("payments"); else navigate("reports"); }));
    bindAdminReportButtons(); animateDynamicNumbers($("#content"));
  }

  async function renderAdminClippers() {
    setHeader("Accesos", "Cliperos y administradores en un solo lugar.");
    const users = await query(state.supabase.from("admin_clipper_overview").select("*").order("role").order("username"));
    const allowed = state.profile.role === "superadmin" ? users : users.filter(u => u.role === "clipper");
    const filter = state.accessRoleFilter || "clipper";
    const visible = filter === "all" ? allowed : filter === "admin" ? allowed.filter(u => ["admin","superadmin"].includes(u.role)) : allowed.filter(u => u.role === filter);
    const cards = visible.map(u => `<div class="access-user-card" data-search-user="${esc(`${u.username} ${u.names||""} ${u.surnames||""} ${u.phone||""}`.toLowerCase())}"><div class="access-user-top"><span class="access-user-avatar">${uiIcon(u.role === "clipper" ? "user" : "shield",18)}</span><div class="access-user-id"><strong>${esc(u.names ? `${u.names} ${u.surnames||""}`.trim() : `@${u.username}`)}</strong><small>@${esc(u.username)} · ${u.role === "superadmin" ? "Superadmin" : u.role === "admin" ? "Administrador" : "Clipero"}</small></div><span class="pill ${u.active ? "pill-green" : "pill-red"}">${u.active ? "Activo" : "Suspendido"}</span></div><div class="access-user-meta"><div><span>WhatsApp</span><b>${esc(u.phone || "Pendiente")}</b></div><div><span>${u.role === "clipper" ? "Pago" : "Creado"}</span><b class="${u.role === "clipper" ? (u.payment_account ? "payment-ready" : "payment-missing") : ""}">${u.role === "clipper" ? (u.payment_account ? paymentMethodLabel(u.payment_method) : "Pendiente") : dateOnlyLabel(u.created_at)}</b></div></div><button class="btn btn-secondary btn-sm btn-block" data-open-user="${u.user_id}">Administrar</button></div>`).join("");
    $("#content").innerHTML = `<div class="card compact-card"><div class="card-head"><div><h2>Usuarios</h2><p>${allowed.length} accesos visibles</p></div><div class="actions">${filter === "clipper" ? `<button id="requestAllPayBtn" class="btn btn-secondary">${uiIcon("wallet",15)} Solicitar datos</button>` : ""}<button id="createClipperBtn" class="btn btn-primary">${uiIcon("plus",15)} Crear acceso</button></div></div><div class="access-toolbar"><div class="access-tabs"><button class="access-tab ${filter==="clipper"?"active":""}" data-access-filter="clipper">Cliperos (${allowed.filter(u=>u.role==="clipper").length})</button>${state.profile.role === "superadmin" ? `<button class="access-tab ${filter==="admin"?"active":""}" data-access-filter="admin">Administradores (${allowed.filter(u=>["admin","superadmin"].includes(u.role)).length})</button><button class="access-tab ${filter==="all"?"active":""}" data-access-filter="all">Todos</button>` : ""}</div><label class="access-search">${uiIcon("user",14)} <input id="accessSearch" placeholder="Buscar usuario, nombre o celular"></label></div><div class="access-card-grid" id="accessGrid">${cards || '<div class="empty">No hay usuarios en esta categoría.</div>'}</div></div>`;
    $("#createClipperBtn").addEventListener("click",openCreateUserModal);
    $("#requestAllPayBtn")?.addEventListener("click", async () => { if (!confirm("¿Solicitar datos de pago a todos los cliperos activos que aún no los registraron?")) return; try { const count = await query(state.supabase.rpc("admin_request_payment_data_all")); toast(`Solicitud activada para ${count || 0} cliperos`, "success"); await renderAdminClippers(); } catch (error) { toast(errorMessage(error), "error"); } });
    $$('[data-access-filter]').forEach(b=>b.addEventListener("click",()=>{state.accessRoleFilter=b.dataset.accessFilter;renderAdminClippers();}));
    $$('[data-open-user]').forEach(b=>b.addEventListener("click",()=>{state.selectedClipperId=b.dataset.openUser;state.selectedClipperTab="info";renderPage(true);}));
    $("#accessSearch")?.addEventListener("input",e=>{const q=e.target.value.trim().toLowerCase();$$('[data-search-user]').forEach(card=>card.classList.toggle("hidden",q&&!card.dataset.searchUser.includes(q)));});
  }

  function credentialMessage(username,password,role="clipper") {
    const site = String(state.settings?.public_site_url || location.origin).replace(/\/$/,"");
    const intro = role === "admin" ? "Tu acceso administrativo a ClipControl ya está listo." : "Tu acceso a ClipControl ya está listo. Aquí podrás registrar tus videos de TikTok, YouTube, Instagram y Facebook, revisar tus métricas y seguir el estado de tus pagos.";
    return `🥷 *Bienvenido a ClipControl*\n\n${intro}\n\n🌐 *Acceso:* ${site}\n👤 *Usuario:* ${username}\n🔐 *Contraseña:* ${password}\n\n📌 Guarda tus credenciales y no las compartas con otras personas.\n\n🚀 ¡Éxitos con tus clips!`;
  }

  function openCredentialsModal(username,password,role) {
    const message = credentialMessage(username,password,role);
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(message).catch(() => {});
    openModal(`<div class="modal-head"><div><h2>✓ Acceso creado</h2><p>Credenciales listas para enviar.</p></div><button id="credentialsX" class="modal-close">×</button></div><div class="modal-body"><div class="credentials-box" id="credentialsText">${esc(message)}</div><div class="credentials-actions"><button id="copyCredentials" class="btn btn-primary">📋 Copiar mensaje</button><button id="whatsappCredentials" class="btn btn-success">WhatsApp ↗</button></div></div>`,"small",layer=>{$("#credentialsX",layer).addEventListener("click",closeModal);$("#copyCredentials",layer).addEventListener("click",()=>copyText(message));$("#whatsappCredentials",layer).addEventListener("click",()=>window.open(`https://wa.me/?text=${encodeURIComponent(message)}`,"_blank","noopener"));});
  }

  function openCreateUserModal() {
    const canAdmin = state.profile.role === "superadmin";
    openModal(`<div class="modal-head"><div><h2>Crear acceso</h2><p>Usuario y contraseña. El resto se completa al ingresar.</p></div><button id="createX" class="modal-close">×</button></div><form id="createUserForm"><div class="modal-body"><div class="form-grid compact-form"><label>Usuario<input name="username" required minlength="3" maxlength="40" placeholder="clipero01"></label><label>Contraseña asignada<input name="password" type="text" required minlength="6" placeholder="Mínimo 6 caracteres"></label>${canAdmin ? `<label class="full">Rol<select name="role"><option value="clipper">Clipero</option><option value="admin">Administrador</option></select></label>` : '<input type="hidden" name="role" value="clipper">'}</div><div class="payment-request-box"><h3>Registro inteligente</h3><p>Los nuevos cliperos completarán perfil, WhatsApp, cuenta principal y datos de pago al primer ingreso.</p></div></div><div class="modal-foot"><button type="button" id="createCancel" class="btn btn-ghost">Cancelar</button><button class="btn btn-primary">Crear y preparar mensaje</button></div></form>`,"small",layer=>{$("#createX",layer).addEventListener("click",closeModal);$("#createCancel",layer).addEventListener("click",closeModal);$("#createUserForm",layer).addEventListener("submit",async event=>{event.preventDefault();const f=Object.fromEntries(new FormData(event.target));showLoading(true);try{await invokeAdminFunction({action:"create",...f});toast("Acceso creado correctamente","success");await renderPage(true);openCredentialsModal(f.username,f.password,f.role);}catch(error){toast(`No se pudo crear el usuario: ${errorMessage(error)}`,"error");}finally{showLoading(false);}});});
  }

  async function renderClipperAdminDetail() {
    const id = state.selectedClipperId;
    const [profile,accounts,reports,rules] = await Promise.all([
      query(state.supabase.from("profiles").select("*").eq("id",id).single()),
      query(state.supabase.from("social_accounts").select("*").eq("user_id",id).order("created_at")),
      query(state.supabase.from("weekly_report_summary").select("*").eq("user_id",id).order("week_start",{ascending:false})),
      query(state.supabase.from("clipper_rules").select("*").eq("user_id",id).maybeSingle()),
    ]);
    state.selectedAccessProfile = profile;
    setHeader(`${profile.names || profile.username} ${profile.surnames || ""}`.trim(),`@${profile.username}`);
    const clipperTabs = [["info","Resumen"],["networks","Redes"],["current","Período actual"],["history","Historial"],["rules","Reglas"],["access","Acceso"]];
    const adminTabs = [["info","Información"],["access","Acceso"]];
    const tabs = profile.role === "clipper" ? clipperTabs : adminTabs;
    if (!tabs.some(([tab])=>tab===state.selectedClipperTab)) state.selectedClipperTab="info";
    $("#content").innerHTML = `<div class="actions" style="margin-bottom:12px"><button id="backClippers" class="btn btn-ghost">← Volver a accesos</button></div><div class="card compact-card"><div class="tabs">${tabs.map(([tab,label])=>`<button class="tab ${state.selectedClipperTab===tab?"active":""}" data-clipper-tab="${tab}">${label}</button>`).join("")}</div><div id="clipperTabContent"></div></div>`;
    $("#backClippers").addEventListener("click",()=>{state.selectedClipperId=null;renderPage(true);});$$('[data-clipper-tab]').forEach(b=>b.addEventListener("click",()=>{state.selectedClipperTab=b.dataset.clipperTab;renderClipperAdminTab(profile,accounts,reports,rules);}));renderClipperAdminTab(profile,accounts,reports,rules);
  }

  function renderClipperAdminTab(profile,accounts,reports,rules) {
    const box=$("#clipperTabContent"),tab=state.selectedClipperTab;
    if(tab==="info"){
      const pay = profile.role === "clipper" ? `<div><span>Pago</span><b>${profile.payment_account ? `${paymentMethodLabel(profile.payment_method)} · ${maskPayment(profile.payment_account)}` : "Pendiente"}</b></div>` : "";
      box.innerHTML=`<div class="profile-admin-grid"><div class="profile-card">${profileAvatarMarkup(profile,"large")}<div><h3>${esc(profile.names||profile.username)} ${esc(profile.surnames||"")}</h3><p class="muted">@${esc(profile.username)} · ${profile.role}</p></div></div><div class="summary-list compact-summary"><div><span>WhatsApp</span><b>${esc(profile.phone||"Pendiente")}</b></div>${pay}<div><span>Redes activas</span><b>${accounts.filter(a=>a.active).length}</b></div><div><span>Reportes</span><b>${reports.length}</b></div><div><span>Estado</span><b>${profile.active?"Activo":"Suspendido"}</b></div><div><span>Último acceso</span><b>${effectiveLastAccess(profile)?dateTimeLabel(effectiveLastAccess(profile)):"Sin registro"}</b></div><div><span>Última actividad</span><b>${relativeTime(profile.last_seen_at)}</b></div><div><span>Ingresos</span><b>${num(profile.login_count||0)}</b></div></div><div style="margin-top:10px">${presenceHtml(profile)}</div><div class="actions"><button id="editAdminProfile" class="btn btn-secondary">Editar datos</button>${profile.role === "clipper" ? `<button id="requestPayData" class="btn ${profile.payment_account && !profile.payment_required ? "btn-ghost" : "btn-primary"}">${uiIcon("wallet",15)} ${profile.payment_account && !profile.payment_required ? "Solicitar nuevamente" : "Solicitar datos de pago"}</button>${profile.payment_account ? '<button id="copyPaymentAccount" class="btn btn-ghost">Copiar cuenta</button>' : ""}` : ""}</div></div>`;
      $("#editAdminProfile").addEventListener("click",()=>openAdminEditProfile(profile));
      $("#requestPayData")?.addEventListener("click",async()=>{try{await query(state.supabase.rpc("admin_request_payment_data",{p_user_id:profile.id,p_required:true}));toast("La solicitud aparecerá obligatoriamente al clipero","success");await renderPage(true);}catch(error){toast(errorMessage(error),"error");}});
      $("#copyPaymentAccount")?.addEventListener("click",()=>copyText(profile.payment_account)); return;
    }
    if(tab==="networks") { const buttons=Object.keys(PLATFORMS).map(p=>`<button class="platform-btn ${state.selectedPlatform===p?"active":""}" data-admin-platform="${p}">${platformBadge(p,true)}</button>`).join("");box.innerHTML=`<div class="platforms" style="margin-bottom:14px">${buttons}</div><div id="adminNetworkList"></div>`;$$('[data-admin-platform]').forEach(b=>b.addEventListener("click",()=>{state.selectedPlatform=b.dataset.adminPlatform;renderClipperAdminTab(profile,accounts,reports,rules);}));renderAdminNetworkList(profile.id,accounts);return; }
    if(tab==="current") { const start=state.activePeriod?.start_date;const current=reports.find(r=>r.week_start===start);box.innerHTML=current?`<div class="report-metric-grid"><div><span>Videos</span><b>${current.video_count}</b></div><div><span>Vistas totales</span><b>${num(current.total_views)}</b></div><div><span>Pago base</span><b>${money(current.calculated_base_pay)}</b></div><div><span>Estado</span><b>${STATUS_LABELS[current.status]}</b></div><div><span>Inicio</span><b>${dateOnlyLabel(current.week_start)}</b></div><div><span>Cierre</span><b>${dateTimeLabel(current.submission_deadline)}</b></div></div><div class="actions" style="margin-top:14px"><button id="openCurrentAdminReport" class="btn btn-primary">Evaluar reporte</button></div>`:`<div class="empty">El clipero todavía no inició el período activo.</div>`;$("#openCurrentAdminReport")?.addEventListener("click",()=>openAdminReportDetail(current.report_id));return; }
    if(tab==="history") { box.innerHTML=`<div class="table-wrap compact-table"><table><thead><tr><th>Período</th><th>Videos</th><th>Vistas</th><th>Pago</th><th>Estado</th><th></th></tr></thead><tbody>${reports.map(r=>`<tr><td>${periodRangeLabel(r)}</td><td>${r.video_count}</td><td>${num(r.total_views)}</td><td>${money(r.total_pay??r.approved_base_pay??r.calculated_base_pay)}</td><td><span class="status ${statusClass(r.status)}">${STATUS_LABELS[r.status]}</span></td><td><button class="btn btn-secondary btn-sm" data-admin-report="${r.report_id}">Abrir</button></td></tr>`).join("")||'<tr><td colspan="6" class="empty">Sin historial.</td></tr>'}</tbody></table></div>`;bindAdminReportButtons();return; }
    if(tab==="rules"){renderAdminRulesTab(profile,rules);return;}
    if(tab==="access"){box.innerHTML=`<div class="grid grid2"><div><h3>Acceso</h3><p class="muted">Suspende el acceso o asigna una nueva contraseña.</p><div class="actions"><button id="toggleActive" class="btn ${profile.active?"btn-danger":"btn-success"}">${profile.active?"Suspender":"Activar"}</button><button id="resetPassword" class="btn btn-secondary">Cambiar contraseña</button></div></div>${state.profile.role==="superadmin"&&profile.id!==state.profile.id?`<div><h3>Eliminar definitivamente</h3><p class="muted">Elimina el usuario y su información relacionada.</p><button id="hardDelete" class="btn btn-danger">Eliminar usuario</button></div>`:""}</div>`;$("#toggleActive").addEventListener("click",()=>adminUserAction({action:"set_active",user_id:profile.id,active:!profile.active},"Estado actualizado"));$("#resetPassword").addEventListener("click",()=>openResetPassword(profile));$("#hardDelete")?.addEventListener("click",()=>hardDeleteUser(profile));}
  }

  async function renderAdminReports() {
    setHeader("Reportes", "Evaluación por período y plataforma.");
    const periods = await query(state.supabase.from("reporting_periods").select("*").order("start_date",{ascending:false}).limit(20));
    if (!state.adminWeek) state.adminWeek = state.activePeriod?.start_date || periods?.[0]?.start_date || currentWeekStartISO();
    const reports = await query(state.supabase.from("weekly_report_summary").select("*").eq("week_start",state.adminWeek).order("total_views",{ascending:false}));
    const ids=reports.map(r=>r.report_id); const platformRows=ids.length?await query(state.supabase.from("weekly_report_platform_summary").select("*").in("report_id",ids)):[]; state.adminPlatformRows=platformRows;
    const aggregate=aggregatePlatformRows(platformRows), pending=reports.filter(r=>["sent","review","observed"].includes(r.status)).length, projected=reports.reduce((s,r)=>s+Number(r.total_pay??r.approved_base_pay??r.calculated_base_pay??0),0);
    const selectedPeriod=periods.find(p=>p.start_date===state.adminWeek);
    $("#content").innerHTML=`${platformMetricCards([],aggregate,false)}<div class="grid grid3 compact-kpis mobile-two-columns" style="margin-top:12px">${kpi("Reportes",reports.length,`${pending} por revisar`)}${kpi("Pago proyectado",money(projected),"Según reglas por red")}${kpi("Cierre",dateOnlyLabel(selectedPeriod?.end_date||reports[0]?.week_end),dateTimeLabel(selectedPeriod?.submission_deadline||reports[0]?.submission_deadline))}</div><div class="card compact-card" style="margin-top:12px"><div class="card-head"><div><h2>Evaluar cliperos</h2><p>${selectedPeriod?periodRangeLabel(selectedPeriod):state.adminWeek}</p></div><div class="actions"><select id="reportPeriodSelect">${periods.map(p=>`<option value="${p.start_date}" ${p.start_date===state.adminWeek?"selected":""}>${esc(p.name||periodRangeLabel(p))}${p.is_active?" · ACTIVO":""}</option>`).join("")}</select><button id="exportReportsBtn" class="btn btn-secondary btn-sm">⬇ Excel</button></div></div>${adminReportsTable(reports)}</div>`;
    $("#reportPeriodSelect")?.addEventListener("change",e=>{state.adminWeek=e.target.value;renderAdminReports();});$("#exportReportsBtn").addEventListener("click",()=>exportWeeklyExcel(reports));bindAdminReportButtons();animateDynamicNumbers($("#content"));
  }

  async function openAdminReportDetail(reportId) {
    showLoading(true);
    try {
      let summary=await query(state.supabase.from("weekly_report_summary").select("*").eq("report_id",reportId).single());
      const lastCheck=summary.metrics_last_checked_at?new Date(summary.metrics_last_checked_at).getTime():0;
      if(!lastCheck||Date.now()-lastCheck>24*60*60*1000){await syncReportMetrics(reportId,true);summary=await query(state.supabase.from("weekly_report_summary").select("*").eq("report_id",reportId).single());}
      const [videos,accounts,observations,platforms]=await Promise.all([query(state.supabase.from("videos").select("*").eq("report_id",reportId).is("deleted_at",null).order("position")),query(state.supabase.from("social_accounts").select("*").eq("user_id",summary.user_id).order("platform")),query(state.supabase.from("report_observations").select("*").eq("report_id",reportId).order("created_at",{ascending:false})),query(state.supabase.from("weekly_report_platform_summary").select("*").eq("report_id",reportId).order("platform"))]);
      state.videos=videos;state.accounts=accounts;const suggestedBonus=Number(summary.suggested_platform_bonus||0);
      const cards=`<div class="report-platform-grid">${platforms.map(row=>`<div class="report-platform-card">${platformBadge(row.platform,true)}<strong>${num(row.views)}</strong><small>${row.video_count} videos · ❤ ${num(row.likes)}</small><div class="report-pay"><span>${row.pay_enabled?`Pago ${Math.round(clamp(Number(row.views||0)/Number(row.target_views||1)*100,0,999))}%`:"Informativo"}</span><b>${row.pay_enabled?money(row.calculated_pay):"—"}</b></div></div>`).join("")}</div>`;
      openModal(`<div class="modal-head sticky-modal-head"><div><h2>${esc(summary.names||summary.username)} ${esc(summary.surnames||"")}</h2><p>${periodRangeLabel(summary)} · @${esc(summary.username)}</p></div><div class="actions"><span class="status ${statusClass(summary.status)}">${STATUS_LABELS[summary.status]}</span><button id="adminReportX" class="modal-close">×</button></div></div><div class="admin-action-bar"><div class="action-summary"><span><small>Videos</small><b>${summary.video_count}</b></span><span><small>Pago base</small><b>${money(summary.calculated_base_pay)}</b></span><span><small>Extra sugerido</small><b>${money(suggestedBonus)}</b></span></div><div class="actions"><button data-review-action="draft" class="btn btn-elaboration btn-sm" ${summary.status==="draft"||["paid","closed","expired"].includes(summary.status)?"disabled":""}>↩ Seguir en elaboración</button><button data-review-action="review" class="btn btn-secondary btn-sm">Revisión</button><button data-review-action="observe" class="btn btn-warning btn-sm">Observar</button><button data-review-action="approve" class="btn btn-success btn-sm">Aprobar</button><button data-review-action="paid" class="btn btn-dark btn-sm">Pagado</button></div></div><div class="modal-body compact-modal-body">${cards}<div class="payment-request-box"><h3>💳 Datos de pago</h3><p>${summary.payment_account?`${paymentMethodLabel(summary.payment_method)} · ${esc(summary.payment_holder||summary.names||"")} · ${esc(summary.payment_account)}`:"Aún no registrados."}</p></div><div class="review-options" style="margin-top:12px"><label>Premio adicional<div class="input-with-action"><input id="bonusPayInput" type="number" min="0" step="0.01" value="${summary.bonus_pay??0}"><button id="useSuggestedBonus" type="button" class="btn btn-secondary btn-sm" ${suggestedBonus>0?"":"disabled"}>Usar ${money(suggestedBonus)}</button></div></label><label>Número de operación<input id="transactionInput" value="${esc(summary.transaction_number||"")}" placeholder="Opcional"></label><label class="full">Nota / observación<textarea id="reviewNote" rows="2">${esc(summary.admin_note||"")}</textarea></label></div><div class="card-head" style="margin-top:14px"><div><h3>Videos</h3><p>Detalle de enlaces y métricas.</p></div><button id="syncReportNow" class="btn btn-secondary btn-sm">↻ Actualizar métricas</button></div>${videosTable(videos,accounts,true)}${observations.length?`<div class="divider"></div><h3>Observaciones</h3>${observations.map(o=>`<div class="alert ${o.resolved?"alert-info":"alert-danger"} compact-alert"><div>📝</div><div><strong>${o.resolved?"Resuelta":"Pendiente"}</strong><p>${esc(o.message)} · ${dateTimeLabel(o.created_at)}</p></div></div>`).join("")}`:""}</div><div class="modal-foot"><span class="small muted">Última métrica: ${dateTimeLabel(summary.metrics_last_checked_at)}</span><button id="adminReportClose" class="btn btn-ghost">Cerrar</button></div>`,"",layer=>{$("#adminReportX",layer).addEventListener("click",closeModal);$("#adminReportClose",layer).addEventListener("click",closeModal);$("#useSuggestedBonus",layer)?.addEventListener("click",()=>{$("#bonusPayInput",layer).value=suggestedBonus.toFixed(2);});$("#syncReportNow",layer).addEventListener("click",async()=>{$("#syncReportNow",layer).disabled=true;await syncReportMetrics(reportId);closeModal();await openAdminReportDetail(reportId);});$$('[data-edit-video]',layer).forEach(b=>b.addEventListener("click",()=>openEditVideoModal(b.dataset.editVideo,true)));$$('[data-delete-video]',layer).forEach(b=>b.addEventListener("click",()=>adminSoftDeleteVideo(b.dataset.deleteVideo,reportId)));$$('[data-sync-video]',layer).forEach(b=>b.addEventListener("click",async()=>{b.disabled=true;await syncVideoMetrics(b.dataset.syncVideo);closeModal();await openAdminReportDetail(reportId);}));$$('[data-review-action]',layer).forEach(button=>button.addEventListener("click",async()=>{const action=button.dataset.reviewAction,note=$("#reviewNote",layer).value.trim(),bonus=Number($("#bonusPayInput",layer).value||0),transaction=$("#transactionInput",layer).value.trim();if(action==="observe"&&!note)return toast("Escribe el motivo de la observación.","error");const confirmText=action==="draft"?"¿Devolver este reporte a En elaboración? El clipero podrá seguir modificándolo mientras el período esté abierto.":"¿Guardar esta evaluación?";if(!confirm(confirmText))return;showLoading(true);try{if(action==="draft"){await query(state.supabase.rpc("admin_return_report_to_draft",{p_report_id:reportId,p_note:note||null}));}else{if(["approve","paid"].includes(action))await syncReportMetrics(reportId,true);await query(state.supabase.rpc("admin_quick_review_report",{p_report_id:reportId,p_action:action,p_bonus_pay:bonus,p_note:note||null,p_transaction_number:transaction||null}));}closeModal();toast(action==="draft"?"Reporte devuelto a En elaboración":"Evaluación guardada","success");await renderPage(true);}catch(error){toast(errorMessage(error),"error");}finally{showLoading(false);}}));});
    }catch(error){toast(errorMessage(error),"error");}finally{showLoading(false);}
  }

  async function renderAdminPayments() {
    setHeader("Pagos", "Datos de cobro y pagos del período activo.");
    const start=state.activePeriod?.start_date||currentWeekStartISO();
    const reports=await query(state.supabase.from("weekly_report_summary").select("*").eq("week_start",start).order("names"));
    const total=reports.reduce((s,r)=>s+Number(r.total_pay??r.approved_base_pay??r.calculated_base_pay??0),0), paid=reports.filter(r=>r.status==="paid"), missing=reports.filter(r=>!r.payment_account);
    $("#content").innerHTML=`<div class="grid grid3 compact-kpis mobile-two-columns">${kpi("Pago proyectado",money(total),`${reports.length} reportes`)}${kpi("Pagados",paid.length,`${reports.length-paid.length} pendientes`)}${kpi("Sin datos de pago",missing.length,"Solicitar desde Accesos")}</div><div class="card compact-card" style="margin-top:12px"><div class="card-head"><div><h2>Pagos del período</h2><p>${periodRangeLabel(state.activePeriod)}</p></div></div><div class="payment-grid">${reports.map(r=>`<div class="payment-card"><div class="payment-card-head"><div><strong>${esc(r.names||r.username)} ${esc(r.surnames||"")}</strong><small>@${esc(r.username)}</small></div><span class="status ${statusClass(r.status)}">${STATUS_LABELS[r.status]}</span></div><div class="payment-breakdown"><div><span>Base</span><b>${money(r.calculated_base_pay)}</b></div><div><span>Bono</span><b>${money(r.bonus_pay||0)}</b></div><div><span>Total</span><b>${money(r.total_pay??r.approved_base_pay??r.calculated_base_pay)}</b></div></div><div class="payment-account-row"><div><span>${paymentMethodLabel(r.payment_method)}</span><b>${r.payment_account?esc(r.payment_account):"Pendiente"}</b></div><div class="actions">${r.payment_account?`<button class="btn btn-ghost btn-sm" data-copy-pay="${esc(r.payment_account)}">Copiar</button>`:""}<button class="btn btn-secondary btn-sm" data-admin-report="${r.report_id}">Evaluar</button></div></div></div>`).join("")||'<div class="empty">Todavía no hay reportes.</div>'}</div></div>`;
    $$('[data-copy-pay]').forEach(b=>b.addEventListener("click",()=>copyText(b.dataset.copyPay)));bindAdminReportButtons();
  }

  async function exportWeeklyExcel(reports) {
    const platformRows=state.adminPlatformRows||[];const byReport={};for(const row of platformRows){(byReport[row.report_id]??={})[row.platform]=row;}
    const headers=["Usuario","Nombres","WhatsApp","Método pago","Cuenta pago","TikTok vistas","TikTok pago","YouTube vistas","YouTube pago","Instagram vistas","Instagram pago","Facebook vistas","Facebook pago","Videos","Pago base","Bono","Total","Estado","Cierre"];
    const rows=reports.map(r=>{const p=byReport[r.report_id]||{};return [r.username,`${r.names||""} ${r.surnames||""}`.trim(),r.phone||"",paymentMethodLabel(r.payment_method),r.payment_account||"",Number(p.tiktok?.views||0),Number(p.tiktok?.calculated_pay||0),Number(p.youtube?.views||0),Number(p.youtube?.calculated_pay||0),Number(p.instagram?.views||0),Number(p.instagram?.calculated_pay||0),Number(p.facebook?.views||0),Number(p.facebook?.calculated_pay||0),Number(r.video_count||0),Number(r.calculated_base_pay||0),Number(r.bonus_pay||0),Number(r.total_pay??r.approved_base_pay??r.calculated_base_pay??0),STATUS_LABELS[r.status],dateTimeLabel(r.submission_deadline)];});
    const table=[headers,...rows].map(row=>`<tr>${row.map(cell=>`<td>${esc(cell)}</td>`).join("")}</tr>`).join("");const blob=new Blob([`<html><head><meta charset="utf-8"></head><body><table>${table}</table></body></html>`],{type:"application/vnd.ms-excel"});const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`ClipControl_${state.adminWeek||state.activePeriod?.start_date||"reporte"}.xls`;a.click();URL.revokeObjectURL(url);
  }

  async function renderAdminSettings() {
    setHeader("Configuración", "Período, pagos y comportamiento general.");
    const [settings,rules,periods]=await Promise.all([query(state.supabase.from("app_settings").select("*").eq("id",1).single()),query(state.supabase.from("platform_payment_rules").select("*").order("platform")),query(state.supabase.from("reporting_periods").select("*").eq("is_active",true).limit(1))]);
    const period=periods?.[0]||state.activePeriod||{};
    $("#content").innerHTML=`<div class="settings-section"><div class="settings-nav"><button class="active" data-settings-tab="general">General</button><button data-settings-tab="period">Período activo</button><button data-settings-tab="payments">Pago por red</button><button data-settings-tab="system">Sistema</button></div><div class="settings-pane active" data-settings-pane="general"><div class="card compact-card"><div class="card-head"><div><h2>General</h2><p>Preferencias visibles y comportamiento de la web.</p></div><span class="chip">v${esc(settings.schema_version||"2.0")}</span></div><form id="generalSettingsForm" class="form-grid compact-form"><label>Filas iniciales al agregar<input name="default_slots" type="number" min="1" max="100" value="${settings.default_slots||7}"><small>No limita la cantidad final.</small></label><label>URL pública de ClipControl<input name="public_site_url" type="url" value="${esc(settings.public_site_url||location.origin)}" placeholder="https://cliperos.netlify.app"></label><label class="full checkbox-label"><input name="possible_bonus_enabled" type="checkbox" ${settings.possible_bonus_enabled?"checked":""}> Permitir bono adicional por desempeño</label><div class="full actions"><button class="btn btn-primary">Guardar general</button></div></form></div></div><div class="settings-pane" data-settings-pane="period"><div class="card compact-card"><div class="card-head"><div><h2>Período activo</h2><p>Esta es la única fecha que verán administración y cliperos.</p></div><span class="pill pill-green">Fuente única</span></div><form id="periodForm" class="period-form"><label class="wide">Nombre<input name="name" value="${esc(period.name||"")}" placeholder="Campaña agosto"></label><label>Inicio<input name="start_date" type="date" required value="${period.start_date||""}"></label><label>Fin<input name="end_date" type="date" required value="${period.end_date||""}"></label><label>Fecha y hora límite<input name="deadline" type="datetime-local" required value="${dateTimeLocalValue(period.submission_deadline)}"></label><div class="wide actions"><button class="btn btn-primary">Aplicar a todos</button></div></form></div></div><div class="settings-pane" data-settings-pane="payments"><div class="card compact-card"><div class="card-head"><div><h2>Pago por plataforma</h2><p>TikTok está remunerado por defecto. Activa otras redes cuando lo decidas.</p></div></div><div class="platform-rule-list">${Object.keys(PLATFORMS).map(platform=>{const r=rules.find(x=>x.platform===platform)||{};return `<form class="platform-rule-row" data-rule-platform="${platform}"><div>${platformBadge(platform)}<small class="muted" style="display:block;margin-top:5px">${r.pay_enabled?"Cuenta para pago":"Solo informativa"}</small></div><label class="switch-line"><input name="pay_enabled" type="checkbox" ${r.pay_enabled?"checked":""}> Remunerar</label><label>Meta de vistas<input name="target_views" type="number" min="1" value="${r.target_views||250000}"></label><label>Alerta<input name="low_alert" type="number" min="0" value="${r.low_alert||70000}"></label><label>Pago de referencia S/<input name="max_base_pay" type="number" min="0" step="0.01" value="${r.max_base_pay||300}"></label><button class="btn btn-secondary btn-sm">Guardar</button></form>`;}).join("")}</div></div></div><div class="settings-pane" data-settings-pane="system"><div class="card compact-card"><div class="card-head"><div><h2>Diagnóstico</h2><p>Comprueba sesión, base de datos y Edge Function.</p></div></div><button id="runDiagnosticsBtn" class="btn btn-dark">${uiIcon("activity",15)} Revisar sistema</button><div id="diagnosticsBox" style="margin-top:12px"></div></div></div></div>`;
    $$('[data-settings-tab]').forEach(b=>b.addEventListener("click",()=>{$$('[data-settings-tab]').forEach(x=>x.classList.toggle("active",x===b));$$('[data-settings-pane]').forEach(p=>p.classList.toggle("active",p.dataset.settingsPane===b.dataset.settingsTab));}));
    $("#generalSettingsForm").addEventListener("submit",async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));try{await query(state.supabase.from("app_settings").update({default_slots:Number(f.default_slots),public_site_url:f.public_site_url.trim(),possible_bonus_enabled:f.possible_bonus_enabled==="on"}).eq("id",1));toast("Configuración general guardada","success");await loadGlobalContext();}catch(error){toast(errorMessage(error),"error");}});
    $("#periodForm").addEventListener("submit",async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));const deadline=new Date(f.deadline);if(Number.isNaN(deadline.getTime()))return toast("Fecha límite inválida","error");try{await query(state.supabase.rpc("admin_set_active_period",{p_start_date:f.start_date,p_end_date:f.end_date,p_deadline:deadline.toISOString(),p_name:f.name||null}));state.adminWeek=f.start_date;toast("Período activo actualizado para todos","success");await renderPage(true);}catch(error){toast(errorMessage(error),"error");}});
    $$('[data-rule-platform]').forEach(form=>form.addEventListener("submit",async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(form));const platform=form.dataset.rulePlatform;try{await query(state.supabase.rpc("admin_save_platform_payment_rule",{p_platform:platform,p_pay_enabled:f.pay_enabled==="on",p_target_views:Number(f.target_views),p_low_alert:Number(f.low_alert),p_max_base_pay:Number(f.max_base_pay),p_bonus_enabled:true,p_apply_active:true}));toast(`${platformLabel(platform)} actualizado`,"success");await renderPage(true);}catch(error){toast(errorMessage(error),"error");}}));
    $("#runDiagnosticsBtn")?.addEventListener("click",runSystemDiagnostics);
  }



  function renderAdminRulesTab(profile, rules) {
    const box = $("#clipperTabContent");
    box.innerHTML = `<div class="alert alert-info compact-alert" style="margin-bottom:12px"><div>⚙</div><div><strong>Preferencias individuales</strong><p>El pago se configura por plataforma en Configuración → Pago por red.</p></div></div><form id="rulesForm" class="form-grid compact-form"><label>Filas iniciales sugeridas<input name="slots_override" type="number" min="1" max="100" value="${rules?.slots_override ?? ""}" placeholder="Usar general"><small>No limita la cantidad de videos.</small></label><label>Edición fuera de plazo<select name="allow_late_edit"><option value="">Usar general</option><option value="true" ${rules?.allow_late_edit === true ? "selected" : ""}>Permitir</option><option value="false" ${rules?.allow_late_edit === false ? "selected" : ""}>No permitir</option></select></label><label>Puede enviar reporte<select name="can_submit"><option value="">Usar general</option><option value="true" ${rules?.can_submit === true ? "selected" : ""}>Sí</option><option value="false" ${rules?.can_submit === false ? "selected" : ""}>No</option></select></label><label class="full">Nota administrativa<textarea name="admin_notes" rows="2">${esc(rules?.admin_notes || "")}</textarea></label><div class="full actions"><button class="btn btn-primary">Guardar preferencias</button><button type="button" id="resetRules" class="btn btn-ghost">Restablecer</button></div></form>`;
    $("#rulesForm").addEventListener("submit", async (event) => {
      event.preventDefault(); const f = Object.fromEntries(new FormData(event.target));
      const nullableBool = (v) => v === "" ? null : v === "true";
      const payload = { user_id: profile.id, slots_override: f.slots_override === "" ? null : Number(f.slots_override), target_views_override: rules?.target_views_override ?? null, low_alert_override: rules?.low_alert_override ?? null, max_base_pay_override: rules?.max_base_pay_override ?? null, payment_mode_override: "per_report", allow_late_edit: nullableBool(f.allow_late_edit), can_submit: nullableBool(f.can_submit), admin_notes: f.admin_notes || null, updated_by: state.profile.id };
      try { await query(state.supabase.from("clipper_rules").upsert(payload, { onConflict: "user_id" })); toast("Preferencias guardadas", "success"); await renderPage(true); } catch (error) { toast(errorMessage(error), "error"); }
    });
    $("#resetRules").addEventListener("click", async () => { if (!confirm("¿Restablecer las preferencias individuales?")) return; try { await query(state.supabase.from("clipper_rules").delete().eq("user_id", profile.id)); toast("Preferencias restablecidas", "success"); await renderPage(true); } catch (error) { toast(errorMessage(error), "error"); } });
  }


  /* ===================================================================
     CLIPCONTROL 2.2 LIVE · PERIOD ENGINE / PRESENCE / COMMUNICATIONS
     =================================================================== */

  function relativeTime(value) {
    if (!value) return "Nunca";
    const diff = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(diff)) return "—";
    const min = Math.max(0, Math.floor(diff / 60000));
    if (min < 1) return "Ahora";
    if (min < 60) return `Hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `Hace ${h} h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `Hace ${d} día${d === 1 ? "" : "s"}`;
    return dateTimeLabel(value);
  }

  function presenceInfo(user) {
    const onlineMinutes = Math.max(Number(state.settings?.online_window_minutes || 5), 1);
    const warningDays = Math.max(Number(state.settings?.inactive_warning_days || 3), 1);
    const criticalDays = Math.max(Number(state.settings?.inactive_critical_days || 7), warningDays);
    const seen = user?.last_seen_at ? new Date(user.last_seen_at).getTime() : 0;
    const login = user?.last_login_at ? new Date(user.last_login_at).getTime() : 0;
    const seenMinutes = seen ? (Date.now() - seen) / 60000 : Infinity;
    const loginDays = login ? (Date.now() - login) / 86400000 : Infinity;
    if (seenMinutes <= onlineMinutes) return { key:"online", label:"En línea", cls:"presence-online", icon:"🟢" };
    if (seenMinutes <= 15) return { key:"recent", label:"Reciente", cls:"presence-recent", icon:"🟡" };
    if (!login) return { key:"never", label:"Nunca ingresó", cls:"presence-inactive", icon:"⚫" };
    if (loginDays >= criticalDays) return { key:"inactive", label:`Sin ingresar ${criticalDays}+ días`, cls:"presence-inactive", icon:"🔴" };
    if (loginDays >= warningDays) return { key:"low", label:`Baja actividad`, cls:"presence-recent", icon:"🟠" };
    return { key:"offline", label:"Desconectado", cls:"", icon:"⚪" };
  }

  function presenceHtml(user) {
    const p = presenceInfo(user);
    return `<div class="presence-line ${p.cls}"><span class="presence-dot"></span><b>${esc(p.label)}</b><span>· último login ${relativeTime(user?.last_login_at)}</span></div>`;
  }

  function todayStartIso() {
    const p = limaDateParts();
    return new Date(`${p.year}-${p.month}-${p.day}T00:00:00-05:00`).toISOString();
  }

  function applyThemeMode(mode) {
    const preferred = mode === "system" ? (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light") : mode;
    document.body.classList.toggle("theme-dark", preferred === "dark");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = preferred === "dark" ? "#080d16" : "#f4f7fb";
  }

  function applySavedTheme() {
    const saved = localStorage.getItem("clipcontrol_theme_v21") || localStorage.getItem("clipcontrol_theme_v2") || "system";
    applyThemeMode(saved);
    requestAnimationFrame(() => document.body.classList.add("theme-ready"));
  }

  function applyAppearanceSettings() {
    const settings = state.settings || {};
    const local = localStorage.getItem("clipcontrol_theme_v21");
    const mode = local || settings.default_theme || "system";
    applyThemeMode(mode);
    const button = $("#themeBtn");
    if (button) button.classList.toggle("hidden", settings.allow_theme_switch === false);
    document.body.classList.remove("motion-reduced","motion-off","density-comfortable");
    if (settings.motion_level === "reduced") document.body.classList.add("motion-reduced");
    if (settings.motion_level === "off") document.body.classList.add("motion-off");
    if (settings.ui_density === "comfortable") document.body.classList.add("density-comfortable");
  }

  function toggleTheme() {
    if (state.settings?.allow_theme_switch === false) return;
    const dark = !document.body.classList.contains("theme-dark");
    localStorage.setItem("clipcontrol_theme_v21", dark ? "dark" : "light");
    applyThemeMode(dark ? "dark" : "light");
  }

  async function loadGlobalContext() {
    const [settings, periods] = await Promise.all([
      query(state.supabase.from("app_settings").select("*").eq("id",1).single()),
      query(state.supabase.from("reporting_periods").select("*").eq("is_active",true).order("updated_at",{ascending:false}).limit(1)),
    ]);
    state.settings = settings;
    state.activePeriod = periods?.[0] || null;
    if (state.activePeriod?.start_date && (!state.adminWeek || state.adminWeek === currentWeekStartISO())) state.adminWeek = state.activePeriod.start_date;
    applyAppearanceSettings();
  }

  function stopPresenceHeartbeat() {
    if (state.presenceTimer) clearInterval(state.presenceTimer);
    state.presenceTimer = null;
  }

  async function touchPresence(silent = true) {
    if (!state.profile || !state.supabase) return;
    try {
      const seen = await query(state.supabase.rpc("touch_my_presence"));
      state.profile.last_seen_at = seen || new Date().toISOString();
    } catch (error) {
      if (!silent) toast(errorMessage(error),"error");
    }
  }

  function startPresenceHeartbeat() {
    stopPresenceHeartbeat();
    touchPresence(true);
    state.presenceTimer = setInterval(() => {
      if (document.visibilityState === "visible") touchPresence(true);
    }, 3 * 60 * 1000);
  }

  async function login(event) {
    event.preventDefault();
    const userInput = $("#loginUser").value.trim().toLowerCase();
    const password = $("#loginPass").value;
    const normalized = userInput.replace(/[^a-z0-9._-]/g, "");
    const configuredAlias = window.CLIPCONTROL_SUPABASE?.loginAliases?.[userInput];
    const email = configuredAlias || (userInput.includes("@") ? userInput : `${normalized}@usuarios.clipcontrol.app`);
    const button = $("#loginBtn");
    button.disabled = true;
    button.innerHTML = `<span>Ingresando…</span><b class="metric-sync">●</b>`;
    try {
      const data = await query(state.supabase.auth.signInWithPassword({ email, password }));
      state.session = data.session;
      await loadSignedUser(true);
    } catch (error) { toast(errorMessage(error),"error"); }
    finally { button.disabled=false; button.innerHTML='<span>Ingresar</span><b>→</b>'; }
  }

  async function loadSignedUser(recordLogin = false) {
    showLoading(true);
    try {
      const userId = state.session?.user?.id;
      state.profile = await query(state.supabase.from("profiles").select("*").eq("id",userId).single());
      if (!state.profile.active) {
        await state.supabase.auth.signOut();
        throw new Error("Tu cuenta está desactivada. Comunícate con administración.");
      }
      if (recordLogin) {
        try {
          const updated = await query(state.supabase.rpc("record_my_login"));
          if (updated?.id) state.profile = updated;
        } catch (error) { console.warn("No se pudo registrar último login", error); }
      }
      showApp();
      state.page="dashboard";
      await renderPage(true);
      startPresenceHeartbeat();
      if (state.profile.role === "clipper" && !profileComplete(state.profile)) {
        openProfileModal(true);
      } else {
        await showMandatoryAnnouncements();
      }
    } catch (error) {
      toast(errorMessage(error),"error");
      await state.supabase.auth.signOut();
    } finally { showLoading(false); }
  }

  async function logout() {
    stopPresenceHeartbeat();
    showLoading(true);
    try { await touchPresence(true); await state.supabase.auth.signOut(); }
    finally {
      state.session=null; state.profile=null; state.currentReportId=null; showLogin(); showLoading(false);
    }
  }

  async function refreshAnnouncementBadge() {
    const badge = $("#noticeBadge");
    if (!badge || !state.profile) return;
    try {
      const rows = await query(state.supabase.from("my_visible_announcements").select("id,acknowledged"));
      const unread = (rows || []).filter(row => !row.acknowledged).length;
      badge.textContent = unread > 99 ? "99+" : String(unread);
      badge.classList.toggle("hidden", unread === 0);
    } catch (_) { badge.classList.add("hidden"); }
  }

  function announcementIcon(kind) {
    const icon = ({urgent:"alert",important:"alert",payment:"wallet",period:"history",admin:"shield",info:"megaphone"})[kind] || "megaphone"; return `<span class="announcement-type-icon">${uiIcon(icon,15)}</span>`;
  }

  async function showMandatoryAnnouncements() {
    if (!state.profile) return;
    let notices=[];
    try {
      notices = await query(state.supabase.from("my_visible_announcements").select("*").eq("show_on_login",true).eq("acknowledged",false).order("starts_at",{ascending:true}));
    } catch (_) { return; }
    if (!notices.length) return refreshAnnouncementBadge();

    const showAt = (index) => {
      const notice = notices[index];
      if (!notice) { closeModal(); refreshAnnouncementBadge(); return; }
      const required = notice.require_ack !== false;
      openModal(`<div class="modal-head"><div><h2>${esc(notice.title)}</h2><p>${required ? "Confirmación requerida" : "Aviso de administración"}</p></div></div><div class="modal-body"><div class="notice-icon-big">${announcementIcon(notice.kind)}</div><div class="notice-modal-message">${esc(notice.message)}</div>${notice.ends_at?`<div class="activity-chip" style="margin-top:14px">Visible hasta ${dateTimeLabel(notice.ends_at)}</div>`:""}</div><div class="modal-foot"><span class="small muted">${index+1} de ${notices.length}</span><button id="ackNotice" class="btn btn-primary">${required ? "Entendido" : "Continuar"}</button></div>`,"small",layer=>{
        $("#ackNotice",layer).addEventListener("click",async()=>{
          try { await query(state.supabase.rpc("acknowledge_announcement",{p_announcement_id:notice.id})); showAt(index+1); }
          catch(error){ toast(errorMessage(error),"error"); }
        });
      });
    };
    showAt(0);
  }

  async function openNoticeInbox() {
    showLoading(true);
    try {
      const rows = await query(state.supabase.from("my_visible_announcements").select("*").order("starts_at",{ascending:false}));
      openModal(`<div class="modal-head"><div><h2>Avisos</h2><p>Comunicados vigentes para tu cuenta.</p></div><button id="noticeInboxX" class="modal-close">×</button></div><div class="modal-body"><div class="announcement-grid">${rows.map(n=>`<article class="announcement-card kind-${esc(n.kind)}"><div class="announcement-head"><div><h3>${announcementIcon(n.kind)} ${esc(n.title)}</h3><small>${dateTimeLabel(n.starts_at)}</small></div><span class="pill ${n.acknowledged?"pill-green":"pill-yellow"}">${n.acknowledged?"Leído":"Nuevo"}</span></div><p>${esc(n.message)}</p>${!n.acknowledged?`<div class="announcement-actions"><button class="btn btn-primary btn-sm" data-ack-inbox="${n.id}">Marcar entendido</button></div>`:""}</article>`).join("")||'<div class="empty">No hay avisos vigentes.</div>'}</div></div><div class="modal-foot"><span></span><button id="noticeInboxClose" class="btn btn-ghost">Cerrar</button></div>`,"medium",layer=>{
        $("#noticeInboxX",layer).addEventListener("click",closeModal); $("#noticeInboxClose",layer).addEventListener("click",closeModal);
        $$('[data-ack-inbox]',layer).forEach(b=>b.addEventListener("click",async()=>{await query(state.supabase.rpc("acknowledge_announcement",{p_announcement_id:b.dataset.ackInbox}));closeModal();await openNoticeInbox();await refreshAnnouncementBadge();}));
      });
    } catch(error){toast(errorMessage(error),"error");}
    finally{showLoading(false);}
  }

  function bindStaticEvents() {
    applySavedTheme();
    $("#showPass").addEventListener("click",()=>{const input=$("#loginPass");input.type=input.type==="password"?"text":"password";});
    $("#loginForm").addEventListener("submit",login);
    $("#logoutBtn").addEventListener("click",logout);
    $("#menuBtn").addEventListener("click",()=>$("#sidebar").classList.toggle("open"));
    $("#refreshBtn").addEventListener("click",async()=>{
      await touchPresence(true);
      if (state.profile?.role === "clipper" && state.currentReportId) {
        try {
          showLoading(true);
          await syncReportMetrics(state.currentReportId, true);
          sessionStorage.setItem(`clipcontrol-entry-sync:${state.currentReportId}`, String(Date.now()));
        } catch (error) { toast(errorMessage(error), "error"); }
        finally { showLoading(false); }
      }
      await renderPage(true);
    });
    $("#themeBtn")?.addEventListener("click",toggleTheme);
    $("#noticeBtn")?.addEventListener("click",openNoticeInbox);
    document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")touchPresence(true);});
    window.addEventListener("keydown",event=>{
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==="k" && ["admin","superadmin"].includes(state.profile?.role)) { event.preventDefault(); openCommandCenter(); }
    });
    window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change",()=>{if((localStorage.getItem("clipcontrol_theme_v21")||state.settings?.default_theme||"system")==="system")applyThemeMode("system");});
  }

  function buildNav() {
    if (!state.profile) return;
    const isAdmin=["admin","superadmin"].includes(state.profile.role);
    const items=isAdmin
      ? [["dashboard","▦","Inicio"],["clippers","👥","Accesos"],["reports","📋","Reportes"],["payments","💳","Pagos"],["announcements","📢","Comunicados"],["settings","⚙","Configuración"]]
      : [["dashboard","⌂","Inicio"],["videos","🎬","Videos"],["networks","◎","Redes"],["history","◷","Historial"],["profile","👤","Perfil"]];
    $("#nav").innerHTML=items.map(([id,icon,label])=>`<button data-page="${id}" class="${state.page===id?"active":""}"><span>${icon}</span>${label}</button>`).join("");
    $$('[data-page]',$("#nav")).forEach(button=>button.addEventListener("click",async()=>{state.page=button.dataset.page;state.selectedClipperId=null;$("#sidebar").classList.remove("open");buildNav();await touchPresence(true);await renderPage(true);}));
    const mobile=isAdmin
      ? [["dashboard","⌂","Inicio"],["clippers","👥","Accesos"],["reports","📋","Reportes"],["announcements","📢","Avisos"],["settings","⚙","Más"]]
      : [["dashboard","⌂","Inicio"],["videos","🎬","Videos"],["__add","＋","Agregar"],["history","◷","Historial"],["profile","👤","Perfil"]];
    const nav=$("#mobileNav");
    if(nav){nav.innerHTML=mobile.map(([id,icon,label])=>`<button data-mobile-page="${id}" class="${state.page===id?"active":""} ${id==="__add"?"mobile-add":""}"><span>${icon}</span>${id==="__add"?"":label}</button>`).join("");$$('[data-mobile-page]',nav).forEach(button=>button.addEventListener("click",async()=>{if(button.dataset.mobilePage==="__add")return handleQuickRegisterAction();state.page=button.dataset.mobilePage;state.selectedClipperId=null;buildNav();await touchPresence(true);await renderPage(true);}));}
  }

  async function renderPage(force=false) {
    if(!state.profile)return;
    showLoading(true);
    try{
      await loadGlobalContext();
      const isAdmin=["admin","superadmin"].includes(state.profile.role);
      if(isAdmin)await renderAdminPage();else await renderClipperPage();
      buildNav();animateDynamicNumbers($("#content"));await refreshAnnouncementBadge();
    }catch(error){console.error(error);$("#content").innerHTML=`<div class="alert alert-danger"><div>⚠️</div><div><strong>No se pudo cargar esta sección</strong><p>${esc(errorMessage(error))}</p></div></div>`;toast(errorMessage(error),"error");}
    finally{showLoading(false);}
  }

  async function saveProfileV20(f) {
    const url=normalizeUrl(f.primary_social_url);
    if(!isValidHttpUrl(url))return toast("Ingresa un link válido de TikTok, Instagram, YouTube o Facebook.","error");
    showLoading(true);
    try{
      const updated=await query(state.supabase.rpc("update_my_profile_v20",{p_names:f.names,p_surnames:f.surnames,p_phone:f.phone,p_primary_social_url:url,p_payment_method:f.payment_method||null,p_payment_account:f.payment_account||null,p_payment_holder:f.payment_holder||null}));
      state.profile=Array.isArray(updated)?updated[0]:updated;showApp();closeModal();toast("Información guardada","success");await renderPage(true);await showMandatoryAnnouncements();
    }catch(error){toast(errorMessage(error),"error");}finally{showLoading(false);}
  }

  async function renderAdminPage() {
    if(state.page==="dashboard")return renderAdminDashboard();
    if(state.page==="clippers")return state.selectedClipperId?renderClipperAdminDetail():renderAdminClippers();
    if(state.page==="reports")return renderAdminReports();
    if(state.page==="payments")return renderAdminPayments();
    if(state.page==="announcements")return renderAdminAnnouncements();
    if(state.page==="settings")return renderAdminSettings();
  }

  function rankingRows(platform, rows, users) {
    const names=Object.fromEntries(users.map(u=>[u.user_id,u]));
    return rows.filter(r=>r.platform===platform).sort((a,b)=>Number(b.views||0)-Number(a.views||0)).slice(0,5).map((r,i)=>{const u=names[r.user_id]||{};return `<div class="ranking-row"><span class="ranking-pos">${i+1}</span><div><strong>${esc(u.names?`${u.names} ${u.surnames||""}`.trim():u.username||"Clipero")}</strong><small>@${esc(u.username||"")} · ${r.video_count} videos</small></div><b>${num(r.views)}</b></div>`;}).join("")||'<div class="empty">Sin datos todavía.</div>';
  }

  function auditActionText(row, users) {
    const u=users.find(x=>x.user_id===row.actor_id);const who=u?.names||u?.username||"Sistema";
    const labels={weekly_reports:"reporte",videos:"video",payments:"pago",profiles:"usuario",social_accounts:"red social",announcements:"aviso"};
    const action={INSERT:"creó",UPDATE:"actualizó",DELETE:"eliminó"}[row.action]||String(row.action||"").toLowerCase();
    return `${who} ${action} ${labels[row.entity_type]||row.entity_type||"un registro"}`;
  }

  async function renderAdminDashboard() {
    setHeader("Control Center","Operación, actividad y rendimiento del período.");
    const activeStart=state.activePeriod?.start_date;
    const today=todayStartIso();
    const [users,reports,socialAccounts,audits,todayVideos]=await Promise.all([
      query(state.supabase.from("admin_clipper_overview").select("*").order("username")),
      activeStart?query(state.supabase.from("weekly_report_summary").select("*").eq("week_start",activeStart).order("total_views",{ascending:false})):Promise.resolve([]),
      query(state.supabase.from("social_accounts").select("id,user_id,platform,account_name,channel_url,active").eq("active",true)),
      query(state.supabase.from("audit_log").select("id,actor_id,action,entity_type,created_at").order("created_at",{ascending:false}).limit(8)).catch(()=>[]),
      query(state.supabase.from("videos").select("id").gte("created_at",today).is("deleted_at",null)).catch(()=>[]),
    ]);
    const clippers=users.filter(u=>u.role==="clipper"),active=clippers.filter(u=>u.active),online=users.filter(u=>presenceInfo(u).key==="online");
    const reportIds=reports.map(r=>r.report_id);
    const [weekVideos,platformRows]=reportIds.length?await Promise.all([
      query(state.supabase.from("videos").select("id,report_id,platform,views,likes,comments,shares,metrics_status").in("report_id",reportIds).is("deleted_at",null)),
      query(state.supabase.from("weekly_report_platform_summary").select("*").in("report_id",reportIds)),
    ]):[[],[]];
    const aggregate=aggregatePlatformRows(platformRows),projected=reports.reduce((a,r)=>a+Number(r.total_pay??r.approved_base_pay??r.calculated_base_pay??0),0),pending=reports.filter(r=>["sent","review","observed"].includes(r.status)).length,missingPay=active.filter(c=>!c.payment_account||c.payment_required).length,errors=weekVideos.filter(v=>v.metrics_status==="error").length;
    const inactive=active.filter(u=>["inactive","never"].includes(presenceInfo(u).key)).length;
    const submittedToday=reports.filter(r=>r.submitted_at&&new Date(r.submitted_at)>=new Date(today)).length;
    const selectedRank=state.rankingPlatform||"tiktok";
    const socialCounts=Object.keys(PLATFORMS).map(platform=>({platform,count:new Set(socialAccounts.filter(a=>a.platform===platform).map(a=>a.user_id)).size}));
    const maxCount=Math.max(...socialCounts.map(x=>x.count),1);
    $("#content").innerHTML=`<section class="dashboard-banner period-hero"><div class="period-main"><span class="eyebrow">CONTROL DEL PERÍODO</span><div class="period-title"><h2>${esc(state.activePeriod?.name||"Sin período activo")}</h2><span class="period-state">${state.activePeriod?"ABIERTO":"SIN PERÍODO"}</span></div><p>${state.activePeriod?periodRangeLabel(state.activePeriod):"Configura el próximo período"}</p><div class="period-meta"><span>Cierre <b>${dateTimeLabel(state.activePeriod?.submission_deadline)}</b></span><span>${active.length} cliperos activos</span><span>${reports.length} reportes iniciados</span></div></div><div class="pay-focus"><small>Pago proyectado</small><strong>${money(projected)}</strong><span>${reports.reduce((s,r)=>s+Number(r.video_count||0),0)} videos registrados</span></div></section>
      <div class="ops-strip"><div class="ops-stat"><small>Conectados ahora</small><strong>${online.length}</strong><span>${online.filter(u=>u.role==="clipper").length} cliperos · ${online.filter(u=>u.role!=="clipper").length} admins</span></div><div class="ops-stat"><small>Videos hoy</small><strong>${todayVideos.length}</strong><span>Registrados desde 00:00</span></div><div class="ops-stat"><small>Reportes hoy</small><strong>${submittedToday}</strong><span>Enviados por cliperos</span></div><div class="ops-stat"><small>Sin ingresar</small><strong>${inactive}</strong><span>${state.settings?.inactive_critical_days||7}+ días o nunca</span></div></div>
      ${platformMetricCards(weekVideos,aggregate,false)}
      <div class="attention-grid" style="margin-top:12px"><button class="attention-card" data-attention="reports"><span class="attention-icon">📋</span><span class="attention-copy"><b>${pending}</b><span>reportes por evaluar</span></span><span class="attention-arrow">→</span></button><button class="attention-card" data-attention="payments"><span class="attention-icon">💳</span><span class="attention-copy"><b>${missingPay}</b><span>sin datos de pago</span></span><span class="attention-arrow">→</span></button><button class="attention-card" data-attention="inactive"><span class="attention-icon">🕘</span><span class="attention-copy"><b>${inactive}</b><span>cliperos inactivos</span></span><span class="attention-arrow">→</span></button></div>
      <div class="grid grid2" style="margin-top:12px"><div class="card compact-card"><div class="card-head"><div><h2>Ranking por plataforma</h2><p>Rendimiento del período actual.</p></div></div><div class="platforms" style="margin-bottom:10px">${Object.keys(PLATFORMS).map(p=>`<button class="platform-btn ${selectedRank===p?"active":""}" data-rank-platform="${p}">${platformBadge(p,true)}</button>`).join("")}</div><div class="ranking-list" id="rankingList">${rankingRows(selectedRank,platformRows,clippers)}</div></div><div class="card compact-card"><div class="card-head"><div><h2>Actividad reciente</h2><p>Cambios relevantes del sistema.</p></div><span class="activity-chip">Ctrl + K · búsqueda rápida</span></div><div class="activity-list">${audits.map(a=>`<div class="activity-row"><span class="activity-icon">${a.entity_type==="payments"?"💳":a.entity_type==="videos"?"🎬":a.entity_type==="weekly_reports"?"📋":"⚙"}</span><div><strong>${esc(auditActionText(a,users))}</strong><p>${esc(a.entity_type||"")}</p></div><time>${relativeTime(a.created_at)}</time></div>`).join("")||'<div class="empty">Sin actividad reciente.</div>'}</div></div></div>
      <div class="grid grid2" style="margin-top:12px"><div class="card compact-card"><div class="card-head"><div><h2>Redes del equipo</h2><p>Toca una red para ver sus cliperos.</p></div></div><div class="bar-list">${socialCounts.map(item=>`<button type="button" class="bar-row bar-row-btn" data-team-platform="${item.platform}"><div class="bar-meta">${platformBadge(item.platform,true)}<span class="network-count"><b>${item.count}</b><small>Ver cliperos →</small></span></div><div class="bar-track"><span style="width:${item.count/maxCount*100}%"></span></div></button>`).join("")}</div></div><div class="card compact-card"><div class="card-head"><div><h2>Reportes recientes</h2><p>Acceso directo a evaluación.</p></div><button id="goReportsBtn" class="btn btn-primary btn-sm">Ver todos</button></div>${adminReportsTable(reports.slice(0,6))}</div></div>`;
    $$('[data-rank-platform]').forEach(b=>b.addEventListener("click",()=>{state.rankingPlatform=b.dataset.rankPlatform;$$('[data-rank-platform]').forEach(x=>x.classList.toggle("active",x===b));$("#rankingList").innerHTML=rankingRows(state.rankingPlatform,platformRows,clippers);}));
    $$('[data-team-platform]').forEach(b=>b.addEventListener("click",()=>openTeamPlatformModal(b.dataset.teamPlatform,socialAccounts,clippers)));
    $$('[data-attention]').forEach(b=>b.addEventListener("click",()=>{if(b.dataset.attention==="reports")navigate("reports");else if(b.dataset.attention==="payments")navigate("payments");else{state.accessRoleFilter="clipper";state.accessActivityFilter="inactive";navigate("clippers");}}));
    $("#goReportsBtn")?.addEventListener("click",()=>navigate("reports"));bindAdminReportButtons();
  }

  async function renderAdminClippers() {
    setHeader("Accesos","Último login, estado actual y administración de usuarios.");
    const users=await query(state.supabase.from("admin_clipper_overview").select("*").order("role").order("username"));
    const allowed=state.profile.role==="superadmin"?users:users.filter(u=>u.role==="clipper");
    const roleFilter=state.accessRoleFilter||"clipper",activityFilter=state.accessActivityFilter||"all";
    let visible=roleFilter==="all"?allowed:roleFilter==="admin"?allowed.filter(u=>["admin","superadmin"].includes(u.role)):allowed.filter(u=>u.role===roleFilter);
    visible=visible.filter(u=>{const k=presenceInfo(u).key;if(activityFilter==="all")return true;if(activityFilter==="online")return k==="online";if(activityFilter==="warning")return ["low","recent"].includes(k);if(activityFilter==="inactive")return ["inactive","never"].includes(k);if(activityFilter==="never")return k==="never";return true;});
    const cards=visible.map(u=>{const pr=presenceInfo(u);return `<div class="access-user-card" data-search-user="${esc(`${u.username} ${u.names||""} ${u.surnames||""} ${u.phone||""}`.toLowerCase())}"><div class="access-user-top"><span class="access-user-avatar">${uiIcon(u.role==="clipper"?"user":"shield",18)}</span><div class="access-user-id"><strong>${esc(u.names?`${u.names} ${u.surnames||""}`.trim():`@${u.username}`)}</strong><small>@${esc(u.username)} · ${u.role==="superadmin"?"Superadmin":u.role==="admin"?"Administrador":"Clipero"}</small></div><span class="pill ${u.active?"pill-green":"pill-red"}">${u.active?"Activo":"Suspendido"}</span></div>${presenceHtml(u)}<div class="login-meta-grid"><div><span>Último login</span><b>${u.last_login_at?dateTimeLabel(u.last_login_at):"Nunca"}</b></div><div><span>Ingresos</span><b>${num(u.login_count||0)}</b></div><div><span>${u.role==="clipper"?"Pago":"Creado"}</span><b>${u.role==="clipper"?(u.payment_account?paymentMethodLabel(u.payment_method):"Pendiente"):dateOnlyLabel(u.created_at)}</b></div></div><button class="btn btn-secondary btn-sm btn-block" data-open-user="${u.user_id}">Administrar</button></div>`;}).join("");
    $("#content").innerHTML=`<div class="card compact-card"><div class="card-head"><div><h2>Usuarios</h2><p>${allowed.length} accesos · ${allowed.filter(u=>presenceInfo(u).key==="online").length} en línea</p></div><div class="actions">${roleFilter==="clipper"?`<button id="requestAllPayBtn" class="btn btn-secondary">${uiIcon("wallet",15)} Solicitar datos</button>`:""}<button id="createClipperBtn" class="btn btn-primary">${uiIcon("plus",15)} Crear acceso</button></div></div><div class="access-toolbar"><div class="access-tabs"><button class="access-tab ${roleFilter==="clipper"?"active":""}" data-access-filter="clipper">Cliperos (${allowed.filter(u=>u.role==="clipper").length})</button>${state.profile.role==="superadmin"?`<button class="access-tab ${roleFilter==="admin"?"active":""}" data-access-filter="admin">Administradores (${allowed.filter(u=>["admin","superadmin"].includes(u.role)).length})</button><button class="access-tab ${roleFilter==="all"?"active":""}" data-access-filter="all">Todos</button>`:""}</div><div class="actions"><select id="activityFilter"><option value="all" ${activityFilter==="all"?"selected":""}>Toda actividad</option><option value="online" ${activityFilter==="online"?"selected":""}>En línea</option><option value="warning" ${activityFilter==="warning"?"selected":""}>Baja actividad</option><option value="inactive" ${activityFilter==="inactive"?"selected":""}>Inactivos</option><option value="never" ${activityFilter==="never"?"selected":""}>Nunca ingresaron</option></select><label class="access-search">${uiIcon("user",14)} <input id="accessSearch" placeholder="Buscar usuario, nombre o celular"></label></div></div><div class="access-card-grid" id="accessGrid">${cards||'<div class="empty">No hay usuarios con este filtro.</div>'}</div></div>`;
    $("#createClipperBtn").addEventListener("click",openCreateUserModal);$("#requestAllPayBtn")?.addEventListener("click",async()=>{if(!confirm("¿Solicitar datos de pago a todos los cliperos activos que aún no los registraron?"))return;try{const count=await query(state.supabase.rpc("admin_request_payment_data_all"));toast(`Solicitud activada para ${count} clipero(s)`,"success");await renderAdminClippers();}catch(error){toast(errorMessage(error),"error");}});
    $$('[data-access-filter]').forEach(b=>b.addEventListener("click",()=>{state.accessRoleFilter=b.dataset.accessFilter;renderAdminClippers();}));$("#activityFilter").addEventListener("change",e=>{state.accessActivityFilter=e.target.value;renderAdminClippers();});$("#accessSearch").addEventListener("input",e=>{const term=e.target.value.trim().toLowerCase();$$('[data-search-user]').forEach(card=>card.classList.toggle("hidden",term&&!card.dataset.searchUser.includes(term)));});$$('[data-open-user]').forEach(b=>b.addEventListener("click",()=>{state.selectedClipperId=b.dataset.openUser;state.selectedClipperTab="info";renderPage(true);}));
  }

  async function renderAdminAnnouncements() {
    setHeader("Comunicados","Publica avisos obligatorios o informativos.");
    const [notices,users]=await Promise.all([
      query(state.supabase.from("announcement_admin_summary").select("*").order("created_at",{ascending:false}).limit(100)),
      query(state.supabase.from("admin_clipper_overview").select("user_id,role,active,username,names,surnames").eq("active",true)),
    ]);
    const expected=n=>n.target_user_ids?.length|| (n.audience==="all"?users.length:n.audience==="admins"?users.filter(u=>u.role!=="clipper").length:users.filter(u=>u.role==="clipper").length);
    $("#content").innerHTML=`<div class="announcement-toolbar"><div><h2 style="margin:0;font-size:17px">Centro de comunicados</h2><p class="muted small">Los avisos obligatorios aparecen al iniciar sesión hasta que el usuario los confirme.</p></div><button id="createAnnouncementBtn" class="btn btn-primary">＋ Crear aviso</button></div><div class="announcement-grid">${notices.map(n=>`<article class="announcement-card kind-${esc(n.kind)}"><div class="announcement-head"><div><h3>${announcementIcon(n.kind)} ${esc(n.title)}</h3><small>${n.audience==="all"?"Todos":n.audience==="admins"?"Administradores":"Cliperos"} · ${dateTimeLabel(n.starts_at)}</small></div><span class="pill ${n.active?"pill-green":"pill-red"}">${n.active?"Activo":"Archivado"}</span></div><p>${esc(n.message)}</p><div class="announcement-meta"><span class="activity-chip">${n.require_ack?"Confirmación obligatoria":"Informativo"}</span><span class="activity-chip">Leído ${n.acknowledged_count||0}/${expected(n)}</span>${n.ends_at?`<span class="activity-chip">Hasta ${dateOnlyLabel(n.ends_at)}</span>`:""}</div><div class="announcement-actions"><button class="btn btn-secondary btn-sm" data-notice-readers="${n.id}" data-expected="${expected(n)}">Ver lecturas</button>${n.active?`<button class="btn btn-ghost btn-sm" data-notice-disable="${n.id}">Archivar</button>`:""}</div></article>`).join("")||'<div class="empty">Todavía no publicaste comunicados.</div>'}</div>`;
    $("#createAnnouncementBtn").addEventListener("click",openCreateAnnouncementModal);$$('[data-notice-disable]').forEach(b=>b.addEventListener("click",async()=>{if(!confirm("¿Archivar este aviso?"))return;await query(state.supabase.from("announcements").update({active:false,updated_at:new Date().toISOString()}).eq("id",b.dataset.noticeDisable));toast("Aviso archivado","success");renderAdminAnnouncements();}));$$('[data-notice-readers]').forEach(b=>b.addEventListener("click",()=>openAnnouncementReaders(b.dataset.noticeReaders,Number(b.dataset.expected||0))));
  }

  function openCreateAnnouncementModal() {
    const now=dateTimeLocalValue(new Date().toISOString());
    openModal(`<div class="modal-head"><div><h2>Nuevo comunicado</h2><p>Puede aparecer obligatoriamente al iniciar sesión.</p></div><button id="announcementX" class="modal-close">×</button></div><form id="announcementForm"><div class="modal-body"><div class="form-grid compact-form"><label class="full">Título<input name="title" maxlength="120" required placeholder="Aviso importante"></label><label class="full">Mensaje<textarea name="message" maxlength="3000" required placeholder="Escribe un mensaje corto y claro..."></textarea></label><label>Tipo<select name="kind"><option value="info">Información</option><option value="important">Importante</option><option value="urgent">Urgente</option><option value="payment">Pago</option><option value="period">Período</option></select></label><label>Destinatarios<select name="audience"><option value="clippers">Todos los cliperos</option><option value="admins">Administradores</option><option value="all">Todos</option></select></label><label>Publicar desde<input name="starts_at" type="datetime-local" value="${now}" required></label><label>Expira<input name="ends_at" type="datetime-local"></label><label class="full checkbox-label"><input name="show_on_login" type="checkbox" checked> Mostrar al iniciar sesión</label><label class="full checkbox-label"><input name="require_ack" type="checkbox" checked> Requerir que presione “Entendido”</label></div><div class="notice-preview" style="margin-top:12px"><b>Consejo</b><p class="small muted">Usa Urgente solo para cambios que realmente necesitan atención inmediata.</p></div></div><div class="modal-foot"><button type="button" id="announcementCancel" class="btn btn-ghost">Cancelar</button><button class="btn btn-primary">Publicar aviso</button></div></form>`,"small",layer=>{$("#announcementX",layer).addEventListener("click",closeModal);$("#announcementCancel",layer).addEventListener("click",closeModal);$("#announcementForm",layer).addEventListener("submit",async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));const starts=new Date(f.starts_at),ends=f.ends_at?new Date(f.ends_at):null;if(ends&&ends<=starts)return toast("La expiración debe ser posterior a la publicación.","error");try{await query(state.supabase.from("announcements").insert({title:f.title.trim(),message:f.message.trim(),kind:f.kind,audience:f.audience,require_ack:f.require_ack==="on",show_on_login:f.show_on_login==="on",starts_at:starts.toISOString(),ends_at:ends?ends.toISOString():null,created_by:state.profile.id,active:true}));closeModal();toast("Comunicado publicado","success");await renderAdminAnnouncements();}catch(error){toast(errorMessage(error),"error");}});});
  }

  async function openAnnouncementReaders(id,expected=0) {
    showLoading(true);
    try {
      const [notice,receipts,users] = await Promise.all([
        query(state.supabase.from("announcements").select("id,audience,target_user_ids,title").eq("id",id).single()),
        query(state.supabase.from("announcement_receipts").select("user_id,acknowledged_at").eq("announcement_id",id).order("acknowledged_at",{ascending:false})),
        query(state.supabase.from("admin_clipper_overview").select("user_id,username,names,surnames,role,active").eq("active",true)),
      ]);
      const targetSet = new Set(notice.target_user_ids || []);
      const audienceUsers = users.filter(u => {
        if (targetSet.size) return targetSet.has(u.user_id);
        if (notice.audience === "all") return true;
        if (notice.audience === "admins") return u.role !== "clipper";
        return u.role === "clipper";
      });
      const receiptMap = new Map(receipts.map(r => [r.user_id,r]));
      const readUsers = audienceUsers.filter(u => receiptMap.has(u.user_id));
      const unreadUsers = audienceUsers.filter(u => !receiptMap.has(u.user_id));
      const personRow = (u,read=true) => `<div class="activity-row"><span class="activity-icon">${read?"✓":"○"}</span><div><strong>${esc(u.names?`${u.names} ${u.surnames||""}`.trim():u.username||"Usuario")}</strong><p>@${esc(u.username||"")} · ${u.role==="clipper"?"Clipero":u.role==="superadmin"?"Superadmin":"Administrador"}</p></div><time>${read?dateTimeLabel(receiptMap.get(u.user_id)?.acknowledged_at):"Pendiente"}</time></div>`;
      openModal(`<div class="modal-head"><div><h2>Lecturas del aviso</h2><p>${readUsers.length}/${audienceUsers.length || expected || 0} confirmaciones.</p></div><button id="readersX" class="modal-close">×</button></div><div class="modal-body"><div class="grid grid2"><div><h3 style="margin-top:0">✓ Leído (${readUsers.length})</h3><div class="activity-list">${readUsers.map(u=>personRow(u,true)).join("")||'<div class="empty">Nadie lo confirmó todavía.</div>'}</div></div><div><h3 style="margin-top:0">○ Pendiente (${unreadUsers.length})</h3><div class="activity-list">${unreadUsers.map(u=>personRow(u,false)).join("")||'<div class="empty">Todos confirmaron el aviso.</div>'}</div></div></div></div><div class="modal-foot"><span class="small muted">${esc(notice.title||"")}</span><button id="readersClose" class="btn btn-ghost">Cerrar</button></div>`,"medium",layer=>{$("#readersX",layer).addEventListener("click",closeModal);$("#readersClose",layer).addEventListener("click",closeModal);});
    } catch(error) { toast(errorMessage(error),"error"); }
    finally { showLoading(false); }
  }

  function checkBox(name,checked,title,description){return `<label class="setting-switch"><input name="${name}" type="checkbox" ${checked?"checked":""}><div><b>${title}</b><span>${description}</span></div></label>`;}

  async function renderAdminSettings() {
    setHeader("Configuración","Períodos, pagos, métricas, usuarios y apariencia.");
    const [settings,rules,periods]=await Promise.all([
      query(state.supabase.from("app_settings").select("*").eq("id",1).single()),
      query(state.supabase.from("platform_payment_rules").select("*").order("platform")),
      query(state.supabase.from("reporting_periods").select("*").order("start_date",{ascending:false}).limit(20)),
    ]);
    const period=periods.find(p=>p.is_active)||state.activePeriod||{};const tab=state.settingsTab||"general";
    const pane=(id,html)=>`<div class="settings-pane ${tab===id?"active":""}" data-settings-pane="${id}">${html}</div>`;
    $("#content").innerHTML=`<div class="settings-section"><div class="settings-nav">${[["general","General"],["periods","Períodos"],["payments","Pagos"],["metrics","Métricas"],["clippers","Cliperos"],["notices","Avisos"],["access","Accesos"],["appearance","Apariencia"],["system","Sistema"]].map(([id,label])=>`<button class="${tab===id?"active":""}" data-settings-tab="${id}">${label}</button>`).join("")}</div>
      ${pane("general",`<div class="settings-group-card"><div class="settings-group-title"><div><h3>General</h3><p>Identidad y preferencias principales.</p></div><span class="chip">v${esc(settings.schema_version||"2.1")}</span></div><form id="generalSettingsForm" class="form-grid compact-form"><label>Nombre del sistema<input name="site_name" value="${esc(settings.site_name||"ClipControl")}"></label><label>URL pública<input name="public_site_url" type="url" value="${esc(settings.public_site_url||location.origin)}"></label><label>Filas iniciales al agregar<input name="default_slots" type="number" min="1" max="100" value="${settings.default_slots||7}"><small>No limita el total de videos.</small></label><label class="checkbox-label"><input name="possible_bonus_enabled" type="checkbox" ${settings.possible_bonus_enabled?"checked":""}> Permitir bono adicional</label><div class="full actions"><button class="btn btn-primary">Guardar general</button></div></form></div>`)}
      ${pane("periods",`<div class="period-engine-grid"><div class="settings-group-card"><div class="settings-group-title"><div><h3>Período activo</h3><p>La misma fecha se muestra a todos los usuarios.</p></div><span class="pill ${period.id?"pill-green":"pill-red"}">${period.id?"Activo":"No configurado"}</span></div><form id="periodForm" class="period-form"><label class="wide">Nombre<input name="name" value="${esc(period.name||"")}" placeholder="Período semanal"></label><label>Inicio<input name="start_date" type="date" required value="${period.start_date||""}"></label><label>Fin<input name="end_date" type="date" required value="${period.end_date||""}"></label><label>Fecha y hora límite<input name="deadline" type="datetime-local" required value="${dateTimeLocalValue(period.submission_deadline)}"></label><div class="wide actions"><button class="btn btn-primary">Aplicar período</button><button type="button" id="closePeriodNow" class="btn btn-warning">Cerrar ahora + siguiente</button><button type="button" id="closePeriodOnly" class="btn btn-ghost">Cerrar sin crear siguiente</button></div></form><div class="period-flow"><span>Período actual</span><i>→</i><span>Congelar métricas</span><i>→</i><span>Historial</span><i>→</i><span>Siguiente período limpio</span></div></div><div class="settings-group-card"><div class="settings-group-title"><div><h3>Automatización avanzada</h3><p>Controla qué ocurre al llegar al cierre.</p></div></div><form id="periodEngineForm"><div class="form-grid compact-form"><label>Duración del siguiente período<input name="period_length_days" type="number" min="1" max="31" value="${settings.period_length_days||7}"><small>7 días recomendado.</small></label><label>Tolerancia después del cierre (min)<input name="period_grace_minutes" type="number" min="0" max="1440" value="${settings.period_grace_minutes||0}"></label><label>Ventana de sincronización final (min)<input name="period_final_sync_window_minutes" type="number" min="0" max="1440" value="${settings.period_final_sync_window_minutes||60}"><small>Cada video se refresca como máximo una vez dentro de esta ventana.</small></label><label>Hora de cierre de períodos futuros<input name="submission_cutoff" type="time" value="${esc(String(settings.submission_cutoff||"23:59:00").slice(0,5))}"><small>Zona horaria: ${esc(settings.timezone_name||"America/Lima")}.</small></label><label>Avisos antes del cierre (horas)<input name="period_notify_before_hours" value="${esc((settings.period_notify_before_hours||[24,3]).join(", "))}" placeholder="24, 3"></label></div><div class="settings-switch-grid" style="margin-top:10px">${checkBox("period_auto_rollover",settings.period_auto_rollover,"Crear siguiente período automáticamente","Al cerrar, inicia el siguiente desde el día posterior.")}${checkBox("period_freeze_metrics",settings.period_freeze_metrics,"Congelar métricas al cerrar","El historial no cambia aunque el video siga creciendo.")}${checkBox("period_final_sync_enabled",settings.period_final_sync_enabled,"Sincronización final","Actualiza videos por lotes antes del cierre.")}</div><div class="actions" style="margin-top:12px"><button class="btn btn-primary">Guardar automatización</button></div></form></div></div><div class="settings-group-card" style="margin-top:12px"><div class="settings-group-title"><div><h3>Historial de períodos</h3><p>Los períodos cerrados conservan videos, métricas y pagos.</p></div></div><div class="period-history">${periods.map(p=>`<div class="period-history-row"><div><strong>${esc(p.name||periodRangeLabel(p))}</strong><small>${periodRangeLabel(p)} · ${p.is_active?"Activo":p.closed_at?`Cerrado ${dateTimeLabel(p.closed_at)}`:"Histórico"}${p.metrics_frozen_at?" · métricas congeladas":""}</small></div><div class="period-history-actions">${p.is_active?'<span class="pill pill-green">ACTIVO</span>':`<button class="btn btn-ghost btn-sm" data-reopen-period="${p.id}">Reabrir</button>`}</div></div>`).join("")}</div></div>`)}
      ${pane("payments",`<div class="settings-group-card"><div class="settings-group-title"><div><h3>Pago por plataforma</h3><p>Cada red se calcula de forma independiente.</p></div></div><div class="platform-rule-list">${Object.keys(PLATFORMS).map(platform=>{const r=rules.find(x=>x.platform===platform)||{};return `<form class="platform-rule-row" data-rule-platform="${platform}"><div>${platformBadge(platform)}<small class="muted" style="display:block;margin-top:5px">${r.pay_enabled?"Cuenta para pago":"Solo informativa"}</small></div><label class="switch-line"><input name="pay_enabled" type="checkbox" ${r.pay_enabled?"checked":""}> Remunerar</label><label>Meta<input name="target_views" type="number" min="1" value="${r.target_views||250000}"></label><label>Alerta<input name="low_alert" type="number" min="0" value="${r.low_alert||70000}"></label><label>Pago por meta S/<input name="max_base_pay" type="number" min="0" step="0.01" value="${r.max_base_pay||300}"></label><button class="btn btn-secondary btn-sm">Guardar</button></form>`;}).join("")}</div></div>`)}
      ${pane("metrics",`<div class="settings-group-card"><div class="settings-group-title"><div><h3>Métricas LIVE</h3><p>Actualización automática sin recargar.</p></div></div><form id="metricsSettingsForm" class="form-grid compact-form"><label>Modo<select name="metrics_refresh_mode"><option value="automatic" selected>Automático LIVE</option></select></label><label>Intervalo mínimo (min)<input name="metrics_min_refresh_minutes" type="number" min="5" max="180" value="${settings.metrics_min_refresh_minutes||15}"></label><label>Intervalo LIVE por video (min)<input name="metrics_live_interval_minutes" type="number" min="5" max="180" value="${settings.metrics_live_interval_minutes||15}"><small>15 min recomendado para evitar bloqueos de las plataformas.</small></label><label>Tamaño de lote LIVE<input name="metrics_live_batch_size" type="number" min="10" max="100" value="${settings.metrics_live_batch_size||60}"></label><label class="full checkbox-label"><input name="metrics_live_enabled" type="checkbox" ${settings.metrics_live_enabled!==false?"checked":""}> Activar métricas LIVE</label><div class="full settings-subtle alert alert-info compact-alert"><div>${uiIcon("activity",16)}</div><div><strong>En vivo</strong><p>Los cambios aparecen solos. El servidor respeta el intervalo configurado.</p></div></div><div class="full actions"><button class="btn btn-primary">${uiIcon("check",15)} Guardar</button></div></form></div>`)}
      ${pane("clippers",`<div class="settings-group-card"><div class="settings-group-title"><div><h3>Actividad de cliperos</h3><p>Define cuándo marcar baja actividad o inactividad.</p></div></div><form id="clipperSettingsForm" class="form-grid compact-form"><label>Baja actividad después de (días)<input name="inactive_warning_days" type="number" min="1" value="${settings.inactive_warning_days||3}"></label><label>Inactivo después de (días)<input name="inactive_critical_days" type="number" min="1" value="${settings.inactive_critical_days||7}"></label><label>Considerar “En línea” durante (min)<input name="online_window_minutes" type="number" min="1" max="30" value="${settings.online_window_minutes||5}"></label><label class="checkbox-label"><input name="payment_data_default_required" type="checkbox" ${settings.payment_data_default_required?"checked":""}> Datos de pago obligatorios para nuevos cliperos</label><div class="full actions"><button class="btn btn-primary">Guardar cliperos</button></div></form></div>`)}
      ${pane("notices",`<div class="settings-group-card"><div class="settings-group-title"><div><h3>Comunicaciones</h3><p>Publica avisos y controla confirmaciones.</p></div></div><div class="actions"><button id="goAnnouncementsSettings" class="btn btn-primary">${uiIcon("megaphone",15)} Comunicados</button><button id="newAnnouncementSettings" class="btn btn-secondary">${uiIcon("plus",15)} Nuevo aviso</button></div><div class="settings-help" style="margin-top:12px">Los avisos pueden ser informativos, importantes, urgentes, de pago o período. Puedes programar inicio/fin y exigir confirmación.</div></div>`)}
      ${pane("access",`<div class="settings-group-card"><div class="settings-group-title"><div><h3>Accesos y seguimiento</h3><p>Visibilidad administrativa sin datos invasivos.</p></div></div><div class="summary-list compact-summary"><div><span>Último login</span><b>Activo</b></div><div><span>Estado actual</span><b>Última actividad</b></div><div><span>Conteo de ingresos</span><b>Activo</b></div><div><span>IP / huella de dispositivo</span><b>No se registra</b></div></div><div class="alert alert-info compact-alert" style="margin-top:12px"><div>🔐</div><div><strong>Privacidad</strong><p>ClipControl registra únicamente login y actividad básica necesaria para administración de accesos.</p></div></div></div>`)}
      ${pane("appearance",`<div class="settings-group-card"><div class="settings-group-title"><div><h3>Apariencia</h3><p>Tema completo, movimiento y densidad.</p></div></div><form id="appearanceSettingsForm" class="form-grid compact-form"><label>Tema predeterminado<select name="default_theme"><option value="system" ${settings.default_theme==="system"?"selected":""}>Sistema</option><option value="light" ${settings.default_theme==="light"?"selected":""}>Claro</option><option value="dark" ${settings.default_theme==="dark"?"selected":""}>Oscuro</option></select></label><label>Animaciones<select name="motion_level"><option value="full" ${settings.motion_level==="full"?"selected":""}>Completas</option><option value="reduced" ${settings.motion_level==="reduced"?"selected":""}>Reducidas</option><option value="off" ${settings.motion_level==="off"?"selected":""}>Desactivadas</option></select></label><label>Densidad<select name="ui_density"><option value="compact" ${settings.ui_density==="compact"?"selected":""}>Compacta</option><option value="comfortable" ${settings.ui_density==="comfortable"?"selected":""}>Cómoda</option></select></label><label class="checkbox-label"><input name="allow_theme_switch" type="checkbox" ${settings.allow_theme_switch?"checked":""}> Permitir que cada usuario cambie el tema</label><div class="full actions"><button class="btn btn-primary">Guardar apariencia</button><button type="button" id="previewThemeBtn" class="btn btn-secondary">Vista previa oscuro/claro</button></div></form></div>`)}
      ${pane("system",`<div class="settings-group-card"><div class="settings-group-title"><div><h3>Estado del sistema</h3><p>Diagnóstico de base de datos y Edge Function.</p></div><span class="chip">2.2 LIVE</span></div><div class="actions"><button id="runDiagnosticsBtn" class="btn btn-dark">${uiIcon("activity",15)} Revisar sistema</button><button id="runPeriodMaintenanceBtn" class="btn btn-secondary">${uiIcon("sync",15)} Mantenimiento</button></div><div id="diagnosticsBox" style="margin-top:12px"></div></div>`)}
      </div>`;
    $$('[data-settings-tab]').forEach(b=>b.addEventListener("click",()=>{state.settingsTab=b.dataset.settingsTab;renderAdminSettings();}));
    const saveSettings=async(payload,msg)=>{try{await query(state.supabase.from("app_settings").update(payload).eq("id",1));toast(msg,"success");await loadGlobalContext();await renderAdminSettings();}catch(error){toast(errorMessage(error),"error");}};
    $("#generalSettingsForm")?.addEventListener("submit",async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));await saveSettings({site_name:f.site_name.trim()||"ClipControl",public_site_url:f.public_site_url.trim(),default_slots:Number(f.default_slots),possible_bonus_enabled:f.possible_bonus_enabled==="on"},"Configuración general guardada");});
    $("#periodForm")?.addEventListener("submit",async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target)),deadline=new Date(f.deadline);if(Number.isNaN(deadline.getTime()))return toast("Fecha límite inválida","error");try{await query(state.supabase.rpc("admin_set_active_period",{p_start_date:f.start_date,p_end_date:f.end_date,p_deadline:deadline.toISOString(),p_name:f.name||null}));state.adminWeek=f.start_date;toast("Período actualizado para todos","success");await renderPage(true);}catch(error){toast(errorMessage(error),"error");}});
    $("#periodEngineForm")?.addEventListener("submit",async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));const hours=String(f.period_notify_before_hours||"").split(",").map(x=>Number(x.trim())).filter(x=>Number.isFinite(x)&&x>0).slice(0,8);await saveSettings({period_length_days:Number(f.period_length_days),period_grace_minutes:Number(f.period_grace_minutes),period_final_sync_window_minutes:Number(f.period_final_sync_window_minutes),submission_cutoff:f.submission_cutoff||"23:59",period_notify_before_hours:hours.length?hours:[24,3],period_auto_rollover:f.period_auto_rollover==="on",period_freeze_metrics:f.period_freeze_metrics==="on",period_final_sync_enabled:f.period_final_sync_enabled==="on"},"Automatización de períodos guardada");});
    $("#closePeriodNow")?.addEventListener("click",async()=>{if(!confirm("¿Cerrar el período ahora, congelar métricas y crear el siguiente período?"))return;try{await query(state.supabase.rpc("admin_close_active_period",{p_create_next:true}));toast("Período cerrado y siguiente período creado","success");await renderPage(true);}catch(error){toast(errorMessage(error),"error");}});
    $("#closePeriodOnly")?.addEventListener("click",async()=>{if(!confirm("¿Cerrar el período SIN crear el siguiente? Los cliperos quedarán sin período activo hasta que administración cree o reabra uno."))return;try{await query(state.supabase.rpc("admin_close_active_period",{p_create_next:false}));toast("Período cerrado. No hay siguiente período activo.","success");await renderPage(true);}catch(error){toast(errorMessage(error),"error");}});
    $$('[data-reopen-period]').forEach(b=>b.addEventListener("click",async()=>{if(!confirm("¿Reabrir este período? El período actualmente activo dejará de estar activo."))return;try{await query(state.supabase.rpc("admin_reopen_period",{p_period_id:b.dataset.reopenPeriod}));toast("Período reabierto","success");await renderPage(true);}catch(error){toast(errorMessage(error),"error");}}));
    $$('[data-rule-platform]').forEach(form=>form.addEventListener("submit",async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(form)),platform=form.dataset.rulePlatform;try{await query(state.supabase.rpc("admin_save_platform_payment_rule",{p_platform:platform,p_pay_enabled:f.pay_enabled==="on",p_target_views:Number(f.target_views),p_low_alert:Number(f.low_alert),p_max_base_pay:Number(f.max_base_pay),p_bonus_enabled:true,p_apply_active:true}));toast(`${platformLabel(platform)} actualizado`,"success");await renderAdminSettings();}catch(error){toast(errorMessage(error),"error");}}));
    $("#metricsSettingsForm")?.addEventListener("submit",async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));await saveSettings({metrics_refresh_mode:"automatic",metrics_min_refresh_minutes:Number(f.metrics_min_refresh_minutes),metrics_live_enabled:f.metrics_live_enabled==="on",metrics_live_interval_minutes:Number(f.metrics_live_interval_minutes),metrics_live_batch_size:Number(f.metrics_live_batch_size),realtime_ui_enabled:true},"Ajustes LIVE guardados");startLiveMetricsEngine();});
    $("#clipperSettingsForm")?.addEventListener("submit",async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));const w=Number(f.inactive_warning_days),c=Number(f.inactive_critical_days);if(c<w)return toast("El umbral de inactividad debe ser igual o mayor al de baja actividad.","error");await saveSettings({inactive_warning_days:w,inactive_critical_days:c,online_window_minutes:Number(f.online_window_minutes),payment_data_default_required:f.payment_data_default_required==="on"},"Ajustes de cliperos guardados");});
    $("#goAnnouncementsSettings")?.addEventListener("click",()=>navigate("announcements"));$("#newAnnouncementSettings")?.addEventListener("click",openCreateAnnouncementModal);
    $("#appearanceSettingsForm")?.addEventListener("submit",async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));localStorage.removeItem("clipcontrol_theme_v21");await saveSettings({default_theme:f.default_theme,motion_level:f.motion_level,ui_density:f.ui_density,allow_theme_switch:f.allow_theme_switch==="on"},"Apariencia guardada");});$("#previewThemeBtn")?.addEventListener("click",toggleTheme);
    $("#runDiagnosticsBtn")?.addEventListener("click",runSystemDiagnostics);$("#runPeriodMaintenanceBtn")?.addEventListener("click",async()=>{try{const r=await invokeAdminFunction({action:"period_maintenance",limit:100});toast(r?.rollover?.rolled?"Período rotado correctamente":`Mantenimiento ejecutado · ${r?.total||0} métricas`,"success");await renderPage(true);}catch(error){toast(errorMessage(error),"error");}});
  }

  async function openCommandCenter() {
    if(!["admin","superadmin"].includes(state.profile?.role))return;
    let users=[];try{users=await query(state.supabase.from("admin_clipper_overview").select("user_id,username,names,surnames,role,phone,last_login_at").order("username").limit(150));}catch(_){return;}
    const actions=[{id:"reports",icon:"report",title:"Reportes pendientes",sub:"Abrir evaluación de reportes"},{id:"payments",icon:"wallet",title:"Pagos",sub:"Ver datos de cobro y pagos"},{id:"announcements",icon:"megaphone",title:"Crear / revisar comunicados",sub:"Avisos para cliperos y administradores"},{id:"settings",icon:"settings",title:"Configuración",sub:"Períodos, métricas y apariencia"}];
    const layer=$("#modalLayer");layer.innerHTML=`<div class="modal-backdrop"><div class="command-panel"><div class="command-search"><input id="commandInput" autocomplete="off" placeholder="Buscar clipero, usuario o acción..."></div><div class="command-results" id="commandResults"></div><div class="command-hint"><span>Enter · abrir</span><span>Ctrl + K</span></div></div></div>`;
    const render=(term="")=>{const q=term.trim().toLowerCase();const a=actions.filter(x=>!q||`${x.title} ${x.sub}`.toLowerCase().includes(q));const u=users.filter(x=>!q||`${x.username} ${x.names||""} ${x.surnames||""} ${x.phone||""}`.toLowerCase().includes(q)).slice(0,12);$("#commandResults",layer).innerHTML=`${a.map(x=>`<button class="command-result" data-command-page="${x.id}"><span class="command-result-icon">${uiIcon(x.icon,17)}</span><div><strong>${esc(x.title)}</strong><small>${esc(x.sub)}</small></div><span class="command-shortcut">Abrir</span></button>`).join("")}${u.length?'<div class="divider"></div>':""}${u.map(x=>`<button class="command-result" data-command-user="${x.user_id}"><span class="command-result-icon">${uiIcon(x.role==="clipper"?"user":"shield",17)}</span><div><strong>${esc(x.names?`${x.names} ${x.surnames||""}`.trim():x.username)}</strong><small>@${esc(x.username)} · ${relativeTime(x.last_login_at)}</small></div><span class="command-shortcut">Perfil</span></button>`).join("")}`;$$('[data-command-page]',layer).forEach(b=>b.addEventListener("click",()=>{closeModal();navigate(b.dataset.commandPage);}));$$('[data-command-user]',layer).forEach(b=>b.addEventListener("click",()=>{state.page="clippers";state.selectedClipperId=b.dataset.commandUser;state.selectedClipperTab="info";closeModal();renderPage(true);}));};
    render();const input=$("#commandInput",layer);input.addEventListener("input",()=>render(input.value));input.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal();});setTimeout(()=>input.focus(),0);
  }

  // ================================================================
  // CLIPCONTROL 2.2 LIVE · CLIPPER DATA + REALTIME METRICS
  // ================================================================
  async function loadClipperCurrentData() {
    const [accounts, settings] = await Promise.all([
      query(state.supabase.from("social_accounts").select("*").eq("user_id", state.profile.id).order("created_at")),
      query(state.supabase.from("app_settings").select("*").eq("id", 1).single()),
    ]);
    state.accounts = accounts;
    state.settings = settings;
    applyAppearanceSettings();

    const reportId = await query(state.supabase.rpc("ensure_weekly_report", { p_week_start: null }));
    state.currentReportId = reportId;

    const fetchCurrent = async () => {
      const [summary, videos, observations, platformSummary] = await Promise.all([
        query(state.supabase.from("weekly_report_summary").select("*").eq("report_id", reportId).single()),
        query(state.supabase.from("videos").select("*").eq("report_id", reportId).is("deleted_at", null).order("position")),
        query(state.supabase.from("report_observations").select("*").eq("report_id", reportId).order("created_at", { ascending: false })),
        query(state.supabase.from("weekly_report_platform_summary").select("*").eq("report_id", reportId).order("platform")),
      ]);
      state.currentSummary = summary;
      state.videos = videos;
      state.observations = observations;
      state.platformSummary = platformSummary || [];
      return { summary, videos };
    };

    const first = await fetchCurrent();
    if (!first.videos.length) return;

    const mode = settings?.metrics_refresh_mode || "entry_manual";
    const minMinutes = Math.max(Number(settings?.metrics_min_refresh_minutes || 10), 1);
    const minMs = minMinutes * 60 * 1000;
    const lastCheckMs = first.summary?.metrics_last_checked_at ? new Date(first.summary.metrics_last_checked_at).getTime() : 0;
    const stale = !lastCheckMs || (Date.now() - lastCheckMs >= minMs);
    const sessionKey = `clipcontrol-entry-sync:${reportId}`;
    const lastEntryAttempt = Number(sessionStorage.getItem(sessionKey) || 0);
    const entryAlreadyAttempted = lastEntryAttempt && (Date.now() - lastEntryAttempt < minMs);

    // manual_only = únicamente botón Actualizar.
    // entry_manual = como máximo un intento por entrada/intervalo, nunca en cada navegación.
    // automatic = permite refresco al entrar y además el Cron automático del servidor.
    const shouldSync = mode !== "manual_only" && stale && !entryAlreadyAttempted;
    if (!shouldSync) return;

    sessionStorage.setItem(sessionKey, String(Date.now()));
    try {
      await syncReportMetrics(reportId, true);
      await fetchCurrent();
    } catch (error) {
      console.warn("Actualización de métricas al ingresar omitida:", error);
    }
  }


  async function runSystemDiagnostics() {
    const box = $("#diagnosticsBox");
    const button = $("#runDiagnosticsBtn");
    if (!box || !button) return;
    button.disabled = true;
    button.textContent = "Revisando…";
    const results = [];
    const check = async (name, task) => {
      try { results.push({name,ok:true,detail:await task()}); }
      catch(error) { results.push({name,ok:false,detail:errorMessage(error)}); }
    };
    await check("Sesión autenticada", async()=>{const {data,error}=await state.supabase.auth.getUser();if(error||!data.user)throw error||new Error("Sin usuario");return data.user.id.slice(0,8);});
    await check("ClipControl 2.2 LIVE", async()=>{const s=await query(state.supabase.from("app_settings").select("schema_version,metrics_refresh_mode,metrics_live_enabled,metrics_live_interval_minutes,realtime_ui_enabled").eq("id",1).single());if(s.schema_version!=="2.2.0")throw new Error(`Versión detectada ${s.schema_version||"desconocida"}`);return `v${s.schema_version} · LIVE ${s.metrics_live_enabled?"activo":"apagado"} · ${s.metrics_live_interval_minutes||15} min`;});
    await check("Período activo", async()=>{const p=await query(state.supabase.from("reporting_periods").select("start_date,end_date,submission_deadline").eq("is_active",true).limit(1).maybeSingle());if(!p)throw new Error("No existe período activo");return `${periodRangeLabel(p)} · cierre ${dateTimeLabel(p.submission_deadline)}`;});
    await check("Actividad / último login", async()=>{const p=await query(state.supabase.from("profiles").select("last_login_at,last_seen_at,login_count").eq("id",state.profile.id).single());return `${p.login_count||0} ingresos · ${relativeTime(p.last_seen_at)}`;});
    await check("Comunicados", async()=>{const rows=await query(state.supabase.from("my_visible_announcements").select("id").limit(1));return `${rows.length} aviso(s) visible(s) en la muestra`;});
    await check("Edge Function", async()=>{const health=await invokeAdminFunction({action:"health"});return `${health.function||"bright-processor"} · v${health.version||"?"}`;});
    box.innerHTML=results.map(r=>`<div class="alert ${r.ok?"alert-success":"alert-danger"}" style="margin-bottom:8px"><div>${r.ok?"✓":"✕"}</div><div><strong>${esc(r.name)}</strong><p>${esc(r.detail||"Correcto")}</p></div></div>`).join("");
    button.disabled=false;button.innerHTML=`${uiIcon("activity",15)} Revisar sistema`;
  }

  function errorMessage(error) {
    const msg = error?.message || String(error || "Error inesperado");
    if (/announcements|announcement_receipts|my_visible_announcements|announcement_admin_summary|period_report_snapshots|last_login_at|last_seen_at|login_count|record_my_login|touch_my_presence|rollover_periods_if_due|freeze_period_metrics|admin_close_active_period|admin_reopen_period/i.test(msg)) return "Falta ejecutar el SQL 18_clipcontrol_v2_1_pro.sql en Supabase.";
    if (/weekly_report_platform_summary|reporting_periods|platform_payment_rules|update_my_profile_v20|admin_set_active_period|admin_save_platform_payment_rule/i.test(msg)) return "Falta ejecutar el SQL 16_clipcontrol_v2_control_center.sql en Supabase.";
    if (/duplicate key|videos_unique_active_url/i.test(msg)) return "Ese enlace de video ya fue registrado.";
    if (/videos_unique_active_position/i.test(msg)) return "Ya existe un video en esa posición.";
    if (/Invalid login credentials/i.test(msg)) return "Usuario o contraseña incorrectos.";
    if (/Email not confirmed/i.test(msg)) return "La cuenta todavía no está confirmada en Supabase.";
    if (/save_video_batch|Could not find the function/i.test(msg)) return "Falta ejecutar las actualizaciones SQL de ClipControl.";
    if (/row-level security|permission denied/i.test(msg)) return "Supabase bloqueó la operación por permisos. Verifica SQL 16 y SQL 18, y vuelve a iniciar sesión.";
    if (/El reporte está cerrado|plazo de envío terminó/i.test(msg)) return "El reporte ya está cerrado. Administración debe habilitar la edición fuera de plazo.";
    return msg;
  }


  function videosTable(videos, accounts, admin = false, editable = false) {
    const accountMap = Object.fromEntries((accounts || []).map((a) => [a.id, a]));
    if (!videos.length) return `<div class="empty">Todavía no hay videos registrados.</div>`;
    return `<div class="table-wrap compact-table video-table"><table><thead><tr><th>N.°</th><th>Red / Cuenta</th><th>Video</th><th>Vistas</th><th>Interacciones</th><th>Estado</th>${admin ? "<th>Fecha</th>" : ""}<th></th></tr></thead><tbody>${videos.map((video) => {
      const account = accountMap[video.account_id] || {};
      const canManage = admin || editable;
      const syncButton = admin ? `<button class="btn btn-secondary btn-sm" data-sync-video="${video.id}" title="Volver a detectar métricas">↻</button>` : "";
      const actions = `<div class="actions table-actions">${syncButton}${canManage ? `<button class="btn btn-ghost btn-sm" data-edit-video="${video.id}">Editar</button><button class="btn btn-danger btn-sm" data-delete-video="${video.id}">Anular</button>` : ""}</div>`;
      const fallbackThumbLegacy = `<span class="video-thumb" style="display:grid;place-items:center">${platformLogo(video.platform)}</span>`;
      const thumb = video.thumbnail_url ? `<span class="video-thumb-stack">${fallbackThumbLegacy}<img class="video-thumb" src="${esc(video.thumbnail_url)}" alt="" loading="lazy" onerror="this.remove()"></span>` : fallbackThumbLegacy;
      const viewsValue = Number(video.views || 0) > 0 ? num(video.views) : '<span class="muted">Pendiente</span>';
      return `<tr><td><b>${video.position}</b></td><td>${platformBadge(video.platform,true)}<br><small class="muted">${esc(account.account_name || "—")}</small></td><td><div style="display:flex;align-items:center;gap:8px">${thumb}<div><a href="${esc(video.video_url)}" target="_blank" rel="noopener">Abrir video ↗</a>${video.external_title ? `<small class="muted" style="display:block;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(video.external_title)}</small>` : ""}</div></div></td><td><b>${viewsValue}</b></td><td><b>❤ ${num(video.likes || 0)}</b><br><small class="muted">💬 ${num(video.comments || 0)} · ↗ ${num(video.shares || 0)}</small></td><td>${metricStatus(video)}<br><small class="muted">${dateTimeLabel(video.metrics_checked_at)}</small></td>${admin ? `<td>${dateTimeLabel(video.created_at)}</td>` : ""}<td>${actions}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  }



  /* ===================================================================
     CLIPCONTROL 2.2 LIVE · REALTIME UI / PROFESSIONAL NAV / COMPACT UX
     =================================================================== */

  function uiIcon(name, size = 18) {
    const paths = {
      home: '<path d="M3 10.8 12 3l9 7.8v9.2a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
      video: '<path d="M4 6.5h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Zm12 4 5-3v9l-5-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
      plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
      history: '<path d="M4 5v5h5M4.7 9.5a8 8 0 1 1-.2 5M12 8v4l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
      user: '<path d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
      users: '<path d="M16 21v-1a6 6 0 0 0-6-6H6a6 6 0 0 0-6 6v1M8 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM17 3.2a4 4 0 0 1 0 7.6M24 21v-1a6 6 0 0 0-4.5-5.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
      report: '<path d="M7 3h8l4 4v14H7V3Zm8 0v5h4M10 12h6M10 16h6M10 8h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
      wallet: '<path d="M3 7a3 3 0 0 1 3-3h12v4M3 7h17a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H6a3 3 0 0 1-3-3V7Zm14 6h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
      megaphone: '<path d="m4 13 2 6h3l-1.5-5M5 9v5h3l9 4V5L8 9H5Zm12 1a3 3 0 0 1 0 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
      settings: '<path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm7.2-3.2a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.5 1a8 8 0 0 0-1.7-1L14.5 3h-5l-.4 3a8 8 0 0 0-1.7 1L5 6 3 9.4 5 11a7 7 0 0 0 0 2l-2 1.6L5 18l2.4-1a8 8 0 0 0 1.7 1l.4 3h5l.4-3a8 8 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6a7 7 0 0 0 .2-1Z" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round"/>',
      network: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 12h18M12 3c2.5 2.5 3.7 5.5 3.7 9S14.5 18.5 12 21M12 3C9.5 5.5 8.3 8.5 8.3 12S9.5 18.5 12 21" fill="none" stroke="currentColor" stroke-width="1.6"/>',
      arrow: '<path d="M5 12h14M14 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
      eye: '<path d="M2.7 12s3.4-6 9.3-6 9.3 6 9.3 6-3.4 6-9.3 6-9.3-6-9.3-6Z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.7" fill="none" stroke="currentColor" stroke-width="1.7"/>',
      heart: '<path d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1-1.1a5.5 5.5 0 1 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
      alert: '<path d="M12 3 2.7 20h18.6L12 3Zm0 6v5M12 17.5v.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
      activity: '<path d="M3 12h4l2-6 4 12 2-6h6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
      check: '<path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      shield: '<path d="M12 3 4.5 6v5.4c0 4.5 3 7.6 7.5 9.6 4.5-2 7.5-5.1 7.5-9.6V6L12 3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
      sync: '<path d="M20 7v5h-5M4 17v-5h5M6.1 8.2A7 7 0 0 1 18 7l2 5M18 15.8A7 7 0 0 1 6 17l-2-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
      logout: '<path d="M10 17l5-5-5-5M15 12H3M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
    };
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${paths[name] || paths.activity}</svg>`;
  }

  function navIcon(name) { return `<span class="nav-icon">${uiIcon(name)}</span>`; }

  function announcementIcon(kind) {
    const icon = ({ urgent:"alert", important:"alert", payment:"wallet", period:"history", admin:"shield", info:"megaphone" })[kind] || "megaphone";
    return `<span class="announcement-type-icon">${uiIcon(icon,15)}</span>`;
  }

  function setLiveStatus(mode = "connected", text = "En vivo") {
    const el = $("#liveStatus");
    if (!el) return;
    el.classList.remove("connected","syncing","error");
    el.classList.add(mode);
    const label = el.querySelector("span");
    if (label) label.textContent = text;
  }

  function showApp() {
    setAuthenticatedShell(true);
    const p = state.profile;
    $("#sideRole").textContent = p.role === "clipper" ? "Portal del clipero" : "Administración";
    $("#miniName").textContent = p.names || p.username;
    $("#miniRole").textContent = p.role === "superadmin" ? "Superadministrador" : p.role === "admin" ? "Administrador" : "Clipero";
    $("#miniAvatar").innerHTML = uiIcon(p.role === "clipper" ? "user" : "shield",18);
    buildNav();
  }

  function bindStaticEvents() {
    applySavedTheme();
    $("#showPass")?.addEventListener("click",()=>{const input=$("#loginPass");if(input)input.type=input.type==="password"?"text":"password";});
    $("#loginForm")?.addEventListener("submit",login);
    $("#logoutBtn")?.addEventListener("click",logout);
    $("#menuBtn")?.addEventListener("click",()=>$("#sidebar")?.classList.toggle("open"));
    $("#themeBtn")?.addEventListener("click",toggleTheme);
    $("#noticeBtn")?.addEventListener("click",openNoticeInbox);
    document.addEventListener("visibilitychange",()=>{
      if(document.visibilityState==="visible"){
        touchPresence(true);
        const interval=Math.max(Number(state.settings?.metrics_live_interval_minutes||15),5)*60000;
        if(!state.lastLiveMetricAttempt||Date.now()-state.lastLiveMetricAttempt>=interval) runLiveMetricSync(true);
      }
    });
    window.addEventListener("keydown",event=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"&&["admin","superadmin"].includes(state.profile?.role)){event.preventDefault();openCommandCenter();}
    });
    window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change",()=>{if((localStorage.getItem("clipcontrol_theme_v21")||state.settings?.default_theme||"system")==="system")applyThemeMode("system");});
  }

  function buildNav() {
    if(!state.profile)return;
    const admin=["admin","superadmin"].includes(state.profile.role);
    const desktop=admin
      ? [["dashboard","home","Inicio"],["clippers","users","Accesos"],["reports","report","Reportes"],["payments","wallet","Pagos"],["announcements","megaphone","Comunicados"],["settings","settings","Ajustes"]]
      : [["dashboard","home","Inicio"],["videos","video","Videos"],["networks","network","Redes"],["history","history","Historial"],["profile","user","Perfil"]];
    const nav=$("#nav");
    if(nav){
      nav.innerHTML=desktop.map(([id,icon,label])=>`<button data-page="${id}" class="${state.page===id?"active":""}">${navIcon(icon)}<span>${label}</span></button>`).join("");
      $$('[data-page]',nav).forEach(b=>b.addEventListener("click",async()=>{state.page=b.dataset.page;state.selectedClipperId=null;$("#sidebar")?.classList.remove("open");buildNav();await touchPresence(true);await renderPage(true);}));
    }
    const mobile=admin
      ? [["dashboard","home","Inicio"],["clippers","users","Accesos"],["reports","report","Reportes"],["payments","wallet","Pagos"],["settings","settings","Más"]]
      : [["dashboard","home","Inicio"],["videos","video","Videos"],["__add","plus","Agregar"],["history","history","Historial"],["profile","user","Perfil"]];
    const m=$("#mobileNav");
    if(m){
      m.innerHTML=mobile.map(([id,icon,label])=>`<button data-mobile-page="${id}" aria-label="${esc(label)}" class="${state.page===id?"active":""} ${id==="__add"?"mobile-add":""}">${navIcon(icon)}${id==="__add"?"":`<span>${label}</span>`}</button>`).join("");
      $$('[data-mobile-page]',m).forEach(b=>b.addEventListener("click",async()=>{if(b.dataset.mobilePage==="__add")return handleQuickRegisterAction();state.page=b.dataset.mobilePage;state.selectedClipperId=null;buildNav();await touchPresence(true);await renderPage(true);}));
    }
  }

  async function loadClipperCurrentData() {
    const [accounts,settings]=await Promise.all([
      query(state.supabase.from("social_accounts").select("*").eq("user_id",state.profile.id).order("created_at")),
      query(state.supabase.from("app_settings").select("*").eq("id",1).single()),
    ]);
    state.accounts=accounts;state.settings=settings;
    const reportId=await query(state.supabase.rpc("ensure_weekly_report",{p_week_start:null}));
    state.currentReportId=reportId;
    const [summary,videos,observations,platformSummary]=await Promise.all([
      query(state.supabase.from("weekly_report_summary").select("*").eq("report_id",reportId).single()),
      query(state.supabase.from("videos").select("*").eq("report_id",reportId).is("deleted_at",null).order("position")),
      query(state.supabase.from("report_observations").select("*").eq("report_id",reportId).order("created_at",{ascending:false})),
      query(state.supabase.from("weekly_report_platform_summary").select("*").eq("report_id",reportId).order("platform")),
    ]);
    state.currentSummary=summary;state.videos=videos;state.observations=observations;state.platformSummary=platformSummary||[];
  }

  function livePlatformCards(rows = [], options = {}) {
    const rowMap=Object.fromEntries((rows||[]).map(r=>[r.platform,r]));
    return `<div class="live-platform-grid">${Object.keys(PLATFORMS).map(platform=>{
      const row=rowMap[platform]||{platform,video_count:0,views:0,likes:0,comments:0,shares:0,calculated_pay:0,pay_enabled:false};
      const extra=options.adminCounts?.[platform];
      const click=options.clickable?`type="button" data-live-platform="${platform}"`:"";
      const footLeft=extra!==undefined?`${extra} clipero${extra===1?"":"s"}`:`${Number(row.video_count||0)} video${Number(row.video_count||0)===1?"":"s"}`;
      const footRight=row.pay_enabled?money(row.calculated_pay||0):`${num(row.likes||0)} likes`;
      const periodKey=state.currentReportId||state.adminWeek||state.activePeriod?.id||"current";
      const countKey=`platform:${state.profile?.id||"anon"}:${periodKey}:${platform}:views`;
      return `<${options.clickable?"button":"article"} ${click} class="live-platform-card ${platform}">${platformBadge(platform,true)}<strong data-count="${Number(row.views||0)}" data-count-key="${esc(countKey)}">${num(row.views||0)}</strong><small>Vistas</small><div class="live-platform-card-foot"><span>${esc(footLeft)}</span><b>${esc(footRight)}</b></div></${options.clickable?"button":"article"}>`;
    }).join("")}</div>`;
  }

  function recentVideoCards(videos = []) {
    if(!videos.length)return `<div class="empty">Aún no registraste videos en este período.</div>`;
    return `<div class="live-recent-videos">${videos.slice(0,6).map(v=>`<a class="live-video-card" href="${esc(v.video_url)}" target="_blank" rel="noopener"><span class="live-video-platform">${platformLogo(v.platform)}</span><span class="live-video-copy"><strong>${esc(v.external_title||platformLabel(v.platform))}</strong><small>${v.metrics_status==="ok"?'<i class="metric-live-dot"></i>Actualizado':esc(v.metrics_status==="syncing"?"Sincronizando":"Pendiente")}</small></span><span class="live-video-metric"><b>${num(v.views||0)}</b><small>vistas</small></span></a>`).join("")}</div>`;
  }

  function renderClipperDashboard() {
    setHeader("Inicio","Métricas en vivo");
    const s=state.currentSummary,rows=state.platformSummary||[];
    const paid=rows.find(r=>r.pay_enabled)||rows.find(r=>r.platform==="tiktok")||{platform:"tiktok",views:0,target_views:250000,calculated_pay:0,max_base_pay:300,video_count:0};
    const target=Math.max(Number(paid.target_views||0),1),views=Number(paid.views||0),progress=clamp(views/target*100,0,100);
    const editable=reportEditable(s),deadlinePassed=s?.submission_deadline&&Date.now()>new Date(s.submission_deadline).getTime();
    $("#content").innerHTML=`
      <section class="live-hero"><div class="live-hero-main"><span class="live-hero-kicker"><i></i> PERÍODO ACTIVO</span><h2>Hola, ${esc(state.profile.names||state.profile.username)}</h2><p>${periodRangeLabel(s)}</p><div class="live-hero-meta"><span>Cierre <b>${dateTimeLabel(s.submission_deadline)}</b></span><span><b>${s.video_count||0}</b> videos</span><span>${deadlinePassed?"Cerrando":"Abierto"}</span></div></div><div class="live-hero-value"><small>Pago estimado</small><strong>${money(s.calculated_base_pay||0)}</strong><span>En vivo</span></div></section>
      <section class="live-paid-card"><div><span class="paid-card-label">${platformLogo(paid.platform)} ${esc(platformLabel(paid.platform))} · REMUNERADO</span><div class="paid-card-title"><span data-count="${views}" data-count-key="${esc(`paid:${state.profile?.id||"anon"}:${state.currentReportId||"current"}:${paid.platform}:views`)}">${num(views)}</span> vistas</div><div class="paid-card-sub">Meta ${num(target)} · ${Math.round(progress)}%</div><div class="paid-progress"><span style="width:${progress}%"></span></div></div><div class="paid-side"><small>Pago actual</small><strong>${money(paid.calculated_pay||0)}</strong><span>Máximo ${money(paid.max_base_pay||0)}</span></div></section>
      ${livePlatformCards(rows)}
      <div class="clipper-quick-actions"><div class="primary-action-panel"><div><h3>Registrar videos</h3><p>Pega uno o varios enlaces. Las métricas se detectan solas.</p></div><button id="quickAddBtn" class="btn btn-primary" ${!editable?"disabled":""}>${uiIcon("plus")} Agregar videos</button></div><div class="submit-mini-panel"><div><small>Reporte</small><strong>${STATUS_LABELS[s.status]}</strong></div><button id="submitReportBtn" class="btn btn-secondary" ${!editable||s.can_submit===false||Number(s.video_count||0)<1?"disabled":""}>${uiIcon("check")} ${s.submitted_at?"Actualizar":"Enviar"}</button></div></div>
      <section class="card compact-card" style="margin-top:12px"><div class="card-head"><div><h2>Videos recientes</h2><p>Actualización automática</p></div><button id="viewVideosBtn" class="btn btn-ghost btn-sm">Ver todos ${uiIcon("arrow",14)}</button></div>${recentVideoCards(state.videos)}</section>`;
    $("#quickAddBtn")?.addEventListener("click",handleQuickRegisterAction);$("#submitReportBtn")?.addEventListener("click",submitCurrentReport);$("#viewVideosBtn")?.addEventListener("click",()=>{state.videoFilterPlatform="all";navigate("videos");});
    animateDynamicNumbers($("#content"));
  }

  function rankingRowsV22(platform, rows, users) {
    const names=Object.fromEntries(users.map(u=>[u.user_id,u]));
    const ranked=(rows||[]).filter(r=>r.platform===platform).sort((a,b)=>Number(b.views||0)-Number(a.views||0)).slice(0,10);
    const max=Math.max(...ranked.map(r=>Number(r.views||0)),1);
    if(!ranked.length)return '<div class="empty">Sin datos todavía.</div>';
    return `<div class="ranking-list-v22">${ranked.map((r,i)=>{const u=names[r.user_id]||{};const name=u.names?`${u.names} ${u.surnames||""}`.trim():u.username||"Clipero";return `<div class="ranking-row-v22"><span class="ranking-pos-v22">${i+1}</span><div class="ranking-person-v22"><strong>${esc(name)}</strong><small>@${esc(u.username||"")} · ${r.video_count||0} videos</small><div class="rank-bar-v22"><span style="width:${Number(r.views||0)/max*100}%"></span></div></div><div class="ranking-value-v22"><b>${num(r.views||0)}</b><small>vistas</small></div></div>`;}).join("")}</div>`;
  }

  async function renderAdminDashboard() {
    setHeader("Inicio","Control en vivo");
    const activeStart=state.activePeriod?.start_date;
    const [users,reports,socialAccounts]=await Promise.all([
      query(state.supabase.from("admin_clipper_overview").select("*").order("username")),
      activeStart?query(state.supabase.from("weekly_report_summary").select("*").eq("week_start",activeStart).order("total_views",{ascending:false})):Promise.resolve([]),
      query(state.supabase.from("social_accounts").select("id,user_id,platform,account_name,channel_url,active").eq("active",true)),
    ]);
    const clippers=users.filter(u=>u.role==="clipper"),active=clippers.filter(u=>u.active),reportIds=reports.map(r=>r.report_id);
    const [weekVideos,platformRows]=reportIds.length?await Promise.all([
      query(state.supabase.from("videos").select("id,report_id,user_id,platform,views,likes,comments,shares,metrics_status").in("report_id",reportIds).is("deleted_at",null)),
      query(state.supabase.from("weekly_report_platform_summary").select("*").in("report_id",reportIds)),
    ]):[[],[]];
    const aggregate=aggregatePlatformRows(platformRows),projected=reports.reduce((a,r)=>a+Number(r.total_pay??r.approved_base_pay??r.calculated_base_pay??0),0),pending=reports.filter(r=>["sent","review","observed"].includes(r.status)).length,missingPay=active.filter(c=>!c.payment_account||c.payment_required).length,errors=weekVideos.filter(v=>v.metrics_status==="error").length;
    const platformCounts=Object.fromEntries(Object.keys(PLATFORMS).map(p=>[p,new Set(socialAccounts.filter(a=>a.platform===p).map(a=>a.user_id)).size]));
    const selected=state.rankingPlatform||"tiktok";
    $("#content").innerHTML=`
      <section class="live-hero"><div class="live-hero-main"><span class="live-hero-kicker"><i></i> EN VIVO</span><h2>${esc(state.activePeriod?.name||"Período activo")}</h2><p>${state.activePeriod?periodRangeLabel(state.activePeriod):"Configura un período"}</p><div class="live-hero-meta"><span>Cierre <b>${dateTimeLabel(state.activePeriod?.submission_deadline)}</b></span><span><b>${active.length}</b> cliperos</span><span><b>${reports.length}</b> reportes</span></div></div><div class="live-hero-value"><small>Pago proyectado</small><strong>${money(projected)}</strong><span>${weekVideos.length} videos</span></div></section>
      ${livePlatformCards(aggregate,{clickable:true,adminCounts:platformCounts})}
      <div class="live-attention"><button class="live-attention-card" data-attention="reports"><span class="live-attention-icon">${uiIcon("report")}</span><span class="live-attention-copy"><b>${pending}</b><span>Reportes por revisar</span></span><span class="live-attention-arrow">${uiIcon("arrow")}</span></button><button class="live-attention-card" data-attention="payments"><span class="live-attention-icon">${uiIcon("wallet")}</span><span class="live-attention-copy"><b>${missingPay}</b><span>Datos de pago pendientes</span></span><span class="live-attention-arrow">${uiIcon("arrow")}</span></button><button class="live-attention-card" data-attention="metrics"><span class="live-attention-icon">${uiIcon("activity")}</span><span class="live-attention-copy"><b>${errors}</b><span>Métricas por revisar</span></span><span class="live-attention-arrow">${uiIcon("arrow")}</span></button></div>
      <section class="card compact-card live-ranking-card"><div class="live-ranking-head"><div><h2>Ranking de cliperos</h2><p>Se actualiza cuando llegan nuevas métricas.</p></div><div class="live-tabs">${Object.keys(PLATFORMS).map(p=>`<button class="live-tab ${selected===p?"active":""}" data-rank-platform="${p}">${platformLogo(p)}<span>${esc(platformLabel(p))}</span></button>`).join("")}</div></div><div id="rankingList">${rankingRowsV22(selected,platformRows,clippers)}</div></section>`;
    $$('[data-rank-platform]').forEach(b=>b.addEventListener("click",()=>{state.rankingPlatform=b.dataset.rankPlatform;$$('[data-rank-platform]').forEach(x=>x.classList.toggle("active",x===b));$("#rankingList").innerHTML=rankingRowsV22(state.rankingPlatform,platformRows,clippers);}));
    $$('[data-live-platform]').forEach(b=>b.addEventListener("click",()=>openTeamPlatformModal(b.dataset.livePlatform,socialAccounts,clippers)));
    $$('[data-attention]').forEach(b=>b.addEventListener("click",()=>{const a=b.dataset.attention;if(a==="reports")navigate("reports");else if(a==="payments")navigate("payments");else{state.videoFilterPlatform="all";navigate("reports");}}));
    animateDynamicNumbers($("#content"));
  }

  function adminReportsTable(reports) {
    if(!reports.length)return '<div class="empty">Todavía no existen reportes en este período.</div>';
    const rows=reports.map(r=>{const progress=clamp((Number(r.total_views||0)/Number(r.target_views||1))*100,0,100);return `<tr><td><div class="report-person"><strong>${esc(r.names||r.username)} ${esc(r.surnames||"")}</strong><small>@${esc(r.username)}</small></div></td><td><b>${r.video_count}</b><br><small>${r.account_count} cuentas</small></td><td><div class="report-metric-main">${uiIcon("eye",13)}<b>${num(r.total_views)}</b></div><div class="report-like-line">${uiIcon("heart",11)} ${num(r.total_likes||0)}</div></td><td><div class="mini-cell-progress"><span>${Math.round(progress)}%</span><div class="progress"><span style="width:${progress}%"></span></div></div></td><td><b>${money(r.total_pay??r.approved_base_pay??r.calculated_base_pay)}</b></td><td><span class="status ${statusClass(r.status)}">${STATUS_LABELS[r.status]}</span></td><td><button class="btn btn-secondary btn-sm report-action-btn" data-admin-report="${r.report_id}">${uiIcon("arrow",14)} Evaluar</button></td></tr>`;}).join("");
    const cards=reports.map(r=>{const progress=clamp((Number(r.total_views||0)/Number(r.target_views||1))*100,0,100);return `<button class="mobile-admin-card" data-admin-report="${r.report_id}"><div class="mobile-admin-card-head"><div><strong>${esc(r.names||r.username)} ${esc(r.surnames||"")}</strong><small>@${esc(r.username)}</small></div><span class="status ${statusClass(r.status)}">${STATUS_LABELS[r.status]}</span></div><div class="mobile-admin-metrics"><span><small>Videos</small><b>${r.video_count}</b></span><span><small>Vistas</small><b>${num(r.total_views)}</b></span><span><small>Likes</small><b>${num(r.total_likes||0)}</b></span><span><small>Pago</small><b>${money(r.total_pay??r.approved_base_pay??r.calculated_base_pay)}</b></span></div><div class="progress"><span style="width:${progress}%"></span></div></button>`;}).join("");
    return `<div class="desktop-report-table"><table><thead><tr><th>Clipero</th><th>Videos</th><th>Métricas</th><th>Avance</th><th>Pago</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="mobile-report-cards">${cards}</div>`;
  }

  function stopLiveRealtime() {
    if(state.liveChannel&&state.supabase){try{state.supabase.removeChannel(state.liveChannel);}catch(_){}}
    state.liveChannel=null;
    if(state.liveMetricTimer)clearInterval(state.liveMetricTimer);
    if(state.liveRefreshTimer)clearTimeout(state.liveRefreshTimer);
    state.liveMetricTimer=null;state.liveRefreshTimer=null;
  }

  function metricTuple(row = {}) {
    return {
      views: Math.max(0, Number(row.views || 0)),
      likes: Math.max(0, Number(row.likes || 0)),
      comments: Math.max(0, Number(row.comments || 0)),
      shares: Math.max(0, Number(row.shares || 0)),
    };
  }

  function hasMetricIncrease(previous, next) {
    if (!previous) return false;
    return next.views > previous.views || next.likes > previous.likes || next.comments > previous.comments || next.shares > previous.shares;
  }

  async function seedLiveMetricCache() {
    state.liveVideoMetricCache = new Map();
    try {
      if (!state.profile) return;
      const isAdmin = ["admin", "superadmin"].includes(state.profile.role);
      if (!isAdmin) {
        for (const video of state.videos || []) state.liveVideoMetricCache.set(video.id, metricTuple(video));
        state.liveMetricCacheReady = true;
        return;
      }

      let reportIds = Array.isArray(state.adminReportIds) ? state.adminReportIds.filter(Boolean) : [];
      if (!reportIds.length && state.adminWeek) {
        const rows = await query(state.supabase.from("weekly_reports").select("id").eq("week_start", state.adminWeek));
        reportIds = (rows || []).map(r => r.id);
      }
      if (!reportIds.length) { state.liveMetricCacheReady = true; return; }

      let from = 0;
      const pageSize = 750;
      while (true) {
        const { data, error } = await state.supabase.from("videos")
          .select("id,views,likes,comments,shares")
          .in("report_id", reportIds)
          .is("deleted_at", null)
          .range(from, from + pageSize - 1);
        if (error) throw error;
        for (const video of data || []) state.liveVideoMetricCache.set(video.id, metricTuple(video));
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
      state.liveMetricCacheReady = true;
    } catch (error) {
      console.warn("No se pudo preparar el cache LIVE", error);
      state.liveMetricCacheReady = true;
    }
  }

  function shouldRefreshVideoPayload(payload) {
    const type = String(payload?.eventType || "").toUpperCase();
    if (type === "INSERT" || type === "DELETE") return true;
    if (type !== "UPDATE") return false;
    const row = payload?.new || {};
    if (!row.id) return false;
    const next = metricTuple(row);
    const previous = state.liveVideoMetricCache.get(row.id);
    state.liveVideoMetricCache.set(row.id, previous ? {
      views: Math.max(previous.views, next.views),
      likes: Math.max(previous.likes, next.likes),
      comments: Math.max(previous.comments, next.comments),
      shares: Math.max(previous.shares, next.shares),
    } : next);

    // Los cambios syncing/error/checked_at/next_check_at no redibujan la pantalla.
    // Solo una subida real de una métrica provoca actualización visual.
    return hasMetricIncrease(previous, next);
  }

  function shouldRefreshReportPayload(payload) {
    const type = String(payload?.eventType || "").toUpperCase();
    if (type === "INSERT" || type === "DELETE") return true;
    if (type !== "UPDATE") return false;
    const row = payload?.new || {};
    if (!row.id) return false;
    const nextStatus = String(row.status || "");
    const previousStatus = state.liveReportStatusCache.get(row.id);
    state.liveReportStatusCache.set(row.id, nextStatus);
    return previousStatus !== undefined && nextStatus !== previousStatus;
  }

  function queueLiveRefresh(table="videos", payload=null) {
    if (table === "videos" && payload && !shouldRefreshVideoPayload(payload)) return;
    if (table === "weekly_reports" && payload && !shouldRefreshReportPayload(payload)) return;

    state.liveDirtyTables=state.liveDirtyTables||new Set();state.liveDirtyTables.add(table);
    if(state.liveRefreshTimer)clearTimeout(state.liveRefreshTimer);
    state.liveRefreshTimer=setTimeout(async()=>{
      if(!state.profile||document.visibilityState!=="visible")return;
      if($("#modalLayer")?.querySelector(".modal")){state.liveDeferred=true;return;}
      try{
        if(state.profile.role==="clipper"&&["dashboard","videos"].includes(state.page)){
          await loadClipperCurrentData();
          state.page==="dashboard"?renderClipperDashboard():renderClipperVideos();
          await seedLiveMetricCache();
        }else if(["admin","superadmin"].includes(state.profile.role)&&(state.page==="dashboard"||state.page==="reports")){
          await loadGlobalContext();
          await renderAdminReports();
          await seedLiveMetricCache();
        }
        if(table==="announcements")await refreshAnnouncementBadge();
      }catch(error){console.warn("Realtime refresh omitido",error);}
      finally{state.liveDirtyTables?.clear();}
    },900);
  }

  async function startLiveRealtime() {
    if(!state.supabase||!state.profile)return;
    if(state.liveChannel){try{state.supabase.removeChannel(state.liveChannel);}catch(_){}}
    await seedLiveMetricCache();
    const isAdmin=["admin","superadmin"].includes(state.profile.role);
    let channel=state.supabase.channel(`clipcontrol-live-${state.profile.id}-${Date.now()}`);
    const videoCfg={event:"*",schema:"public",table:"videos"};if(!isAdmin)videoCfg.filter=`user_id=eq.${state.profile.id}`;
    const reportCfg={event:"*",schema:"public",table:"weekly_reports"};if(!isAdmin)reportCfg.filter=`user_id=eq.${state.profile.id}`;
    channel=channel.on("postgres_changes",videoCfg,(payload)=>queueLiveRefresh("videos",payload))
      .on("postgres_changes",reportCfg,(payload)=>queueLiveRefresh("weekly_reports",payload))
      .on("postgres_changes",{event:"*",schema:"public",table:"announcements"},(payload)=>queueLiveRefresh("announcements",payload))
      .on("postgres_changes",{event:"*",schema:"public",table:"reporting_periods"},(payload)=>queueLiveRefresh("reporting_periods",payload));
    state.liveChannel=channel.subscribe(status=>{
      if(status==="SUBSCRIBED")setLiveStatus("connected","En vivo");
      else if(status==="CHANNEL_ERROR"||status==="TIMED_OUT")setLiveStatus("error","Reconectando");
      else setLiveStatus("syncing","Conectando");
    });
  }

  async function runLiveMetricSync(silent=true) {
    if(!state.profile||state.liveMetricBusy||document.visibilityState!=="visible")return;
    if(state.settings?.metrics_live_enabled===false)return;
    state.liveMetricBusy=true;state.lastLiveMetricAttempt=Date.now();if(!silent)setLiveStatus("syncing","Actualizando");
    try{
      const isAdmin=["admin","superadmin"].includes(state.profile.role);const limit=Math.max(1,Math.min(Number(state.settings?.metrics_live_batch_size||60),100));
      await invokeProcessor({action:isAdmin?"sync_due_metrics":"sync_my_due_metrics",limit});
      if(!silent)setLiveStatus("connected","En vivo");
    }catch(error){console.warn("Sincronización LIVE omitida:",error);if(!silent)setLiveStatus("connected","En vivo");}
    finally{state.liveMetricBusy=false;}
  }

  function startLiveMetricsEngine() {
    if(state.liveMetricTimer)clearInterval(state.liveMetricTimer);
    const minutes=Math.max(Number(state.settings?.metrics_live_interval_minutes||15),5);
    setTimeout(()=>runLiveMetricSync(true),2500);
    state.liveMetricTimer=setInterval(()=>runLiveMetricSync(true),minutes*60*1000);
  }

  async function loadSignedUser(recordLogin=false) {
    showLoading(true);
    try{
      const userId=state.session?.user?.id;
      state.profile=await query(state.supabase.from("profiles").select("*").eq("id",userId).single());
      if(!state.profile.active){await state.supabase.auth.signOut();throw new Error("Tu cuenta está desactivada. Comunícate con administración.");}
      if(recordLogin){try{const updated=await query(state.supabase.rpc("record_my_login"));if(updated?.id)state.profile=updated;}catch(error){console.warn("No se pudo registrar último login",error);}}
      showApp();state.page="dashboard";await renderPage(true);startPresenceHeartbeat();startLiveRealtime();startLiveMetricsEngine();
      if(state.profile.role==="clipper"&&!profileComplete(state.profile))openProfileModal(true);else await showMandatoryAnnouncements();
    }catch(error){toast(errorMessage(error),"error");await state.supabase.auth.signOut();}
    finally{showLoading(false);}
  }

  async function logout() {
    stopLiveRealtime();stopPresenceHeartbeat();showLoading(true);
    try{await touchPresence(true);await state.supabase.auth.signOut();}
    finally{state.session=null;state.profile=null;state.currentReportId=null;showLogin();showLoading(false);setLiveStatus("syncing","Conectando");}
  }

  function metricSourceLabel(source = "") {
    const value = String(source || "").trim().toLowerCase();
    const map = {
      "public-youtube": "YouTube publico",
      "public-youtube-verified": "YouTube público verificado",
      "public-youtube-partial": "YouTube público parcial",
      "youtube-data-api-verified": "YouTube API oficial",
      "public-instagram": "Instagram publico",
      "public-instagram-verified": "Instagram público verificado",
      "public-instagram-partial": "Instagram público parcial",
      "tiktok-verified-compact": "TikTok verificado",
      "tiktok-partial-compact": "TikTok parcial",
      "tiktok-metadata-only": "TikTok basico",
      "facebook-apify": "Facebook externo (histórico)",
      "facebook-public-embed": "Facebook público",
      "facebook-public-html": "Facebook público",
      "facebook-public-limited": "Facebook público limitado",
      "facebook-public-v3": "Facebook público V3",
      "facebook-public-v3-partial": "Facebook parcial",
      "facebook-public-v3-limited": "Facebook público limitado",
      "facebook-public-v4": "Facebook público",
      "facebook-public-v4-limited": "Facebook público limitado",
      "facebook-public-relay-v6": "Facebook público JSON",
      "facebook-public-relay-v6-limited": "Facebook público limitado",
      "facebook-embed-partial-v7": "Facebook público parcial",
      "facebook-embed-only-v7": "Facebook embed oficial",
      "facebook-public-limited-v7": "Facebook público limitado",
    };
    return map[value] || (value ? value.replaceAll("-", " ") : "");
  }

  function metricAvailabilityLabel(video) {
    const meta = video?.metrics_meta && typeof video.metrics_meta === "object" ? video.metrics_meta : {};
    const availability = meta?.availability && typeof meta.availability === "object" ? meta.availability : {};
    const detected = [];
    if (availability.views === true) detected.push("vistas");
    if (availability.likes === true) detected.push("likes");
    if (availability.comments === true) detected.push("coment.");
    if (availability.shares === true) detected.push("comp.");
    const source = metricSourceLabel(video?.metrics_source);
    if (video?.metrics_error) return source ? `${source} · revisar` : "Revisar";
    if (source && detected.length) return `${source} · ${detected.join(" · ")}`;
    if (source) return source;
    return detected.length ? detected.join(" · ") : "";
  }




  function videosTable(videos, accounts, admin = false, editable = false) {
    const accountMap=Object.fromEntries((accounts||[]).map(a=>[a.id,a]));
    if(!videos.length)return '<div class="empty">Todavía no hay videos registrados.</div>';
    const rows=videos.map(video=>{
      const account=accountMap[video.account_id]||{},canManage=admin||editable;
      const syncButton=admin?`<button class="btn btn-secondary btn-sm btn-icon-only" data-sync-video="${video.id}" title="Sincronizar ahora" aria-label="Sincronizar ahora">${uiIcon("sync",14)}</button>`:"";
      const actions=`<div class="actions table-actions">${syncButton}${canManage?`<button class="btn btn-ghost btn-sm" data-edit-video="${video.id}">Editar</button><button class="btn btn-danger btn-sm" data-delete-video="${video.id}">Anular</button>`:""}</div>`;
      const fallbackThumb=`<span class="video-thumb" style="display:grid;place-items:center">${platformLogo(video.platform)}</span>`;
      const thumb=video.thumbnail_url
        ? `<span class="video-thumb-stack">${fallbackThumb}<img class="video-thumb" src="${esc(video.thumbnail_url)}" alt="" loading="lazy" onerror="this.remove()"></span>`
        : fallbackThumb;
      const availability = video?.metrics_meta && typeof video.metrics_meta === "object" ? (video.metrics_meta.availability || {}) : {};
      const fbHasOtherMetric = video.platform === "facebook" && availability.views === false
        && (availability.likes === true || availability.comments === true || availability.shares === true);
      const views=Number(video.views||0)>0?num(video.views):(fbHasOtherMetric?'<span class="muted" title="Facebook no expuso vistas">—</span>':'<span class="muted">Pendiente</span>');
      const metricHint = metricAvailabilityLabel(video);
      return `<tr><td><b>${video.position}</b></td><td>${platformBadge(video.platform,true)}<br><small>${esc(account.account_name||"—")}</small></td><td><div style="display:flex;align-items:center;gap:8px;min-width:0">${thumb}<div style="min-width:0"><a href="${esc(video.video_url)}" target="_blank" rel="noopener">Abrir video</a>${video.external_title?`<small class="muted" style="display:block;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(video.external_title)}</small>`:""}</div></div></td><td><div class="report-metric-main">${uiIcon("eye",13)}<b>${views}</b></div></td><td><div class="report-like-line">${uiIcon("heart",11)} ${num(video.likes||0)} likes</div><small>${num(video.comments||0)} comentarios · ${num(video.shares||0)} compartidos</small></td><td>${metricStatus(video)}<br><small>${dateTimeLabel(video.metrics_checked_at)}</small>${metricHint ? `<br><small class="muted">${esc(metricHint)}</small>` : ""}</td>${admin?`<td>${dateTimeLabel(video.created_at)}</td>`:""}<td>${actions}</td></tr>`;
    }).join("");
    return `<div class="table-wrap compact-table video-table"><table><thead><tr><th>N.°</th><th>Red / Cuenta</th><th>Video</th><th>Vistas</th><th>Interacciones</th><th>Estado</th>${admin?"<th>Fecha</th>":""}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function errorMessage(error) {
    const msg=error?.message||String(error||"Error inesperado");
    if(/metrics_live_enabled|metrics_live_interval_minutes|metrics_live_batch_size|realtime_ui_enabled|sync_my_due_metrics/i.test(msg))return "Falta instalar la actualización SQL/Edge Function de ClipControl 2.2 LIVE.";
    if(/announcements|announcement_receipts|my_visible_announcements|announcement_admin_summary|period_report_snapshots|last_login_at|last_seen_at|login_count|record_my_login|touch_my_presence|rollover_periods_if_due|freeze_period_metrics|admin_close_active_period|admin_reopen_period/i.test(msg))return "Falta ejecutar el SQL 18 de ClipControl 2.1 en Supabase.";
    if(/weekly_report_platform_summary|reporting_periods|platform_payment_rules|update_my_profile_v20|admin_set_active_period|admin_save_platform_payment_rule/i.test(msg))return "Falta ejecutar el SQL 16 de ClipControl 2.0 en Supabase.";
    if(/duplicate key|videos_unique_active_url/i.test(msg))return "Ese enlace de video ya fue registrado.";
    if(/videos_unique_active_position/i.test(msg))return "Ya existe un video en esa posición.";
    if(/Invalid login credentials/i.test(msg))return "Usuario o contraseña incorrectos.";
    if(/Email not confirmed/i.test(msg))return "La cuenta todavía no está confirmada en Supabase.";
    if(/save_video_batch|Could not find the function/i.test(msg))return "Falta ejecutar las actualizaciones SQL de ClipControl.";
    if(/row-level security|permission denied/i.test(msg))return "Supabase bloqueó la operación por permisos. Verifica las migraciones y vuelve a iniciar sesión.";
    if(/El reporte está cerrado|plazo de envío terminó/i.test(msg))return "El reporte ya está cerrado. Administración debe habilitar la edición fuera de plazo.";
    return msg;
  }



  /* ===================================================================
     CLIPCONTROL 2.2.6 · STABLE LIVE / SOLO SUBIDAS / SIN PARPADEO
     - El administrador ya no tiene un dashboard separado.
     - "Inicio" es directamente la evaluación de reportes del período.
     - Estados y acciones usan color semántico y mejor contraste.
     - En móvil, los reportes son tarjetas compactas sin scroll horizontal.
     =================================================================== */

  function statusClass(status) {
    if (status === "draft") return "st-draft";
    if (status === "sent") return "st-sent";
    if (status === "review") return "st-review";
    if (status === "observed") return "st-observed";
    if (status === "approved") return "st-approved";
    if (status === "pending_payment") return "st-pending";
    if (status === "paid") return "st-paid";
    if (status === "closed") return "st-closed";
    if (status === "expired") return "st-expired";
    return "st-draft";
  }

  function statusBadge(status) {
    const label = STATUS_LABELS[status] || status || "Estado";
    return `<span class="status status-v224 ${statusClass(status)}"><i></i>${esc(label)}</span>`;
  }

  function navigate(page) {
    const admin = ["admin","superadmin"].includes(state.profile?.role);
    state.page = admin && page === "reports" ? "dashboard" : page;
    buildNav();
    renderPage(true);
  }

  function buildNav() {
    if (!state.profile) return;
    const isAdmin = ["admin","superadmin"].includes(state.profile.role);
    if (isAdmin && state.page === "reports") state.page = "dashboard";

    const items = isAdmin
      ? [["dashboard","home","Inicio"],["clippers","users","Accesos"],["payments","wallet","Pagos"],["announcements","megaphone","Comunicados"],["settings","settings","Ajustes"]]
      : [["dashboard","home","Inicio"],["videos","video","Videos"],["networks","network","Redes"],["history","history","Historial"],["profile","user","Perfil"]];

    $("#nav").innerHTML = items.map(([id,icon,label]) =>
      `<button data-page="${id}" class="${state.page===id?"active":""}">${navIcon(icon)}<span class="nav-label">${label}</span></button>`
    ).join("");

    $$('[data-page]', $("#nav")).forEach(button => button.addEventListener("click", async () => {
      state.page = button.dataset.page;
      state.selectedClipperId = null;
      $("#sidebar").classList.remove("open");
      buildNav();
      await touchPresence(true);
      await renderPage(true);
    }));

    const mobile = isAdmin
      ? [["dashboard","home","Inicio"],["clippers","users","Accesos"],["payments","wallet","Pagos"],["announcements","megaphone","Avisos"],["settings","settings","Ajustes"]]
      : [["dashboard","home","Inicio"],["videos","video","Videos"],["__add","plus","Agregar"],["history","history","Historial"],["profile","user","Perfil"]];

    const nav = $("#mobileNav");
    if (nav) {
      nav.innerHTML = mobile.map(([id,icon,label]) =>
        `<button data-mobile-page="${id}" class="${state.page===id?"active":""} ${id==="__add"?"mobile-add":""}">${uiIcon(icon,18)}${id==="__add"?"":`<span>${label}</span>`}</button>`
      ).join("");
      $$('[data-mobile-page]', nav).forEach(button => button.addEventListener("click", async () => {
        if (button.dataset.mobilePage === "__add") return handleQuickRegisterAction();
        state.page = button.dataset.mobilePage;
        state.selectedClipperId = null;
        buildNav();
        await touchPresence(true);
        await renderPage(true);
      }));
    }
  }

  async function renderAdminPage() {
    if (state.page === "dashboard" || state.page === "reports") return renderAdminReports();
    if (state.page === "clippers") return state.selectedClipperId ? renderClipperAdminDetail() : renderAdminClippers();
    if (state.page === "payments") return renderAdminPayments();
    if (state.page === "announcements") return renderAdminAnnouncements();
    if (state.page === "settings") return renderAdminSettings();
    state.page = "dashboard";
    return renderAdminReports();
  }

  async function renderAdminDashboard() {
    return renderAdminReports();
  }

  async function renderAdminReports() {
    setHeader("Inicio", "Evaluación del período");
    const periods = await query(state.supabase.from("reporting_periods").select("*").order("start_date",{ascending:false}).limit(20));
    if (!state.adminWeek) state.adminWeek = state.activePeriod?.start_date || periods?.[0]?.start_date || currentWeekStartISO();
    const reports = await query(state.supabase.from("weekly_report_summary").select("*").eq("week_start",state.adminWeek).order("total_views",{ascending:false}));
    const ids = reports.map(r=>r.report_id);
    state.adminReportIds = ids;
    state.liveReportStatusCache = new Map(reports.map(r => [r.report_id, String(r.status || "")]));
    const platformRows = ids.length ? await query(state.supabase.from("weekly_report_platform_summary").select("*").in("report_id",ids)) : [];
    state.adminPlatformRows = platformRows;
    const aggregate = aggregatePlatformRows(platformRows);
    const pending = reports.filter(r=>["sent","review","observed"].includes(r.status)).length;
    const projected = reports.reduce((sum,r)=>sum+Number(r.total_pay??r.approved_base_pay??r.calculated_base_pay??0),0);
    const selectedPeriod = periods.find(p=>p.start_date===state.adminWeek);

    $("#content").innerHTML = `
      <section class="reports-home-v224">
        <div class="reports-home-top">
          <div>
            <span class="reports-kicker">PERÍODO</span>
            <h2>${esc(selectedPeriod?.name || periodRangeLabel(selectedPeriod) || state.adminWeek)}</h2>
            <p>${selectedPeriod?.is_active ? '<span class="period-live-dot"></span>Activo' : 'Histórico'} · ${reports.length} cliperos</p>
          </div>
          <div class="reports-home-actions">
            <label class="period-select-v224">${uiIcon("history",15)}<select id="reportPeriodSelect">${periods.map(p=>`<option value="${p.start_date}" ${p.start_date===state.adminWeek?"selected":""}>${esc(p.name||periodRangeLabel(p))}${p.is_active?" · ACTIVO":""}</option>`).join("")}</select></label>
            <button id="exportReportsBtn" class="btn btn-secondary btn-sm">${uiIcon("report",14)} Excel</button>
          </div>
        </div>
        ${livePlatformCards(aggregate)}
        <div class="report-mini-summary-v224">
          <div><span>Reportes</span><strong>${reports.length}</strong></div>
          <div><span>Por revisar</span><strong>${pending}</strong></div>
          <div><span>Pago proyectado</span><strong>${money(projected)}</strong></div>
          <div><span>Cierre</span><strong>${dateOnlyLabel(selectedPeriod?.end_date||reports[0]?.week_end)}</strong></div>
        </div>
      </section>
      <section class="card report-list-card-v224">
        <div class="report-list-head-v224"><div><h2>Evaluar cliperos</h2><p>Estado, avance y pago en una sola vista.</p></div><span class="report-live-note"><i></i> En vivo</span></div>
        ${adminReportsTable(reports)}
      </section>`;

    $("#reportPeriodSelect")?.addEventListener("change",e=>{state.adminWeek=e.target.value;renderAdminReports();});
    $("#exportReportsBtn")?.addEventListener("click",()=>exportWeeklyExcel(reports));
    bindAdminReportButtons();
    animateDynamicNumbers($("#content"));
  }

  function adminReportsTable(reports) {
    if (!reports.length) return '<div class="empty">Todavía no existen reportes en este período.</div>';
    const rows = reports.map(r => {
      const progress = clamp((Number(r.total_views||0)/Number(r.target_views||1))*100,0,100);
      const rowTone = `row-${statusClass(r.status)}`;
      return `<tr class="report-row-v224 ${rowTone}">
        <td><div class="report-person report-person-v224"><strong>${esc(r.names||r.username)} ${esc(r.surnames||"")}</strong><small>@${esc(r.username)}</small></div></td>
        <td><div class="report-number-v224"><b>${r.video_count}</b><small>${r.account_count} cuenta${Number(r.account_count)===1?"":"s"}</small></div></td>
        <td><div class="report-metric-main metric-main-v224">${uiIcon("eye",14)}<b>${num(r.total_views)}</b></div><div class="report-like-line metric-like-v224">${uiIcon("heart",12)} ${num(r.total_likes||0)}</div></td>
        <td><div class="mini-cell-progress progress-v224"><span>${Math.round(progress)}%</span><div class="progress"><span style="width:${progress}%"></span></div></div></td>
        <td><b class="report-pay-v224">${money(r.total_pay??r.approved_base_pay??r.calculated_base_pay)}</b></td>
        <td>${statusBadge(r.status)}</td>
        <td><button class="btn btn-sm report-evaluate-btn-v224" data-admin-report="${r.report_id}">${uiIcon("arrow",14)}<span>Evaluar</span></button></td>
      </tr>`;
    }).join("");

    const cards = reports.map(r => {
      const progress = clamp((Number(r.total_views||0)/Number(r.target_views||1))*100,0,100);
      return `<article class="mobile-report-card-v224 row-${statusClass(r.status)}">
        <div class="mobile-report-head-v224"><div class="report-person-v224"><strong>${esc(r.names||r.username)} ${esc(r.surnames||"")}</strong><small>@${esc(r.username)}</small></div>${statusBadge(r.status)}</div>
        <div class="mobile-report-stats-v224">
          <div><span>Videos</span><b>${r.video_count}</b></div>
          <div><span>Vistas</span><b>${num(r.total_views)}</b></div>
          <div><span>Likes</span><b>${num(r.total_likes||0)}</b></div>
          <div><span>Pago</span><b>${money(r.total_pay??r.approved_base_pay??r.calculated_base_pay)}</b></div>
        </div>
        <div class="mobile-progress-line-v224"><span>Avance <b>${Math.round(progress)}%</b></span><div class="progress"><span style="width:${progress}%"></span></div></div>
        <button class="btn report-evaluate-btn-v224 mobile-evaluate-v224" data-admin-report="${r.report_id}">${uiIcon("arrow",15)}<span>Evaluar reporte</span></button>
      </article>`;
    }).join("");

    return `<div class="desktop-report-table desktop-report-table-v224"><table><thead><tr><th>Clipero</th><th>Videos</th><th>Métricas</th><th>Avance</th><th>Pago</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="mobile-report-cards mobile-report-cards-v224">${cards}</div>`;
  }

  function renderClipperDashboard() {
    setHeader("Inicio","Métricas en vivo");
    const s=state.currentSummary,rows=state.platformSummary||[];
    const paid=rows.find(r=>r.pay_enabled)||rows.find(r=>r.platform==="tiktok")||{platform:"tiktok",views:0,target_views:250000,calculated_pay:0,max_base_pay:300,video_count:0};
    const target=Math.max(Number(paid.target_views||0),1),views=Number(paid.views||0),progress=clamp(views/target*100,0,100);
    const editable=reportEditable(s),deadlinePassed=s?.submission_deadline&&Date.now()>new Date(s.submission_deadline).getTime();
    $("#content").innerHTML=`
      <section class="live-hero"><div class="live-hero-main"><span class="live-hero-kicker"><i></i> PERÍODO ACTIVO</span><h2>Hola, ${esc(state.profile.names||state.profile.username)}</h2><p>${periodRangeLabel(s)}</p><div class="live-hero-meta"><span>Cierre <b>${dateTimeLabel(s.submission_deadline)}</b></span><span><b>${s.video_count||0}</b> videos</span><span>${deadlinePassed?"Cerrando":"Abierto"}</span></div></div><div class="live-hero-value"><small>Pago estimado</small><strong>${money(s.calculated_base_pay||0)}</strong><span>En vivo</span></div></section>
      <section class="live-paid-card"><div><span class="paid-card-label">${platformLogo(paid.platform)} ${esc(platformLabel(paid.platform))} · REMUNERADO</span><div class="paid-card-title"><span data-count="${views}">${num(views)}</span> vistas</div><div class="paid-card-sub">Meta ${num(target)} · ${Math.round(progress)}%</div><div class="paid-progress"><span style="width:${progress}%"></span></div></div><div class="paid-side"><small>Pago actual</small><strong>${money(paid.calculated_pay||0)}</strong><span>Máximo ${money(paid.max_base_pay||0)}</span></div></section>
      ${livePlatformCards(rows)}
      <div class="clipper-quick-actions"><div class="primary-action-panel"><div><h3>Registrar videos</h3><p>Pega uno o varios enlaces.</p></div><button id="quickAddBtn" class="btn btn-primary" ${!editable?"disabled":""}>${uiIcon("plus")} Agregar videos</button></div><div class="submit-mini-panel submit-mini-panel-v224"><div><small>Reporte</small>${statusBadge(s.status)}</div><button id="submitReportBtn" class="btn btn-secondary" ${!editable||s.can_submit===false||Number(s.video_count||0)<1?"disabled":""}>${uiIcon("check")} ${s.submitted_at?"Actualizar":"Enviar"}</button></div></div>
      <section class="card compact-card" style="margin-top:12px"><div class="card-head"><div><h2>Videos recientes</h2><p>Actualización automática</p></div><button id="viewVideosBtn" class="btn btn-ghost btn-sm">Ver todos ${uiIcon("arrow",14)}</button></div>${recentVideoCards(state.videos)}</section>`;
    $("#quickAddBtn")?.addEventListener("click",handleQuickRegisterAction);
    $("#submitReportBtn")?.addEventListener("click",submitCurrentReport);
    $("#viewVideosBtn")?.addEventListener("click",()=>{state.videoFilterPlatform="all";navigate("videos");});
    animateDynamicNumbers($("#content"));
  }


  /* ===================================================================
     CLIPCONTROL 2.3.3 · CREATOR CONTROL
     - Marca visual con GIF.
     - Avance y pago SIEMPRE separados por red registrada.
     - Accesos corregidos usando last_login_at + last_seen_at.
     - Avatar persistente en Supabase Storage.
     - Diagnóstico compatible con backend 2.3.1+.
     =================================================================== */

  function platformLogo(platform) {
    const label = platformLabel(platform);
    const icons = {
      tiktok: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.7 3.2v10.1a3.9 3.9 0 1 1-3.3-3.9v3.1a1.2 1.2 0 1 0 .8 1.1V3.2h2.5Z" fill="#fff"/><path d="M13.7 3.2c.55 1.75 1.92 3.06 3.68 3.52v2.75a7.8 7.8 0 0 1-3.68-1.3V3.2Z" fill="#25F4EE"/><path d="M14.45 3.2c.55 1.47 1.7 2.55 3.18 3.05v2.38a6.8 6.8 0 0 1-3.18-1.12V3.2Zm-4.05 6.2v2.7a1.22 1.22 0 0 0-.77 2.15 3.85 3.85 0 0 1 .77-4.85Z" fill="#FE2C55"/></svg>`,
      instagram: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="5" fill="none" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="3.6" fill="none" stroke="#fff" stroke-width="2"/><circle cx="17.3" cy="6.8" r="1.05" fill="#fff"/></svg>`,
      youtube: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.1 8.2a3 3 0 0 0-2.1-2.1C17.15 5.6 12 5.6 12 5.6s-5.15 0-7 .5a3 3 0 0 0-2.1 2.1A16 16 0 0 0 2.5 12a16 16 0 0 0 .4 3.8A3 3 0 0 0 5 17.9c1.85.5 7 .5 7 .5s5.15 0 7-.5a3 3 0 0 0 2.1-2.1 16 16 0 0 0 .4-3.8 16 16 0 0 0-.4-3.8Z" fill="#FF0000"/><path d="m10 15.35 5-3.35-5-3.35v6.7Z" fill="#fff"/></svg>`,
      facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#1877F2"/><path d="M13.6 21v-7h2.35l.35-2.75h-2.7V9.5c0-.8.22-1.35 1.38-1.35H16.4V5.7c-.25-.03-1.1-.1-2.1-.1-2.08 0-3.5 1.27-3.5 3.6v2.05H8.45V14h2.35v7h2.8Z" fill="#fff"/></svg>`
    };
    return `<span class="platform-logo platform-${esc(platform)} official-platform-logo" aria-label="${esc(label)}">${icons[platform] || icons.tiktok}</span>`;
  }

  function profileInitials(profile) {
    const words = `${profile?.names || ""} ${profile?.surnames || ""}`.trim().split(/\s+/).filter(Boolean);
    if (words.length) return words.slice(0,2).map(word => word[0]).join("").toUpperCase();
    return String(profile?.username || "U").slice(0,2).toUpperCase();
  }

  function profileAvatarMarkup(profile, size = "medium") {
    const url = String(profile?.avatar_url || "").trim();
    const roleClass = profile?.role && profile.role !== "clipper" ? " avatar-admin" : "";
    if (url && /^https?:\/\//i.test(url)) {
      return `<span class="profile-avatar profile-avatar-${size}${roleClass}"><img src="${esc(url)}" alt="Foto de ${esc(profile?.names || profile?.username || "usuario")}" loading="lazy" referrerpolicy="no-referrer"></span>`;
    }
    return `<span class="profile-avatar profile-avatar-${size} profile-avatar-fallback${roleClass}">${esc(profileInitials(profile))}</span>`;
  }

  function effectiveLastAccess(user) {
    return user?.last_login_at || user?.last_seen_at || null;
  }

  function presenceInfo(user) {
    const onlineMinutes = Math.max(Number(state.settings?.online_window_minutes || 5), 1);
    const warningDays = Math.max(Number(state.settings?.inactive_warning_days || 3), 1);
    const criticalDays = Math.max(Number(state.settings?.inactive_critical_days || 7), warningDays);
    const seen = user?.last_seen_at ? new Date(user.last_seen_at).getTime() : 0;
    const access = effectiveLastAccess(user) ? new Date(effectiveLastAccess(user)).getTime() : 0;
    const seenMinutes = seen ? (Date.now() - seen) / 60000 : Infinity;
    const accessDays = access ? (Date.now() - access) / 86400000 : Infinity;
    if (seenMinutes <= onlineMinutes) return { key:"online", label:"En línea", cls:"presence-online", icon:"🟢" };
    if (seenMinutes <= 15) return { key:"recent", label:"Actividad reciente", cls:"presence-recent", icon:"🟡" };
    if (!access) return { key:"never", label:"Sin actividad registrada", cls:"presence-inactive", icon:"⚫" };
    if (accessDays >= criticalDays) return { key:"inactive", label:`Sin actividad ${criticalDays}+ días`, cls:"presence-inactive", icon:"🔴" };
    if (accessDays >= warningDays) return { key:"low", label:"Baja actividad", cls:"presence-recent", icon:"🟠" };
    return { key:"offline", label:"Desconectado", cls:"", icon:"⚪" };
  }

  function presenceHtml(user) {
    const p = presenceInfo(user);
    const access = effectiveLastAccess(user);
    const source = user?.last_login_at ? "último login" : user?.last_seen_at ? "última actividad" : "sin registro";
    return `<div class="presence-line ${p.cls}"><span class="presence-dot"></span><b>${esc(p.label)}</b><span>· ${source} ${access ? relativeTime(access) : "—"}</span></div>`;
  }

  function authLoginStamp(session) {
    const user = session?.user;
    if (!user?.id) return "";
    return String(user.last_sign_in_at || user.updated_at || `${user.id}:${session?.expires_at || "session"}`);
  }

  function shouldRecordAuthLogin(session) {
    const userId = session?.user?.id;
    const stamp = authLoginStamp(session);
    if (!userId || !stamp) return false;
    return localStorage.getItem(`clipcontrol_login_stamp_v232:${userId}`) !== stamp;
  }

  function markAuthLoginRecorded(session) {
    const userId = session?.user?.id;
    const stamp = authLoginStamp(session);
    if (userId && stamp) localStorage.setItem(`clipcontrol_login_stamp_v232:${userId}`, stamp);
  }

  async function init() {
    setAuthenticatedShell(false);
    try {
      const cfg = window.CLIPCONTROL_SUPABASE;
      if (!cfg?.url || !cfg?.publishableKey || !window.supabase) {
        $("#connectionText").textContent = "Falta configurar Supabase";
        $("#connectionDot").classList.add("bad");
        return;
      }
      state.supabase = window.supabase.createClient(cfg.url, cfg.publishableKey, {
        auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true },
      });
      $("#connectionDot").classList.add("ok");
      $("#connectionText").textContent = "Conexión segura lista";
      bindStaticEvents();

      const { data, error } = await state.supabase.auth.getSession();
      if (error) throw error;
      if (data?.session) {
        state.session = data.session;
        await loadSignedUser(shouldRecordAuthLogin(data.session));
      }

      state.supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT") return showLogin();
        if (session) state.session = session;
      });
    } catch (error) {
      $("#connectionText").textContent = "No se pudo iniciar la conexión";
      $("#connectionDot").classList.add("bad");
      toast(errorMessage(error), "error");
    }
  }

  async function loadSignedUser(recordLogin = false) {
    showLoading(true);
    try {
      const userId = state.session?.user?.id;
      state.profile = await query(state.supabase.from("profiles").select("*").eq("id", userId).single());
      if (!state.profile.active) {
        await state.supabase.auth.signOut();
        throw new Error("Tu cuenta está desactivada. Comunícate con administración.");
      }
      if (recordLogin) {
        try {
          const updated = await query(state.supabase.rpc("record_my_login"));
          state.profile = { ...state.profile, ...(updated?.id ? updated : {}) };
          markAuthLoginRecorded(state.session);
        } catch (error) {
          console.warn("No se pudo registrar último login", error);
        }
      }
      showApp();
      state.page = "dashboard";
      await renderPage(true);
      startPresenceHeartbeat();
      startLiveRealtime();
      startLiveMetricsEngine();
      if (state.profile.role === "clipper" && !profileComplete(state.profile)) openProfileModal(true);
      else await showMandatoryAnnouncements();
    } catch (error) {
      toast(errorMessage(error), "error");
      await state.supabase.auth.signOut();
    } finally { showLoading(false); }
  }

  function showApp() {
    setAuthenticatedShell(true);
    const p = state.profile;
    $("#sideRole").textContent = p.role === "clipper" ? "Portal del clipero" : "Administración";
    $("#miniName").textContent = p.names || p.username;
    $("#miniRole").textContent = p.role === "superadmin" ? "Superadministrador" : p.role === "admin" ? "Administrador" : "Clipero";
    $("#miniAvatar").innerHTML = profileAvatarMarkup(p, "tiny");
    buildNav();
  }

  async function uploadMyAvatar(file) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type || "")) return toast("Usa una imagen JPG, PNG, WEBP o GIF.", "error");
    if (file.size > 4 * 1024 * 1024) return toast("La foto debe pesar máximo 4 MB.", "error");
    showLoading(true);
    try {
      const path = `${state.profile.id}/avatar`;
      const { error: uploadError } = await state.supabase.storage.from("profile-avatars").upload(path, file, { upsert:true, contentType:file.type, cacheControl:"3600" });
      if (uploadError) throw uploadError;
      const { data } = state.supabase.storage.from("profile-avatars").getPublicUrl(path);
      const publicUrl = `${data.publicUrl}?v=${Date.now()}`;
      await query(state.supabase.rpc("update_my_avatar_url", { p_avatar_url:publicUrl }));
      state.profile.avatar_url = publicUrl;
      showApp();
      toast("Foto de perfil actualizada", "success");
      await renderPage(true);
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { showLoading(false); }
  }

  async function removeMyAvatar() {
    if (!state.profile?.avatar_url || !confirm("¿Quitar tu foto de perfil?")) return;
    showLoading(true);
    try {
      await query(state.supabase.rpc("update_my_avatar_url", { p_avatar_url:null }));
      try { await state.supabase.storage.from("profile-avatars").remove([`${state.profile.id}/avatar`]); } catch (_) {}
      state.profile.avatar_url = null;
      showApp();
      toast("Foto eliminada", "success");
      await renderPage(true);
    } catch (error) { toast(errorMessage(error), "error"); }
    finally { showLoading(false); }
  }

  function renderProfilePage() {
    setHeader("Mi perfil", "Identidad, contacto y datos de pago.");
    const p = state.profile;
    $("#content").innerHTML = `
      <section class="profile-identity-card">
        <div class="profile-identity-main">${profileAvatarMarkup(p,"xl")}<div><span class="profile-role-chip">${p.role === "clipper" ? "CLIPERO" : "ADMINISTRACIÓN"}</span><h2>${esc(`${p.names || ""} ${p.surnames || ""}`.trim() || p.username)}</h2><p>@${esc(p.username)} · ${presenceHtml(p)}</p></div></div>
        <div class="profile-photo-actions"><label class="btn btn-secondary" for="avatarFile">${uiIcon("user",15)} Cambiar foto</label><input id="avatarFile" class="hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif">${p.avatar_url ? '<button id="removeAvatarBtn" class="btn btn-ghost" type="button">Quitar foto</button>' : ""}<small>JPG, PNG, WEBP o GIF · máximo 4 MB</small></div>
      </section>
      <div class="grid grid2 profile-form-grid">
        <div class="card compact-card profile-info-card"><div class="card-head"><div><h2>Información personal</h2><p>Datos usados por administración.</p></div><span class="chip">@${esc(p.username)}</span></div><form id="profileForm" class="form-grid compact-form"><label>Nombres<input name="names" required value="${esc(p.names || "")}"></label><label>Apellidos<input name="surnames" required value="${esc(p.surnames || "")}"></label><label>Celular / WhatsApp<input name="phone" required value="${esc(p.phone || "")}"></label><label>Cuenta social principal<input name="primary_social_url" required type="url" value="${esc(p.primary_social_url || "")}" placeholder="https://www.tiktok.com/@usuario"></label><div class="full actions"><button class="btn btn-primary">Guardar cambios</button></div></form></div>
        <div class="card compact-card profile-payment-card"><div class="card-head"><div><h2>Datos de pago</h2><p>Solo para procesar tus pagos.</p></div><span class="pill ${p.payment_account ? "pill-green" : "pill-yellow"}">${p.payment_account ? "Completo" : "Pendiente"}</span></div><form id="paymentProfileForm" class="form-grid compact-form"><label>Método<select name="payment_method">${paymentMethodOptions(p.payment_method || "")}</select></label><label>Número / cuenta<input name="payment_account" value="${esc(p.payment_account || "")}" placeholder="Yape, Plin, cuenta o CCI"></label><label class="full">Titular<input name="payment_holder" value="${esc(p.payment_holder || `${p.names || ""} ${p.surnames || ""}`.trim())}" placeholder="Nombre del titular"></label><div class="full actions"><button class="btn btn-primary">Guardar datos de pago</button></div></form></div>
      </div>`;
    $("#avatarFile")?.addEventListener("change", event => uploadMyAvatar(event.target.files?.[0]));
    $("#removeAvatarBtn")?.addEventListener("click", removeMyAvatar);
    $("#profileForm").addEventListener("submit", saveOwnProfile);
    $("#paymentProfileForm").addEventListener("submit", async event => {
      event.preventDefault();
      const f = Object.fromEntries(new FormData(event.target));
      await saveProfileV20({ names:p.names, surnames:p.surnames, phone:p.phone, primary_social_url:p.primary_social_url, ...f });
    });
  }

  function clipperRegisteredPlatforms() {
    const set = new Set(activeAccounts().map(account => account.platform));
    for (const row of state.platformSummary || []) if (Number(row.video_count || 0) > 0) set.add(row.platform);
    return [...set].filter(platform => PLATFORMS[platform]);
  }

  function clipperPlatformProgressCards() {
    const platforms = clipperRegisteredPlatforms();
    if (!platforms.length) return `<div class="empty network-progress-empty">Registra una red para empezar a medir tu avance.</div>`;
    const rowMap = Object.fromEntries((state.platformSummary || []).map(row => [row.platform,row]));
    const videoMap = summarizeVideosByPlatform(state.videos || []);
    return `<div class="registered-platform-grid">${platforms.map(platform => {
      const fallback = videoMap[platform] || {videos:0,views:0,likes:0,comments:0,shares:0};
      const row = rowMap[platform] || { platform,video_count:fallback.videos,views:fallback.views,likes:fallback.likes,comments:fallback.comments,shares:fallback.shares,pay_enabled:false,target_views:0,max_base_pay:0,calculated_pay:0 };
      const target = Number(row.target_views || 0), views = Number(row.views || 0);
      const progress = row.pay_enabled && target ? clamp((views / target) * 100,0,100) : 0;
      const accountCount = activeAccounts().filter(a => a.platform === platform).length;
      return `<article class="registered-platform-card registered-${platform}"><div class="registered-platform-head"><div>${platformBadge(platform,true)}<small>${accountCount} cuenta${accountCount===1?"":"s"} registrada${accountCount===1?"":"s"}</small></div><span>${Number(row.video_count || 0)} videos</span></div><div class="registered-platform-main"><div><strong>${num(views)}</strong><small>vistas</small></div><div class="network-pay-box"><small>${row.pay_enabled ? "Pago actual" : "Solo métrica"}</small><b>${row.pay_enabled ? money(row.calculated_pay || 0) : "—"}</b></div></div>${row.pay_enabled ? `<div class="network-target-line"><span>Avance <b>${Math.round(progress)}%</b></span><span>Meta ${num(target)}</span></div><div class="network-target-progress"><span style="width:${progress}%"></span></div><div class="network-max-line">Máximo de esta red: <b>${money(row.max_base_pay || 0)}</b></div>` : `<div class="network-info-line">Esta red no está habilitada para pago. Sus métricas se muestran por separado.</div>`}</article>`;
    }).join("")}</div>`;
  }

  function renderClipperDashboard() {
    setHeader("Inicio", "Avance separado por cada red registrada.");
    const s = state.currentSummary;
    const rows = state.platformSummary || [];
    const paidRows = rows.filter(row => row.pay_enabled && clipperRegisteredPlatforms().includes(row.platform));
    const estimatedPay = paidRows.reduce((sum,row) => sum + Number(row.calculated_pay || 0),0);
    const maxPay = paidRows.reduce((sum,row) => sum + Number(row.max_base_pay || 0),0);
    const editable = reportEditable(s);
    const deadlinePassed = s?.submission_deadline && Date.now() > new Date(s.submission_deadline).getTime();
    const submitted = Boolean(s?.submitted_at);
    $("#content").innerHTML = `
      <section class="creator-hero"><div class="creator-hero-copy"><span class="creator-live"><i></i> PERÍODO ACTIVO</span><h2>Hola, ${esc(state.profile.names || state.profile.username)}</h2><p>${periodRangeLabel(s)}</p><div class="creator-hero-meta"><span>Cierre <b>${dateTimeLabel(s.submission_deadline)}</b></span><span><b>${s.video_count || 0}</b> videos</span><span><b>${clipperRegisteredPlatforms().length}</b> redes</span></div></div><div class="creator-pay-total"><small>Pago estimado total</small><strong>${money(estimatedPay)}</strong><span>Suma independiente de cada red · máximo ${money(maxPay)}</span></div></section>
      <section class="network-progress-section"><div class="section-title-row"><div><span class="section-eyebrow">TU AVANCE REAL</span><h3>Rendimiento por red</h3><p>No mezclamos vistas de plataformas diferentes.</p></div><button id="goNetworksBtn" class="btn btn-ghost btn-sm">${uiIcon("network",14)} Administrar redes</button></div>${clipperPlatformProgressCards()}</section>
      <div class="clipper-action-strip"><div class="clipper-action-primary"><div><span>CONTENIDO</span><h3>Registrar videos</h3><p>Agrega enlaces a la red que corresponde.</p></div><button id="quickAddBtn" class="btn btn-primary" ${!editable ? "disabled" : ""}>${uiIcon("plus")} Agregar videos</button></div><div class="clipper-action-report"><div><span>REPORTE</span>${statusBadge(s.status)}<small>${submitted ? `Enviado ${dateTimeLabel(s.submitted_at)}` : "Todavía no enviado"}</small></div><button id="submitReportBtn" class="btn ${submitted ? "btn-secondary" : "btn-success"}" ${!editable || s.can_submit === false || Number(s.video_count || 0) < 1 ? "disabled" : ""}>${uiIcon("check")} ${submitted ? "Actualizar entrega" : "Enviar reporte"}</button></div></div>
      ${submitted && editable ? `<div class="edit-after-send-note">${uiIcon("activity",15)} <span>El reporte fue enviado, pero sigue editable hasta el cierre. Si Administración lo devuelve a <b>En elaboración</b>, podrás continuar normalmente.</span></div>` : ""}
      ${deadlinePassed ? `<div class="alert alert-warning compact-alert" style="margin-top:12px"><div>⏱</div><div><strong>Período cerrado</strong><p>Ya no se permiten cambios salvo habilitación administrativa.</p></div></div>` : ""}
      <section class="card compact-card recent-content-card"><div class="card-head"><div><h2>Videos recientes</h2><p>Métricas automáticas por plataforma.</p></div><button id="viewVideosBtn" class="btn btn-ghost btn-sm">Ver todos ${uiIcon("arrow",14)}</button></div>${recentVideoCards(state.videos)}</section>`;
    $("#quickAddBtn")?.addEventListener("click",handleQuickRegisterAction);
    $("#submitReportBtn")?.addEventListener("click",submitCurrentReport);
    $("#viewVideosBtn")?.addEventListener("click",()=>{state.videoFilterPlatform="all";navigate("videos");});
    $("#goNetworksBtn")?.addEventListener("click",()=>navigate("networks"));
    animateDynamicNumbers($("#content"));
  }

  function reportPlatformProgressMarkup(reportId) {
    const rows = (state.adminPlatformRows || []).filter(row => row.report_id === reportId && Number(row.video_count || 0) > 0);
    if (!rows.length) return `<span class="report-network-empty">Sin redes</span>`;
    return `<div class="report-network-progress">${rows.map(row => {
      const target = Number(row.target_views || 0), views = Number(row.views || 0);
      const progress = row.pay_enabled && target ? clamp((views / target) * 100,0,100) : 0;
      return `<span class="report-network-pill platform-pill-${row.platform}" title="${esc(`${platformLabel(row.platform)} · ${num(views)} vistas · ${row.pay_enabled ? `${Math.round(progress)}% · ${money(row.calculated_pay || 0)}` : "sin pago"}`)}">${platformLogo(row.platform)}<span><b>${num(views)}</b><small>${row.pay_enabled ? `${Math.round(progress)}% · ${money(row.calculated_pay || 0)}` : "Informativo"}</small></span></span>`;
    }).join("")}</div>`;
  }

  function adminReportsTable(reports) {
    if (!reports.length) return '<div class="empty">Todavía no existen reportes en este período.</div>';
    const rows = reports.map(r => `<tr class="report-row-v224 row-${statusClass(r.status)}"><td><div class="report-person report-person-v224"><strong>${esc(r.names||r.username)} ${esc(r.surnames||"")}</strong><small>@${esc(r.username)}</small></div></td><td><div class="report-number-v224"><b>${r.video_count}</b><small>${r.account_count} cuenta${Number(r.account_count)===1?"":"s"}</small></div></td><td><div class="report-metric-main metric-main-v224">${uiIcon("eye",14)}<b>${num(r.total_views)}</b></div><div class="report-like-line metric-like-v224">${uiIcon("heart",12)} ${num(r.total_likes||0)}</div></td><td>${reportPlatformProgressMarkup(r.report_id)}</td><td><b class="report-pay-v224">${money(r.total_pay??r.approved_base_pay??r.calculated_base_pay)}</b><small class="pay-sum-note">Suma por redes</small></td><td>${statusBadge(r.status)}</td><td><button class="btn btn-sm report-evaluate-btn-v224" data-admin-report="${r.report_id}">${uiIcon("arrow",14)}<span>Evaluar</span></button></td></tr>`).join("");
    const cards = reports.map(r => `<article class="mobile-report-card-v224 row-${statusClass(r.status)}"><div class="mobile-report-head-v224"><div class="report-person-v224"><strong>${esc(r.names||r.username)} ${esc(r.surnames||"")}</strong><small>@${esc(r.username)}</small></div>${statusBadge(r.status)}</div><div class="mobile-report-stats-v224"><div><span>Videos</span><b>${r.video_count}</b></div><div><span>Vistas</span><b>${num(r.total_views)}</b></div><div><span>Likes</span><b>${num(r.total_likes||0)}</b></div><div><span>Pago</span><b>${money(r.total_pay??r.approved_base_pay??r.calculated_base_pay)}</b></div></div><div class="mobile-network-breakdown"><span>Avance por redes</span>${reportPlatformProgressMarkup(r.report_id)}</div><button class="btn report-evaluate-btn-v224 mobile-evaluate-v224" data-admin-report="${r.report_id}">${uiIcon("arrow",15)}<span>Evaluar reporte</span></button></article>`).join("");
    return `<div class="desktop-report-table desktop-report-table-v224"><table><thead><tr><th>Clipero</th><th>Videos</th><th>Métricas</th><th>Avance por redes</th><th>Pago total</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="mobile-report-cards mobile-report-cards-v224">${cards}</div>`;
  }

  async function renderAdminClippers() {
    setHeader("Accesos","Actividad real, último acceso y administración de usuarios.");
    const [overview,profiles] = await Promise.all([
      query(state.supabase.from("admin_clipper_overview").select("*").order("role").order("username")),
      query(state.supabase.from("profiles").select("id,avatar_url,last_login_at,last_seen_at,login_count")),
    ]);
    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id,p]));
    const users = (overview || []).map(u => ({...u,...(profileMap[u.user_id] || {})}));
    const allowed = state.profile.role === "superadmin" ? users : users.filter(u => u.role === "clipper");
    const roleFilter = state.accessRoleFilter || "clipper", activityFilter = state.accessActivityFilter || "all";
    let visible = roleFilter === "all" ? allowed : roleFilter === "admin" ? allowed.filter(u => ["admin","superadmin"].includes(u.role)) : allowed.filter(u => u.role === roleFilter);
    visible = visible.filter(u => { const k=presenceInfo(u).key; if(activityFilter==="all")return true; if(activityFilter==="online")return k==="online"; if(activityFilter==="warning")return ["low","recent"].includes(k); if(activityFilter==="inactive")return ["inactive","never"].includes(k); if(activityFilter==="never")return k==="never"; return true; });
    const cards = visible.map(u => { const access=effectiveLastAccess(u); return `<div class="access-user-card access-user-card-v232" data-search-user="${esc(`${u.username} ${u.names||""} ${u.surnames||""} ${u.phone||""}`.toLowerCase())}"><div class="access-user-top">${profileAvatarMarkup(u,"small")}<div class="access-user-id"><strong>${esc(u.names?`${u.names} ${u.surnames||""}`.trim():`@${u.username}`)}</strong><small>@${esc(u.username)} · ${u.role==="superadmin"?"Superadmin":u.role==="admin"?"Administrador":"Clipero"}</small></div><span class="pill ${u.active?"pill-green":"pill-red"}">${u.active?"Activo":"Suspendido"}</span></div>${presenceHtml(u)}<div class="login-meta-grid"><div><span>Último acceso</span><b>${access?dateTimeLabel(access):"Sin registro"}</b></div><div><span>Ingresos</span><b>${num(u.login_count||0)}</b></div><div><span>${u.role==="clipper"?"Pago":"Creado"}</span><b>${u.role==="clipper"?(u.payment_account?paymentMethodLabel(u.payment_method):"Pendiente"):dateOnlyLabel(u.created_at)}</b></div></div><button class="btn btn-secondary btn-sm btn-block" data-open-user="${u.user_id}">Administrar</button></div>`; }).join("");
    $("#content").innerHTML = `<div class="card compact-card access-center-v232"><div class="card-head"><div><h2>Usuarios</h2><p>${allowed.length} accesos · ${allowed.filter(u=>presenceInfo(u).key==="online").length} en línea</p></div><div class="actions">${roleFilter==="clipper"?`<button id="requestAllPayBtn" class="btn btn-secondary">${uiIcon("wallet",15)} Solicitar datos</button>`:""}<button id="createClipperBtn" class="btn btn-primary">${uiIcon("plus",15)} Crear acceso</button></div></div><div class="access-toolbar"><div class="access-tabs"><button class="access-tab ${roleFilter==="clipper"?"active":""}" data-access-filter="clipper">Cliperos (${allowed.filter(u=>u.role==="clipper").length})</button>${state.profile.role==="superadmin"?`<button class="access-tab ${roleFilter==="admin"?"active":""}" data-access-filter="admin">Administradores (${allowed.filter(u=>["admin","superadmin"].includes(u.role)).length})</button><button class="access-tab ${roleFilter==="all"?"active":""}" data-access-filter="all">Todos</button>`:""}</div><div class="actions"><select id="activityFilter"><option value="all" ${activityFilter==="all"?"selected":""}>Toda actividad</option><option value="online" ${activityFilter==="online"?"selected":""}>En línea</option><option value="warning" ${activityFilter==="warning"?"selected":""}>Baja actividad</option><option value="inactive" ${activityFilter==="inactive"?"selected":""}>Inactivos</option><option value="never" ${activityFilter==="never"?"selected":""}>Sin actividad registrada</option></select><label class="access-search">${uiIcon("user",14)} <input id="accessSearch" placeholder="Buscar usuario, nombre o celular"></label></div></div><div class="access-card-grid" id="accessGrid">${cards||'<div class="empty">No hay usuarios con este filtro.</div>'}</div></div>`;
    $("#createClipperBtn").addEventListener("click",openCreateUserModal);
    $("#requestAllPayBtn")?.addEventListener("click",async()=>{if(!confirm("¿Solicitar datos de pago a todos los cliperos activos que aún no los registraron?"))return;try{const count=await query(state.supabase.rpc("admin_request_payment_data_all"));toast(`Solicitud activada para ${count} clipero(s)`,"success");await renderAdminClippers();}catch(error){toast(errorMessage(error),"error");}});
    $$('[data-access-filter]').forEach(b=>b.addEventListener("click",()=>{state.accessRoleFilter=b.dataset.accessFilter;renderAdminClippers();}));
    $("#activityFilter").addEventListener("change",e=>{state.accessActivityFilter=e.target.value;renderAdminClippers();});
    $("#accessSearch").addEventListener("input",e=>{const term=e.target.value.trim().toLowerCase();$$('[data-search-user]').forEach(card=>card.classList.toggle("hidden",term&&!card.dataset.searchUser.includes(term)));});
    $$('[data-open-user]').forEach(b=>b.addEventListener("click",()=>{state.selectedClipperId=b.dataset.openUser;state.selectedClipperTab="info";renderPage(true);}));
  }

  function versionAtLeast(current, minimum) {
    const a = String(current || "0").split(".").map(n => Number(n.replace(/\D.*/,"")) || 0);
    const b = String(minimum || "0").split(".").map(n => Number(n.replace(/\D.*/,"")) || 0);
    for (let i=0;i<Math.max(a.length,b.length);i++) { if ((a[i]||0) > (b[i]||0)) return true; if ((a[i]||0) < (b[i]||0)) return false; }
    return true;
  }

  async function runSystemDiagnostics() {
    const box = $("#diagnosticsBox"), button = $("#runDiagnosticsBtn");
    if (!box || !button) return;
    button.disabled = true; button.textContent = "Revisando…";
    const results = [];
    const check = async (name, task) => { try { results.push({name,ok:true,detail:await task()}); } catch(error) { results.push({name,ok:false,detail:errorMessage(error)}); } };
    await check("Sesión autenticada", async()=>{const {data,error}=await state.supabase.auth.getUser();if(error||!data.user)throw error||new Error("Sin usuario");return data.user.id.slice(0,8);});
    await check("Motor de datos", async()=>{const s=await query(state.supabase.from("app_settings").select("schema_version,metrics_live_enabled,metrics_live_interval_minutes").eq("id",1).single());if(!versionAtLeast(s.schema_version,"2.3.1"))throw new Error(`Versión ${s.schema_version||"desconocida"}; se requiere 2.3.1 o superior`);return `v${s.schema_version} · compatible · LIVE ${s.metrics_live_enabled===false?"apagado":"activo"}`;});
    await check("Período activo", async()=>{const p=await query(state.supabase.from("reporting_periods").select("start_date,end_date,submission_deadline").eq("is_active",true).limit(1).maybeSingle());if(!p)throw new Error("No existe período activo");return `${periodRangeLabel(p)} · cierre ${dateTimeLabel(p.submission_deadline)}`;});
    await check("Actividad / último acceso", async()=>{
      // Primero intenta actualizar presencia; si el RPC no está disponible, el diagnóstico continúa con los datos existentes.
      try { await state.supabase.rpc("touch_my_presence"); } catch (_) {}
      const p=await query(state.supabase.from("profiles").select("last_login_at,last_seen_at,login_count").eq("id",state.profile.id).single());
      let authAccess=null;
      try { const {data}=await state.supabase.auth.getUser(); authAccess=data?.user?.last_sign_in_at||null; } catch (_) {}
      const access=p.last_login_at||p.last_seen_at||authAccess;
      const count=Number(p.login_count||0);
      if(!access && count>0) return `${count} ingreso(s) · acceso registrado (sin fecha histórica)`;
      if(!access) throw new Error("Aún no existe una marca de actividad");
      return `${Math.max(count,1)} ingreso(s) · ${relativeTime(access)}`;
    });
    await check("Perfil visual", async()=>{
      const p=await query(state.supabase.from("profiles").select("avatar_url").eq("id",state.profile.id).single());
      return p.avatar_url?"Foto configurada":"Disponible · sin foto todavía (avatar con iniciales)";
    });
    await check("Comunicados", async()=>{const rows=await query(state.supabase.from("my_visible_announcements").select("id").limit(1));return `${rows.length} aviso(s) visible(s) en la muestra`;});
    await check("Edge Function", async()=>{const health=await invokeAdminFunction({action:"health"});return `${health.function||"bright-processor"} · v${health.version||"?"}`;});
    box.innerHTML = results.map(r=>`<div class="alert ${r.ok?"alert-success":"alert-danger"}" style="margin-bottom:8px"><div>${r.ok?"✓":"✕"}</div><div><strong>${esc(r.name)}</strong><p>${esc(r.detail||"Correcto")}</p></div></div>`).join("");
    button.disabled=false; button.innerHTML=`${uiIcon("activity",15)} Revisar sistema`;
  }

  function errorMessage(error) {
    const msg = error?.message || String(error || "Error inesperado");
    if (/profile-avatars|avatar_url|update_my_avatar_url|admin_return_report_to_draft/i.test(msg)) return "Falta ejecutar 23_clipcontrol_ui_profile_draft.sql en Supabase.";
    if (/metrics_live_enabled|metrics_live_interval_minutes|metrics_live_batch_size|realtime_ui_enabled|sync_my_due_metrics/i.test(msg)) return "Falta instalar la actualización SQL/Edge Function de ClipControl 2.2 LIVE.";
    if (/announcements|announcement_receipts|my_visible_announcements|announcement_admin_summary|period_report_snapshots|last_login_at|last_seen_at|login_count|record_my_login|touch_my_presence|rollover_periods_if_due|freeze_period_metrics|admin_close_active_period|admin_reopen_period/i.test(msg)) return "Falta ejecutar el SQL 18 de ClipControl 2.1 en Supabase.";
    if (/weekly_report_platform_summary|reporting_periods|platform_payment_rules|update_my_profile_v20|admin_set_active_period|admin_save_platform_payment_rule/i.test(msg)) return "Falta ejecutar el SQL 16 de ClipControl 2.0 en Supabase.";
    if (/duplicate key|videos_unique_active_url/i.test(msg)) return "Ese enlace de video ya fue registrado.";
    if (/videos_unique_active_position/i.test(msg)) return "Ya existe un video en esa posición.";
    if (/Invalid login credentials/i.test(msg)) return "Usuario o contraseña incorrectos.";
    if (/Email not confirmed/i.test(msg)) return "La cuenta todavía no está confirmada en Supabase.";
    if (/save_video_batch|Could not find the function/i.test(msg)) return "Falta ejecutar las actualizaciones SQL de ClipControl.";
    if (/row-level security|permission denied/i.test(msg)) return "Supabase bloqueó la operación por permisos. Verifica las migraciones y vuelve a iniciar sesión.";
    if (/El reporte está cerrado|plazo de envío terminó/i.test(msg)) return "El reporte ya está cerrado. Administración debe habilitar la edición fuera de plazo.";
    return msg;
  }

  /* ===================================================================
     CLIPCONTROL 2.3.4 · PAGO PROPORCIONAL SIN TECHO + CIERRE AUTOMÁTICO
     - S/ de referencia se paga por cada bloque de meta, sin cap al 100%.
     - Avance admin por redes realmente registradas.
     - El clipero ya no envía manualmente: el reporte se autoenvía al cierre.
     - Acceso rápido a foto de perfil desde el avatar lateral.
     =================================================================== */

  function uncappedPlatformPay(row) {
    if (!row || row.pay_enabled === false) return 0;
    const views = Number(row.views || 0);
    const target = Number(row.target_views || 0);
    const referencePay = Number(row.max_base_pay || 0);
    if (views <= 0 || target <= 0 || referencePay <= 0) return 0;
    return Math.round(((views / target) * referencePay) * 100) / 100;
  }

  function platformProgressRaw(row) {
    const target = Number(row?.target_views || 0);
    if (!target) return 0;
    return Math.max(0, (Number(row?.views || 0) / target) * 100);
  }

  function normalizedPlatformRow(platform, row = null) {
    const rule = state.platformRuleMap?.[platform] || {};
    return {
      platform,
      video_count: Number(row?.video_count || 0),
      views: Number(row?.views || 0),
      likes: Number(row?.likes || 0),
      comments: Number(row?.comments || 0),
      shares: Number(row?.shares || 0),
      pay_enabled: row?.pay_enabled ?? rule.pay_enabled ?? false,
      target_views: Number(row?.target_views ?? rule.target_views ?? 0),
      max_base_pay: Number(row?.max_base_pay ?? rule.max_base_pay ?? 0),
      calculated_pay: Number(row?.calculated_pay || 0),
      report_id: row?.report_id || null,
      user_id: row?.user_id || null,
    };
  }

  function platformRowsForReport(reportId) {
    return (state.adminPlatformRows || []).filter(row => row.report_id === reportId);
  }

  function reportUncappedBase(report) {
    const rows = platformRowsForReport(report?.report_id).filter(row => row.pay_enabled !== false);
    if (!rows.length) return Number(report?.calculated_base_pay || 0);
    return Math.round(rows.reduce((sum, row) => sum + uncappedPlatformPay(row), 0) * 100) / 100;
  }

  function reportDisplayTotal(report) {
    const base = reportUncappedBase(report);
    const bonus = Number(report?.bonus_pay || 0);
    return Math.round((base + bonus) * 100) / 100;
  }

  function aggregatePlatformRows(rows = []) {
    const map = Object.fromEntries(Object.keys(PLATFORMS).map(platform => [platform, {
      platform, video_count:0, views:0, likes:0, comments:0, shares:0,
      calculated_pay:0, uncapped_pay:0, pay_enabled:false, target_views:0, max_base_pay:0,
    }]));
    for (const source of rows || []) {
      const row = normalizedPlatformRow(source.platform, source);
      const item = map[row.platform];
      if (!item) continue;
      item.video_count += row.video_count;
      item.views += row.views;
      item.likes += row.likes;
      item.comments += row.comments;
      item.shares += row.shares;
      item.pay_enabled = item.pay_enabled || Boolean(row.pay_enabled);
      item.calculated_pay += uncappedPlatformPay(row);
      item.uncapped_pay += uncappedPlatformPay(row);
    }
    return Object.values(map);
  }

  function compactRegisteredPlatformsForUser(userId) {
    return (state.adminRegisteredPlatformsByUser?.[userId] || []).filter(p => PLATFORMS[p]);
  }

  function reportPlatformProgressMarkup(reportId, userId = null) {
    const sourceRows = platformRowsForReport(reportId);
    const rowMap = Object.fromEntries(sourceRows.map(row => [row.platform, row]));
    const registered = userId ? compactRegisteredPlatformsForUser(userId) : [];
    const platforms = registered.length ? registered : [...new Set(sourceRows.filter(row => Number(row.video_count || 0) > 0).map(row => row.platform))];
    if (!platforms.length) return `<span class="report-network-empty">Sin redes registradas</span>`;
    return `<div class="report-network-progress report-network-progress-v234">${platforms.map(platform => {
      const row = normalizedPlatformRow(platform, rowMap[platform]);
      const raw = row.pay_enabled ? platformProgressRaw(row) : 0;
      const pay = uncappedPlatformPay(row);
      const detail = row.pay_enabled ? `${Math.round(raw)}% · ${money(pay)}` : `${num(row.views)} vistas`;
      return `<span class="report-network-pill platform-pill-${platform}" title="${esc(`${platformLabel(platform)} · ${num(row.views)} vistas${row.pay_enabled ? ` · ${Math.round(raw)}% · ${money(pay)}` : ""}`)}">${platformLogo(platform)}<span><b>${row.pay_enabled ? `${Math.round(raw)}%` : num(row.views)}</b><small>${esc(detail)}</small></span></span>`;
    }).join("")}</div>`;
  }

  function clipperPlatformProgressCards() {
    const platforms = clipperRegisteredPlatforms();
    if (!platforms.length) return `<div class="empty network-progress-empty">Registra una red para empezar a medir tu avance.</div>`;
    const rowMap = Object.fromEntries((state.platformSummary || []).map(row => [row.platform,row]));
    const videoMap = summarizeVideosByPlatform(state.videos || []);
    return `<div class="registered-platform-grid registered-platform-grid-v234">${platforms.map(platform => {
      const fallback = videoMap[platform] || {videos:0,views:0,likes:0,comments:0,shares:0};
      const row = normalizedPlatformRow(platform, rowMap[platform] || {platform,video_count:fallback.videos,views:fallback.views,likes:fallback.likes,comments:fallback.comments,shares:fallback.shares});
      const raw = row.pay_enabled ? platformProgressRaw(row) : 0;
      const bar = clamp(raw,0,100);
      const pay = uncappedPlatformPay(row);
      const accountCount = activeAccounts().filter(account => account.platform === platform).length;
      return `<article class="registered-platform-card registered-${platform}">
        <div class="registered-platform-head"><div>${platformBadge(platform,true)}<small>${accountCount} cuenta${accountCount===1?"":"s"}</small></div><span>${row.video_count} video${row.video_count===1?"":"s"}</span></div>
        <div class="registered-platform-main"><div><strong>${num(row.views)}</strong><small>vistas</small></div><div class="network-pay-box"><small>${row.pay_enabled ? "Pago por vistas" : "Solo métrica"}</small><b>${row.pay_enabled ? money(pay) : "—"}</b></div></div>
        ${row.pay_enabled ? `<div class="network-target-line"><span>Avance <b>${Math.round(raw)}%</b></span><span>Meta de referencia ${num(row.target_views)}</span></div><div class="network-target-progress"><span style="width:${bar}%"></span></div><div class="network-max-line network-reference-line">${money(row.max_base_pay)} por cada ${num(row.target_views)} vistas · <b>sin techo</b></div>` : `<div class="network-info-line">Esta red se mide por separado y todavía no está habilitada para pago.</div>`}
      </article>`;
    }).join("")}</div>`;
  }

  function recentVideoCards(videos = []) {
    if (!videos.length) return `<div class="empty">Aún no registraste videos en este período.</div>`;
    const accountMap = Object.fromEntries((state.accounts || []).map(account => [account.id,account]));
    return `<div class="live-recent-videos live-recent-videos-v234">${videos.slice(0,8).map(v => {
      const account = accountMap[v.account_id] || {};
      const accountName = account.account_name || platformLabel(v.platform);
      const meaningfulTitle = v.external_title && String(v.external_title).trim().toLowerCase() !== "empresa" ? v.external_title : "";
      return `<a class="live-video-card live-video-card-v234" href="${esc(v.video_url)}" target="_blank" rel="noopener"><span class="live-video-platform">${platformLogo(v.platform)}</span><span class="live-video-copy"><strong>${esc(accountName)}</strong><small>${meaningfulTitle ? esc(meaningfulTitle) : (v.metrics_status==="ok"?'<i class="metric-live-dot"></i>Métrica actualizada':esc(v.metrics_status==="syncing"?"Sincronizando":"Pendiente"))}</small></span><span class="live-video-metric"><b>${num(v.views||0)}</b><small>vistas</small></span></a>`;
    }).join("")}</div>`;
  }

  function renderClipperDashboard() {
    const s = state.currentSummary;
    const firstName = String(state.profile.names || state.profile.username || "Clipero").trim().split(/\s+/)[0];
    const registered = clipperRegisteredPlatforms();
    const rowMap = Object.fromEntries((state.platformSummary || []).map(row => [row.platform,row]));
    const estimatedPay = registered.reduce((sum,platform) => sum + uncappedPlatformPay(normalizedPlatformRow(platform,rowMap[platform])),0);
    const editable = reportEditable(s);
    const deadlinePassed = s?.submission_deadline && Date.now() > new Date(s.submission_deadline).getTime();
    setHeader(`Hola, ${firstName}`, `${periodRangeLabel(s)} · ${s?.video_count || 0} videos · cierre ${dateTimeLabel(s?.submission_deadline)}`);
    $("#content").innerHTML = `
      <section class="creator-overview-v234">
        <div class="creator-overview-user"><button id="quickProfilePhoto" class="creator-photo-button" type="button" title="Cambiar foto de perfil">${profileAvatarMarkup(state.profile,"medium")}<i>+</i></button><div><span><i></i> ${deadlinePassed ? "PERÍODO CERRADO" : "PERÍODO ACTIVO"}</span><strong>${registered.length} red${registered.length===1?"":"es"} registrada${registered.length===1?"":"s"}</strong><small>${deadlinePassed ? "El reporte quedó enviado automáticamente." : "No necesitas enviar nada: el reporte se entrega automáticamente al cierre."}</small></div></div>
        <div class="creator-overview-pay"><small>Pago estimado total</small><strong>${money(estimatedPay)}</strong><span>Pago proporcional por vistas · sin techo</span></div>
      </section>
      <section class="network-progress-section network-progress-section-v234"><div class="section-title-row"><div><span class="section-eyebrow">AVANCE POR RED</span><h3>Tus plataformas</h3><p>Cada red conserva su propia meta, vistas y pago.</p></div><button id="goNetworksBtn" class="btn btn-ghost btn-sm">${uiIcon("network",14)} Administrar redes</button></div>${clipperPlatformProgressCards()}</section>
      <div class="clipper-action-strip clipper-action-strip-v234"><div class="clipper-action-primary"><div><span>CONTENIDO</span><h3>Registrar videos</h3><p>${editable ? "Pega tus enlaces y continúa trabajando hasta la fecha límite." : "El período ya no permite cambios."}</p></div><button id="quickAddBtn" class="btn btn-primary" ${!editable ? "disabled" : ""}>${uiIcon("plus")} Agregar videos</button></div><div class="auto-submit-card-v234">${uiIcon("check",16)}<div><strong>Entrega automática</strong><small>${deadlinePassed ? "Reporte enviado por cierre" : `Se enviará ${dateTimeLabel(s?.submission_deadline)}`}</small></div></div></div>
      <section class="card compact-card recent-content-card recent-content-card-v234"><div class="card-head"><div><h2>Videos recientes</h2><p>Tu contenido y sus vistas, sin bloques repetidos.</p></div><div class="actions"><button id="refreshMyMetricsBtn" class="btn btn-secondary btn-sm">${uiIcon("sync",14)} Métricas</button><button id="viewVideosBtn" class="btn btn-ghost btn-sm">Ver todos ${uiIcon("arrow",14)}</button></div></div>${recentVideoCards(state.videos)}</section>`;
    $("#quickAddBtn")?.addEventListener("click",handleQuickRegisterAction);
    $("#quickProfilePhoto")?.addEventListener("click",()=>navigate("profile"));
    $("#viewVideosBtn")?.addEventListener("click",()=>{state.videoFilterPlatform="all";navigate("videos");});
    $("#refreshMyMetricsBtn")?.addEventListener("click",async()=>{showLoading(true);try{await runLiveMetricSync(false);await renderPage(true);}finally{showLoading(false);}});
    $("#goNetworksBtn")?.addEventListener("click",()=>navigate("networks"));
    animateDynamicNumbers($("#content"));
  }

  async function returnReportToDraftFast(reportId) {
    if (!confirm("¿Mandar este reporte a Seguir en elaboración? El clipero podrá volver a modificarlo mientras el período esté abierto.")) return;
    showLoading(true);
    try {
      await query(state.supabase.rpc("admin_return_report_to_draft",{p_report_id:reportId,p_note:null}));
      toast("Reporte devuelto a En elaboración","success");
      await renderPage(true);
    } catch (error) { toast(errorMessage(error),"error"); }
    finally { showLoading(false); }
  }

  function bindAdminReportButtons() {
    $$('[data-admin-report]').forEach(button => button.addEventListener("click",()=>openAdminReportDetail(button.dataset.adminReport)));
    $$('[data-return-draft]').forEach(button => button.addEventListener("click",event=>{event.stopPropagation();returnReportToDraftFast(button.dataset.returnDraft);}));
  }

  async function renderAdminReports() {
    setHeader("Inicio","Avance y pago proporcional por cada red");
    try { await state.supabase.rpc("clipcontrol_auto_submit_due_reports_v234"); } catch (_) {}
    const periods = await query(state.supabase.from("reporting_periods").select("*").order("start_date",{ascending:false}).limit(20));
    if (!state.adminWeek) state.adminWeek = state.activePeriod?.start_date || periods?.[0]?.start_date || currentWeekStartISO();
    const reports = await query(state.supabase.from("weekly_report_summary").select("*").eq("week_start",state.adminWeek).order("total_views",{ascending:false}));
    const reportIds = reports.map(r=>r.report_id);
    const userIds = [...new Set(reports.map(r=>r.user_id).filter(Boolean))];
    const [platformRows,socialAccounts] = await Promise.all([
      reportIds.length ? query(state.supabase.from("weekly_report_platform_summary").select("*").in("report_id",reportIds)) : Promise.resolve([]),
      userIds.length ? query(state.supabase.from("social_accounts").select("user_id,platform,active").in("user_id",userIds).eq("active",true)) : Promise.resolve([]),
    ]);
    let paymentRules = [];
    try { paymentRules = await query(state.supabase.from("platform_payment_rules").select("*")); } catch (_) {}
    state.adminReportIds = reportIds;
    state.adminPlatformRows = platformRows || [];
    state.platformRuleMap = Object.fromEntries((paymentRules || []).map(rule => [rule.platform,rule]));
    state.adminRegisteredPlatformsByUser = {};
    for (const account of socialAccounts || []) {
      if (!state.adminRegisteredPlatformsByUser[account.user_id]) state.adminRegisteredPlatformsByUser[account.user_id] = [];
      if (!state.adminRegisteredPlatformsByUser[account.user_id].includes(account.platform)) state.adminRegisteredPlatformsByUser[account.user_id].push(account.platform);
    }
    const aggregate = aggregatePlatformRows(platformRows || []);
    const pending = reports.filter(r=>["sent","review","observed"].includes(r.status)).length;
    const projected = reports.reduce((sum,r)=>sum+reportDisplayTotal(r),0);
    const metricIssues = (platformRows || []).reduce((sum,row)=>sum + (Number(row.views || 0) > 0 ? 0 : 1), 0);
    const selectedPeriod = periods.find(p=>p.start_date===state.adminWeek);
    $("#content").innerHTML = `
      <section class="reports-home-v224 reports-home-v234"><div class="reports-home-top"><div><span class="reports-kicker">PERÍODO</span><h2>${esc(selectedPeriod?.name || periodRangeLabel(selectedPeriod) || state.adminWeek)}</h2><p>${selectedPeriod?.is_active ? '<span class="period-live-dot"></span>Activo' : 'Histórico'} · ${reports.length} cliperos · pago sin techo</p></div><div class="reports-home-actions"><label class="period-select-v224">${uiIcon("history",15)}<select id="reportPeriodSelect">${periods.map(p=>`<option value="${p.start_date}" ${p.start_date===state.adminWeek?"selected":""}>${esc(p.name||periodRangeLabel(p))}${p.is_active?" · ACTIVO":""}</option>`).join("")}</select></label><button id="refreshDueMetricsBtn" class="btn btn-secondary btn-sm">${uiIcon("sync",14)} Métricas</button><button id="exportReportsBtn" class="btn btn-secondary btn-sm">${uiIcon("report",14)} Excel</button></div></div>
      ${livePlatformCards(aggregate,{})}
      <div class="report-mini-summary-v224"><div><span>Reportes</span><strong>${reports.length}</strong></div><div><span>Por revisar</span><strong>${pending}</strong></div><div><span>Métricas flojas</span><strong>${metricIssues}</strong><small>redes sin vistas detectadas</small></div><div><span>Pago proyectado</span><strong>${money(projected)}</strong><small>proporcional sin límite</small></div><div><span>Cierre</span><strong>${dateOnlyLabel(selectedPeriod?.end_date||reports[0]?.week_end)}</strong></div></div></section>
      <section class="card report-list-card-v224"><div class="report-list-head-v224"><div><h2>Evaluar cliperos</h2><p>El avance se divide por las redes registradas de cada clipero.</p></div><span class="report-live-note"><i></i> En vivo</span></div>${adminReportsTable(reports)}</section>`;
    $("#reportPeriodSelect")?.addEventListener("change",e=>{state.adminWeek=e.target.value;renderAdminReports();});
    $("#refreshDueMetricsBtn")?.addEventListener("click",async()=>{showLoading(true);try{await runLiveMetricSync(false);await renderAdminReports();}finally{showLoading(false);}});
    $("#exportReportsBtn")?.addEventListener("click",()=>exportWeeklyExcel(reports));
    bindAdminReportButtons();
    animateDynamicNumbers($("#content"));
  }

  function adminReportsTable(reports) {
    if (!reports.length) return '<div class="empty">Todavía no existen reportes en este período.</div>';
    const actionMarkup = r => {
      const canReturn = !["draft","paid","closed","expired"].includes(r.status);
      return `<div class="report-actions-v234">${canReturn?`<button class="btn btn-elaboration btn-sm" data-return-draft="${r.report_id}" title="Seguir en elaboración">↩ <span>Elaborar</span></button>`:""}<button class="btn btn-sm report-evaluate-btn-v224" data-admin-report="${r.report_id}">${uiIcon("arrow",14)}<span>Evaluar</span></button></div>`;
    };
    const rows = reports.map(r => `<tr class="report-row-v224 row-${statusClass(r.status)}"><td><div class="report-person report-person-v224"><strong>${esc(r.names||r.username)} ${esc(r.surnames||"")}</strong><small>@${esc(r.username)}</small></div></td><td><div class="report-number-v224"><b>${r.video_count}</b><small>${r.account_count} cuenta${Number(r.account_count)===1?"":"s"}</small></div></td><td><div class="report-metric-main metric-main-v224">${uiIcon("eye",14)}<b>${num(r.total_views)}</b></div><div class="report-like-line metric-like-v224">${uiIcon("heart",12)} ${num(r.total_likes||0)}</div></td><td>${reportPlatformProgressMarkup(r.report_id,r.user_id)}</td><td><b class="report-pay-v224">${money(reportDisplayTotal(r))}</b><small class="pay-sum-note">vistas por red + bono</small></td><td>${statusBadge(r.status)}</td><td>${actionMarkup(r)}</td></tr>`).join("");
    const cards = reports.map(r => `<article class="mobile-report-card-v224 row-${statusClass(r.status)}"><div class="mobile-report-head-v224"><div class="report-person-v224"><strong>${esc(r.names||r.username)} ${esc(r.surnames||"")}</strong><small>@${esc(r.username)}</small></div>${statusBadge(r.status)}</div><div class="mobile-report-stats-v224"><div><span>Videos</span><b>${r.video_count}</b></div><div><span>Vistas</span><b>${num(r.total_views)}</b></div><div><span>Likes</span><b>${num(r.total_likes||0)}</b></div><div><span>Pago</span><b>${money(reportDisplayTotal(r))}</b></div></div><div class="mobile-network-breakdown"><span>Avance por redes</span>${reportPlatformProgressMarkup(r.report_id,r.user_id)}</div>${actionMarkup(r)}</article>`).join("");
    return `<div class="desktop-report-table desktop-report-table-v224"><table><thead><tr><th>Clipero</th><th>Videos</th><th>Métricas</th><th>Avance por redes</th><th>Pago total</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="mobile-report-cards mobile-report-cards-v224">${cards}</div>`;
  }

  async function openAdminReportDetail(reportId) {
    showLoading(true);
    try {
      let summary = await query(state.supabase.from("weekly_report_summary").select("*").eq("report_id",reportId).single());
      const [videos,accounts,observations,platforms,rules] = await Promise.all([
        query(state.supabase.from("videos").select("*").eq("report_id",reportId).is("deleted_at",null).order("position")),
        query(state.supabase.from("social_accounts").select("*").eq("user_id",summary.user_id).order("platform")),
        query(state.supabase.from("report_observations").select("*").eq("report_id",reportId).order("created_at",{ascending:false})),
        query(state.supabase.from("weekly_report_platform_summary").select("*").eq("report_id",reportId).order("platform")),
        query(state.supabase.from("platform_payment_rules").select("*")),
      ]);
      state.videos=videos; state.accounts=accounts;
      state.platformRuleMap = Object.fromEntries((rules||[]).map(rule=>[rule.platform,rule]));
      const rowMap=Object.fromEntries((platforms||[]).map(row=>[row.platform,row]));
      const registered=[...new Set(accounts.filter(a=>a.active).map(a=>a.platform).concat((platforms||[]).filter(r=>Number(r.video_count||0)>0).map(r=>r.platform)))];
      const normalized=registered.map(platform=>normalizedPlatformRow(platform,rowMap[platform]));
      const basePay=Math.round(normalized.reduce((sum,row)=>sum+uncappedPlatformPay(row),0)*100)/100;
      const cards=`<div class="report-platform-grid report-platform-grid-v234">${normalized.map(row=>{const raw=row.pay_enabled?platformProgressRaw(row):0;return `<div class="report-platform-card report-platform-card-v234">${platformBadge(row.platform,true)}<strong>${num(row.views)}</strong><small>${row.video_count} videos · ${row.pay_enabled?`${Math.round(raw)}% de referencia`:"solo métricas"}</small><div class="report-pay"><span>${row.pay_enabled?`${money(row.max_base_pay)} / ${num(row.target_views)} vistas`:"No remunerado"}</span><b>${row.pay_enabled?money(uncappedPlatformPay(row)):"—"}</b></div></div>`;}).join("")}</div>`;
      openModal(`<div class="modal-head sticky-modal-head"><div><h2>${esc(summary.names||summary.username)} ${esc(summary.surnames||"")}</h2><p>${periodRangeLabel(summary)} · @${esc(summary.username)}</p></div><div class="actions">${statusBadge(summary.status)}<button id="adminReportX" class="modal-close">×</button></div></div><div class="admin-action-bar"><div class="action-summary"><span><small>Videos</small><b>${summary.video_count}</b></span><span><small>Pago por vistas</small><b>${money(basePay)}</b></span><span><small>Bono adicional</small><b>${money(summary.bonus_pay||0)}</b></span></div><div class="actions"><button data-review-action="draft" class="btn btn-elaboration btn-sm" ${summary.status==="draft"||["paid","closed","expired"].includes(summary.status)?"disabled":""}>↩ Seguir en elaboración</button><button data-review-action="review" class="btn btn-secondary btn-sm">Revisión</button><button data-review-action="observe" class="btn btn-warning btn-sm">Observar</button><button data-review-action="approve" class="btn btn-success btn-sm">Aprobar</button><button data-review-action="paid" class="btn btn-dark btn-sm">Pagado</button></div></div><div class="modal-body compact-modal-body">${cards}<div class="formula-box formula-box-v234"><b>Pago sin techo</b><span>Cada red: vistas ÷ meta de referencia × pago de referencia. Superar la meta sigue aumentando el pago.</span></div><div class="payment-request-box"><h3>💳 Datos de pago</h3><p>${summary.payment_account?`${paymentMethodLabel(summary.payment_method)} · ${esc(summary.payment_holder||summary.names||"")} · ${esc(summary.payment_account)}`:"Aún no registrados."}</p></div><div class="review-options" style="margin-top:12px"><label>Bono adicional<input id="bonusPayInput" type="number" min="0" step="0.01" value="${summary.bonus_pay??0}"><small class="muted">Este bono es aparte del pago automático por vistas.</small></label><label>Número de operación<input id="transactionInput" value="${esc(summary.transaction_number||"")}" placeholder="Opcional"></label><label class="full">Nota / observación<textarea id="reviewNote" rows="2">${esc(summary.admin_note||"")}</textarea></label></div><div class="card-head" style="margin-top:14px"><div><h3>Videos</h3><p>Detalle de enlaces y métricas.</p></div><button id="syncReportNow" class="btn btn-secondary btn-sm">↻ Actualizar métricas</button></div>${videosTable(videos,accounts,true)}${observations.length?`<div class="divider"></div><h3>Observaciones</h3>${observations.map(o=>`<div class="alert ${o.resolved?"alert-info":"alert-danger"} compact-alert"><div>📝</div><div><strong>${o.resolved?"Resuelta":"Pendiente"}</strong><p>${esc(o.message)} · ${dateTimeLabel(o.created_at)}</p></div></div>`).join("")}`:""}</div><div class="modal-foot"><span class="small muted">Última métrica: ${dateTimeLabel(summary.metrics_last_checked_at)}</span><button id="adminReportClose" class="btn btn-ghost">Cerrar</button></div>`,"",layer=>{
        $("#adminReportX",layer).addEventListener("click",closeModal); $("#adminReportClose",layer).addEventListener("click",closeModal);
        $("#syncReportNow",layer).addEventListener("click",async()=>{$("#syncReportNow",layer).disabled=true;await syncReportMetrics(reportId);closeModal();await openAdminReportDetail(reportId);});
        $$('[data-edit-video]',layer).forEach(b=>b.addEventListener("click",()=>openEditVideoModal(b.dataset.editVideo,true)));
        $$('[data-delete-video]',layer).forEach(b=>b.addEventListener("click",()=>adminSoftDeleteVideo(b.dataset.deleteVideo,reportId)));
        $$('[data-sync-video]',layer).forEach(b=>b.addEventListener("click",async()=>{b.disabled=true;await syncVideoMetrics(b.dataset.syncVideo);closeModal();await openAdminReportDetail(reportId);}));
        $$('[data-review-action]',layer).forEach(button=>button.addEventListener("click",async()=>{
          const action=button.dataset.reviewAction,note=$("#reviewNote",layer).value.trim(),bonus=Number($("#bonusPayInput",layer).value||0),transaction=$("#transactionInput",layer).value.trim();
          if(action==="observe"&&!note)return toast("Escribe el motivo de la observación.","error");
          const confirmText=action==="draft"?"¿Devolver este reporte a En elaboración?":"¿Guardar esta evaluación con el pago proporcional sin techo?";
          if(!confirm(confirmText))return; showLoading(true);
          try {
            if(action==="draft") await query(state.supabase.rpc("admin_return_report_to_draft",{p_report_id:reportId,p_note:note||null}));
            else {
              if(["approve","paid"].includes(action)) await syncReportMetrics(reportId,true);
              await query(state.supabase.rpc("admin_quick_review_report_v234",{p_report_id:reportId,p_action:action,p_bonus_pay:bonus,p_note:note||null,p_transaction_number:transaction||null}));
            }
            closeModal(); toast(action==="draft"?"Reporte devuelto a En elaboración":"Evaluación guardada","success"); await renderPage(true);
          } catch(error){toast(errorMessage(error),"error");} finally{showLoading(false);}
        }));
      });
    } catch(error){toast(errorMessage(error),"error");} finally{showLoading(false);}
  }

  async function renderAdminPayments() {
    setHeader("Pagos","Pago proporcional por vistas, separado por plataforma.");
    const start=state.activePeriod?.start_date||currentWeekStartISO();
    const reports=await query(state.supabase.from("weekly_report_summary").select("*").eq("week_start",start).order("names"));
    const ids=reports.map(r=>r.report_id);
    const platformRows=ids.length?await query(state.supabase.from("weekly_report_platform_summary").select("*").in("report_id",ids)):[];
    state.adminPlatformRows=platformRows;
    const total=reports.reduce((sum,r)=>sum+reportDisplayTotal(r),0),paid=reports.filter(r=>r.status==="paid"),missing=reports.filter(r=>!r.payment_account);
    $("#content").innerHTML=`<div class="grid grid3 compact-kpis mobile-two-columns">${kpi("Pago proyectado",money(total),"Sin techo por vistas")}${kpi("Pagados",paid.length,`${reports.length-paid.length} pendientes`)}${kpi("Sin datos de pago",missing.length,"Solicitar desde Accesos")}</div><div class="card compact-card" style="margin-top:12px"><div class="card-head"><div><h2>Pagos del período</h2><p>Cada red se calcula de forma independiente.</p></div></div><div class="payment-grid payment-grid-v234">${reports.map(r=>{const rows=platformRowsForReport(r.report_id).filter(row=>row.pay_enabled!==false);const base=reportUncappedBase(r);return `<div class="payment-card payment-card-v234"><div class="payment-card-head"><div><strong>${esc(r.names||r.username)} ${esc(r.surnames||"")}</strong><small>@${esc(r.username)}</small></div>${statusBadge(r.status)}</div><div class="payment-network-list-v234">${rows.map(row=>`<div>${platformLogo(row.platform)}<span>${platformLabel(row.platform)}</span><b>${num(row.views)} vistas</b><strong>${money(uncappedPlatformPay(row))}</strong></div>`).join("")||'<small class="muted">Sin redes remuneradas</small>'}</div><div class="payment-breakdown"><div><span>Por vistas</span><b>${money(base)}</b></div><div><span>Bono extra</span><b>${money(r.bonus_pay||0)}</b></div><div><span>Total</span><b>${money(reportDisplayTotal(r))}</b></div></div><div class="payment-account-row"><div><span>${paymentMethodLabel(r.payment_method)}</span><b>${r.payment_account?esc(r.payment_account):"Pendiente"}</b></div><div class="actions">${r.payment_account?`<button class="btn btn-ghost btn-sm" data-copy-pay="${esc(r.payment_account)}">Copiar</button>`:""}<button class="btn btn-secondary btn-sm" data-admin-report="${r.report_id}">Evaluar</button></div></div></div>`;}).join("")||'<div class="empty">Todavía no hay reportes.</div>'}</div></div>`;
    $$('[data-copy-pay]').forEach(b=>b.addEventListener("click",()=>copyText(b.dataset.copyPay))); bindAdminReportButtons();
  }

  async function exportWeeklyExcel(reports) {
    let platformRows = state.adminPlatformRows || [];
    const reportIds = (reports||[]).map(r=>r.report_id);
    const userIds = [...new Set((reports||[]).map(r=>r.user_id).filter(Boolean))];
    if (reportIds.length && !platformRows.some(row=>reportIds.includes(row.report_id))) {
      platformRows = await query(state.supabase.from("weekly_report_platform_summary").select("*").in("report_id",reportIds));
    }
    const [videoRows,socialAccounts] = await Promise.all([
      reportIds.length ? query(state.supabase.from("videos").select("id,report_id,user_id,platform,account_id,position,video_url,views,likes,comments,shares,external_title,metrics_status,created_at").in("report_id",reportIds).is("deleted_at",null).order("position")) : Promise.resolve([]),
      userIds.length ? query(state.supabase.from("social_accounts").select("id,user_id,platform,account_name,channel_url,active").in("user_id",userIds)) : Promise.resolve([]),
    ]);
    const byReport={}; for(const row of platformRows){if(!byReport[row.report_id])byReport[row.report_id]={};byReport[row.report_id][row.platform]=row;}
    const accountMap = Object.fromEntries((socialAccounts || []).map(account => [account.id, account]));
    const reportMap = Object.fromEntries((reports || []).map(report => [report.report_id, report]));
    const safeXml=value=>String(value??"")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&apos;");
    const cell=(value,type=null)=>{
      const resolvedType = type || (typeof value==="number" && Number.isFinite(value) ? "Number" : "String");
      const cellValue = resolvedType === "Number" ? Number(value || 0) : safeXml(value);
      return `<Cell><Data ss:Type="${resolvedType}">${cellValue}</Data></Cell>`;
    };
    const rowXml=(cells)=>`<Row>${cells.map(item=>Array.isArray(item)?cell(item[0],item[1]):cell(item)).join("")}</Row>`;
    const sheet=(name,rows)=>`<Worksheet ss:Name="${safeXml(name)}"><Table>${rows.map(rowXml).join("")}</Table></Worksheet>`;

    const detailHeaders=["Usuario","Clipero","Método pago","Cuenta pago","Titular","Videos","TikTok vistas","TikTok pago","Instagram vistas","Instagram pago","YouTube vistas","YouTube pago","Facebook vistas","Facebook pago","Pago por vistas","Bono adicional","Pago total","Estado","Cierre"];
    const detailRows=(reports||[]).map(r=>{
      const p=byReport[r.report_id]||{};
      const base=Math.round(Object.values(p).reduce((sum,row)=>sum+uncappedPlatformPay(row),0)*100)/100;
      const bonus=Number(r.bonus_pay||0);
      return [
        r.username||"",
        `${r.names||""} ${r.surnames||""}`.trim(),
        paymentMethodLabel(r.payment_method),
        r.payment_account || "",
        r.payment_holder || "",
        Number(r.video_count||0),
        Number(p.tiktok?.views||0),
        uncappedPlatformPay(p.tiktok),
        Number(p.instagram?.views||0),
        uncappedPlatformPay(p.instagram),
        Number(p.youtube?.views||0),
        uncappedPlatformPay(p.youtube),
        Number(p.facebook?.views||0),
        uncappedPlatformPay(p.facebook),
        base,
        bonus,
        Math.round((base+bonus)*100)/100,
        STATUS_LABELS[r.status]||r.status||"",
        dateTimeLabel(r.submission_deadline),
      ];
    });
    const aggregateRows = aggregatePlatformRows(platformRows || []);
    const totals = {
      clippers: Number((reports||[]).length),
      videos: (reports||[]).reduce((sum, report) => sum + Number(report.video_count || 0), 0),
      views: (reports||[]).reduce((sum, report) => sum + Number(report.total_views || 0), 0),
      base: Math.round((reports||[]).reduce((sum, report) => sum + reportUncappedBase(report), 0) * 100) / 100,
      bonus: Math.round((reports||[]).reduce((sum, report) => sum + Number(report.bonus_pay || 0), 0) * 100) / 100,
      missingPayment: (reports||[]).filter(report => !String(report.payment_account || "").trim()).length,
    };
    const totalPay = Math.round((totals.base + totals.bonus) * 100) / 100;
    const accountRollup = new Map();
    for (const video of (videoRows || [])) {
      const report = reportMap[video.report_id];
      if (!report) continue;
      const account = accountMap[video.account_id] || {};
      const key = `${video.report_id}:${video.account_id || `${video.platform}:sin-cuenta`}`;
      if (!accountRollup.has(key)) {
        accountRollup.set(key, {
          username: report.username || "",
          clipero: `${report.names || ""} ${report.surnames || ""}`.trim(),
          payment_method: paymentMethodLabel(report.payment_method),
          payment_account: report.payment_account || "",
          platform: platformLabel(video.platform),
          account_name: account.account_name || "Sin cuenta asignada",
          channel_url: account.channel_url || "",
          videos: 0,
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
        });
      }
      const row = accountRollup.get(key);
      row.videos += 1;
      row.views += Number(video.views || 0);
      row.likes += Number(video.likes || 0);
      row.comments += Number(video.comments || 0);
      row.shares += Number(video.shares || 0);
    }
    const accountRows = [...accountRollup.values()]
      .sort((a,b)=>a.clipero.localeCompare(b.clipero,"es") || a.platform.localeCompare(b.platform,"es") || a.account_name.localeCompare(b.account_name,"es"))
      .map(row => [row.username,row.clipero,row.payment_method,row.payment_account,row.platform,row.account_name,row.channel_url,row.videos,row.views,row.likes,row.comments,row.shares]);
    const videoSheetHeaders = ["Clipero","Usuario","Método pago","Cuenta pago","Plataforma","Cuenta social","Posición","Título","URL","Vistas","Likes","Comentarios","Compartidos","Estado métrica","Registrado"];
    const videoSheetRows = (videoRows || []).map(video => {
      const report = reportMap[video.report_id] || {};
      const account = accountMap[video.account_id] || {};
      return [
        `${report.names || ""} ${report.surnames || ""}`.trim(),
        report.username || "",
        paymentMethodLabel(report.payment_method),
        report.payment_account || "",
        platformLabel(video.platform),
        account.account_name || "",
        Number(video.position || 0),
        video.external_title || "",
        video.video_url || "",
        Number(video.views || 0),
        Number(video.likes || 0),
        Number(video.comments || 0),
        Number(video.shares || 0),
        video.metrics_status || "",
        dateTimeLabel(video.created_at),
      ];
    });
    const summaryRows = [
      ["Período", periodRangeLabel({ week_start: state.adminWeek, week_end: (() => { const date = new Date(`${state.adminWeek || currentWeekStartISO()}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + 6); return date.toISOString().slice(0, 10); })() })],
      ["Exportado", dateTimeLabel(new Date().toISOString())],
      ["Cliperos", totals.clippers],
      ["Videos", totals.videos],
      ["Vistas totales", totals.views],
      ["Pago por vistas", totals.base],
      ["Bonos", totals.bonus],
      ["Pago total", totalPay],
      ["Sin datos de pago", totals.missingPayment],
      [""],
      ["Clipero","Método pago","Cuenta pago","Titular","Estado","Pago total"],
      ...(reports||[]).map(report => [`${report.names || ""} ${report.surnames || ""}`.trim(), paymentMethodLabel(report.payment_method), report.payment_account || "Pendiente", report.payment_holder || "", STATUS_LABELS[report.status] || report.status || "", reportDisplayTotal(report)]),
      [""],
      ["Red","Videos","Vistas","Likes","Comentarios","Compartidos","Pago proyectado"],
      ...aggregateRows.map(row => [platformLabel(row.platform), Number(row.video_count||0), Number(row.views||0), Number(row.likes||0), Number(row.comments||0), Number(row.shares||0), Math.round(Number(row.uncapped_pay||0)*100)/100]),
    ];
    const workbook = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${sheet("Resumen", summaryRows)}
${sheet("Cliperos", [detailHeaders, ...detailRows])}
${sheet("Cuentas", [["Usuario","Clipero","Método pago","Cuenta pago","Plataforma","Cuenta social","Canal","Videos","Vistas","Likes","Comentarios","Compartidos"], ...accountRows])}
${sheet("Videos", [videoSheetHeaders, ...videoSheetRows])}
</Workbook>`;
    const filenameDate = String(state.adminWeek || currentWeekStartISO()).replace(/[^\d-]/g,"");
    const blob=new Blob(["\ufeff",workbook],{type:"application/vnd.ms-excel"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=`ClipControl_${filenameDate}_resumen.xls`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast("Excel exportado con resumen y detalle", "success");
  }

  async function loadClipperCurrentData() {
    try { await state.supabase.rpc("clipcontrol_auto_submit_due_reports_v234"); } catch (_) {}
    const [accounts,settings]=await Promise.all([
      query(state.supabase.from("social_accounts").select("*").eq("user_id",state.profile.id).order("created_at")),
      query(state.supabase.from("app_settings").select("*").eq("id",1).single()),
    ]);
    state.accounts=accounts; state.settings=settings;
    try { const rules=await query(state.supabase.from("platform_payment_rules").select("*")); state.platformRuleMap=Object.fromEntries((rules||[]).map(rule=>[rule.platform,rule])); } catch (_) {}
    const reportId=await query(state.supabase.rpc("ensure_weekly_report",{p_week_start:null})); state.currentReportId=reportId;
    const [summary,videos,observations,platformSummary]=await Promise.all([
      query(state.supabase.from("weekly_report_summary").select("*").eq("report_id",reportId).single()),
      query(state.supabase.from("videos").select("*").eq("report_id",reportId).is("deleted_at",null).order("position")),
      query(state.supabase.from("report_observations").select("*").eq("report_id",reportId).order("created_at",{ascending:false})),
      query(state.supabase.from("weekly_report_platform_summary").select("*").eq("report_id",reportId).order("platform")),
    ]);
    state.currentSummary=summary; state.videos=videos; state.observations=observations; state.platformSummary=platformSummary||[];
  }

  let deadlineWatcherV234 = null;
  function startDeadlineWatcherV234() {
    if (deadlineWatcherV234) clearInterval(deadlineWatcherV234);
    deadlineWatcherV234 = setInterval(async()=>{
      if (!state.profile || !state.supabase) return;
      try {
        const result=await query(state.supabase.rpc("clipcontrol_auto_submit_due_reports_v234"));
        if (Number(result||0)>0 && state.profile.role==="clipper") await renderPage(true);
      } catch (_) {}
    },60000);
  }

  function showApp() {
    setAuthenticatedShell(true);
    const p=state.profile;
    $("#sideRole").textContent=p.role==="clipper"?"Portal del clipero":"Administración";
    $("#miniName").textContent=p.names||p.username;
    $("#miniRole").textContent=p.role==="superadmin"?"Superadministrador":p.role==="admin"?"Administrador":"Clipero";
    const avatar=$("#miniAvatar"); avatar.innerHTML=profileAvatarMarkup(p,"tiny");
    avatar.classList.toggle("avatar-clickable",p.role==="clipper");
    avatar.title=p.role==="clipper"?"Cambiar foto de perfil":"";
    avatar.onclick=p.role==="clipper"?()=>navigate("profile"):null;
    buildNav(); startDeadlineWatcherV234();
  }

  function errorMessage(error) {
    const msg=error?.message||String(error||"Error inesperado");
    if(/admin_quick_review_report_v234|clipcontrol_auto_submit_due_reports_v234|clipcontrol_uncapped_platform_pay/i.test(msg))return "Falta ejecutar 24_clipcontrol_pago_sin_techo_autoenvio.sql en Supabase.";
    if(/profile-avatars|avatar_url|update_my_avatar_url|admin_return_report_to_draft/i.test(msg))return "Falta ejecutar 23_clipcontrol_ui_profile_draft.sql en Supabase.";
    if(/metrics_live_enabled|metrics_live_interval_minutes|metrics_live_batch_size|realtime_ui_enabled|sync_my_due_metrics/i.test(msg))return "Falta instalar la actualización SQL/Edge Function de ClipControl 2.2 LIVE.";
    if(/announcements|announcement_receipts|my_visible_announcements|announcement_admin_summary|period_report_snapshots|last_login_at|last_seen_at|login_count|record_my_login|touch_my_presence|rollover_periods_if_due|freeze_period_metrics|admin_close_active_period|admin_reopen_period/i.test(msg))return "Falta ejecutar el SQL 18 de ClipControl 2.1 en Supabase.";
    if(/weekly_report_platform_summary|reporting_periods|platform_payment_rules|update_my_profile_v20|admin_set_active_period|admin_save_platform_payment_rule/i.test(msg))return "Falta ejecutar el SQL 16 de ClipControl 2.0 en Supabase.";
    if(/duplicate key|videos_unique_active_url/i.test(msg))return "Ese enlace de video ya fue registrado.";
    if(/videos_unique_active_position/i.test(msg))return "Ya existe un video en esa posición.";
    if(/Invalid login credentials/i.test(msg))return "Usuario o contraseña incorrectos.";
    if(/Email not confirmed/i.test(msg))return "La cuenta todavía no está confirmada en Supabase.";
    if(/row-level security|permission denied/i.test(msg))return "Supabase bloqueó la operación por permisos. Verifica las migraciones y vuelve a iniciar sesión.";
    return msg;
  }


  // La ultima capa gana sobre las versiones historicas conservadas en el archivo.
  function buildNav() { return buildNavV240(); }
  async function renderAdminPage() { return renderAdminPageV240(); }
  async function renderClipperPage() { return renderClipperPageV240(); }
  async function renderAdminReports() { return renderAdminReportsV240(); }
  function renderClipperVideos() { return renderClipperVideosV240(); }

  // Diagnóstico mínimo de infraestructura. Facebook ya no tiene una ruta especial.
  window.clipcontrolDebugYoutube = () => invokeProcessor({ action:"youtube_public_feed", limit:15 });
  window.clipcontrolDebugHealth = () => invokeProcessor({ action:"health" });
  window.clipcontrolDebugFacebook = (url) => invokeProcessor({ action:"facebook_probe", url });

  window.addEventListener("DOMContentLoaded", init);

  window.clipcontrolDebugFrontend = () => ({
    version: CLIPCONTROL_FRONTEND_VERSION,
    source: "app-v2.6.4.js",
    scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
    samples: {
      facebook_reel: videoUrlValidation("https://www.facebook.com/reel/1579243183893033"),
      facebook_share: videoUrlValidation("https://www.facebook.com/share/p/1Gt2mqMZu9/"),
      tiktok_short: videoUrlValidation("https://vt.tiktok.com/ZSVNuNh39/"),
      youtube_short: videoUrlValidation("https://youtube.com/shorts/wSrn2PM4o6o?si=JRei8DWRyfFQpCSo"),
      instagram_reel: videoUrlValidation("https://www.instagram.com/reel/ABC123/")
    }
  });

})();

