(() => {
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
  const MAX_BATCH_ROWS = 100;

  async function invokeProcessor(payload) {
    const { data: sessionData, error: sessionError } = await state.supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (sessionError || !accessToken) {
      throw new Error("La sesión no está disponible. Cierra sesión y vuelve a ingresar.");
    }

    const { data, error } = await state.supabase.functions.invoke(ADMIN_FUNCTION, {
      body: payload,
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (error) {
      let message = error.message || "No se pudo ejecutar la operación del servidor.";
      try {
        const response = error.context;
        if (response?.clone) {
          const details = await response.clone().json();
          message = details?.error || details?.message || message;
        }
      } catch (_) {}
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);
    return data;
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

  function showLogin() {
    $("#loginView").classList.remove("hidden");
    $("#appView").classList.add("hidden");
    closeModal();
  }

  function showApp() {
    $("#loginView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    const p = state.profile;
    $("#sideRole").textContent = p.role === "clipper" ? "Portal del clipero" : "Administración";
    $("#miniName").textContent = p.names || p.username;
    $("#miniRole").textContent = p.role === "superadmin" ? "Superadministrador" : p.role === "admin" ? "Administrador" : "Clipero";
    $("#miniAvatar").textContent = "🥷";
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
        <div class="team-goal"><div class="ring-progress small-ring" style="--p:${percent}%"><span>${Math.round(percent)}%</span></div><div><small>Vistas</small><strong>${num(s.total_views)}</strong><span>Meta: ${num(s.target_views)}</span></div></div>
      </section>
      <div class="grid grid4 compact-kpis mobile-two-columns" style="margin-top:12px">
        ${kpi("Videos", num(s.video_count), `${accounts.length} cuentas activas`)}
        ${kpi("Vistas", num(s.total_views), `${num(s.total_likes || 0)} me gusta`)}
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

  function openQuickRegisterModal() {
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
    draftRows = draftRows.filter((row) => !usedPositions.has(Number(row.position))).slice(0, MAX_BATCH_ROWS);
    if (!draftRows.length) {
      const initialCount = clamp(Number(state.settings?.default_slots || DEFAULT_BATCH_ROWS), 1, MAX_BATCH_ROWS);
      draftRows = nextFreePositions(initialCount).map((position) => ({ position, platform: registeredAccounts[0]?.platform || "tiktok", account_id: "", video_url: "" }));
    }

    openModal(`
      <div class="modal-head"><div><h2>Agregar videos</h2><p>Completa solo las filas que necesites. Las métricas se detectan automáticamente.</p></div><button id="quickX" class="modal-close" title="Cerrar">×</button></div>
      <div class="modal-body">
        <div class="batch-toolbar"><span id="rowCounter" class="chip">${draftRows.length} filas disponibles</span><button id="addBatchRowBtn" class="btn btn-secondary btn-sm">＋ Agregar fila</button></div>
        <div class="quick-table table-wrap"><table><thead><tr><th>N.°</th><th>Plataforma</th><th>Cuenta</th><th>Enlace del video</th><th>Detección</th><th></th></tr></thead><tbody id="quickRows">${draftRows.map((row) => quickRow(row.position, row.platform, row.account_id, row.video_url, registeredAccounts)).join("")}</tbody></table></div>
      </div>
      <div class="modal-foot"><div id="draftState" class="draft-note">Puedes guardar desde una sola fila.</div><div class="actions"><button id="clearDraftBtn" class="btn btn-ghost">Limpiar</button><button id="saveQuickBtn" class="btn btn-primary">Guardar y detectar</button></div></div>`, "", (layer) => {
        const tbody = $("#quickRows", layer);
        const updateCounter = () => { $("#rowCounter", layer).textContent = `${$$('tr[data-position]', tbody).length} filas disponibles`; };
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
          if ($$('tr[data-position]', tbody).length >= MAX_BATCH_ROWS) return toast(`Máximo ${MAX_BATCH_ROWS} filas por carga.`, "error");
          tbody.insertAdjacentHTML("beforeend", quickRow(position, registeredAccounts[0]?.platform || "tiktok", "", "", registeredAccounts));
          updateCounter();
          saveDraft();
          tbody.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
      const videoUrl = normalizeUrl(rawUrl);
      urlInput.value = videoUrl;
      if (!isValidHttpUrl(videoUrl)) return toast(`El enlace de la fila ${position} no es válido.`, "error");
      rows.push({ position, account_id: accountId, video_url: videoUrl, views: 0, likes: 0 });
    }
    if (!rows.length) return toast("Completa al menos una fila para guardar.", "error");
    button.disabled = true;
    button.textContent = "Guardando…";
    try {
      await query(state.supabase.rpc("save_video_batch", { p_report_id: state.currentReportId, p_rows: rows }));
      const positions = rows.map((r) => r.position);
      const savedVideos = await query(state.supabase.from("videos").select("id,position").eq("report_id", state.currentReportId).in("position", positions).is("deleted_at", null));
      localStorage.removeItem(draftKey);
      closeModal();
      toast(`${rows.length} video${rows.length === 1 ? "" : "s"} guardado${rows.length === 1 ? "" : "s"}. Detectando métricas…`, "success");
      for (const video of savedVideos || []) await syncVideoMetrics(video.id, true);
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
      state.profile = Array.isArray(updated) ? updated[0] : updated;
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
      query(state.supabase.from("social_accounts").select("platform,active").eq("active", true)),
    ]);
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
    const platformCounts = Object.keys(PLATFORMS).map((platform) => ({ platform, count: socialAccounts.filter((a) => a.platform === platform).length }));
    const maxPlatform = Math.max(...platformCounts.map((p) => p.count), 1);
    const topReports = reports.slice(0, 5);

    $("#content").innerHTML = `
      <section class="dashboard-banner compact-banner">
        <div><span class="eyebrow">SEMANA ${weekLabel(currentWeekStartISO())}</span><h2>Control semanal</h2><p>Cliperos, vistas, reportes y pagos.</p></div>
        <div class="team-goal"><div class="ring-progress small-ring" style="--p:${teamProgress}%"><span>${Math.round(teamProgress)}%</span></div><div><small>Vistas del equipo</small><strong>${num(totalViews)}</strong><span>Meta conjunta: ${num(targetViews)}</span></div></div>
      </section>
      <div class="grid grid4 compact-kpis mobile-two-columns" style="margin-top:14px">
        ${kpi("Cliperos activos", num(active.length), `${clippers.length} registrados`)}
        ${kpi("Videos", num(totalVideos), `${reports.length} reportes`)}
        ${kpi("Vistas totales", num(totalViews), `${num(totalLikes)} me gusta`)}
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
          <div class="bar-list">${platformCounts.map((item) => `<div class="bar-row"><div class="bar-meta">${platformBadge(item.platform, true)}<b>${item.count}</b></div><div class="bar-track"><span style="width:${(item.count / maxPlatform) * 100}%"></span></div></div>`).join("")}</div>
        </div>
      </div>
      <div class="card compact-card" style="margin-top:14px">
        <div class="card-head"><div><h2>Reportes de la semana</h2><p>Evaluación rápida y pagos.</p></div><div class="actions"><button id="exportWeeklyBtn" class="btn btn-secondary btn-sm">⬇ Excel semanal</button><button id="goReportsBtn" class="btn btn-primary btn-sm">Ver reportes</button></div></div>
        ${adminReportsTable(reports.slice(0, 10))}
      </div>`;
    $("#exportWeeklyBtn").addEventListener("click", () => exportWeeklyExcel(reports));
    $("#goReportsBtn").addEventListener("click", () => navigate("reports"));
    bindAdminReportButtons();
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
    const cards = clippers.map((c) => `<button class="clipper-access-card" data-open-clipper="${c.user_id}"><div class="clipper-access-top"><span class="avatar">🥷</span><div><strong>${c.names ? esc(`${c.names} ${c.surnames || ""}`) : `@${esc(c.username)}`}</strong><small>@${esc(c.username)}</small></div><span class="pill ${c.active ? "pill-green" : "pill-red"}">${c.active ? "Activo" : "Suspendido"}</span></div><div class="clipper-access-info"><span><small>WhatsApp</small><b>${esc(c.phone || "Pendiente")}</b></span><span><small>Redes</small><b>${c.active_social_accounts}</b></span><span><small>Último reporte</small><b>${dateOnlyLabel(c.latest_report_week)}</b></span></div><div class="clipper-access-action">Administrar →</div></button>`).join("");
    $("#content").innerHTML = `<div class="card compact-card"><div class="card-head"><div><h2>Cliperos</h2><p>${clippers.length} usuarios registrados</p></div><button id="createClipperBtn" class="btn btn-primary">＋ Crear acceso</button></div>
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
      </div><div class="alert alert-info" style="margin-top:14px"><div>🥷</div><div><strong>Registro simplificado</strong><p>El clipero ingresará nombres, apellidos, WhatsApp y el link de su cuenta principal.</p></div></div></div><div class="modal-foot"><span></span><div class="actions"><button type="button" id="createCancel" class="btn btn-ghost">Cancelar</button><button class="btn btn-primary">Crear usuario</button></div></div></form>`, "small", (layer) => {
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
      box.innerHTML = `<div class="profile-admin-grid"><div class="profile-card"><span class="avatar large-avatar">🥷</span><div><h3>${esc(profile.names || profile.username)} ${esc(profile.surnames || "")}</h3><p class="muted">@${esc(profile.username)}</p></div></div><div class="summary-list compact-summary"><div><span>WhatsApp</span><b>${esc(profile.phone || "Pendiente")}</b></div><div><span>Cuenta principal</span><b>${profile.primary_social_url ? `<a href="${esc(profile.primary_social_url)}" target="_blank">Abrir link</a>` : "Pendiente"}</b></div><div><span>Redes activas</span><b>${accounts.filter((a) => a.active).length}</b></div><div><span>Reportes</span><b>${reports.length}</b></div><div><span>Estado</span><b>${profile.active ? "Activo" : "Suspendido"}</b></div></div><div class="actions"><button id="editAdminProfile" class="btn btn-secondary">Editar datos</button></div></div>`;
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
        <div class="divider"></div><h3>Diagnóstico</h3><button id="runDiagnosticsBtn" class="btn btn-dark">🩺 Revisar sistema</button><div id="diagnosticsBox" style="margin-top:12px"></div>
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
    button.textContent = "🩺 Ejecutar diagnóstico";
  }

  window.addEventListener("DOMContentLoaded", init);
})();
