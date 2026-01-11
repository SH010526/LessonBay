/* ============================
   LessonBay (Static + localStorage) ? v12 FIXED (NO-REDUCE)
   - ? Enrollment/Enter/Replay gating 안정화 + UI 반영
     1) enrollment를 ""(빈키)로 저장하지 않음 (읽기는 레거시 호환)
     2) 수강완료 즉시 상세페이지 버튼/문구 갱신(수강중/만료/재수강)
     3) 재생 버튼은 모달로 연결
     4) 라이브에서 선생님(본인수업)만 녹화 가능 + 녹화 종료 시 다시보기 자동 등록(데모)
   - Keeps v11 fixes:
       migration/normalize, enter btn detection, tolerant endAt parsing,
       <a> disabled blocker, file upload(DataURL), dashboards separation, etc.
   ============================ */

/* ============================
   ? Supabase Auth (메일 인증)
   - login/signup을 localStorage가 아니라 Supabase로 통일
   - user_metadata에 name/role 저장
   - 세션 기반으로 localStorage(K.USER) 동기화해서
     기존 UI/권한 로직(teacher/student)을 그대로 살림
   ============================ */

const SUPABASE_URL = "https://pqvdexhxytahljultmjd.supabase.co";   // Project URL
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxdmRleGh4eXRhaGxqdWx0bWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NjMzNTMsImV4cCI6MjA4MTUzOTM1M30.WzJWY3-92Bwkic-Wb2rOmZ1joEUj-s69cSL2hPT79fQ";             // anon public key
const SUPABASE_SDK_SRC = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
const STORAGE_BUCKET = "LessonBay"; // Supabase Storage 버킷 이름
const SUPABASE_PROJECT_REF = (() => {
  try {
    return new URL(SUPABASE_URL).hostname.split(".")[0] || "";
  } catch (_) {
    return "";
  }
})();

// ? SDK가 없는 페이지에서도 크래시 나지 않게 (전역 supabase와 이름 충돌 방지)
let supabaseClient = null;
let __supabaseSdkPromise = null;
function ensureSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  try {
    if (typeof window !== "undefined" && window.supabase && typeof window.supabase.createClient === "function") {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    }
  } catch (e) {
    supabaseClient = null;
  }
  return supabaseClient;
}
ensureSupabaseClient();

function loadSupabaseSdkOnce() {
  if (typeof document === "undefined") return Promise.resolve(null);
  if (window.supabase && typeof window.supabase.createClient === "function") {
    return Promise.resolve(window.supabase);
  }
  if (__supabaseSdkPromise) return __supabaseSdkPromise;

  __supabaseSdkPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SUPABASE_SDK_SRC}"]`);
    if (existing && (existing.dataset.loaded === "1")) {
      resolve(window.supabase || null);
      return;
    }
    const s = existing || document.createElement("script");
    if (!existing) {
      s.src = SUPABASE_SDK_SRC;
      s.async = true;
      s.setAttribute("data-supabase-sdk", "1");
    }
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve(window.supabase || null);
    };
    s.onerror = () => {
      __supabaseSdkPromise = null;
      reject(new Error("Supabase SDK load failed"));
    };
    if (!existing) {
      (document.head || document.body || document.documentElement).appendChild(s);
    }
  });

  return __supabaseSdkPromise;
}

async function waitForSupabaseClient(timeoutMs = 8000, intervalMs = 150) {
  const start = Date.now();
  if (!supabaseClient) {
    try { await loadSupabaseSdkOnce(); } catch (_) {}
  }
  while (!supabaseClient && Date.now() - start < timeoutMs) {
    ensureSupabaseClient();
    if (supabaseClient) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return supabaseClient;
}

// OTP 백엔드 API
const API_BASE_URL = (() => {
  if (typeof window !== "undefined" && window.location) {
    const origin = window.location.origin || "";
    // 프로덕션(railway/custom 도메인)은 동일 origin 사용
    if (origin.includes("railway.app") || origin.includes("lessonbay")) return origin;
    // 로컬 5500(정적)에서 백엔드 3000으로 우회
    if (origin.includes("127.0.0.1:5500") || origin.includes("localhost:5500")) return "http://localhost:3000";
    return origin || "http://localhost:3000";
  }
  return "http://localhost:3000";
})();

// In-memory caches (no localStorage/IndexedDB)
let userCache = null;
let __authInvalidated = false;
let enrollmentsSynced = false;
let enrollmentsSyncing = false;
let enrollmentsLastAt = 0;
let enrollmentsLastError = null;
let enrollFetchPromise = null;
let enrollFetchKey = "";
const dataCache = {
  classes: [],
  enrollments: {},   // userKey -> classId -> record
  replays: {},       // classId -> [replay]
  chat: {},          // classId -> [messages]
  materials: {},     // classId -> [materials]
  assignments: {},   // classId -> [assignments + submissions]
  assignMeta: {},    // legacy compatibility, kept empty
  reviews: {},       // classId -> [reviews]
  qna: {},           // classId -> [questions with comments]
  attendance: {},    // classId -> [rows]
  progress: {},      // classId -> [rows]
};

// API helper
async function apiHeaders() {
  const token = await getAuthToken();
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function readSupabaseSessionFromStorage(storage) {
  try {
    if (!storage) return null;
    const keys = [];
    if (SUPABASE_PROJECT_REF) keys.push(`sb-${SUPABASE_PROJECT_REF}-auth-token`);
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (!k || !k.startsWith("sb-") || !k.endsWith("-auth-token")) continue;
      if (!keys.includes(k)) keys.push(k);
    }
    for (const k of keys) {
      const raw = storage.getItem(k);
      if (!raw) continue;
      const parsed = safeParse(raw, null);
      if (!parsed) continue;
      if (parsed.access_token || parsed.refresh_token) return parsed;
      if (parsed.currentSession) return parsed.currentSession;
      if (parsed.data?.session) return parsed.data.session;
    }
  } catch (_) {}
  return null;
}

function readSupabaseTokenFromStorage() {
  const session =
    readSupabaseSessionFromStorage(typeof localStorage !== "undefined" ? localStorage : null) ||
    readSupabaseSessionFromStorage(typeof sessionStorage !== "undefined" ? sessionStorage : null);
  return session?.access_token || "";
}

async function getAuthToken() {
  ensureSupabaseClient();
  let token = "";
  if (supabaseClient?.auth?.getSession) {
    try {
      const { data } = await supabaseClient.auth.getSession();
      token = data?.session?.access_token || "";
    } catch (_) {}
  }
  let storedSession = null;
  if (!token) {
    storedSession =
      readSupabaseSessionFromStorage(typeof localStorage !== "undefined" ? localStorage : null) ||
      readSupabaseSessionFromStorage(typeof sessionStorage !== "undefined" ? sessionStorage : null);
    token = storedSession?.access_token || "";
  }
  if (!token && storedSession?.refresh_token && supabaseClient?.auth?.refreshSession) {
    try {
      const { data } = await supabaseClient.auth.refreshSession({
        refresh_token: storedSession.refresh_token,
      });
      token = data?.session?.access_token || "";
    } catch (_) {}
  }
  return token;
}

// 단순 로딩 오버레이
let loadingCount = 0;
let toastTimer = null;
let loadingTimer = null;

function showToast(msg, type = "info", duration = 3000) {
  if (!msg) return;
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.style.position = "fixed";
    el.style.bottom = "20px";
    el.style.right = "20px";
    el.style.padding = "12px 14px";
    el.style.borderRadius = "8px";
    el.style.color = "#fff";
    el.style.zIndex = "9999";
    el.style.boxShadow = "0 6px 16px rgba(0,0,0,0.2)";
    el.style.fontSize = "14px";
    document.body.appendChild(el);
  }
  const colors = {
    info: "rgba(55, 114, 255, 0.9)",
    success: "rgba(40, 167, 69, 0.9)",
    warn: "rgba(255, 193, 7, 0.9)",
    danger: "rgba(220, 53, 69, 0.9)",
  };
  el.style.background = colors[type] || colors.info;
  el.textContent = msg;
  el.style.display = "block";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.display = "none";
  }, duration);
}

function showLoading() {
  loadingCount += 1;
  if (!loadingTimer) {
    loadingTimer = setTimeout(() => {
      let el = document.getElementById("globalLoading");
      if (!el) {
        el = document.createElement("div");
        el.id = "globalLoading";
        el.style.position = "fixed";
        el.style.inset = "0";
        el.style.background = "rgba(0,0,0,0.08)";
        el.style.display = "flex";
        el.style.alignItems = "center";
        el.style.justifyContent = "center";
        el.style.zIndex = "9999";
        el.style.fontSize = "16px";
        el.style.color = "#fff";
        el.style.backdropFilter = "none";
        el.style.pointerEvents = "none"; // 화면 상호작용 차단 안 함.
        el.innerHTML = `<div style="padding:12px 14px; background:rgba(15,23,42,0.85); border-radius:10px; box-shadow:0 8px 20px rgba(0,0,0,0.16);">잠시만요... 처리 중이에요</div>`;
        el.style.display = "none";
        document.body.appendChild(el);
      }
      el.style.display = "flex";
      loadingTimer = null;
    }, 800); // 0.8s 이상 걸리는 요청만 오버레이 표시
  }
}
function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0 && loadingTimer) {
    clearTimeout(loadingTimer);
    loadingTimer = null;
  }
  const el = document.getElementById("globalLoading");
  if (el && loadingCount === 0) el.style.display = "none";
}

function scheduleAfterPaint(fn) {
  if (typeof fn !== "function") return;
  if (typeof window === "undefined") {
    fn();
    return;
  }
  const run = () => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(fn, 0);
        });
      });
    } else {
      setTimeout(fn, 0);
    }
  };
  if (document.readyState === "complete" || document.readyState === "interactive") {
    run();
  } else {
    window.addEventListener("DOMContentLoaded", run, { once: true });
  }
}

function scheduleIdleTask(fn, timeout = 800) {
  if (typeof fn !== "function") return null;
  if (typeof requestIdleCallback === "function") {
    return requestIdleCallback(() => fn(), { timeout });
  }
  return setTimeout(fn, Math.min(timeout, 300));
}

const PAGE_SCRIPTS = [
  { selector: "#homePopular", fn: "loadHomePopular", src: "pages/home.js" },
  { selector: "#classGrid", fn: "loadClassesPage", src: "pages/classes.js" },
  { selector: "#detailRoot", fn: "loadClassDetailPage", src: "pages/class_detail.js" },
  { selector: "#createClassForm", fn: "handleCreateClassPage", src: "pages/create_class.js" },
  { selector: "#loginForm", fn: "handleLoginPage", src: "pages/auth.js" },
  { selector: "#signupForm", fn: "handleSignupPage", src: "pages/auth.js" },
  { selector: "#settingsRoot", fn: "handleSettingsPage", src: "pages/settings.js" },
  { selector: "#teacherDash", fn: "loadTeacherDashboard", src: "pages/teacher_dashboard.js" },
  { selector: "#studentDash", fn: "loadStudentDashboard", src: "pages/student_dashboard.js" },
  { selector: "#liveRoot", fn: "loadLivePage", src: "pages/live_class.js" },
];
const __pageScriptPromises = {};

function loadPageScript(src) {
  if (!src || typeof document === "undefined") return Promise.reject(new Error("no src"));
  if (__pageScriptPromises[src]) return __pageScriptPromises[src];
  __pageScriptPromises[src] = new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-page-src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.defer = true;
    s.setAttribute("data-page-src", src);
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`page script load failed: ${src}`));
    (document.head || document.body || document.documentElement).appendChild(s);
  });
  return __pageScriptPromises[src];
}

function bootPageScripts() {
  if (typeof document === "undefined") return;
  PAGE_SCRIPTS.forEach((p) => {
    if (!p.selector || !p.fn || !p.src) return;
    if (!document.querySelector(p.selector)) return;
    if (typeof window[p.fn] === "function") return;
    loadPageScript(p.src)
      .then(() => {
        if (typeof window[p.fn] === "function") window[p.fn]();
      })
      .catch((err) => console.error(err));
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1000) {
  if (!timeoutMs) return fetch(url, options); // 의미 : 타임아웃이 아니라면 그냥 fetch 실행
  // 
  //fetch 뜻 : 자바스크립트에서 제공하는 내장 함수로, 네트워크를 통해 리소스를 비동기적으로 가져오는 데 사용됩니다.
  // 네트워크를 통해 리소스를 비동기적으로 가져온다는 의미 : fetch는 네트워크 요청을 비동기적으로 처리하여, 페이지가 로딩되는 동안 다른 작업을 할 수 있도록 합니다.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // assertion 304 뜻 : HTTP 상태 코드 304는 "Not Modified"를 의미하며, 클라이언트가 요청한 리소스가 서버에서 변경되지 않았음을 나타냅니다.
  //위의 글의 의미 : 즉, 클라이언트가 이전에 받은 리소스를 다시 요청했을 때, 서버는 해당 리소스가 변경되지 않았으므로 클라이언트에게 동일한 리소스를 다시 보내지 않고, 
  // 클라이언트가 캐시된 버전을 사용할 수 있도록 지시합니다.

  try {
    return await fetch(url, { ...options, signal: controller.signal }); // abort signal 뜻 : 요청이 타임아웃되었을 때 요청을 중단하는 신호
    //현재 타임아웃 시간은 1000ms로 설정되어 있습니다. 이 값은 fetch 요청이 1초 이상 걸릴 경우 요청을 중단하도록 지정합니다.
  } finally {
    clearTimeout(timer);
  }
}

async function apiGet(path, opts = {}) {
  const silent = !!opts.silent;
  const timeoutMs = Number(opts.timeout) || 0;
  const tolerateTimeout = !!opts.tolerateTimeout;
  if (!silent) showLoading();
  try {
    const res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
      headers: await apiHeaders(),
    }, timeoutMs);
    if (!res.ok) {
      if (res.status === 401) handleUnauthorized();
      const txt = await res.text();
      if (!silent) showToast(txt || "요청 실패", "danger");
      throw new Error(txt);
    }
    return res.json();
  } catch (e) {
    if (e?.name === "AbortError" && tolerateTimeout) return null;
    throw e;
  } finally {
    if (!silent) hideLoading();
  }
}

async function apiPost(path, body) {
  showLoading();
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: await apiHeaders(),
      body: JSON.stringify(body || {}),
    });
    if (res.ok) return res.json();
    if (res.status === 401) handleUnauthorized();

    // 응답 본문은 한 번만 소비 가능하므로 text로 읽고 JSON 시도
    const raw = await res.text();
    try {
      const data = raw ? JSON.parse(raw) : null;
      const msg = data?.detail || data?.error || raw || "알 수 없는 오류";
      showToast(msg, "danger");
      throw new Error(msg);
    } catch (_) {
      showToast(raw || "알 수 없는 오류", "danger");
      throw new Error(raw || "알 수 없는 오류");
    }
  } finally {
    hideLoading();
  }
}

// generic request (for DELETE 등)
async function apiRequest(path, method = "GET", body = null) {
  showLoading();
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: await apiHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    if (res.status === 401) handleUnauthorized();
    const raw = await res.text();
    try {
      const data = raw ? JSON.parse(raw) : null;
      const msg = data?.detail || data?.error || raw || "알 수 없는 오류";
      showToast(msg, "danger");
      throw new Error(msg);
    } catch (_) {
      showToast(raw || "알 수 없는 오류", "danger");
      throw new Error(raw || "알 수 없는 오류");
    }
  } finally {
    hideLoading();
  }
}

const FALLBACK_THUMB =
  "https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=1400&q=60";

const K = {
  USER: "lc_user",
  USERS: "lc_users",
  CLASSES: "lc_classes",
  ENROLL: "lc_enrollments",
  REPLAY: "lc_replays",
  CHAT: "lc_chat",
  MATERIALS: "lc_materials",
  ASSIGN: "lc_assignments",
  ASSIGN_META: "lc_assign_meta",
  REVIEWS: "lc_reviews",
  QNA: "lc_qna",
  ATTEND: "lc_attendance",
  PROGRESS: "lc_progress",
  SEEDED: "lc_seeded_v1",
};

// ? VOD(녹화) 저장소: 메모리 (IndexedDB 사용 안 함)
const VOD_MEM = new Map(); // vodKey -> Blob

async function uploadToSupabaseStorage(file, prefix = "uploads") {
  ensureSupabaseClient();
  if (!supabaseClient) {
    await waitForSupabaseClient(8000);
  }
  if (!supabaseClient) throw new Error("Supabase SDK를 불러올 수 없습니다.");
  const safeName = (file.name || "file")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
  const path = `${prefix}/${Date.now()}-${safeName}`;
  const { error } = await supabaseClient.storage.from(STORAGE_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
  });
  if (error) throw error;
  // 7일짜리 서명 URL
  const { data: signed, error: signErr } = await supabaseClient.storage.from(STORAGE_BUCKET).createSignedUrl(path, 60 * 60 * 24 * 7);
  if (signErr) throw signErr;
  return { path, signedUrl: signed?.signedUrl || null };
}

function buildPublicStorageUrl(path, bucket = STORAGE_BUCKET) {
  if (!path || isHttpLike(path) || path.startsWith("data:")) return path || null;
  const { bucket: b, path: p } = normalizeStoragePath(path, bucket);
  const clean = String(p || "").replace(/^\/+/, "");
  const withBucket = b ? `${b}/${clean}` : clean;
  return `${SUPABASE_URL}/storage/v1/object/public/${withBucket}`;
}

function normalizeStoragePath(path, defaultBucket = STORAGE_BUCKET) {
  const clean = String(path || "").replace(/^\/+/, "");
  const parts = clean.split("/");
  const knownPrefixes = new Set(["class-thumbs", "materials", "replays", "uploads"]);
  if (parts.length > 1 && knownPrefixes.has(parts[1])) {
    return { bucket: parts[0], path: parts.slice(1).join("/") };
  }
  return { bucket: defaultBucket, path: clean };
}

function parseSupabaseStorageUrl(urlStr) {
  if (!urlStr || !isHttpLike(urlStr)) return null;
  try {
    const u = new URL(urlStr);
    if (!u.hostname.includes("supabase.co")) return null;
    const m = u.pathname.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)/);
    if (!m) return null;
    return { bucket: m[1], path: m[2] };
  } catch (_) {
    return null;
  }
}

const STORAGE_SIGN_TTL_MS = 1000 * 60 * 20;
const storageSignedCache = new Map();

function getCachedSignedUrl(key) {
  const hit = storageSignedCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    storageSignedCache.delete(key);
    return null;
  }
  return hit.url || null;
}

function setCachedSignedUrl(key, url) {
  if (!url) return;
  storageSignedCache.set(key, { url, expiresAt: Date.now() + STORAGE_SIGN_TTL_MS });
}

async function signStorageViaApi(bucket, path, filename) {
  if (!path) return null;
  try {
    const params = new URLSearchParams();
    if (bucket) params.set("bucket", bucket);
    params.set("path", path);
    if (filename) params.set("download", filename);
    const res = await apiGet(`/api/storage/sign?${params.toString()}`, { silent: true });
    return res?.signedUrl || null;
  } catch (_) {
    return null;
  }
}

async function resolveStorageUrl(urlOrPath) {
  ensureSupabaseClient();
  if (!urlOrPath || urlOrPath.startsWith("data:")) return urlOrPath;
  if (isHttpLike(urlOrPath)) {
    const parsed = parseSupabaseStorageUrl(urlOrPath);
    if (!parsed) return urlOrPath;
    const cacheKey = `view:${parsed.bucket}/${parsed.path}`;
    const cached = getCachedSignedUrl(cacheKey);
    if (cached) return cached;
    if (supabaseClient) {
      const { data, error } = await supabaseClient.storage.from(parsed.bucket).createSignedUrl(parsed.path, 60 * 60 * 24);
      if (!error && data?.signedUrl) {
        setCachedSignedUrl(cacheKey, data.signedUrl);
        return data.signedUrl;
      }
    }
    const apiSigned = await signStorageViaApi(parsed.bucket, parsed.path);
    if (apiSigned) {
      setCachedSignedUrl(cacheKey, apiSigned);
      return apiSigned;
    }
    return buildPublicStorageUrl(parsed.path, parsed.bucket) || urlOrPath;
  }
  const norm = normalizeStoragePath(urlOrPath, STORAGE_BUCKET);
  const cacheKey = `view:${norm.bucket}/${norm.path}`;
  const cached = getCachedSignedUrl(cacheKey);
  if (cached) return cached;
  if (supabaseClient) {
    const { data, error } = await supabaseClient.storage.from(norm.bucket).createSignedUrl(norm.path, 60 * 60 * 24);
    if (!error && data?.signedUrl) {
      setCachedSignedUrl(cacheKey, data.signedUrl);
      return data.signedUrl;
    }
  }
  const apiSigned = await signStorageViaApi(norm.bucket, norm.path);
  if (apiSigned) {
    setCachedSignedUrl(cacheKey, apiSigned);
    return apiSigned;
  }
  return buildPublicStorageUrl(norm.path, norm.bucket) || urlOrPath;
}
async function resolveStorageDownloadUrl(path, filename) {
  ensureSupabaseClient();
  if (!path) return path;

  const addDownloadParam = (url, fname) => {
    try {
      const u = new URL(url);
      if (!u.searchParams.has("download") && fname) u.searchParams.set("download", fname);
      return u.toString();
    } catch (_) {
      return url;
    }
  };

  // 이미 서명된 전체 URL인 경우에도 download 파라미터를 보장
  if (/^https?:\/\//i.test(path) || path.startsWith("data:")) {
    const parsed = parseSupabaseStorageUrl(path);
    if (!parsed) return addDownloadParam(path, filename || "download");
    const cacheKey = `dl:${parsed.bucket}/${parsed.path}?${filename || ""}`;
    const cached = getCachedSignedUrl(cacheKey);
    if (cached) return addDownloadParam(cached, filename || "download");
    if (supabaseClient) {
      const opts2 = filename ? { download: filename } : undefined;
      const { data, error } = await supabaseClient.storage.from(parsed.bucket).createSignedUrl(parsed.path, 60 * 60 * 24, opts2);
      if (!error && data?.signedUrl) {
        setCachedSignedUrl(cacheKey, data.signedUrl);
        return addDownloadParam(data.signedUrl, filename || "download");
      }
    }
    const apiSigned = await signStorageViaApi(parsed.bucket, parsed.path, filename);
    if (apiSigned) {
      setCachedSignedUrl(cacheKey, apiSigned);
      return addDownloadParam(apiSigned, filename || "download");
    }
    return addDownloadParam(buildPublicStorageUrl(parsed.path, parsed.bucket) || path, filename || "download");
  }

  const norm = normalizeStoragePath(path, STORAGE_BUCKET);
  const cacheKey = `dl:${norm.bucket}/${norm.path}?${filename || ""}`;
  const cached = getCachedSignedUrl(cacheKey);
  if (cached) return addDownloadParam(cached, filename || "download");
  if (supabaseClient) {
    const opts = filename ? { download: filename } : undefined;
    const { data, error } = await supabaseClient.storage.from(norm.bucket).createSignedUrl(norm.path, 60 * 60 * 24, opts);
    if (!error && data?.signedUrl) {
      setCachedSignedUrl(cacheKey, data.signedUrl);
      return addDownloadParam(data.signedUrl, filename || "download");
    }
  }
  const apiSigned = await signStorageViaApi(norm.bucket, norm.path, filename);
  if (apiSigned) {
    setCachedSignedUrl(cacheKey, apiSigned);
    return addDownloadParam(apiSigned, filename || "download");
  }
  return buildPublicStorageUrl(norm.path, norm.bucket) || path;
}

function encodeDataUrlWithName(dataUrl, fname) {
  if (!dataUrl || !dataUrl.startsWith("data:")) return dataUrl;
  const parts = dataUrl.split(";base64,");
  if (parts.length !== 2) return dataUrl;
  const [meta, b64] = parts;
  const name = encodeURIComponent(fname || "file");
  return `${meta};name=${name};base64,${b64}`;
}

function triggerDownload(url, filename = "download") {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "download";
  a.rel = "noopener";
  a.target = "_self";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function forceDownload(url, filename = "download") {
  try {
    if (!url) throw new Error("empty url");
    if (url.startsWith("data:") || url.startsWith("blob:")) {
      triggerDownload(url, filename);
      showToast("다운로드를 시작했습니다.", "success");
      return;
    }
    triggerDownload(url, filename);
    showToast("다운로드를 시작했습니다.", "success");
  } catch (err) {
    console.error("forceDownload failed", err);
    // 마지막 수단: 현재 탭 이동 (팝업 차단 방지)
    try { location.href = url; } catch (_) {}
  }
}

/* ============================
   ? Supabase session -> local user sync
   ============================ */
async function syncLocalUserFromSupabaseSession() {
  ensureSupabaseClient();
  const applySession = (session) => {
    if (!session || !session.user) return false;
    const u = session.user;
    const email = String(u.email || "").trim();
    const name = String(u.user_metadata?.name || "").trim() || (email ? email.split("@")[0] : "사용자");
    const roleMeta = u.user_metadata?.role;
    const role = (roleMeta === "teacher" || roleMeta === "student" || roleMeta === "admin")
      ? roleMeta
      : "student";
    setUser({ id: u.id, name, role, email });
    return true;
  };
  if (!supabaseClient || !supabaseClient.auth?.getSession) {
    const stored =
      readSupabaseSessionFromStorage(typeof localStorage !== "undefined" ? localStorage : null) ||
      readSupabaseSessionFromStorage(typeof sessionStorage !== "undefined" ? sessionStorage : null);
    if (!applySession(stored)) setUser(null);
    return;
  }

  try {
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const session = sessionData?.session || null;

    if (!session || !session.user) {
      setUser(null);
      return;
    }
    applySession(session);
  } catch (_) {
    const stored =
      readSupabaseSessionFromStorage(typeof localStorage !== "undefined" ? localStorage : null) ||
      readSupabaseSessionFromStorage(typeof sessionStorage !== "undefined" ? sessionStorage : null);
    if (!applySession(stored)) setUser(null);
  }
}

async function supabaseSignupWithEmailConfirm(name, email, password, role) {
  // OTP 방식: 서버로 6자리 코드 발송 요청
  return apiPost("/api/auth/send-otp", {
    name,
    email,
    password,
    role: role === "teacher" ? "teacher" : "student",
  });
}

async function supabaseLogin(email, password) {
  ensureSupabaseClient();
  if (!supabaseClient) {
    await waitForSupabaseClient(8000);
  }
  if (!supabaseClient) throw new Error("Supabase SDK 로딩에 실패했습니다. 새로고침 후 다시 시도해 주세요.");

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    throw error;
  }

  // 로그인 성공 -> 로컬 user 동기화
  await syncLocalUserFromSupabaseSession();
  return data;
}

/* ============================
   기존 코드 시작 (원본 유지)
   ============================ */

async function vodPut(vodKey, blob) {
  if (!vodKey || !blob) return false;
  VOD_MEM.set(vodKey, blob);
  return true;
}

async function vodGet(vodKey) {
  return VOD_MEM.get(vodKey) || null;
}

async function vodDelete(vodKey) {
  VOD_MEM.delete(vodKey);
  return true;
}

// ============================
// ? VOD 함수명 호환
// ============================
async function vodPutBlob(vodKey, blob) { return vodPut(vodKey, blob); }
async function vodGetBlob(vodKey) { return vodGet(vodKey); }
async function vodDeleteBlob(vodKey) { return vodDelete(vodKey); }

// 모달 코드에 saveClasses가 등장하는데, 실제 저장 함수는 setClasses임(호환 래퍼)
function saveClasses(list) { return setClasses(list); }

// ? VOD 데모 영상(Blob) 생성
async function makeDemoVodBlob(title = "VOD") {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas ctx not available");

  const stream = canvas.captureStream ? canvas.captureStream(30) : null;
  if (!stream) throw new Error("captureStream not supported");
  if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder not supported");

  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  const mimeType = candidates.find((t) => {
    try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
  }) || "";

  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  let t = 0;
  const start = performance.now();

  const draw = () => {
    const now = performance.now();
    t = (now - start) / 1000;

    ctx.fillStyle = "#eef2ff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const pad = 72;
    const w = canvas.width - pad * 2;
    const h = canvas.height - pad * 2;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    roundRect(ctx, pad, pad, w, h, 28, true, false);

    ctx.fillStyle = "#0f172a";
    ctx.font = "700 48px Pretendard, system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.fillText("VOD Demo", pad + 56, pad + 120);

    ctx.fillStyle = "rgba(15,23,42,0.7)";
    ctx.font = "500 28px Pretendard, system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.fillText(title, pad + 56, pad + 170);

    const cx = pad + 90 + ((Math.sin(t * 2) + 1) / 2) * (w - 180);
    const cy = pad + 260 + ((Math.cos(t * 1.5) + 1) / 2) * (h - 360);
    ctx.beginPath();
    ctx.fillStyle = "#6D5EFC";
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(15,23,42,0.55)";
    ctx.font = "600 26px Pretendard, system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.fillText(`00:${String(Math.floor(t)).padStart(2, "0")}`, pad + 56, pad + h - 70);
  };

  function roundRect(_ctx, x, y, w, h, r, fill, stroke) {
    const min = Math.min(w, h);
    if (r > min / 2) r = min / 2;
    _ctx.beginPath();
    _ctx.moveTo(x + r, y);
    _ctx.arcTo(x + w, y, x + w, y + h, r);
    _ctx.arcTo(x + w, y + h, x, y + h, r);
    _ctx.arcTo(x, y + h, x, y, r);
    _ctx.arcTo(x, y, x + w, y, r);
    _ctx.closePath();
    if (fill) _ctx.fill();
    if (stroke) _ctx.stroke();
  }

  const fps = 30;
  const total = Math.floor(2.5 * fps);
  let frame = 0;

  return await new Promise((resolve, reject) => {
    rec.onstop = () => {
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
        resolve(blob);
      } catch (e) {
        reject(e);
      }
    };
    rec.onerror = (e) => reject(e.error || e);

    rec.start(200);

    const timer = setInterval(() => {
      frame++;
      draw();
      if (frame >= total) {
        clearInterval(timer);
        try { rec.stop(); } catch (e) { reject(e); }
      }
    }, 1000 / fps);
  });
}

try {
  if (typeof window !== "undefined") {
    window.__deleteVodBlob = (key) => { vodDelete(key); };
  }
} catch(_) {}

const OLD_USER_KEYS = ["currentUser", "LessonBay_currentUser", "user", "authUser"];
const OLD_USERS_KEYS = ["users", "LessonBay_users"];
const OLD_CLASSES_KEYS = ["classes", "LessonBay_classes", "classData"];
const OLD_ENROLL_KEYS = ["enrollments", "LessonBay_enrollments"];
const HTML_ROUTE_BASES = new Set([
  "index",
  "classes",
  "class_detail",
  "live_class",
  "teacher_dashboard",
  "student_dashboard",
  "create_class",
  "settings",
  "login",
  "signup",
  "logout",
  "privacy",
  "pay_success",
  "pay_fail",
]);
const HTML_QUERY_IGNORED = new Set([
  "class_detail",
  "live_class",
]);

// 과제 선택 유지용 임시 변수
let assignPendingSelect = null;
let __detailPageNonce = 0;

const $ = (sel, el = document) => el.querySelector(sel); 
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

function safeParse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}
function won(n) { return "\u20A9" + (Number(n) || 0).toLocaleString("ko-KR"); }
function getPath() {
  const raw = location.pathname.split("/").filter(Boolean).pop() || "index";
  if (raw.endsWith(".html")) return raw;
  if (HTML_ROUTE_BASES.has(raw)) return `${raw}.html`;
  return raw || "index.html";
}
function getParam(name) { return new URLSearchParams(location.search).get(name); }
const LAST_CLASS_KEY = "lessonbay:lastClassId";
const CLASS_CACHE_KEY = "lessonbay:classCacheV1";
const CLASS_DETAIL_CACHE_KEY = "lessonbay:classDetailCacheV1";
const PREFETCH_CLASS_KEY = "lessonbay:prefetchClassV1";
const ENROLL_CACHE_KEY = "lessonbay:enrollCacheV1";
const CACHE_TTL_MS = 1000 * 60 * 10; // 10분 캐시
const ENROLL_CACHE_TTL_MS = 1000 * 60 * 2; // 2분 캐시
const PREFETCH_PAGE_TTL_MS = 1000 * 60 * 5; // 5분 캐시
const PAGE_HTML_CACHE_TTL_MS = 1000 * 60 * 5; // 5분 캐시

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHttpLike(u) {
  return /^https?:\/\//i.test(u || "");
}

function isProdOrigin() {
  if (typeof location === "undefined") return false;
  const origin = location.origin || "";
  return origin.includes("railway.app") || origin.includes("lessonbay");
}

function initialThumbSrc(raw) {
  if (!raw) return FALLBACK_THUMB;
  if (isHttpLike(raw) || raw.startsWith("data:")) return raw;
  return FALLBACK_THUMB;
}

async function hydrateThumb(el, raw) {
  if (!el) return;
  if (!raw) { el.src = FALLBACK_THUMB; return; }
  if (isHttpLike(raw) || raw.startsWith("data:")) { el.src = raw; }
  else { el.src = FALLBACK_THUMB; }

  const retryCnt = Number(el.getAttribute("data-thumb-retry") || "0");
  if (!el.dataset.thumbErrorBound) {
    el.dataset.thumbErrorBound = "1";
    el.addEventListener("error", async () => {
      if (el.dataset.thumbFallback === "1") return;
      try {
        const refreshed = await resolveStorageUrl(raw);
        if (refreshed && refreshed !== el.src) {
          el.dataset.thumbFallback = "1";
          el.src = refreshed;
          return;
        }
      } catch (_) {}
      el.dataset.thumbFallback = "1";
      el.src = FALLBACK_THUMB;
    }, { once: true });
  }

  try {
    const signed = await resolveStorageUrl(raw);
    const candidate = signed || buildPublicStorageUrl(raw);
    if (candidate && (isHttpLike(candidate) || candidate.startsWith("data:"))) {
      el.src = candidate;
      return;
    }
  } catch (_) {
    // ignore
  }

  // supabaseClient가 아직 없거나 서명 실패 시 짧게 재시도 (최대 3회)
  if (retryCnt < 3) {
    el.setAttribute("data-thumb-retry", String(retryCnt + 1));
    setTimeout(() => hydrateThumb(el, raw), 400 * (retryCnt + 1));
  }
}

async function ensureUserReady(timeoutMs = 1200) {
  const sync = syncLocalUserFromSupabaseSession().catch(() => {});
  await Promise.race([sync, sleep(timeoutMs)]);
  return getUser();
}

function hydrateThumbs(ctx = document) {
  $$("img[data-thumb]", ctx).forEach((img) => {
    const raw = img.getAttribute("data-thumb") || "";
    hydrateThumb(img, raw);
  });
}

function slimClassForCache(c) {
  if (!c || typeof c !== "object") return null;
  const id = c.id || c.classId;
  if (!id) return null;
  return {
    id,
    title: c.title || "",
    teacher: c.teacher?.name || c.teacher || c.teacherName || "",
    teacherId: c.teacherId || c.teacher?.id || "",
    category: c.category || "",
    description: c.description || "",
    weeklyPrice: c.weeklyPrice ?? null,
    monthlyPrice: c.monthlyPrice ?? null,
    thumb: c.thumbUrl || c.thumb || FALLBACK_THUMB,
  };
}

function cacheClassList(list) {
  const slim = (Array.isArray(list) ? list : []).map(slimClassForCache).filter(Boolean);
  try { sessionStorage.setItem(CLASS_CACHE_KEY, JSON.stringify({ at: Date.now(), list: slim })); } catch (_) {}
}

function loadCachedClasses() {
  try {
    const raw = sessionStorage.getItem(CLASS_CACHE_KEY);
    if (!raw) return [];
    const parsed = safeParse(raw, null);
    if (!parsed?.list || !Array.isArray(parsed.list)) return [];
    if (parsed.at && Date.now() - parsed.at > CACHE_TTL_MS) return [];
    return parsed.list;
  } catch (_) {
    return [];
  }
}

function cacheClassDetail(cls) {
  const slim = slimClassForCache(cls);
  if (!slim) return;
  try {
    const raw = sessionStorage.getItem(CLASS_DETAIL_CACHE_KEY);
    const parsed = safeParse(raw, { map: {} }) || { map: {} };
    const map = parsed.map && typeof parsed.map === "object" ? parsed.map : {};
    map[slim.id] = { at: Date.now(), data: slim };
    sessionStorage.setItem(CLASS_DETAIL_CACHE_KEY, JSON.stringify({ map }));
  } catch (_) {}
}

function loadCachedClassDetail(id) {
  if (!id) return null;
  try {
    const raw = sessionStorage.getItem(CLASS_DETAIL_CACHE_KEY);
    if (!raw) return null;
    const parsed = safeParse(raw, null);
    const entry = parsed?.map?.[id];
    if (!entry?.data) return null;
    if (entry.at && Date.now() - entry.at > CACHE_TTL_MS) return null;
    return entry.data || null;
  } catch (_) {
    return null;
  }
}

function getUserCacheKey(user) {
  if (!user) return "";
  if (user.id) return `id:${user.id}`;
  const email = normalizeEmail(user.email || "");
  if (email) return `email:${email}`;
  const name = String(user.name || "").trim();
  return name ? `name:${name}` : "";
}

function cacheEnrollments(user, list) {
  const key = getUserCacheKey(user);
  if (!key) return;
  try {
    sessionStorage.setItem(ENROLL_CACHE_KEY, JSON.stringify({ at: Date.now(), key, list: list || [] }));
  } catch (_) {}
}

function loadCachedEnrollments(user) {
  try {
    const raw = sessionStorage.getItem(ENROLL_CACHE_KEY);
    if (!raw) return null;
    const parsed = safeParse(raw, null);
    if (!parsed?.list || !Array.isArray(parsed.list)) return null;
    if (parsed.at && Date.now() - parsed.at > ENROLL_CACHE_TTL_MS) return null;
    const key = getUserCacheKey(user);
    if (!key || parsed.key !== key) return null;
    return parsed.list;
  } catch (_) {
    return null;
  }
}

async function fetchEnrollmentsForUser(u, attempt = 0, opts = {}) {
  const key = getUserCacheKey(u);
  if (!key) return null;
  if (!opts.force && enrollFetchPromise && enrollFetchKey === key) return enrollFetchPromise;

  enrollFetchKey = key;
  enrollmentsSyncing = true;
  enrollmentsLastError = null;

  const timeoutMs = Number(opts.timeoutMs) || (attempt === 0 ? 5000 : 10000);
  enrollFetchPromise = (async () => {
    try {
      const token = await getAuthToken();
      if (!token) {
        if (attempt < 2) {
          setTimeout(() => fetchEnrollmentsForUser(u, attempt + 1, { force: true, timeoutMs }), 1200 * (attempt + 1));
        }
        return null;
      }
      const enrollList = await apiGet("/api/me/enrollments", { silent: true, timeout: timeoutMs, tolerateTimeout: false });
      if (Array.isArray(enrollList)) {
        setEnrollments(enrollList || []);
        cacheEnrollments(u, enrollList || []);
        markEnrollmentsSynced();
        return enrollList;
      }
      if (attempt < 2) {
        setTimeout(() => fetchEnrollmentsForUser(u, attempt + 1, { force: true, timeoutMs }), 4000 * (attempt + 1));
      }
      return enrollList || null;
    } catch (e) {
      enrollmentsLastError = e;
      if (attempt < 2) {
        setTimeout(() => fetchEnrollmentsForUser(u, attempt + 1, { force: true, timeoutMs }), 4000 * (attempt + 1));
      }
      return null;
    } finally {
      enrollmentsSyncing = false;
      enrollFetchPromise = null;
    }
  })();

  return enrollFetchPromise;
}

function prefetchPage(href) {
  if (!href || typeof document === "undefined") return;
  const url = href.split("#")[0];
  if (!url.endsWith(".html") && !url.includes(".html?") && !url.includes(".html&")) return;
  const key = `prefetch:${url}`;
  try {
    const cached = sessionStorage.getItem(key);
    if (cached) {
      const parsed = safeParse(cached, null);
      if (parsed?.at && Date.now() - parsed.at < PREFETCH_PAGE_TTL_MS) return;
    }
  } catch (_) {}
  if (document.querySelector(`link[data-prefetch="${url}"]`)) return;
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = url;
  link.setAttribute("data-prefetch", url);
  document.head.appendChild(link);
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now() }));
  } catch (_) {}

  // HTML 프리패치 캐시 (soft nav용)
  prefetchPageHtml(url);
}

function normalizePageHtmlUrl(url) {
  try {
    const u = new URL(url, location.href);
    const cleanPath = u.pathname.replace(/\/+$/, "") || "/";
    if (cleanPath === "/") {
      u.pathname = "/index.html";
      return u.toString();
    }
    const parts = cleanPath.split("/").filter(Boolean);
    const base = (parts[0] || "").replace(/\.html$/i, "");
    if (HTML_ROUTE_BASES.has(base)) {
      u.pathname = `/${base}.html`;
      if (HTML_QUERY_IGNORED.has(base)) u.search = "";
    }
    return u.toString();
  } catch (_) {
    return url;
  }
}

function pageHtmlCacheKey(url) {
  try {
    const u = new URL(normalizePageHtmlUrl(url), location.href);
    return `pagehtml:${u.pathname}${u.search || ""}`;
  } catch (_) {
    return `pagehtml:${url}`;
  }
}

function getCachedPageHtml(url) {
  try {
    const key = pageHtmlCacheKey(url);
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = safeParse(raw, null);
    if (!parsed?.html) return null;
    if (parsed.at && Date.now() - parsed.at > PAGE_HTML_CACHE_TTL_MS) return null;
    return parsed.html;
  } catch (_) {
    return null;
  }
}

function setCachedPageHtml(url, html) {
  if (!html) return;
  try {
    const key = pageHtmlCacheKey(url);
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), html }));
  } catch (_) {}
}

async function fetchPageHtml(url) {
  const normalized = normalizePageHtmlUrl(url);
  const cached = getCachedPageHtml(normalized);
  if (cached) return cached;
  const res = await fetch(normalized, { headers: { "X-Requested-With": "fetch" } });
  if (!res.ok) throw new Error(`page fetch failed: ${res.status}`);
  const html = await res.text();
  setCachedPageHtml(normalized, html);
  return html;
}

function prefetchPageHtml(url) {
  if (!url || typeof fetch === "undefined") return;
  const normalized = normalizePageHtmlUrl(url);
  if (getCachedPageHtml(normalized)) return;
  fetch(normalized, { headers: { "X-Requested-With": "fetch" } })
    .then((res) => (res.ok ? res.text() : null))
    .then((html) => { if (html) setCachedPageHtml(normalized, html); })
    .catch(() => {});
}

function prefetchCorePages() {
  if (!isProdOrigin()) return;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn?.saveData || /2g/.test(conn?.effectiveType || "")) return;
  const page = getPath();
  const plan = {
    "index.html": ["classes.html"],
    "classes.html": ["class_detail.html"],
    "class_detail.html": ["live_class.html", "classes.html"],
    "teacher_dashboard.html": ["class_detail.html"],
    "student_dashboard.html": ["class_detail.html"],
    "create_class.html": ["classes.html"],
    "live_class.html": ["class_detail.html"],
  };
  const pages = plan[page] || [];
  if (!pages.length) return;
  const run = () => pages.forEach(prefetchPage);
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 1500 });
  } else {
    setTimeout(run, 800);
  }
}

let __navPrefetchBound = false;
function bindNavPrefetch() {
  if (__navPrefetchBound) return;
  __navPrefetchBound = true;
  if (typeof document === "undefined") return;
  document.addEventListener("pointerenter", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (!href || href.startsWith("http")) return;
    prefetchPage(href);
  }, true);
}

let __warmupStarted = false;
let __warmupTimer = null;
function warmupBackend() {
  if (__warmupStarted) return;
  __warmupStarted = true;
  if (!isProdOrigin()) return;
  const ping = () => {
    try {
      fetch(`${API_BASE_URL}/api/health`, { cache: "no-store", keepalive: true }).catch(() => {});
    } catch (_) {}
  };
  ping();
  __warmupTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    ping();
  }, 60 * 1000);
}

function cachePrefetchClass(cls) {
  const slim = slimClassForCache(cls);
  if (!slim) return;
  try { sessionStorage.setItem(PREFETCH_CLASS_KEY, JSON.stringify({ at: Date.now(), cls: slim })); } catch (_) {}
}

function consumePrefetchClass(expectId) {
  try {
    const raw = sessionStorage.getItem(PREFETCH_CLASS_KEY);
    if (!raw) return null;
    const parsed = safeParse(raw, null);
    if (!parsed?.cls) return null;
    if (parsed.at && Date.now() - parsed.at > CACHE_TTL_MS) return null;
    if (expectId && parsed.cls.id !== expectId) return null;
    return parsed.cls;
  } catch (_) {
    return null;
  } finally {
    try { sessionStorage.removeItem(PREFETCH_CLASS_KEY); } catch (_) {}
  }
}

function rememberClassId(id) {
  if (!id) return;
  try { sessionStorage.setItem(LAST_CLASS_KEY, String(id)); } catch (_) {}
}
function readLastClassId() {
  try { return sessionStorage.getItem(LAST_CLASS_KEY) || ""; } catch (_) { return ""; }
}
function resolveClassIdFromUrl() {
  const fromQuery = getParam("id");
  if (fromQuery) return fromQuery;

  const path = (typeof location !== "undefined" && location.pathname) ? location.pathname : "";
  const segments = path.split("/").filter(Boolean);
  const last = segments.pop() || "";
  const ignore = new Set(["class_detail", "classes", "class", "live_class", "live", "index"]);
  if (last && !ignore.has(last.toLowerCase()) && !last.includes(".")) {
    return decodeURIComponent(last);
  }

  // 쿼리 유실 시 마지막으로 열었던 수업 ID로 복원
  return readLastClassId();
}
const SOFT_NAV_ENABLED = true;
let __softNavBound = false;
let __softNavInFlight = false;

function isSameOrigin(url) {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin;
  } catch (_) {
    return false;
  }
}

function isHtmlRoute(url) {
  try {
    const u = new URL(url, location.href);
    const p = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (!p || p === "/") return true;
    if (p.endsWith(".html")) return true;
    const base = p.split("/").filter(Boolean)[0] || "";
    return HTML_ROUTE_BASES.has(base);
  } catch (_) {
    return false;
  }
}

function shouldSoftNavigate(url) {
  if (!SOFT_NAV_ENABLED) return false;
  if (!url) return false;
  if (url.startsWith("http") && !isSameOrigin(url)) return false;
  if (!isHtmlRoute(url)) return false;
  return true;
}

async function softNavigate(url, opts = {}) {
  if (__softNavInFlight) return;
  __softNavInFlight = true;
  const replace = !!opts.replace;
  try {
    const u = new URL(url, location.href);
    if (u.hash && u.pathname === location.pathname && u.search === location.search) {
      location.hash = u.hash;
      return;
    }
    const html = await fetchPageHtml(u.toString());
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (doc?.title) document.title = doc.title;
    const body = doc.body;
    if (!body) return;
    document.body.innerHTML = body.innerHTML;
    if (replace) history.replaceState({}, "", u.toString());
    else history.pushState({}, "", u.toString());
    window.scrollTo(0, 0);
    try { init(); } catch (e) { console.error("soft nav init failed", e); }
  } catch (e) {
    console.error("soft nav failed", e);
    location.href = url;
  } finally {
    __softNavInFlight = false;
  }
}

function navigateTo(url, opts = {}) {
  if (shouldSoftNavigate(url)) {
    softNavigate(url, opts);
    return;
  }
  if (opts.replace) location.replace(url);
  else location.href = url;
}

function bindSoftNavigation() {
  if (__softNavBound) return;
  __softNavBound = true;
  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    if (a.hasAttribute("download")) return;
    const target = (a.getAttribute("target") || "").toLowerCase();
    if (target && target !== "_self") return;
    const href = a.getAttribute("href") || "";
    if (!shouldSoftNavigate(href)) return;
    e.preventDefault();
    navigateTo(href);
  });

  window.addEventListener("popstate", () => {
    if (!shouldSoftNavigate(location.href)) return;
    softNavigate(location.href, { replace: true });
  });
}
function goClassDetail(id, hash = "") {
  if (!id) return;
  const cls = getClasses().find(x => x.id === id);
  if (cls) {
    cachePrefetchClass(cls);
    cacheClassDetail(cls);
  }
  rememberClassId(id);
  const suffix = hash ? (hash.startsWith("#") ? hash : `#${hash}`) : "";
  navigateTo(`class_detail.html?id=${encodeURIComponent(id)}${suffix}`);
}
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function displayUserName(obj) {
  const pick = (v) => (v && String(v).trim()) ? String(v).trim() : "";
  const name = pick(obj?.userName) || pick(obj?.name) || pick(obj?.user?.name);
  if (name) return name;
  const email = pick(obj?.userEmail) || pick(obj?.email) || pick(obj?.user?.email);
  if (email && email.includes("@")) return email.split("@")[0] || "사용자";
  const id = pick(obj?.userId) || pick(obj?.id) || pick(obj?.user?.id);
  if (id && id.includes("-") && id.length > 15) return "사용자";
  if (id) return id;
  return "사용자";
}
function displayUserRole(obj) {
  const role = (obj?.userRole || obj?.role || obj?.user?.role || "").toLowerCase();
  if (role === "teacher") return "선생님";
  if (role === "student") return "학생";
  return "사용자";
}
function escapeAttr(s) { return escapeHtml(s); }
async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    try {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ""));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    } catch (e) {
      reject(e);
    }
  });
}
function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }
function isOwnerTeacherForClass(user, cls) {
  if (!user || !cls) return false;
  if (user.role !== "teacher") return false;
  if (user.id && cls.teacherId) return user.id === cls.teacherId;
  if (user.name && cls.teacher) return user.name === cls.teacher;
  return false;
}

// ---------------------------
// ? BUTTON LOADING (signup 등에서 사용)
// - 기존 코드에서 setBtnLoading을 호출하지만 구현이 누락되어 있었음.
// - 구현 누락 시 '가입하기' 클릭해도 콘솔 에러로 인해 화면상 아무 반응이 없는 것처럼 보임.
// ---------------------------
function setBtnLoading(btn, loading, loadingText = "처리중...", idleText = null) {
  if (!btn) return;

  // 최초 상태 저장
  if (!btn.dataset.idleHtml) btn.dataset.idleHtml = btn.innerHTML;
  if (!btn.dataset.idleDisabled) btn.dataset.idleDisabled = btn.disabled ? "1" : "0";
  if (idleText !== null && !btn.dataset.idleText) btn.dataset.idleText = idleText;

  if (loading) {
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.innerHTML = loadingText;
  } else {
    btn.disabled = btn.dataset.idleDisabled === "1";
    btn.classList.remove("is-loading");
    btn.innerHTML = btn.dataset.idleHtml || btn.innerHTML;
  }
}

// ---------------------------
// ? STORAGE MIGRATION
// ---------------------------
function migrateStorage() {
  // no-op (localStorage 미사용)
}

function getUserPassword(u) {
  return String((u && (u.pw ?? u.password ?? u.pass ?? u.pwd ?? "")) || "");
}

function getUser() { return userCache; }
function setUser(u) {
  userCache = u || null;
  if (userCache) __authInvalidated = false;
}
function getUsers() { return []; }
function setUsers(_list) { /* no-op */ }

function getClasses() { return dataCache.classes; }
function setClasses(list) {
  const arr = Array.isArray(list) ? list : [];
  dataCache.classes = arr;
  cacheClassList(arr);
}

function renderClassCard(c, wide = false) {
  return `
    <div class="class-card ${wide ? "wide" : ""}" data-id="${escapeAttr(c.id)}">
      <img class="thumb" loading="lazy" decoding="async" src="${escapeAttr(initialThumbSrc(c.thumb))}" data-thumb="${escapeAttr(c.thumb || "")}" alt="">
      <div class="class-body">
        <div class="title2">${escapeHtml(c.title)}</div>
        <div class="sub2">선생님 · ${escapeHtml(c.teacher || "-")} · ${escapeHtml(c.category || "-")}</div>
        <div class="desc2">${escapeHtml(c.description || "")}</div>
        <div class="chips">
          <span class="chip">${won(c.weeklyPrice)}</span>
          <span class="chip secondary">${won(c.monthlyPrice)}</span>
        </div>
      </div>
    </div>
  `;
}

// ===== Enrollment storage: keep as OBJECT-MAP (userKey -> classId -> record) =====
function convertEnrollmentArrayToMap(arr) {
  const map = {};
  if (!Array.isArray(arr)) return map;

  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;

    const e = { ...raw };
    const classId = String(
      e.classId ||
      e.class?.id ||
      e.courseId ||
      e.class ||
      e.course ||
      e.id ||
      ""
    );
    if (!classId) continue;
    e.classId = classId;

    const snap = e.userSnapshot && typeof e.userSnapshot === "object" ? e.userSnapshot : null;
    const userId = String(
      e.userId ||
      e.uid ||
      e.user?.id ||
      (snap && (snap.id || snap.uid)) ||
      ""
    );
    const userEmail = normalizeEmail(
      e.userEmail ||
      e.email ||
      e.user?.email ||
      (snap && snap.email) ||
      ""
    );
    const userName = String(
      e.userName ||
      e.name ||
      e.user?.name ||
      (snap && snap.name) ||
      ""
    ).trim();

    if (userId) e.userId = userId;
    if (userEmail) e.userEmail = userEmail;
    if (userName) e.userName = userName;

    const keys = new Set();
    if (e.userKey) keys.add(String(e.userKey));
    if (userId) { keys.add(`id:${userId}`); keys.add(userId); }
    if (userEmail) { keys.add(`email:${userEmail}`); keys.add(userEmail); }
    if (userName) keys.add(`name:${userName}`);

    for (const k of keys) {
      if (!k) continue;
      if (!map[k]) map[k] = {};
      if (!map[k][classId]) map[k][classId] = e;
    }
  }
  return map;
}

function getEnrollments() { return dataCache.enrollments; }
function setEnrollments(v) {
  let out = v;
  if (Array.isArray(out)) out = convertEnrollmentArrayToMap(out);
  if (!out || typeof out !== "object") out = {};
  dataCache.enrollments = out;
}
function isEnrollmentsSynced() { return enrollmentsSynced; }
function isEnrollmentsSyncing() { return enrollmentsSyncing; }
function markEnrollmentsSynced(at = Date.now()) {
  enrollmentsSynced = true;
  enrollmentsLastAt = at;
}
function markEnrollmentsUnsynced() {
  enrollmentsSynced = false;
  enrollmentsLastAt = 0;
}

function getReplays() { return dataCache.replays; }
function setReplays(v) { dataCache.replays = v || {}; }

function getChat() { return dataCache.chat; }
function setChat(v) { dataCache.chat = v || {}; }

// 자료/과제/리뷰/Q&A/출결/진도
function getMaterials() { return dataCache.materials; }
function setMaterials(v) { dataCache.materials = v || {}; }
function getAssignments() { return dataCache.assignments; }
function setAssignments(v) { dataCache.assignments = v || {}; }
function getAssignMeta() { return dataCache.assignMeta; }
function setAssignMeta(v) { dataCache.assignMeta = v || {}; }
function getReviews() { return dataCache.reviews; }
function setReviews(v) { dataCache.reviews = v || {}; }
function getQna() { return dataCache.qna; }
function setQna(v) { dataCache.qna = v || {}; }
function getAttendance() { return dataCache.attendance; }
function setAttendance(v) { dataCache.attendance = v || {}; }
function getProgress() { return dataCache.progress; }
function setProgress(v) { dataCache.progress = v || {}; }

// ---------------------------
// ? ROBUST USER KEY LIST
// ---------------------------
function userKeyList(u, includeEmptyLegacy = true) {
  if (!u) return [];
  const keys = [];

  const id = String(u.id || "").trim();
  const emailKey = normalizeEmail(u.email || u.emailKey || "");
  const nameKey = String(u.name || "").trim().toLowerCase();

  if (id) keys.push(`id:${id}`);
  if (emailKey) keys.push(`email:${emailKey}`);
  if (nameKey) keys.push(`name:${nameKey}`);

  if (id) keys.push(id);
  if (emailKey) keys.push(emailKey);

  if (includeEmptyLegacy) keys.push("");

  return Array.from(new Set(keys.filter(k => k !== null && k !== undefined)));
}

function readEnrollmentForUser(u, classId) {
  const enroll = getEnrollments();
  const keys = userKeyList(u, true);

  for (const k of keys) {
    if (enroll?.[k]?.[classId]) return enroll[k][classId];
  }

  const emailKey = normalizeEmail(u?.email || u?.emailKey || "");
  const idKey = String(u?.id || "").trim();
  const nameKey = String(u?.name || "").trim().toLowerCase();

  const allKeys = Object.keys(enroll || {});
  for (const k of allKeys) {
    const bucket = enroll?.[k];
    if (!bucket || !bucket[classId]) continue;

    const hit =
      (emailKey && String(k).includes(emailKey)) ||
      (idKey && (k === idKey || k === `id:${idKey}`)) ||
      (emailKey && k === `email:${emailKey}`) ||
      (nameKey && k === `name:${nameKey}`);

    if (hit) return bucket[classId];
  }

  return null;
}

function normalizeEnrollmentsForUser(u, classId) {
  try {
    const enroll = getEnrollments();
    if (!enroll || typeof enroll !== "object") return;

    const record = readEnrollmentForUser(u, classId);
    if (!record) return;

    const stableKeys = Array.from(
      new Set(
        [
          ...userKeyList(u, true),
          String(u?.id || "").trim(),
          normalizeEmail(u?.email || u?.emailKey || ""),
        ].filter((x) => x !== null && x !== undefined)
      )
    ).filter((k) => String(k).trim() !== "");

    let changed = false;
    for (const k of stableKeys) {
      if (!enroll[k]) enroll[k] = {};
      if (!enroll[k][classId]) {
        enroll[k][classId] = record;
        changed = true;
      }
    }

    if (changed) setEnrollments(enroll);
  } catch (_) {}
}

function parseEndTime(e) {
  if (!e) return 0;

  const raw =
    e.endAt ?? e.endDate ?? e.end ?? e.endsAt ?? e.expireAt ?? e.expiresAt ??
    e.end_time ?? e.endTime ?? e.until ?? "";

  let t = Date.parse(String(raw || ""));
  if (!Number.isNaN(t) && t) return t;

  const s = String(raw || "").trim();
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const dt = new Date(y, mo - 1, d, 23, 59, 59, 999);
    return dt.getTime();
  }

  return 0;
}

function fmtDateKR(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "-";
  return `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, "0")}.${String(dt.getDate()).padStart(2, "0")}`;
}

function isEnrollmentActiveForUser(u, classId) {
  const e = readEnrollmentForUser(u, classId);
  if (!e) return false;
  const end = parseEndTime(e);
  if (!end) return false;
  return Date.now() <= end;
}

// ---------------------------
// ? USERS NORMALIZE/DEDUPE (legacy 유지)
// ---------------------------
function normalizeUsersInStorage() { /* no-op: localStorage 미사용 */ }
function normalizeCurrentUserInStorage() { /* no-op: localStorage 미사용 */ }

// ---------------------------
// ? SEED
// ---------------------------
function getBuiltinClasses() {
  return [
    {
      id: "c_demo_korean_1",
      title: "영어 회화 입문",
      teacher: "이승훈",
      category: "영어",
      description: "왕초보도 바로 따라올 수 있는 실전 표현과 발음 교정.",
      weeklyPrice: 19000,
      monthlyPrice: 59000,
      thumb: "https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=1400&q=60",
    },
    {
      id: "c_demo_math_1",
      title: "고등 수학 확률과 통계",
      teacher: "이승훈",
      category: "수학",
      description: "개념부터 기출, 모의고사까지 확률·통계 핵심 정리와 실전 연습.",
      weeklyPrice: 25000,
      monthlyPrice: 79000,
      thumb: "https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=1400&q=60",
    },
  ];
}

async function loadLocalSampleClasses() {
  const builtin = getBuiltinClasses();

  try {
    const res = await fetch("data/classes.json", { cache: "no-cache" });
    if (!res.ok) return builtin;
    const list = await res.json();
    const normalized = (list || []).map(c => ({
      ...c,
      teacher: c.teacher || c.teacherName || "-",
      teacherId: c.teacherId || "",
      thumb: c.thumb || FALLBACK_THUMB,
    }));
    return normalized.length ? normalized : builtin;
  } catch (err) {
    console.warn("local sample classes load failed", err);
    return builtin;
  }
}

async function ensureSeedData() {
  const sessionPromise = syncLocalUserFromSupabaseSession().catch(() => {});
  const detailOnly = !!document.getElementById("detailRoot") && !document.getElementById("classGrid") && !document.getElementById("homePopular");

  const rerenderVisible = () => {
    if (typeof loadHomePopular === "function" && $("#homePopular")) loadHomePopular(); // 홈 인기 수업
    if (typeof loadClassesPage === "function" && $("#classGrid")) loadClassesPage(); // 수업 목록
    if (typeof loadClassDetailPage === "function" && $("#detailRoot")) loadClassDetailPage(); // 수업 상세
    if (typeof handleCreateClassPage === "function" && $("#createClassForm")) handleCreateClassPage(); // 수업 생성
    if (typeof loadTeacherDashboard === "function" && $("#teacherDash")) loadTeacherDashboard(); // 선생님 대시보드
    if (typeof loadStudentDashboard === "function" && $("#studentDash")) loadStudentDashboard(); // 학생 대시보드
  };

  const cached = loadCachedClasses();
  const hasCachedClasses = cached.length > 0;
  if (hasCachedClasses) {
    setClasses(cached);
  } else if (!detailOnly) {
    const builtin = getBuiltinClasses();
    if (builtin.length) setClasses(builtin);
    scheduleIdleTask(async () => {
      try {
        const local = await loadLocalSampleClasses();
        if (Array.isArray(local) && local.length) {
          setClasses(local);
          rerenderVisible();
        }
      } catch (e) {
        console.error("local sample classes load failed", e);
      }
    });
  } else {
    setClasses([]);
  }
  const user = getUser();
  let hasCachedEnroll = false;
  if (user) {
    const cachedEnroll = loadCachedEnrollments(user);
    if (cachedEnroll) {
      setEnrollments(cachedEnroll);
      hasCachedEnroll = Array.isArray(cachedEnroll) && cachedEnroll.length > 0;
      if (hasCachedEnroll) markEnrollmentsSynced();
      else markEnrollmentsUnsynced();
    } else {
      setEnrollments({});
      markEnrollmentsUnsynced();
    }
  } else {
    setEnrollments({});
    markEnrollmentsUnsynced();
  }

  // 초기 데이터로 한 번 갱신
  rerenderVisible();
  updateNav();

  // 원격 수업 목록 (느린 응답이면 타임아웃 후 백그라운드 재시도)
  const fetchClassesOnce = (attempt = 0) => {
    const timeoutMs = attempt === 0 ? 4000 : 8000;
    return apiGet("/api/classes", { silent: true, timeout: timeoutMs, tolerateTimeout: true })
      .then((classes) => {
        if (!Array.isArray(classes) || !classes.length) return false;
        const normalized = (classes || []).map(c => ({
          ...c,
          teacher: c.teacher?.name || c.teacherName || c.teacher || "-",
          teacherId: c.teacherId || c.teacher?.id || "",
          thumb: c.thumbUrl || c.thumb || FALLBACK_THUMB,
        }));
        if (normalized.length) setClasses(normalized);
        rerenderVisible();
        return true;
      })
      .catch((e) => {
        if (attempt >= 2) console.error("classes fetch failed", e);
        return false;
      });
  };
  const fetchClassesRemote = (attempt = 0) => {
    return fetchClassesOnce(attempt).then((ok) => {
      if (!ok && attempt < 2) {
        setTimeout(() => fetchClassesRemote(attempt + 1), 4000 * (attempt + 1));
      }
      return ok;
    });
  };

  // 초기 fetch는 병렬 처리 (로그인/캐시 상태에 따라 조건부 실행)
  const initialFetches = [];
  if (!detailOnly && !hasCachedClasses) initialFetches.push(fetchClassesRemote(0));
  if (user && !hasCachedEnroll) {
    initialFetches.push(fetchEnrollmentsForUser(user, 0, { force: true, timeoutMs: 5000 }));
  }
  if (initialFetches.length) {
    Promise.allSettled(initialFetches).then(() => rerenderVisible());
  }

  // 세션 동기화 완료 후 내비/페이지 재반영
  sessionPromise.then(async () => {
    try {
      const u = getUser();
      if (u) {
        const cachedEnroll = loadCachedEnrollments(u);
        const hasEnroll = Array.isArray(cachedEnroll) && cachedEnroll.length > 0;
        if (!hasEnroll) {
          try {
            await fetchEnrollmentsForUser(u, 0, { force: true });
            rerenderVisible();
          } catch (e) {
            console.error("enrollments fetch failed (late)", e);
          }
        }
      }
      rerenderVisible();
      updateNav();
    } catch (_) {}
  });
}

// ---------------------------
// ? NAV + LOGOUT
// ---------------------------
function buildNavLinks() {
  const user = getUser();
  const navLinks = $("#navLinks");
  if (!navLinks) return;

  const isTeacher = user?.role === "teacher";
  navLinks.innerHTML = `
    <a class="nav-link" href="index.html">홈</a>
    <a class="nav-link" href="classes.html">수업 목록</a>
    ${isTeacher ? `<a class="nav-link" href="create_class.html">수업 생성</a>` : ``}
    ${user ? `<a class="nav-link" href="settings.html">설정</a>` : ``}
  `;
}

function clearOldAuthKeys() {
  for (const k of OLD_USER_KEYS) localStorage.removeItem(k);
  localStorage.removeItem("current_user");
  localStorage.removeItem("CURRENT_USER");
}

function clearSupabaseSessionStorage(storage) {
  try {
    if (!storage) return;
    const keys = new Set();
    if (SUPABASE_PROJECT_REF) keys.add(`sb-${SUPABASE_PROJECT_REF}-auth-token`);
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (!k) continue;
      if (k.startsWith("sb-") && k.endsWith("-auth-token")) keys.add(k);
      if (k.startsWith("supabase.auth")) keys.add(k);
    }
    keys.forEach((k) => storage.removeItem(k));
  } catch (_) {}
}

function clearSupabaseSessions() {
  clearSupabaseSessionStorage(typeof localStorage !== "undefined" ? localStorage : null);
  clearSupabaseSessionStorage(typeof sessionStorage !== "undefined" ? sessionStorage : null);
}

function handleUnauthorized() {
  if (__authInvalidated) return;
  __authInvalidated = true;
  setUser(null);
  clearSupabaseSessions();
  clearOldAuthKeys();
  updateNav();
  showToast("세션이 만료되었습니다. 다시 로그인해 주세요.", "warn");
}

// ? Supabase 로그아웃 포함
async function doLogout(goHome = true) {
  try {
    if (supabaseClient) {
      await supabaseClient.auth.signOut();
    }
  } catch (_) {}

  clearSupabaseSessions();
  setUser(null);
  clearOldAuthKeys();
  if (goHome) navigateTo("index.html", { replace: true });
}

function updateNav() {
  buildNavLinks();

  const user = getUser();
  const navRight = $("#navRight");
  if (!navRight) return;

  if (!user) {
    navRight.innerHTML = `
      <a class="nav-link" href="login.html">로그인</a>
      <a class="btn primary" href="signup.html">회원가입</a>
    `;
    return;
  }

  const roleBadge = user.role === "teacher"
    ? `<span class="badge teacher">선생님</span>`
    : user.role === "admin"
      ? `<span class="badge teacher">관리자</span>`
      : `<span class="badge student">학생</span>`;

  const dashHref = user.role === "teacher"
    ? "teacher_dashboard.html"
    : user.role === "admin"
      ? "settings.html"
      : "student_dashboard.html";

  navRight.innerHTML = `
    <span class="user-pill">
      <span class="user-avatar">${escapeHtml((user.name || "U").trim().slice(0,1).toUpperCase())}</span>
      <strong>${escapeHtml(user.name || "사용자")}</strong>
      ${roleBadge}
    </span>
    <a class="nav-link" href="${dashHref}">내 수업</a>
    <a class="nav-link" href="logout.html" id="navLogoutLink">로그아웃</a>
  `;

  $("#navLogoutLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    doLogout(true);
  });

  const path = getPath();
  $$(".nav-link").forEach(a => {
    const href = a.getAttribute("href") || "";
    a.classList.toggle("active", href === path);
  });
}

function runReveal() {
  const els = $$('[data-reveal]');
  els.forEach((el, i) => {
    const delay = Number(el.getAttribute("data-reveal")) || (i * 90);
    setTimeout(() => el.classList.add("is-revealed"), delay);
  });
}

// ---------------------------
// ? GLOBAL DISABLED BLOCKER (for <a> tags)
// ---------------------------
let __gateBlockerInstalled = false;
function installGateBlockerOnce() {
  if (__gateBlockerInstalled) return;
  __gateBlockerInstalled = true;

  document.addEventListener("click", (e) => {
    const t = e.target;
    const el = t && t.closest ? t.closest('[aria-disabled="true"], .is-disabled') : null;
    if (!el) return;
    if (el.tagName && el.tagName.toLowerCase() === "button" && el.disabled) return;

    e.preventDefault();
    e.stopPropagation();
  }, true);
}

function setGateDisabled(el, disabled) {
  if (!el) return;
  if ("disabled" in el) el.disabled = !!disabled;

  if (disabled) {
    el.setAttribute("aria-disabled", "true");
    el.classList.add("is-disabled");
    el.classList.add("disabled");
  } else {
    el.removeAttribute("aria-disabled");
    el.classList.remove("is-disabled");
    el.classList.remove("disabled");
  }
}

// ---------------------------
// ? AUTH (OTP + 로컬 저장 기본, Supabase는 보조)
// ---------------------------
function pickValue(...ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) return (el.value ?? "").toString();
  }
  return "";
}

function localLogin(email, password) {
  console.warn("localLogin disabled. Use Supabase auth.");
  return false;
}

// ---------------------------
// ? INIT
// ---------------------------
function init() {
  migrateStorage();
  normalizeUsersInStorage();
  normalizeCurrentUserInStorage(); // 핵심
  installGateBlockerOnce();        // <a> disabled blocking

  // 페이지 스크립트는 즉시 로드 시도 (softNavigate 이후에도 동작 보장)
  bootPageScripts();

  scheduleAfterPaint(() => {
    // 네트워크 핸드셰이크 단축 (Supabase/Livekit/jsdelivr)
    (function injectPreconnects() {
      const needsSupabase = !!document.querySelector('script[src*="supabase-js"]');
      const origins = [
        "https://cdn.jsdelivr.net",
        "https://*.livekit.cloud",
      ];
      if (needsSupabase) {
        origins.push(SUPABASE_URL, SUPABASE_URL.replace("https://", "https://*."));
      }
      const head = document.head || document.getElementsByTagName("head")[0];
      origins.forEach((o) => {
        if (!o || document.querySelector(`link[data-preconnect="${o}"]`)) return;
        const l1 = document.createElement("link");
        l1.rel = "preconnect";
        l1.href = o;
        l1.setAttribute("data-preconnect", o);
        const l2 = document.createElement("link");
        l2.rel = "dns-prefetch";
        l2.href = o;
        l2.setAttribute("data-preconnect", o + ":dns");
        head.appendChild(l1);
        head.appendChild(l2);
      });
    })();

    // 로그인/회원가입 페이지는 SDK를 먼저 로드해 실패 확률을 낮춤
    if ($("#loginForm") || $("#signupForm")) {
      loadSupabaseSdkOnce()
        .then(() => { ensureSupabaseClient(); })
        .catch(() => {});
    }

    // NAV 먼저 렌더하여 느린 API 때문에 UI가 비지 않도록 함
    updateNav();
    runReveal();
    bindSoftNavigation();
    warmupBackend();

    // 화면 즉시 렌더, 데이터는 백그라운드
    if (typeof handleCreateClassPage === "function" && $("#createClassForm")) handleCreateClassPage();
    if (typeof handleLoginPage === "function" && $("#loginForm")) handleLoginPage();
    if (typeof handleSignupPage === "function" && $("#signupForm")) handleSignupPage();
    if (typeof handleSettingsPage === "function" && $("#settingsRoot")) handleSettingsPage();
    if (typeof loadLivePage === "function" && $("#liveRoot")) loadLivePage();

    ensureSeedData();

    prefetchCorePages();
    bindNavPrefetch();
    const homePopular = $("#homePopular");
    if (typeof loadHomePopular === "function" && homePopular && homePopular.dataset.hydrated !== "1") {
      if (homePopular.dataset.hydrated !== "1") loadHomePopular();
    }
    const classGrid = $("#classGrid");
    if (typeof loadClassesPage === "function" && classGrid && classGrid.dataset.hydrated !== "1") {
      if (classGrid.dataset.hydrated !== "1") loadClassesPage();
    }
    const teacherDash = $("#teacherDash");
    if (typeof loadTeacherDashboard === "function" && teacherDash && teacherDash.dataset.hydrated !== "1") {
      if (teacherDash.dataset.hydrated !== "1") loadTeacherDashboard();
    }
    const studentDash = $("#studentDash");
    if (typeof loadStudentDashboard === "function" && studentDash && studentDash.dataset.hydrated !== "1") {
      if (studentDash.dataset.hydrated !== "1") loadStudentDashboard();
    }

    if (getPath() === "logout.html") doLogout(true);
  });
}

document.addEventListener("DOMContentLoaded", init);
