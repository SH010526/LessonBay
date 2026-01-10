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
const STORAGE_BUCKET = "LessonBay"; // Supabase Storage 버킷 이름

// ? SDK가 없는 페이지에서도 크래시 나지 않게 (전역 supabase와 이름 충돌 방지)
let supabaseClient = null;
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
  let token = "";
  try {
    const { data } = await supabaseClient.auth.getSession();
    token = data?.session?.access_token || "";
  } catch (_) {}
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
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

async function apiGet(path, opts = {}) {
  const silent = !!opts.silent;
  if (!silent) showLoading();
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      headers: await apiHeaders(),
    });
    if (!res.ok) {
      const txt = await res.text();
      showToast(txt || "요청 실패", "danger");
      throw new Error(txt);
    }
    return res.json();
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
  if (!supabaseClient) return;

  try {
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const session = sessionData?.session || null;

    if (!session || !session.user) {
      userCache = null;
      return;
    }

    const u = session.user;
    const email = String(u.email || "").trim();
    const name = String(u.user_metadata?.name || "").trim() || (email ? email.split("@")[0] : "사용자");
    const roleMeta = u.user_metadata?.role;
    const role = (roleMeta === "teacher" || roleMeta === "student" || roleMeta === "admin")
      ? roleMeta
      : "student";

    userCache = { id: u.id, name, role, email };
  } catch (_) {
    // ignore
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
  if (!supabaseClient) throw new Error("Supabase SDK가 로드되지 않았습니다. (login.html에서 SDK 스크립트 순서를 확인하세요)");

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
  if (cls) cachePrefetchClass(cls);
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
function setUser(u) { userCache = u || null; }
function getUsers() { return []; }
function setUsers(_list) { /* no-op */ }

function getClasses() { return dataCache.classes; }
function setClasses(list) {
  const arr = Array.isArray(list) ? list : [];
  dataCache.classes = arr;
  cacheClassList(arr);
}

// ===== Enrollment storage: keep as OBJECT-MAP (userKey -> classId -> record) =====
function convertEnrollmentArrayToMap(arr) {
  const map = {};
  if (!Array.isArray(arr)) return map;

  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;

    const e = { ...raw };
    const classId = String(e.classId || e.courseId || e.class || e.course || e.id || "");
    if (!classId) continue;
    e.classId = classId;

    const snap = e.userSnapshot && typeof e.userSnapshot === "object" ? e.userSnapshot : null;
    const userId = String(e.userId || e.uid || (snap && (snap.id || snap.uid)) || "");
    const userEmail = normalizeEmail(e.userEmail || e.email || (snap && snap.email) || "");
    const userName = String(e.userName || e.name || (snap && snap.name) || "").trim();

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
    if ($("#homePopular")) loadHomePopular();
    if ($("#classGrid")) loadClassesPage();
    if ($("#detailRoot")) loadClassDetailPage();
    if ($("#createClassForm")) handleCreateClassPage();
    if ($("#teacherDash")) loadTeacherDashboard();
    if ($("#studentDash")) loadStudentDashboard();
  };

  const cached = loadCachedClasses();
  if (cached.length) {
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
  if (user) {
    const cachedEnroll = loadCachedEnrollments(user);
    if (cachedEnroll) {
      setEnrollments(cachedEnroll);
    } else {
      setEnrollments({});
    }
  } else {
    setEnrollments({});
  }

  // 초기 데이터로 한 번 갱신
  rerenderVisible();
  updateNav();

  // 원격 수업 목록
  if (!detailOnly) {
    scheduleIdleTask(() => (async () => {
      try {
        const classes = await apiGet("/api/classes", { silent: true });
        const normalized = (classes || []).map(c => ({
          ...c,
          teacher: c.teacher?.name || c.teacherName || c.teacher || "-",
          teacherId: c.teacherId || c.teacher?.id || "",
          thumb: c.thumbUrl || c.thumb || FALLBACK_THUMB,
        }));
        if (normalized.length) setClasses(normalized);
        rerenderVisible();
      } catch (e) {
        console.error("classes fetch failed", e);
      }
    })());
  }

  let enrollFetchPromise = null;
  let enrollFetchKey = "";
  const loadEnrollmentsFor = async (u) => {
    const key = getUserCacheKey(u);
    if (!key) return;
    if (enrollFetchPromise && enrollFetchKey === key) return enrollFetchPromise;
    enrollFetchKey = key;
    enrollFetchPromise = (async () => {
      try {
        const enrollList = await apiGet("/api/me/enrollments", { silent: true });
        setEnrollments(enrollList || []);
        cacheEnrollments(u, enrollList || []);
        rerenderVisible();
      } catch (e) {
        console.error("enrollments fetch failed", e);
      } finally {
        enrollFetchPromise = null;
      }
    })();
    return enrollFetchPromise;
  };

  // 원격 수강 정보 (캐시로 먼저 렌더, 백그라운드 갱신)
  if (user) {
    loadEnrollmentsFor(user);
  }

  // 세션 동기화 완료 후 내비/페이지 재반영
  sessionPromise.then(async () => {
    try {
      const u = getUser();
      if (u) {
        scheduleIdleTask(async () => {
          try {
            await loadEnrollmentsFor(u);
          } catch (e) {
            console.error("enrollments fetch failed (late)", e);
          }
        });
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

// ? Supabase 로그아웃 포함
async function doLogout(goHome = true) {
  try {
    if (supabaseClient) {
      await supabaseClient.auth.signOut();
    }
  } catch (_) {}

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

function handleSignupPage() {
  const form = $("#signupForm");
  if (!form) return;

  // 메시지 영역
  function ensureMsgEl() {
    let msg = document.getElementById("signupMsg");
    if (!msg) {
      msg = document.createElement("div");
      msg.id = "signupMsg";
      msg.className = "muted";
      msg.style.marginTop = "12px";
      form.insertAdjacentElement("afterend", msg);
    }
    return msg;
  }

  let pending = null; // {name,email,pw,role}

  async function submitSignup(ev) {
    ev.preventDefault();
    const name = pickValue("suName", "signupName", "name").trim();
    const email = pickValue("suEmail", "signupEmail", "email").trim();
    const pw = pickValue("suPass", "signupPw", "password", "pw");
    const role = pickValue("suRole", "signupRole", "role") || "student";
    const agree = $("#suAgree")?.checked || false;
    const msg = ensureMsgEl();

    if (!name || !email || !pw) {
      msg.textContent = "이름/이메일/비밀번호를 입력하세요.";
      return;
    }
    if (!agree) {
      msg.textContent = "약관 및 개인정보 처리방침에 동의해야 가입할 수 있습니다.";
      return;
    }

    const submitBtn = form.querySelector("button");
    try {
      setBtnLoading(submitBtn, true, "가입중...");
      await supabaseSignupWithEmailConfirm(name, email, pw, role);
      pending = { name, email, pw, role };
      msg.innerHTML = `
        <div style="margin-top:8px;">
          6자리 인증코드를 이메일로 보냈습니다. 아래에 입력 후 확인을 눌러주세요.
        </div>
        <div style="margin-top:8px;">
          <input id="otpInput" class="input" placeholder="인증번호 6자리" style="width:60%; display:inline-block; margin-right:8px;" />
          <button id="otpVerifyBtn" class="btn">확인</button>
        </div>
        <div style="margin-top:10px;"><button id="otpResendBtn" class="btn">재전송</button></div>
        <div id="otpStatus" class="muted" style="margin-top:10px; font-size:13px;"></div>
      `;

      const verifyBtn = document.getElementById("otpVerifyBtn");
      const resendBtn = document.getElementById("otpResendBtn");
      const statusEl = document.getElementById("otpStatus");

      verifyBtn?.addEventListener("click", async () => {
        const code = (document.getElementById("otpInput")?.value || "").trim();
        if (!code) { if (statusEl) statusEl.textContent = "인증번호를 입력하세요."; return; }
        try {
          setBtnLoading(verifyBtn, true, "확인중...");
          await apiPost("/api/auth/verify-otp", { email, code });
          // 계정 생성됨 -> 로그인
          await supabaseLogin(email, pw);
          statusEl.textContent = "가입 및 로그인 완료! 잠시 후 이동합니다.";
          setTimeout(() => { navigateTo("index.html", { replace: true }); }, 500);
        } catch (e) {
          statusEl.textContent = e?.message || "인증 실패";
        } finally {
          setBtnLoading(verifyBtn, false);
        }
      });

      resendBtn?.addEventListener("click", async () => {
        if (!pending) return;
        try {
          setBtnLoading(resendBtn, true, "재전송 중...");
          await supabaseSignupWithEmailConfirm(pending.name, pending.email, pending.pw, pending.role);
          if (statusEl) statusEl.textContent = "인증코드를 재전송했습니다. 메일을 확인하세요.";
        } catch (e) {
          if (statusEl) statusEl.textContent = e?.message || "재전송 실패";
        } finally {
          setBtnLoading(resendBtn, false);
        }
      });

    } catch (e) {
      msg.textContent = e?.message || "가입 실패";
    } finally {
      setBtnLoading(submitBtn, false);
    }
  }

  form.addEventListener("submit", submitSignup);
}

function handleLoginPage() {
  const form = $("#loginForm");
  if (!form) return;

  (async () => {
    let user = getUser();
    if (!user) user = await ensureUserReady();
    if (user) {
      const dest = user.role === "teacher"
        ? "teacher_dashboard.html"
        : user.role === "admin"
          ? "settings.html"
          : "student_dashboard.html";
      navigateTo(dest, { replace: true });
    }
  })();

  let msg = document.getElementById("loginMsg");
  if (!msg) {
    msg = document.createElement("div");
    msg.id = "loginMsg";
    msg.className = "muted";
    msg.style.marginTop = "10px";
    form.insertAdjacentElement("afterend", msg);
  }

  function setMsg(text, isError = false) {
    if (!msg) return;
    msg.textContent = text;
    msg.style.color = isError ? "#d00" : "#475569";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = pickValue("liEmail", "loginEmail", "email").trim();
    const pw = pickValue("liPass", "loginPw", "password", "pw");
    const submitBtn = form.querySelector("button");

    if (!email || !pw) {
      setMsg("이메일/비밀번호를 입력하세요.", true);
      return;
    }

    try {
      setBtnLoading(submitBtn, true, "로그인중...");
      await supabaseLogin(email, pw);
      setMsg("로그인 성공! 이동합니다.", false);
      setTimeout(() => { navigateTo("index.html", { replace: true }); }, 300);
    } catch (err) {
      setMsg(err?.message || "로그인 실패", true);
    } finally {
      setBtnLoading(submitBtn, false);
    }
  });
}

// ---------------------------
// ? SETTINGS (계정 삭제)
// ---------------------------
function removeUserData(u) {
  if (!u) return;

  // 1) users 목록에서 제거
  const users = getUsers().filter(x => normalizeEmail(x.email) !== normalizeEmail(u.email));
  setUsers(users);

  // 2) enrollments에서 해당 유저 키들 제거
  const enroll = getEnrollments();
  const keys = userKeyList(u, true);
  keys.forEach(k => { if (enroll[k]) delete enroll[k]; });
  setEnrollments(enroll);

  // 3) 채팅에서 해당 이메일 메시지 제거
  const chat = getChat();
  const emailKey = normalizeEmail(u.email);
  Object.keys(chat || {}).forEach(cid => {
    chat[cid] = (chat[cid] || []).filter(m => m.emailKey !== emailKey);
  });
  setChat(chat);

  // 4) 선생님이면 본인 수업/재생 목록 삭제
  if (u.role === "teacher") {
    const classes = getClasses();
    const myClasses = classes.filter(c => c.teacher === u.name).map(c => c.id);
    const rest = classes.filter(c => c.teacher !== u.name);
    setClasses(rest);

    // 해당 수업의 replays 제거
    const rp = getReplays();
    myClasses.forEach(id => { if (rp[id]) delete rp[id]; });
    setReplays(rp);

    // 해당 수업의 enrollments 제거
    const en2 = getEnrollments();
    Object.keys(en2 || {}).forEach(uid => {
      myClasses.forEach(cid => { if (en2[uid] && en2[uid][cid]) delete en2[uid][cid]; });
    });
    setEnrollments(en2);
  }

  // 5) 현재 사용자 로그아웃
  setUser(null);
  clearOldAuthKeys();
}

function handleSettingsPage() {
  const root = $("#settingsRoot");
  if (!root) return;

  (async () => {
    let user = getUser();
    if (!user) user = await ensureUserReady();
    if (!user) { navigateTo("login.html", { replace: true }); return; }

  const info = $("#settingsInfo");
  if (info) {
    info.innerHTML = `
      <div class="card pad" style="margin-top:12px;">
        <div><strong>이름:</strong> ${escapeHtml(user.name || "")}</div>
        <div><strong>이메일:</strong> ${escapeHtml(user.email || "")}</div>
        <div><strong>역할:</strong> ${escapeHtml(user.role || "")}</div>
      </div>
    `;
  }

  const delBtn = $("#settingsDeleteBtn");
  const pwInput = $("#settingsPw");
  const msg = $("#settingsMsg");

  delBtn?.addEventListener("click", async () => {
    const pw = (pwInput?.value || "").trim();
    if (!pw) {
      msg.textContent = "비밀번호를 입력하세요.";
      return;
    }

    try {
      msg.textContent = "";
      setBtnLoading(delBtn, true, "확인 중...");

      // 비밀번호 확인용 재로그인 시도 (세션 유지)
      await supabaseLogin(user.email, pw);

      if (!confirm("정말로 계정을 삭제하시겠습니까?")) {
        setBtnLoading(delBtn, false);
        return;
      }

      await apiPost("/api/account/delete", {});
      alert("계정을 삭제했습니다.");
      await doLogout(true);
    } catch (e) {
      console.error(e);
      const errText = e?.message || "";
      if (errText.includes("Not Found")) {
        msg.textContent = "계정 삭제 API를 찾을 수 없습니다. 백엔드가 최신 코드로 실행 중인지 확인하세요. (npm run dev 재시작)";
      } else {
        msg.textContent = errText || "계정 삭제에 실패했습니다.";
      }
    } finally {
      setBtnLoading(delBtn, false);
    }
  });

  // 관리자 패널
  if (user.role === "admin") {
    const mount = document.getElementById("adminPanelMount") || root;
    const panel = document.createElement("div");
    panel.className = "card pad-lg";
    panel.style.marginTop = "16px";
    panel.innerHTML = `
      <div class="h2">관리자 패널</div>
      <div class="muted" style="margin-top:6px;">사용자 정지/해제</div>
      <div style="margin-top:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <button class="btn" id="adminRefreshBtn">새로고침</button>
        <input id="adminSearch" class="input" placeholder="이름/이메일 검색" style="min-width:220px;">
        <span class="muted" id="adminMsg" style="font-size:12px;"></span>
      </div>
      <div id="adminUserList" style="margin-top:12px;"></div>
    `;
    mount.appendChild(panel);

    const msgEl = panel.querySelector("#adminMsg");
    const listEl = panel.querySelector("#adminUserList");
    const refreshBtn = panel.querySelector("#adminRefreshBtn");
    const searchEl = panel.querySelector("#adminSearch");
    let lastData = [];

    const renderList = (items) => {
      lastData = items || [];
      const keyword = (searchEl?.value || "").trim().toLowerCase();
      const filtered = keyword
        ? lastData.filter(u =>
            (u.name || "").toLowerCase().includes(keyword) ||
            (u.email || "").toLowerCase().includes(keyword)
          )
        : lastData;
      if (!Array.isArray(items) || !items.length) {
        listEl.innerHTML = `<div class="muted" style="font-size:13px;">사용자가 없습니다.</div>`;
        return;
      }
      listEl.innerHTML = filtered.map(u => `
        <div class="session-item">
          <div>
            <div class="session-title">${escapeHtml(u.name || u.email || u.id || "사용자")}</div>
            <div class="session-sub">
              ${escapeHtml(u.email || "")} · 역할: ${escapeHtml(u.role || "")} · 상태: ${escapeHtml(u.status || "")}
              ${u.suspendedUntil ? ` · 정지 해제 예정: ${new Date(u.suspendedUntil).toLocaleString("ko-KR")}` : ""}
            </div>
          </div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <input type="datetime-local" class="input" data-admin-until="${escapeAttr(u.id)}" style="min-width:180px;" value="${u.suspendedUntil ? escapeAttr(new Date(u.suspendedUntil).toISOString().slice(0,16)) : ""}" />
            <input type="text" class="input" data-admin-reason="${escapeAttr(u.id)}" placeholder="사유(선택)" style="min-width:160px;" />
            ${u.status === "suspended"
              ? `<button class="btn" data-admin-unsuspend="${escapeAttr(u.id)}">정지 해제</button>`
              : `<button class="btn danger" data-admin-suspend="${escapeAttr(u.id)}">정지</button>`}
          </div>
        </div>
      `).join("");
    };

    async function loadUsers() {
      msgEl.textContent = "불러오는 중...";
      try {
        const list = await apiGet("/api/admin/users");
        renderList(list || []);
        msgEl.textContent = "";
        // 버튼 바인딩
        listEl.querySelectorAll("[data-admin-suspend]").forEach(btn => {
          btn.addEventListener("click", async () => {
            const uid = btn.getAttribute("data-admin-suspend");
            if (!uid) return;
            try {
              msgEl.textContent = "정지 처리 중...";
              const untilVal = listEl.querySelector(`[data-admin-until="${CSS.escape(uid)}"]`)?.value || null;
              const reasonVal = listEl.querySelector(`[data-admin-reason="${CSS.escape(uid)}"]`)?.value || null;
              await apiPost(`/api/admin/users/${encodeURIComponent(uid)}/suspend`, { until: untilVal || null, reason: reasonVal || null });
              await loadUsers();
            } catch (e) {
              console.error(e);
              msgEl.textContent = e?.message || "정지 실패";
            }
          });
        });
        listEl.querySelectorAll("[data-admin-unsuspend]").forEach(btn => {
          btn.addEventListener("click", async () => {
            const uid = btn.getAttribute("data-admin-unsuspend");
            if (!uid) return;
            try {
              msgEl.textContent = "해제 처리 중...";
              await apiPost(`/api/admin/users/${encodeURIComponent(uid)}/unsuspend`, {});
              await loadUsers();
            } catch (e) {
              console.error(e);
              msgEl.textContent = e?.message || "해제 실패";
            }
          });
        });
      } catch (e) {
        console.error(e);
        msgEl.textContent = e?.message || "목록 불러오기 실패";
      }
    }

    refreshBtn?.addEventListener("click", loadUsers);
    searchEl?.addEventListener("input", () => renderList(lastData));
    loadUsers();
  }
  })();
}

/* ============================
   ? HOME / LIST / DETAIL / LIVE
   (아래부터는 네 원본 코드 그대로)
   ============================ */

function renderClassCard(c, wide = false) {
  return `
    <div class="class-card ${wide ? "wide" : ""}" data-id="${escapeAttr(c.id)}">
      <img class="thumb" loading="lazy" src="${escapeAttr(initialThumbSrc(c.thumb))}" data-thumb="${escapeAttr(c.thumb || "")}" alt="">
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

function loadHomePopular() {
  const wrap = $("#homePopular");
  if (!wrap) return;

  const classes = getClasses();
  const top = classes.slice(0, 6);
  if (!top.length) return;

  wrap.innerHTML = top.map(c => renderClassCard(c)).join("");

  $$(".class-card", wrap).forEach(card => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-id");
      goClassDetail(id);
    });
  });

  hydrateThumbs(wrap);
}

function loadClassesPage() {
  const grid = $("#classGrid");
  if (!grid) return;

  const categorySel = $("#filterCategory");
  const searchInput = $("#searchInput");

  const classes = getClasses();
  const categories = Array.from(new Set(classes.map(c => c.category).filter(Boolean))).sort();

  if (categorySel) {
    categorySel.innerHTML =
      `<option value="all">전체 카테고리</option>` +
      categories.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
  }

  function applyFilter() {
    const q = (searchInput?.value || "").trim().toLowerCase();
    const cat = categorySel?.value || "all";

    const filtered = classes.filter(c => {
      const hitQ =
        !q ||
        (c.title || "").toLowerCase().includes(q) ||
        (c.teacher || "").toLowerCase().includes(q) ||
        (c.description || "").toLowerCase().includes(q);
      const hitC = (cat === "all") || (c.category === cat);
      return hitQ && hitC;
    });

    grid.innerHTML = filtered.map(c => renderClassCard(c, true)).join("") +
      (filtered.length ? "" : `<p class="muted" style="margin-top:14px;">조건에 맞는 수업이 없어요.</p>`);

    $$(".class-card", grid).forEach(card => {
      card.addEventListener("click", () => {
        const id = card.getAttribute("data-id");
        goClassDetail(id);
      });
    });

    hydrateThumbs(grid);
  }

  categorySel?.addEventListener("change", applyFilter);
  searchInput?.addEventListener("input", applyFilter);
  applyFilter();
}

// ---------------------------
// ? CLASS DETAIL (핵심)
// ---------------------------
function fmtDateKR(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "-";
  return `${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,"0")}.${String(dt.getDate()).padStart(2,"0")}`;
}

function ensureReplayModalBinding() {
  const backdrop = $("#modalBackdrop");
  if (!backdrop) return;

  const closeBtn = $("#modalClose");
  const okBtn = $("#modalOk");

  const vodVideo = $("#vodVideo");
  const vodEmpty = $("#vodEmpty");
  let currentVodObjectUrl = null;

  function cleanupVodUrl() {
    if (currentVodObjectUrl) {
      URL.revokeObjectURL(currentVodObjectUrl);
      currentVodObjectUrl = null;
    }
  }

  function close() {
    // 모달 닫을 때 영상 정리
    if (vodVideo) {
      try { vodVideo.pause(); } catch (_) {}
      vodVideo.removeAttribute("src");
      vodVideo.load();
    }
    cleanupVodUrl();
    backdrop.style.display = "none";
  }

  closeBtn?.addEventListener("click", close);
  okBtn?.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  window.__openReplayModal = async (payload) => {
    // payload:
    //  - string(title)
    //  - { title, vodKey, vodUrl, classId, replayId }
    const title = (typeof payload === "string") ? payload : (payload?.title || "다시보기");
    let vodKey = (typeof payload === "object") ? (payload?.vodKey || null) : null;
    const vodUrl = (typeof payload === "object") ? (payload?.vodUrl || null) : null;
    const classId = (typeof payload === "object") ? (payload?.classId || null) : null;
    const replayId = (typeof payload === "object") ? (payload?.replayId || null) : null;

    const t = $("#modalTitle");
    if (t) t.textContent = title || "다시보기";

    // 기본은 '빈 상태' 보여주기
    if (vodEmpty) vodEmpty.style.display = "grid";
    if (vodVideo) vodVideo.style.display = "none";

    // 이전 URL 정리
    cleanupVodUrl();

    // 영상이 있으면 IndexedDB에서 꺼내서 재생
    if (vodVideo) {
      let blob = null;
      let urlToPlay = vodUrl || null;

      if (!urlToPlay && vodKey) {
        try { blob = await vodGetBlob(vodKey); } catch (_) { blob = null; }
      }

      // vodUrl이 우선, 없으면 blob으로 재생
      if (urlToPlay || blob) {
        const src = urlToPlay || URL.createObjectURL(blob);
        if (!urlToPlay) currentVodObjectUrl = src;
        vodVideo.src = src;
        vodVideo.style.display = "block";
        if (vodEmpty) vodEmpty.style.display = "none";
        // 자동재생 시도 (브라우저 정책에 따라 실패할 수 있음)
        vodVideo.play().catch(() => {});
      }
    }

    backdrop.style.display = "flex";
  };
}

// ? 강력한 버튼 탐지 (입장/수강 등록 후 입장 포함)
function getDetailEnterButtons() {
  const candidates = Array.from(new Set([
    ...$$("#goLiveBtn"),
    ...$$("#liveEnterBtn"),
    ...$$("#enterLiveBtn"),
    ...$$("#btnEnterLive"),
    ...$$("#detailLiveBtn"),
    ...$$("#detailGoLiveBtn"),
    ...$$("[data-live-enter]"),
    ...$$(".btn-live-enter"),
    ...$$(".enter-live"),
    ...$$("button"),
    ...$$("a")
  ]));

  return candidates.filter(el => {
    const txt = (el.textContent || "").trim();
    const id = (el.id || "").toLowerCase();
    const cls = (el.className || "").toLowerCase();

    const bad =
      txt.includes("지난 수업") || txt.includes("다시보기") || txt.includes("재생") ||
      txt.includes("나가기") || txt.includes("퇴장") || txt.includes("종료") ||
      txt.includes("결제") || txt.includes("수강하기");
    if (bad) return false;

    if (txt.includes("입장")) return true;
    if (id.includes("live") || id.includes("enter") || cls.includes("live") || cls.includes("enter")) return true;
    if (el.hasAttribute("data-live-enter")) return true;

    return false;
  });
}

// ? 재생 버튼도 강제로 갱신
function refreshReplayButtons(canWatch) {
  const btns = Array.from(new Set([
    ...$$("#sessionList button"),
    ...$$(".session-item button"),
    ...$$("button")
  ])).filter(b => ((b.textContent || "").trim() === "재생"));

  btns.forEach(b => {
    setGateDisabled(b, !canWatch);
    if (!canWatch) b.classList.add("ghost");
    else b.classList.remove("ghost");
  });
}

async function loadClassDetailPage() {
  const root = $("#detailRoot");
  if (!root) return;

  const detailNonce = ++__detailPageNonce;
  root.dataset.detailNonce = String(detailNonce);
  const isDetailPageActive = () => {
    const current = document.getElementById("detailRoot");
    if (!current || current !== root) return false;
    if (!document.body.contains(root)) return false;
    return root.dataset.detailNonce === String(detailNonce);
  };

  ensureReplayModalBinding();
  let assignExistingFile = null; // 학생 과제 편집 시 기존 첨부 유지/삭제용
  const installDetailTabs = () => {
    if (!isDetailPageActive()) return;
    const pills = $$("#detailTabNav .pill");
    const sections = $$("[data-section]");
    const show = (key) => {
      if (!isDetailPageActive()) return;
      sections.forEach(sec => {
        const name = sec.getAttribute("data-section");
        sec.style.display = (name === key) ? "" : "none";
      });
      pills.forEach(p => {
        p.classList.toggle("active", p.getAttribute("data-tab") === key);
      });
      // 탭 클릭 시 필요한 데이터만 로드
      if (key === "materials") fetchMaterialsData();
      if (key === "assignments") fetchAssignmentsData();
      if (key === "reviews") fetchReviewsData();
      if (key === "qna") fetchQnaData();
    };
    pills.forEach(p => {
      p.addEventListener("click", () => show(p.getAttribute("data-tab")));
    });
    show("sessions");
  };
  installDetailTabs();

  const id = resolveClassIdFromUrl();
  if (!id) {
    $("#detailTitle").textContent = "수업을 찾을 수 없습니다.";
    showToast("수업 ID가 전달되지 않았어요. 수업 목록으로 이동합니다.", "warn");
    setTimeout(() => { navigateTo("classes.html", { replace: true }); }, 800);
    return;
  }
  root.dataset.classId = String(id);
  rememberClassId(id);

  const classes = getClasses();
  let c = classes.find(x => x.id === id);
  const user = getUser();
  let needsRemote = false;

  // 직전 페이지에서 넘겨둔 프리페치 데이터 활용
  if (!c) {
    const prefetched = consumePrefetchClass(id);
    if (prefetched) {
      c = prefetched;
      const merged = [...classes.filter(x => x.id !== prefetched.id), prefetched];
      setClasses(merged);
    }
  }

  if (!c) {
    needsRemote = true;
    c = {
      id,
      title: "불러오는 중...",
      teacher: "-",
      teacherId: "",
      category: "-",
      description: "",
      weeklyPrice: 0,
      monthlyPrice: 0,
      thumb: FALLBACK_THUMB,
    };
  }

  const applyDetail = () => {
    if (!isDetailPageActive()) return;
    $("#detailImg").src = initialThumbSrc(c.thumb);
    $("#detailImg").setAttribute("data-thumb", c.thumb || "");
    $("#detailImg").setAttribute("loading", "lazy");
    hydrateThumbs(root);

    $("#detailTitle").textContent = c.title || "-";
    $("#detailTeacher").textContent = c.teacher || "-";
    $("#detailCategory").textContent = c.category || "-";
    $("#detailDesc").textContent = c.description || "";
    $("#detailWeekly").textContent = won(c.weeklyPrice);
    $("#detailMonthly").textContent = won(c.monthlyPrice);
  };

  applyDetail();

  if (needsRemote && id) {
    (async () => {
      try {
        const remote = await apiGet(`/api/classes/${encodeURIComponent(id)}`, { silent: true });
        if (!remote) throw new Error("empty response");
        if (!isDetailPageActive()) return;
        const normalized = {
          ...remote,
          teacher: remote.teacher?.name || remote.teacherName || remote.teacher || "-",
          teacherId: remote.teacherId || remote.teacher?.id || "",
          thumb: remote.thumbUrl || remote.thumb || FALLBACK_THUMB,
        };
        Object.assign(c, normalized);
        const next = [...classes.filter(x => x.id !== c.id), normalized];
        setClasses(next);
        applyDetail();
        calc();
        refreshGates();
        ensureProtectedData();
      } catch (e) {
        console.error("class detail fetch failed", e);
        if (isDetailPageActive()) showToast("수업 정보를 불러오지 못했어요.", "warn");
      }
    })();
  }

  // 원격 데이터는 백그라운드로 불러와서 UI를 즉시 렌더
  const detailLoadCache = { mats: false, assigns: false, revs: false, qnas: false };
  let protectedLoaded = false;
  async function fetchMaterialsData() {
    if (!isDetailPageActive()) return;
    if (detailLoadCache.mats) return;
    detailLoadCache.mats = true;
    try {
      const mats = await apiGet(`/api/classes/${encodeURIComponent(id)}/materials`, { silent: true }).catch(() => []);
      if (!isDetailPageActive()) return;
      const map = getMaterials();
      map[id] = mats || [];
      setMaterials(map);
      renderMaterials();
    } catch (e) { console.error("materials fetch failed", e); }
  }
  async function fetchAssignmentsData() {
    if (!isDetailPageActive()) return;
    if (detailLoadCache.assigns) return;
    detailLoadCache.assigns = true;
    try {
      const assigns = await apiGet(`/api/classes/${encodeURIComponent(id)}/assignments`, { silent: true }).catch(() => []);
      if (!isDetailPageActive()) return;
      const map = getAssignments();
      map[id] = assigns || [];
      setAssignments(map);
      renderAssignments();
    } catch (e) { console.error("assignments fetch failed", e); }
  }
  async function fetchReviewsData() {
    if (!isDetailPageActive()) return;
    if (detailLoadCache.revs) return;
    detailLoadCache.revs = true;
    try {
      const revs = await apiGet(`/api/classes/${encodeURIComponent(id)}/reviews`, { silent: true }).catch(() => []);
      if (!isDetailPageActive()) return;
      const map = getReviews();
      map[id] = revs || [];
      setReviews(map);
      renderReviews();
    } catch (e) { console.error("reviews fetch failed", e); }
  }
  async function fetchQnaData() {
    if (!isDetailPageActive()) return;
    if (detailLoadCache.qnas) return;
    detailLoadCache.qnas = true;
    try {
      const qnas = await apiGet(`/api/classes/${encodeURIComponent(id)}/qna`, { silent: true }).catch(() => []);
      if (!isDetailPageActive()) return;
      const map = getQna();
      map[id] = qnas || [];
      setQna(map);
      renderQna();
    } catch (e) { console.error("qna fetch failed", e); }
  }

  const planWeekly = $("#planWeekly");
  const planMonthly = $("#planMonthly");
  const durationLabel = $("#durationLabel");
  const durationSel = $("#durationSelect");
  const payAmount = $("#payAmount");
  const endDate = $("#endDate");

  const enrollStateText = $("#enrollStateText");
  const teacherHint = $("#teacherHint");

  // ? buy button id가 다를 수도 있으니 강제로 찾아줌
  function getBuyButton() {
    const direct = $("#buyBtn");
    if (direct) return direct;

    const btns = [...$$("button"), ...$$("a")];
    const hit = btns.find(b => ((b.textContent || "").includes("수강") && (b.textContent || "").includes("하기")));
    return hit || null;
  }
  const buyBtn = getBuyButton();
  const buyBtnDefaultText = buyBtn ? (buyBtn.textContent || "결제하고 수강하기") : "결제하고 수강하기";

  function setDurationOptions() {
    const weekly = planWeekly?.checked ?? true;
    const opts = weekly
      ? [1,2,3,4,6,8,12].map(n => ({ v:n, t:`${n}주` }))
      : [1,2,3,4,6,12].map(n => ({ v:n, t:`${n}개월` }));

    if (durationLabel) durationLabel.textContent = weekly ? "기간(주)" : "기간(개월)";
    if (durationSel) {
      durationSel.innerHTML = opts.map(o => `<option value="${o.v}">${o.t}</option>`).join("");
      durationSel.value = weekly ? "4" : "1";
    }
  }

  function calc() {
    const weekly = planWeekly?.checked ?? true;
    const dur = Number(durationSel?.value || 1);
    const now = new Date();
    const end = new Date(now);

    let total = 0;
    if (weekly) {
      total = (Number(c.weeklyPrice) || 0) * dur;
      end.setDate(end.getDate() + dur * 7);
    } else {
      total = (Number(c.monthlyPrice) || 0) * dur;
      end.setMonth(end.getMonth() + dur);
    }

    if (payAmount) payAmount.textContent = won(total);
    if (endDate) endDate.textContent = fmtDateKR(end);
    return { weekly, dur, total, start: now, end };
  }

  planWeekly?.addEventListener("change", () => { setDurationOptions(); calc(); refreshGates(); });
  planMonthly?.addEventListener("change", () => { setDurationOptions(); calc(); refreshGates(); });
  durationSel?.addEventListener("change", () => { calc(); refreshGates(); });

  setDurationOptions();
  calc();

  function getEnrollStatusForUI(user) {
    const e = user ? readEnrollmentForUser(user, c.id) : null;
    if (!user) return { state: "guest", e: null, active: false, endText: "-" };

    if (user.role === "teacher") {
      const isOwnerTeacher = isOwnerTeacherForClass(user, c);
      return { state: isOwnerTeacher ? "owner_teacher" : "other_teacher", e: null, active: true, endText: "-" };
    }

    if (user.role === "student") {
      if (!e) return { state: "student_not_enrolled", e: null, active: false, endText: "-" };
      const endT = parseEndTime(e);
      const endText = endT ? fmtDateKR(endT) : (e.endDate || "-");
      const active = isEnrollmentActiveForUser(user, c.id);
      return { state: active ? "student_active" : "student_expired", e, active, endText };
    }

    return { state: "unknown", e: null, active: false, endText: "-" };
  }

function ensureProtectedData() {
  if (!isDetailPageActive()) return;
  if (protectedLoaded) return;
  const status = getEnrollStatusForUI(getUser());
  const allowed = status.state === "owner_teacher" || status.state === "student_active";
  if (!allowed) return;
  protectedLoaded = true;
  // 현재 탭 우선, 나머지는 탭 클릭 시 로드
  const activeTab = $("#detailTabNav .pill.active")?.getAttribute("data-tab");
  if (activeTab === "materials") fetchMaterialsData();
  if (activeTab === "assignments") fetchAssignmentsData();
  if (activeTab === "reviews") fetchReviewsData();
  if (activeTab === "qna") fetchQnaData();
  // 지난 수업은 바로 보여줘야 하므로 로드
  renderReplaysList(c.id);
}

  function refreshGates() {
    if (!isDetailPageActive()) return;
    const user = getUser();
    const status = getEnrollStatusForUI(user);

    const enterBtns = getDetailEnterButtons();
    enterBtns.forEach(btn => {
      if (status.state === "owner_teacher") {
        setGateDisabled(btn, false);
        btn.textContent = "라이브 입장 (선생님)";
        return;
      }
      if (status.state === "other_teacher") {
        setGateDisabled(btn, true);
        btn.textContent = "본인 수업만 입장";
        return;
      }
      if (status.state === "guest") {
        setGateDisabled(btn, false);
        btn.textContent = "라이브 입장";
        return;
      }
      if (status.state === "student_active") {
        setGateDisabled(btn, false);
        btn.textContent = "라이브 입장";
        return;
      }
      if (status.state === "student_expired") {
        setGateDisabled(btn, true);
        btn.textContent = "만료 (재수강 후 입장)";
        return;
      }
      if (status.state === "student_not_enrolled") {
        setGateDisabled(btn, true);
        btn.textContent = "수강 등록 후 입장";
        return;
      }
      setGateDisabled(btn, true);
      btn.textContent = "권한 없음";
    });

    // 결제/수강 버튼 UI도 상태 반영
    if (buyBtn) {
      if (status.state === "owner_teacher") {
        buyBtn.textContent = "선생님은 결제 없이 라이브/녹화가 가능합니다";
        setGateDisabled(buyBtn, true);
        if (teacherHint) teacherHint.style.display = "block";
      } else if (status.state === "other_teacher") {
        buyBtn.textContent = "선생님 계정은 학생 결제를 할 수 없습니다";
        setGateDisabled(buyBtn, true);
        if (teacherHint) teacherHint.style.display = "none";
      } else if (status.state === "student_active") {
        buyBtn.textContent = `수강중 (종료: ${status.endText})`;
        setGateDisabled(buyBtn, true);
        if (teacherHint) teacherHint.style.display = "none";
      } else if (status.state === "student_expired") {
        buyBtn.textContent = "재수강 결제하기";
        setGateDisabled(buyBtn, false);
        if (teacherHint) teacherHint.style.display = "none";
      } else if (status.state === "student_not_enrolled") {
        buyBtn.textContent = buyBtnDefaultText;
        setGateDisabled(buyBtn, false);
        if (teacherHint) teacherHint.style.display = "none";
      } else {
        buyBtn.textContent = buyBtnDefaultText;
        setGateDisabled(buyBtn, false);
        if (teacherHint) teacherHint.style.display = "none";
      }
    }

    // 상태 문구
    if (enrollStateText) {
      if (status.state === "guest") {
        enrollStateText.textContent = "로그인 후 수강 등록하면 라이브/다시보기가 열립니다.";
      } else if (status.state === "student_not_enrolled") {
        enrollStateText.textContent = "아직 수강 등록이 없습니다. 결제 후 라이브/다시보기가 열립니다.";
      } else if (status.state === "student_active") {
        enrollStateText.textContent = `수강중입니다. (종료: ${status.endText})`;
      } else if (status.state === "student_expired") {
        enrollStateText.textContent = `수강이 만료되었습니다. (종료: ${status.endText}) 재수강 후 이용 가능합니다.`;
      } else if (status.state === "owner_teacher") {
        enrollStateText.textContent = "선생님(본인 수업) 권한: 라이브/녹화/삭제 이용 가능";
      } else if (status.state === "other_teacher") {
        enrollStateText.textContent = "선생님 계정은 본인 수업만 이용 가능합니다.";
      } else {
        enrollStateText.textContent = "";
      }
    }

    const canWatch = (status.state === "owner_teacher") || (status.state === "student_active");
    if (canWatch) ensureProtectedData();
    refreshReplayButtons(canWatch);
  }

  function bindEnterClicks() {
    const enterBtns = getDetailEnterButtons();
    enterBtns.forEach(btn => {
      if (btn.dataset.liveBound === "1") return;
      btn.dataset.liveBound = "1";

      btn.addEventListener("click", () => {
        const u = getUser();
        if (!u) {
          alert("로그인이 필요합니다.");
          navigateTo("login.html");
          return;
        }

        const isOwnerTeacher = isOwnerTeacherForClass(u, c);

        if (u.role === "teacher") {
          if (!isOwnerTeacher) {
            alert("선생님은 본인 수업만 라이브에 들어갈 수 있습니다.");
            return;
          }
          navigateTo(`live_class.html?id=${encodeURIComponent(c.id)}&s=1`);
          return;
        }

        if (!isEnrollmentActiveForUser(u, c.id)) {
          alert("수강(결제) 후 라이브 입장이 가능합니다.");
          $("#purchase")?.scrollIntoView({ behavior: "smooth", block: "start" });
          refreshGates();
          return;
        }

        navigateTo(`live_class.html?id=${encodeURIComponent(c.id)}&s=1`);
      });
    });
  }

  // v13: 페이지 진입 시에도 한번 정규화(과거 키 혼재로 상태 판정이 꼬이는 경우 방지)
  const u0 = getUser();
  if (u0) normalizeEnrollmentsForUser(u0, c.id);

  refreshGates();
  bindEnterClicks();
  ensureProtectedData();

  buyBtn?.addEventListener("click", async () => {
    const user = getUser();
    if (!user) {
      alert("로그인이 필요합니다.");
      navigateTo("login.html");
      return;
    }
    if (user.role !== "student") {
      alert("학생 계정만 수강 등록이 가능합니다.");
      return;
    }

    const status = readEnrollmentForUser(user, c.id);
    const isActiveAlready = status && isEnrollmentActiveForUser(user, c.id);
    if (isActiveAlready) {
      alert("이미 수강중입니다.");
      refreshGates();
      return;
    }

    const { weekly, dur, total } = calc();

    try {
      await apiPost(`/api/classes/${encodeURIComponent(c.id)}/enroll`, {
        planType: weekly ? "weekly" : "monthly",
        duration: dur,
        paidAmount: total,
      });
      const latest = await apiGet("/api/me/enrollments");
      setEnrollments(latest || []);
      alert("수강 등록 완료!");
    } catch (err) {
      console.error(err);
      alert("수강 등록 실패\n" + (err?.message || ""));
    }

    refreshGates();
    bindEnterClicks();
    ensureProtectedData();
    refreshGates();
  });

  // ---------------------------
  // 자료실 / 과제 / 리뷰 / Q&A 렌더링
  // ---------------------------
  function renderMaterials() {
    if (!isDetailPageActive()) return;
    const list = $("#materialList");
    if (!list) return;
    const mats = getMaterials()[c.id] || [];
    const showUploader = (m) => {
      const raw = m.uploaderId || m.author || "";
      const looksUuid = raw.includes("-") && raw.length > 20;
      return looksUuid ? "" : raw;
    };
    list.innerHTML = mats.length
      ? mats.map(m => `
        <div class="session-item">
          <div>
            <div class="session-title">${escapeHtml(m.title)}</div>
            <div class="session-sub">
              ${new Date(m.createdAt || m.at || Date.now()).toLocaleString("ko-KR")}
              ${showUploader(m) ? ` · ${escapeHtml(showUploader(m))}` : ""}
            </div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button
              class="btn primary"
              type="button"
              data-storage-path="${escapeAttr(m.filePath || "")}"
              data-file-name="${escapeAttr(m.fileName || m.title || "자료")}"
              data-file-url="${escapeAttr(m.fileUrl || m.url || "")}"
            >다운로드</button>
          </div>
        </div>
      `).join("")
      : `<div class="muted" style="font-size:13px;">아직 등록된 자료가 없습니다.</div>`;

    list.querySelectorAll("[data-storage-path]").forEach((btn) => {
      const p = btn.getAttribute("data-storage-path");
      const directUrl = btn.getAttribute("data-file-url") || "";
      btn.addEventListener("click", async () => {
        const fname = btn.getAttribute("data-file-name") || "download";
        try {
          const url = await resolveStorageDownloadUrl(p || directUrl, fname);
          await forceDownload(url, fname);
        } catch (err) {
          console.error(err);
          alert("파일을 가져오지 못했습니다. 잠시 후 다시 시도하세요.");
        }
      });
    });
  }

  function renderAssignments() {
    if (!isDetailPageActive()) return;
    const list = $("#assignList");
    if (!list) return;
    const assignList = getAssignments()[c.id] || [];
    const assignMap = Object.fromEntries(assignList.map(a => [a.id, a]));
    const latestAssignId = assignList.length ? assignList[assignList.length - 1].id : null;
    const selectEl = $("#assignSelect");
    const prevSelected = assignPendingSelect || selectEl?.value || null;
    if (selectEl) {
      selectEl.innerHTML = assignList.length
        ? assignList.map(a => `<option value="${escapeAttr(a.id)}">${escapeHtml(a.title || "무제")} · ${a.dueAt ? new Date(a.dueAt).toLocaleString("ko-KR") : "마감 없음"}</option>`).join("")
        : `<option>등록된 과제가 없습니다</option>`;
      if (prevSelected && assignMap[prevSelected]) {
        selectEl.value = prevSelected;
      } else if (!selectEl.value && latestAssignId) {
        selectEl.value = latestAssignId;
      } else if (selectEl.value && !assignMap[selectEl.value] && latestAssignId) {
        selectEl.value = latestAssignId;
      }
      selectEl.disabled = !assignList.length;
      if (!selectEl.dataset.boundChange) {
        selectEl.dataset.boundChange = "1";
        selectEl.addEventListener("change", () => {
          assignPendingSelect = selectEl.value;
          if (formWrap) formWrap.dataset.editing = "";
          renderAssignments();
        });
      }
    }
    const submitBtnMain = $("#assignSubmitBtn");
    if (submitBtnMain) submitBtnMain.disabled = !assignList.length;
    let selectedAssignId = selectEl?.value || latestAssignId;
    assignPendingSelect = null;
    const meta = (selectedAssignId && assignMap[selectedAssignId]) ? assignMap[selectedAssignId] : (assignList[assignList.length - 1] || {});

    const isOwnerTeacher = isOwnerTeacherForClass(user, c);
    const myEmail = normalizeEmail(user?.email || "");
    const submissions = Array.isArray(meta?.submissions) ? meta.submissions : [];
    const myAssign = submissions.find(a => normalizeEmail(a.userEmail || a.studentEmail || "") === myEmail || a.studentId === user?.id) || null;
    const formWrap = document.getElementById("assignFormWrap");
    const textEl = document.getElementById("assignText");
    const fileEl = document.getElementById("assignFile");
    let filePreview = document.getElementById("assignFilePreview");
    if (!filePreview && fileEl?.parentElement) {
      filePreview = document.createElement("div");
      filePreview.id = "assignFilePreview";
      filePreview.className = "muted";
      filePreview.style.marginTop = "6px";
      fileEl.parentElement.appendChild(filePreview);
    }
    const renderFilePreview = (label, onRemove) => {
      if (!filePreview) return;
      if (!label) {
        filePreview.innerHTML = `<span style="color:rgba(15,23,42,.55); font-size:12px;">첨부 없음</span>`;
        return;
      }
      filePreview.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <span style="font-size:13px;">${escapeHtml(label)}</span>
          <button class="btn" type="button" id="assignFileRemoveBtn" style="padding:4px 10px;">첨부 제거</button>
        </div>
      `;
      const btn = document.getElementById("assignFileRemoveBtn");
      btn?.addEventListener("click", () => {
        onRemove?.();
        renderFilePreview("");
      });
    };
    const stripTimestampPrefix = (name) => {
      if (!name) return "";
      return String(name).replace(/^\d{10,}-/, "") || String(name);
    };
    const inferFileName = (v) => {
      if (!v) return "";
      try {
        if (v.startsWith("data:")) {
          // data:[mime];name=<fname>;base64,...
          const nameMatch = v.match(/;name=([^;]+);base64,/);
          if (nameMatch && nameMatch[1]) return stripTimestampPrefix(decodeURIComponent(nameMatch[1]));
          return "첨부 파일";
        }
        if (!isHttpLike(v)) {
          const base = v.split("/").pop() || "";
          return stripTimestampPrefix(decodeURIComponent(base)) || "첨부 파일";
        }
        const u = new URL(v);
        const path = u.pathname.split("/").pop() || "";
        if (path) return stripTimestampPrefix(decodeURIComponent(path.split("?")[0])) || "첨부 파일";
        return "첨부 파일";
      } catch (_) {
        return "첨부 파일";
      }
    };
    const buildExistingFile = (submission) => {
      const fileVal = submission?.fileData || submission?.fileUrl || "";
      if (!fileVal) return null;
      return {
        name: submission?.fileName || inferFileName(fileVal) || "첨부 파일",
        data: fileVal
      };
    };
    fileEl?.addEventListener("change", () => {
      const f = fileEl.files?.[0] || null;
      if (f) {
        assignExistingFile = null;
        renderFilePreview(`${f.name} (새 첨부)`, () => {
          fileEl.value = "";
          assignExistingFile = null;
          renderFilePreview("");
        });
      } else if (assignExistingFile) {
        renderFilePreview(`${assignExistingFile.name} (기존 첨부)`, () => { assignExistingFile = null; });
      } else {
        renderFilePreview("");
      }
    });
    const submitBtn = submitBtnMain;
    const toggleStudentFields = (show) => {
      if (textEl) textEl.style.display = show ? "block" : "none";
      if (fileEl) fileEl.style.display = show ? "block" : "none";
      if (submitBtn) submitBtn.style.display = show ? "block" : "none";
    };

    // 학생 편집 상태 플래그 (dataset.editing = "1" 이면 편집/제출 가능)
    let isEditingStudent = formWrap?.dataset.editing === "1";

    if (isOwnerTeacher) {
      // 선생님: 학생 제출 폼 완전 숨김
      toggleStudentFields(false);
      if (formWrap) formWrap.style.display = "none";
      const statusEl = document.getElementById("assignStatus");
      if (statusEl) statusEl.style.display = "none";
    } else {
      // 학생: 선택된 과제 기준으로만 편집 버튼/입력 노출 결정
      const hasSubmission = !!myAssign;
      if (hasSubmission) {
        if (isEditingStudent) {
          toggleStudentFields(true);
        } else {
          if (formWrap) formWrap.dataset.editing = "0";
          toggleStudentFields(false);
        }
      } else {
        if (formWrap) formWrap.dataset.editing = "1";
        toggleStudentFields(true);
      }
    }

    // 과제 정보 카드는 제거 (폼만 유지)
    const metaInfo = document.getElementById("assignMetaInfo");
    if (metaInfo) metaInfo.remove();

    // 상태 안내 (학생용)
    let statusEl = document.getElementById("assignStatus");
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.id = "assignStatus";
      statusEl.className = "muted";
      statusEl.style.marginTop = "6px";
      const wrap = document.getElementById("assignFormWrap")?.parentElement;
      if (wrap) wrap.insertBefore(statusEl, document.getElementById("assignFormWrap"));
    }
    if (statusEl) {
      if (!assignList.length) {
        statusEl.textContent = "등록된 과제가 없습니다.";
      } else {
        const dueTxt = meta?.dueAt ? `마감: ${new Date(meta.dueAt).toLocaleString("ko-KR")}` : "마감 설정 없음";
        if (myAssign) {
          const submitted = myAssign.submittedAt || myAssign.at;
          const updated = myAssign.updatedAt ? ` / 수정: ${new Date(myAssign.updatedAt).toLocaleString("ko-KR")}` : "";
          const titleTxt = assignMap[myAssign.assignId || selectedAssignId || ""]?.title || "과제";
          statusEl.textContent = `${titleTxt} 제출 완료 (${new Date(submitted).toLocaleString("ko-KR")}${updated}) · ${dueTxt} · 수정하려면 수정 버튼을 눌러주세요.`;
        } else {
          statusEl.textContent = `선택된 과제: ${assignMap[selectedAssignId || latestAssignId || ""]?.title || "과제"} · ${dueTxt}`;
        }
      }
    }

    // 마감/과제 설정 UI (선생님)
    if (isOwnerTeacher) {
      let metaBox = document.getElementById("assignMetaBox");
      if (!metaBox) {
        metaBox = document.createElement("div");
        metaBox.id = "assignMetaBox";
        metaBox.className = "muted";
        metaBox.style.marginBottom = "8px";
        list.parentElement?.insertBefore(metaBox, list);
      }
      const dueVal = meta?.dueAt || "";
      metaBox.innerHTML = `
        <div style="display:grid; gap:8px; border:1px solid rgba(15,23,42,.08); padding:10px; border-radius:12px; background:rgba(255,255,255,.7);">
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <strong>과제 설정</strong>
            <input type="text" id="assignTitleInput" class="input" style="width:220px;" placeholder="과제명" value="${escapeAttr(meta.title || "")}">
            <input type="date" id="assignDueDate" class="input" style="width:160px;">
            <select id="assignDueHour" class="input" style="width:90px;">
              ${Array.from({length:24},(_,i)=>`<option value="${i}">${String(i).padStart(2,"0")}시</option>`).join("")}
            </select>
            <select id="assignDueMin" class="input" style="width:90px;">
              ${["00","10","20","30","40","50"].map(m=>`<option value="${Number(m)}">${m}분</option>`).join("")}
            </select>
            <button class="btn" id="assignDueSave">저장</button>
            <button class="btn" id="assignDueClear">초기화</button>
          </div>
          <textarea id="assignDescInput" class="input" placeholder="과제 설명을 입력하세요.">${escapeHtml(meta.desc || "")}</textarea>
          <div class="muted" style="font-size:12px;">마감 이후 제출/수정은 차단됩니다.</div>
        </div>
        <div id="assignListMeta" style="margin-top:8px;"></div>
      `;
      const t = document.getElementById("assignTitleInput");
      const d = document.getElementById("assignDescInput");
      const dueDate = document.getElementById("assignDueDate");
      const dueHour = document.getElementById("assignDueHour");
      const dueMin = document.getElementById("assignDueMin");
      if (t) t.value = meta?.title || "";
      if (d) d.value = meta?.desc || "";
      if (dueDate && dueHour && dueMin) {
        if (meta?.dueAt) {
          const dt = new Date(meta.dueAt);
          dueDate.value = dt.toISOString().slice(0,10);
          dueHour.value = dt.getHours();
          const m = dt.getMinutes();
          dueMin.value = [0,10,20,30,40,50].includes(m) ? m : 0;
        } else {
          dueDate.value = "";
          dueHour.value = "23";
          dueMin.value = "50";
        }
      }
      document.getElementById("assignDueSave")?.addEventListener("click", async () => {
        const dateStr = document.getElementById("assignDueDate")?.value || "";
        const hourStr = document.getElementById("assignDueHour")?.value || "0";
        const minStr = document.getElementById("assignDueMin")?.value || "0";
        let dueIso = null;
        if (dateStr) {
          const [y,m,dv] = dateStr.split("-").map(Number);
          const hh = Number(hourStr);
          const mm = Number(minStr);
          const dt = new Date(y, (m||1)-1, dv||1, hh||0, mm||0, 0, 0);
          dueIso = dt.toISOString();
        }
        const title = (document.getElementById("assignTitleInput")?.value || "").trim();
        const desc = (document.getElementById("assignDescInput")?.value || "").trim();
        if (!title) { alert("과제명을 입력하세요."); return; }
        try {
          const editingId = metaBox.dataset.editing;
          if (editingId) {
            try {
              await apiRequest(`/api/assignments/${encodeURIComponent(editingId)}`, "PUT", {
                title,
                description: desc,
                dueAt: dueIso,
              });
            } catch (e) {
              if ((e?.message || "").includes("Not Found")) {
                // 서버에 없으면 새로 생성으로 대체
                await apiPost(`/api/classes/${encodeURIComponent(c.id)}/assignments`, {
                  title,
                  description: desc,
                  dueAt: dueIso,
                });
              } else {
                throw e;
              }
            }
          } else {
            await apiPost(`/api/classes/${encodeURIComponent(c.id)}/assignments`, {
              title,
              description: desc,
              dueAt: dueIso,
            });
          }
          const refreshed = await apiGet(`/api/classes/${encodeURIComponent(c.id)}/assignments`).catch(() => []);
          const amap = getAssignments();
          amap[c.id] = refreshed || [];
          setAssignments(amap);
          renderAssignments();
        } catch (e) {
          console.error(e);
          alert("과제 저장 실패\n" + (e?.message || ""));
        }
      });
      document.getElementById("assignDueClear")?.addEventListener("click", () => {
        metaBox.dataset.editing = "";
        assignPendingSelect = null;
        const t = document.getElementById("assignTitleInput");
        const d = document.getElementById("assignDescInput");
        const dueD = document.getElementById("assignDueDate");
        const dueH = document.getElementById("assignDueHour");
        const dueM = document.getElementById("assignDueMin");
        if (t) t.value = "";
        if (d) d.value = "";
        if (dueD) dueD.value = "";
        if (dueH) dueH.value = "0";
        if (dueM) dueM.value = "0";
      });

      // 과제 목록(설정/수정)
      const metaListBox = document.getElementById("assignListMeta");
      if (metaListBox) {
        metaListBox.innerHTML = assignList.length ? assignList.map(m => `
          <div class="session-item" style="border-left:3px solid rgba(109,94,252,.35); margin-top:6px;">
            <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">
              <div class="session-title">${escapeHtml(m.title || "무제")}</div>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button class="btn" data-assign-edit="${escapeAttr(m.id)}">수정</button>
                <button class="btn danger" data-assign-delete="${escapeAttr(m.id)}">삭제</button>
              </div>
            </div>
            <div class="session-sub">${m.dueAt ? `마감: ${new Date(m.dueAt).toLocaleString("ko-KR")}` : "마감 없음"}</div>
            ${m.desc ? `<div class="session-sub" style="white-space:pre-wrap;">${escapeHtml(m.desc)}</div>` : ``}
          </div>
        `).join("") : `<div class="muted" style="font-size:13px;">등록된 과제가 없습니다. 과제명을 입력 후 저장을 눌러 추가하세요.</div>`;

        $$("[data-assign-edit]").forEach(btn => {
          btn.addEventListener("click", () => {
            const id = btn.getAttribute("data-assign-edit");
            const target = assignMap[id];
            if (!target) return;
            metaBox.dataset.editing = id;
            assignPendingSelect = id;
            const t = document.getElementById("assignTitleInput");
            const d = document.getElementById("assignDescInput");
            const dueDate = document.getElementById("assignDueDate");
            const dueHour = document.getElementById("assignDueHour");
            const dueMin = document.getElementById("assignDueMin");
            if (t) t.value = target.title || "";
            if (d) d.value = target.description || target.desc || "";
            if (target.dueAt && dueDate && dueHour && dueMin) {
              const dt = new Date(target.dueAt);
              dueDate.value = dt.toISOString().slice(0,10);
              dueHour.value = dt.getHours();
              const m = dt.getMinutes();
              dueMin.value = [0,10,20,30,40,50].includes(m) ? m : 0;
            } else {
              if (dueDate) dueDate.value = "";
              if (dueHour) dueHour.value = "23";
              if (dueMin) dueMin.value = "50";
            }
            if (selectEl) selectEl.value = id;
            const submitBtn2 = document.getElementById("assignSubmitBtn");
            if (submitBtn2) submitBtn2.disabled = false;
          });
        });
        $$("[data-assign-delete]").forEach(btn => {
          btn.addEventListener("click", async () => {
            const id = btn.getAttribute("data-assign-delete");
            if (!confirm("해당 과제를 삭제할까요?")) return;
            try {
              await apiRequest(`/api/assignments/${encodeURIComponent(id)}`, "DELETE");
              const refreshed = await apiGet(`/api/classes/${encodeURIComponent(c.id)}/assignments`).catch(() => []);
              const amap = getAssignments();
              amap[c.id] = refreshed || [];
              setAssignments(amap);
              if (selectEl && refreshed?.length) {
                selectEl.value = refreshed[refreshed.length - 1].id;
              }
              renderAssignments();
            } catch (e) {
              console.error(e);
              if ((e?.message || "").includes("Not Found")) {
                // 서버에 없으면 로컬 목록을 새로고침해 정리
                const refreshed = await apiGet(`/api/classes/${encodeURIComponent(c.id)}/assignments`).catch(() => []);
                const amap = getAssignments();
                amap[c.id] = refreshed || [];
                setAssignments(amap);
                renderAssignments();
              } else {
                alert("과제 삭제 실패\n" + (e?.message || ""));
              }
            }
          });
        });
      }
    } else {
      const metaBox = document.getElementById("assignMetaBox");
      if (metaBox) metaBox.remove();
    }

    if (!isOwnerTeacher) {
      // 학생 화면: 선택된 과제 기준으로 본인 제출만 보여주기
      if (myAssign) {
      const scoreVal = (myAssign.score ?? "") === "" || myAssign.score === null ? null : myAssign.score;
      const feedbackVal = myAssign.feedback || "";
      const gradedLine = (scoreVal !== null || feedbackVal)
        ? `<div class="session-sub" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <span class="chip" style="padding:4px 8px;">점수</span>
            <strong>${scoreVal === null ? "미입력" : `${escapeHtml(scoreVal)}점`}</strong>
            <span class="chip" style="padding:4px 8px;">코멘트</span>
            <span>${feedbackVal ? escapeHtml(feedbackVal) : "미입력"}</span>
          </div>`
        : `<div class="session-sub" style="color:rgba(15,23,42,.6);">채점 대기 중입니다.</div>`;
      list.innerHTML = `
        <div class="muted" style="margin-bottom:6px;">제출한 과제는 선생님만 확인할 수 있습니다.</div>
        <div class="session-item" style="border-left:3px solid rgba(109,94,252,.35);">
          <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div class="session-title">${escapeHtml(assignMap[myAssign.assignId || selectedAssignId || ""]?.title || "제출함")}</div>
            <span class="chip" style="background:rgba(109,94,252,.14);">내 제출</span>
          </div>
          <div class="session-sub">제출: ${new Date(myAssign.submittedAt || myAssign.at).toLocaleString("ko-KR")}${myAssign.updatedAt ? ` / 수정: ${new Date(myAssign.updatedAt).toLocaleString("ko-KR")}` : ""}</div>
          ${gradedLine}
          <div class="session-sub" style="white-space:pre-wrap;">${escapeHtml(myAssign.text || "")}</div>
          ${myAssign.url ? `<div class="session-sub"><a href="${escapeAttr(myAssign.url)}" target="_blank">링크 열기</a></div>` : ``}
          ${(() => {
            const fUrl = myAssign.fileData || myAssign.fileUrl || "";
            const fName = myAssign.fileName || inferFileName(fUrl) || "첨부 파일";
            if (!fUrl) return ``;
            const isDirect = isHttpLike(fUrl) || fUrl.startsWith("data:");
            const linkHtml = isDirect
              ? `<a href="${escapeAttr(fUrl)}" download="${escapeAttr(fName)}" target="_blank" style="font-weight:700;">${escapeHtml(fName)}</a>`
              : `<a href="#" data-download-path="${escapeAttr(fUrl)}" data-file-name="${escapeAttr(fName)}" style="font-weight:700; text-decoration:underline;">${escapeHtml(fName)}</a>`;
            return `<div class="session-sub" style="display:flex; gap:8px; align-items:center;">
              <span class="chip secondary" style="padding:4px 8px;">첨부</span>
              ${linkHtml}
            </div>`;
          })()}
          <div style="margin-top:8px;">
            <button class="btn" id="assignEditMine">수정</button>
          </div>
        </div>
      `;
        // 내 제출 수정: 폼에 값 채워서 다시 제출할 수 있게
        $("#assignEditMine")?.addEventListener("click", () => {
          const sel = document.getElementById("assignSelect");
      if (sel && myAssign.assignId) sel.value = myAssign.assignId;
      const txt = document.getElementById("assignText");
      if (txt) txt.value = myAssign.content || myAssign.text || "";
      assignExistingFile = buildExistingFile(myAssign);
      if (fileEl) fileEl.value = "";
      if (assignExistingFile) {
        renderFilePreview(`${assignExistingFile.name} (기존 첨부)`, () => { assignExistingFile = null; });
      } else {
        renderFilePreview("");
      }
      const status = document.getElementById("assignStatus");
      if (status) status.textContent = "수정 후 다시 제출 버튼을 눌러주세요.";
      if (formWrap) formWrap.dataset.editing = "1";
      toggleStudentFields(true);
      if (formWrap) formWrap.style.display = "block";
        });
        // 제출한 상태에서는 기본적으로 입력 필드 숨김 (수정 버튼을 눌렀을 때만 다시 보임)
      const showForm = formWrap?.dataset.editing === "1";
      if (formWrap) {
        formWrap.dataset.editing = showForm ? "1" : "0";
        formWrap.style.display = showForm ? "block" : "none";
      }
      if (showForm && myAssign && !assignExistingFile) {
        assignExistingFile = buildExistingFile(myAssign);
      }
      toggleStudentFields(showForm);
      if (!showForm) renderFilePreview("");
      if (showForm && assignExistingFile) {
        renderFilePreview(`${assignExistingFile.name} (기존 첨부)`, () => { assignExistingFile = null; });
      }
    } else {
      list.innerHTML = `<div class="muted" style="font-size:13px;">제출한 과제가 없습니다. 제출 후에는 선생님만 전체 목록을 볼 수 있습니다.</div>`;
      toggleStudentFields(true);
      if (formWrap) {
        formWrap.dataset.editing = "1";
        formWrap.style.display = "block";
      }
      renderFilePreview("");
    }
    attachSubmissionFileFetchHandlers();
    return;
    }

    list.innerHTML = assignList.length
      ? assignList.map(a => {
        const subCount = Array.isArray(a.submissions) ? a.submissions.length : 0;
        return `
        <div class="session-item">
          <div>
            <div class="session-title">${escapeHtml(a.title)}</div>
            <div class="session-sub">제출 마감: ${a.dueAt ? new Date(a.dueAt).toLocaleString("ko-KR") : "마감 없음"}</div>
            <div class="session-sub" style="white-space:pre-wrap;">${escapeHtml(a.description || "")}</div>
              <div class="session-sub">제출: ${subCount}건</div>
            ${subCount ? `
              <div style="margin-top:8px; display:flex; flex-direction:column; gap:8px;">
                ${a.submissions.map(s => {
                  const when = new Date(s.submittedAt || s.at || s.updatedAt || Date.now()).toLocaleString("ko-KR");
                  const who = escapeHtml(s.student?.name || s.studentName || s.studentEmail || s.studentId || "학생");
                  const txt = escapeHtml(s.content || s.text || "");
                  const fUrl = s.fileUrl || s.fileData || "";
                  const fName = s.fileName || inferFileName(fUrl) || "첨부 파일";
                  const fileRow = (fUrl || s.hasFile) ? `<div class="session-sub" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                      <span class="chip secondary" style="padding:4px 8px;">첨부</span>
                      ${fUrl
                        ? `<a href="${escapeAttr(fUrl)}" download="${escapeAttr(fName)}" target="_blank" style="font-weight:700;">${escapeHtml(fName)}</a>`
                        : `<a href="#" data-fetch-file="${escapeAttr(s.id)}" data-file-name="${escapeAttr(fName)}" style="font-weight:700; text-decoration:underline;">${escapeHtml(fName)}</a>`}
                    </div>` : "";
                  const scoreVal = (s.score ?? "") === "" || s.score === null ? "" : s.score;
                  const feedbackVal = s.feedback || "";
                  const gradedInfo = (scoreVal !== "" || feedbackVal)
                    ? `저장됨 · ${new Date(s.gradedAt || s.updatedAt || Date.now()).toLocaleString("ko-KR")}`
                    : "점수/피드백을 입력해 저장하세요.";
                  const savedDisplay = `
                    <div class="session-sub" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                      <span class="chip" style="padding:4px 8px;">점수</span>
                      <strong>${scoreVal === "" ? "미입력" : `${escapeHtml(scoreVal)}점`}</strong>
                      <span class="chip" style="padding:4px 8px;">코멘트</span>
                      <span>${feedbackVal ? escapeHtml(feedbackVal) : "미입력"}</span>
                    </div>
                  `;
                  return `
                    <div class="card" style="padding:10px 12px; background:rgba(255,255,255,.72);">
                      <div class="session-sub" style="font-weight:950;">${who} · ${when}</div>
                      <div class="session-sub" style="color:rgba(15,23,42,.6);">${gradedInfo}</div>
                      ${savedDisplay}
                      <div class="session-sub" style="white-space:pre-wrap;">${txt || "(내용 없음)"}</div>
                      ${fileRow}
                      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:6px;">
                        <label style="font-size:12px; font-weight:950;">점수</label>
                        <input type="number" min="0" max="100" step="1" value="" placeholder="예: 100" data-grade-score="${escapeAttr(s.id)}" data-last-score="${escapeAttr(scoreVal)}" class="input" style="width:90px;">
                        <label style="font-size:12px; font-weight:950;">코멘트</label>
                        <input type="text" value="" placeholder="피드백 입력" data-grade-feedback="${escapeAttr(s.id)}" data-last-feedback="${escapeAttr(feedbackVal)}" class="input" style="flex:1; min-width:180px;">
                        <button class="btn" type="button" data-grade-fill="${escapeAttr(s.id)}">불러오기</button>
                        <button class="btn primary" type="button" data-grade-save="${escapeAttr(s.id)}" data-grade-assign="${escapeAttr(a.id)}">저장</button>
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            ` : ``}
          </div>
        </div>
      `;
      }).join("")
      : `<div class="muted" style="font-size:13px;">등록된 과제가 없습니다.</div>`;

    attachSubmissionFileFetchHandlers();

    if (isOwnerTeacher) {
      $$("[data-grade-fill]").forEach(btn => {
        btn.addEventListener("click", () => {
          const subId = btn.getAttribute("data-grade-fill");
          const scoreInput = document.querySelector(`[data-grade-score="${CSS.escape(subId)}"]`);
          const fbInput = document.querySelector(`[data-grade-feedback="${CSS.escape(subId)}"]`);
          if (scoreInput) scoreInput.value = scoreInput.getAttribute("data-last-score") || "";
          if (fbInput) fbInput.value = fbInput.getAttribute("data-last-feedback") || "";
        });
      });

      $$("[data-grade-save]").forEach(btn => {
        btn.addEventListener("click", async () => {
          // 클릭 시 폼 submit 방지
          try { btn.closest("form")?.addEventListener("submit", (ev) => ev.preventDefault(), { once: true }); } catch (_) {}
          const subId = btn.getAttribute("data-grade-save");
          const asgId = btn.getAttribute("data-grade-assign");
          const scoreInput = document.querySelector(`[data-grade-score="${CSS.escape(subId)}"]`);
          const fbInput = document.querySelector(`[data-grade-feedback="${CSS.escape(subId)}"]`);
          const scoreRaw = scoreInput?.value;
          const feedbackVal = fbInput?.value || "";
          const originalText = btn.textContent;
          const scorePayload = (scoreRaw === "" || scoreRaw === null || scoreRaw === undefined)
            ? null
            : (Number.isFinite(Number(scoreRaw)) ? Number(scoreRaw) : null);

          const patchLocalGrade = () => {
            const amap = getAssignments();
            const list = amap[c.id] || [];
            const patched = list.map(a => {
              if (a.id !== asgId) return a;
              return {
                ...a,
                submissions: (a.submissions || []).map(s => s.id === subId ? { ...s, score: scorePayload, feedback: feedbackVal } : s)
              };
            });
            amap[c.id] = patched;
            setAssignments(amap);
          };

          // 바로 화면에 반영 (느린 네트워크에서도 피드백 보장)
          patchLocalGrade();
          renderAssignments();
          attachSubmissionFileFetchHandlers();
          try {
            btn.disabled = true;
            btn.textContent = "저장중...";
            await apiPost(`/api/assignments/${encodeURIComponent(asgId)}/submissions/${encodeURIComponent(subId)}/grade`, {
              score: scorePayload,
              feedback: feedbackVal,
            });
            let refreshed = null;
            try {
              refreshed = await apiGet(`/api/classes/${encodeURIComponent(c.id)}/assignments`, { silent: true }).catch(() => null);
            } catch (_) {
              refreshed = null;
            }
            if (Array.isArray(refreshed)) {
              const amap = getAssignments();
              amap[c.id] = refreshed || [];
              setAssignments(amap);
            }
            renderAssignments();
            showToast("채점이 저장됐어요.", "success");
            // 입력값 초기화
            const scoreInput = document.querySelector(`[data-grade-score="${CSS.escape(subId)}"]`);
            const fbInput = document.querySelector(`[data-grade-feedback="${CSS.escape(subId)}"]`);
            if (scoreInput) {
              scoreInput.setAttribute("data-last-score", scorePayload === null ? "" : String(scorePayload));
              scoreInput.value = "";
            }
            if (fbInput) {
              fbInput.setAttribute("data-last-feedback", feedbackVal || "");
              fbInput.value = "";
            }
          } catch (e) {
            console.error(e);
            alert("채점 저장 실패\n" + (e?.message || ""));
            const refreshed = await apiGet(`/api/classes/${encodeURIComponent(c.id)}/assignments`, { silent: true }).catch(() => null);
            if (Array.isArray(refreshed)) {
              const amap = getAssignments();
              amap[c.id] = refreshed || [];
              setAssignments(amap);
              renderAssignments();
            }
          } finally {
            btn.disabled = false;
            btn.textContent = "저장됨";
            setTimeout(() => {
              btn.textContent = originalText || "저장";
            }, 1200);
          }
        });
      });
    }
  }

  // 첨부 파일 on-demand fetch (teacher view에서 fileUrl 제거했으므로 필요)
  function attachSubmissionFileFetchHandlers() {
    $$("[data-fetch-file]").forEach(link => {
      const handler = async (e) => {
        e.preventDefault();
        const subId = link.getAttribute("data-fetch-file");
        const fname = link.getAttribute("data-file-name") || "첨부파일";
        try {
          link.classList.add("is-loading");
          link.textContent = "불러오는 중...";
          const res = await apiGet(`/api/submissions/${encodeURIComponent(subId)}/file`, { silent: true });
          const url = res?.fileUrl;
          const name = res?.fileName || fname;
          if (!url) throw new Error("첨부가 없습니다.");
          const finalUrl = url.startsWith("data:") ? encodeDataUrlWithName(url, name) : url;
          await forceDownload(finalUrl, name);
        } catch (e) {
          alert("첨부를 불러오지 못했습니다.\n" + (e?.message || ""));
        } finally {
          link.classList.remove("is-loading");
          link.textContent = fname;
        }
      };
      link.addEventListener("click", handler, { once: true });
    });
    $$("[data-download-path]").forEach(link => {
      if (link.dataset.downloadBound === "1") return;
      link.dataset.downloadBound = "1";
      link.addEventListener("click", async (e) => {
        e.preventDefault();
        const path = link.getAttribute("data-download-path") || "";
        const fname = link.getAttribute("data-file-name") || "첨부 파일";
        try {
          link.classList.add("is-loading");
          link.textContent = "불러오는 중...";
          const url = await resolveStorageDownloadUrl(path, fname);
          if (!url) throw new Error("첨부가 없습니다.");
          const finalUrl = url.startsWith("data:") ? encodeDataUrlWithName(url, fname) : url;
          await forceDownload(finalUrl, fname);
        } catch (err) {
          alert("첨부를 불러오지 못했습니다.\n" + (err?.message || ""));
        } finally {
          link.classList.remove("is-loading");
          link.textContent = fname;
        }
      });
    });
  }

  function renderReviews() {
    if (!isDetailPageActive()) return;
    const list = $("#reviewList");
    if (!list) return;
    const revs = getReviews()[c.id] || [];
    const showName = (r) => escapeHtml(displayUserName(r));
    const avg = revs.length ? (revs.reduce((s,r)=>s+(r.rating||0),0)/revs.length).toFixed(1) : "-";
    list.innerHTML = `
      <div class="muted" style="margin-bottom:8px;">평점: ${avg} / 5 (${revs.length}명)</div>
      ${revs.length ? revs.map(r => `
        <div class="session-item">
          <div>
            <div class="session-title">★ ${r.rating} · ${showName(r)}</div>
            <div class="session-sub">${new Date(r.createdAt || r.at).toLocaleString("ko-KR")}</div>
            <div class="session-sub" style="white-space:pre-wrap;">${escapeHtml(r.comment || r.text || "")}</div>
          </div>
        </div>
      `).join("") : `<div class="muted" style="font-size:13px;">아직 리뷰가 없습니다.</div>`}
    `;
  }

  function renderQna() {
    if (!isDetailPageActive()) return;
    const list = $("#qnaList");
    if (!list) return;
    const nameOf = (obj) => escapeHtml(displayUserName(obj));
    const roleOf = (obj) => escapeHtml(displayUserRole(obj));
  const qnas = getQna()[c.id] || [];
  list.innerHTML = qnas.length ? qnas.map(q => `
    <div class="session-item">
      <div>
          <div class="session-title">${escapeHtml(q.question || q.text || "")}</div>
          <div class="session-sub">${new Date(q.createdAt || q.at || Date.now()).toLocaleString("ko-KR")} · ${nameOf(q)} (${roleOf(q)})</div>
          <div style="margin-top:8px; display:grid; gap:6px;">
            ${(q.replies || []).map(r => `
              <div class="session-sub" style="background:rgba(15,23,42,.04); padding:6px 8px; border-radius:10px;">
                <strong>${nameOf(r)} (${roleOf(r)})</strong><br/>
                ${escapeHtml(r.text || r.comment || "")} <span style="color:var(--muted2);">(${new Date(r.at || r.createdAt || Date.now()).toLocaleString("ko-KR")})</span>
              </div>
            `).join("")}
          </div>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <input class="input" data-qreply="${escapeAttr(q.id)}" placeholder="댓글 입력" style="width:180px;">
          <button class="btn" data-qreplybtn="${escapeAttr(q.id)}">답변</button>
        </div>
      </div>
    `).join("") : `<div class="muted" style="font-size:13px;">등록된 질문이 없습니다.</div>`;

    $$("[data-qreplybtn]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!user) { alert("로그인이 필요합니다."); return; }
        const qid = btn.getAttribute("data-qreplybtn");
        const inp = document.querySelector(`[data-qreply="${CSS.escape(qid)}"]`);
        const text = (inp?.value || "").trim();
        if (!text) return;
        try {
          await apiPost(`/api/qna/${encodeURIComponent(qid)}/comments`, { comment: text });
          const list = await apiGet(`/api/classes/${encodeURIComponent(c.id)}/qna`).catch(() => []);
          const all = getQna();
          all[c.id] = list || [];
          setQna(all);
          renderQna();
        } catch (e) {
          console.error(e);
          alert("댓글 저장 실패");
        }
      });
    });
  }

  // 자료 업로드 (선생님만)
  const matForm = $("#materialFormWrap");
  if (matForm) matForm.style.display = isOwnerTeacherForClass(user, c) ? "block" : "none";
  $("#matUploadBtn")?.addEventListener("click", () => {
    if (!isOwnerTeacherForClass(user, c)) return;
    const title = ($("#matTitle")?.value || "").trim();
    const file = $("#matFile")?.files?.[0] || null;
    if (!title || !file) { alert("제목과 파일을 입력하세요."); return; }
    (async () => {
      try {
        const { signedUrl, path } = await uploadToSupabaseStorage(file, `materials/${c.id}`);
        await apiPost(`/api/classes/${encodeURIComponent(c.id)}/materials`, {
          title,
          fileUrl: signedUrl || path,
          mime: file.type || null,
          filePath: path,
        });
        const mats = await apiGet(`/api/classes/${encodeURIComponent(c.id)}/materials`).catch(() => []);
        const mm = getMaterials();
        mm[c.id] = mats || [];
        setMaterials(mm);
        renderMaterials();
        // 비디오 파일이라면 다시보기에도 자동 등록
        if (file.type && file.type.startsWith("video/")) {
          try {
            await apiPost(`/api/classes/${encodeURIComponent(c.id)}/replays`, {
              title: `${title} (업로드 영상)`,
              vodUrl: signedUrl || path,
              mime: file.type || null,
              filePath: path,
            });
            const refreshed = await apiGet(`/api/classes/${encodeURIComponent(c.id)}/replays`).catch(() => []);
            const rp = getReplays();
            rp[c.id] = refreshed || [];
            setReplays(rp);
            renderReplaysList(c.id);
          } catch (err) {
            console.error(err);
          }
        }
        $("#matTitle").value = "";
        $("#matFile").value = "";
      } catch (e) {
        console.error(e);
        alert("자료 업로드 실패\n" + (e?.message || ""));
      }
    })();
  });

  // 과제 제출 (학생만)
  const assignForm = $("#assignFormWrap");
    if (assignForm) assignForm.style.display = (user?.role === "student") ? "block" : "none";
  $("#assignSubmitBtn")?.addEventListener("click", async () => {
    if (!user || user.role !== "student") return;
    const assignList = Array.isArray(getAssignments()[c.id]) ? getAssignments()[c.id] : [];
    const select = document.getElementById("assignSelect");
    const currentAssignId = select?.value || (assignList[assignList.length - 1]?.id);
    if (!currentAssignId) { alert("등록된 과제가 없습니다."); return; }
    const meta = assignList.find(a => a.id === currentAssignId) || {};
    if (meta?.dueAt && Date.now() > Date.parse(meta.dueAt)) {
      alert("제출 기한이 지났습니다.");
      return;
    }
    const text = ($("#assignText")?.value || "").trim();
    const file = $("#assignFile")?.files?.[0] || null;
    if (!text && !file && !assignExistingFile) { alert("제출 내용 또는 파일을 입력하세요."); return; }

    const saveAssignment = async (fileData) => {
      try {
        await apiPost(`/api/assignments/${encodeURIComponent(currentAssignId)}/submissions`, {
          content: text,
          fileUrl: fileData || null,
        });
        const assigns = await apiGet(`/api/classes/${encodeURIComponent(c.id)}/assignments`).catch(() => []);
        const map = getAssignments();
        map[c.id] = assigns || [];
        setAssignments(map);
        renderAssignments();
        $("#assignText").value = "";
        $("#assignFile").value = "";
        assignExistingFile = null;
        alert("과제 제출 완료!");
      } catch (e) {
        console.error(e);
        alert("과제 제출 실패");
      }
    };

    const encodeDataUrlWithName = (dataUrl, fname) => {
      if (!dataUrl.startsWith("data:")) return dataUrl;
      const parts = dataUrl.split(";base64,");
      if (parts.length !== 2) return dataUrl;
      const [meta, b64] = parts;
      const name = encodeURIComponent(fname || "file");
      return `${meta};name=${name};base64,${b64}`;
    };

    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result || "");
        const withName = encodeDataUrlWithName(raw, file.name);
        saveAssignment(withName);
      };
      reader.readAsDataURL(file);
    } else if (assignExistingFile?.data) {
      await saveAssignment(assignExistingFile.data);
    } else {
      saveAssignment("");
    }
  });

  // 리뷰 작성 (학생, 수강중만)
  const reviewForm = $("#reviewFormWrap");
  const canReview = user?.role === "student" && isEnrollmentActiveForUser(user, c.id);
  if (!reviewForm && $("#reviewList")?.parentElement && canReview) {
    const wrap = document.createElement("div");
    wrap.id = "reviewFormWrap";
    wrap.style.marginTop = "12px";
    wrap.innerHTML = `
      <div class="field">
        <label>별점 (1-5)</label>
        <input id="reviewRating" class="input" type="number" min="1" max="5" value="5" />
      </div>
      <div class="field" style="margin-top:8px;">
        <label>리뷰 내용</label>
        <textarea id="reviewText" placeholder="후기를 남겨주세요."></textarea>
      </div>
      <button class="btn primary" id="reviewSubmitBtn" style="margin-top:10px;">리뷰 남기기</button>
    `;
    $("#reviewList")?.parentElement?.insertBefore(wrap, $("#reviewList"));
  }
  const reviewFormNow = $("#reviewFormWrap");
  if (reviewFormNow) reviewFormNow.style.display = canReview ? "block" : "none";
  const reviewBtn = $("#reviewSubmitBtn");
  if (reviewBtn && !reviewBtn.dataset.bound) {
    reviewBtn.dataset.bound = "1";
    reviewBtn.addEventListener("click", async () => {
      if (!canReview) return;
      const rating = Number($("#reviewRating")?.value || 5);
      const text = ($("#reviewText")?.value || "").trim();
      try {
        await apiPost(`/api/classes/${encodeURIComponent(c.id)}/reviews`, { rating, comment: text });
        const rev = await apiGet(`/api/classes/${encodeURIComponent(c.id)}/reviews`).catch(() => []);
        const rmap = getReviews();
        rmap[c.id] = rev || [];
        setReviews(rmap);
        $("#reviewText").value = "";
        renderReviews();
      } catch (e) {
        console.error(e);
        alert("리뷰 저장 실패");
      }
    });
  }

  // Q&A 작성 (로그인 필요)
  const qnaForm = $("#qnaFormWrap");
  if (qnaForm) qnaForm.style.display = user ? "block" : "none";
  $("#qnaSubmitBtn")?.addEventListener("click", async () => {
    if (!user) { alert("로그인이 필요합니다."); return; }
    const text = ($("#qnaText")?.value || "").trim();
    if (!text) return;
    try {
      await apiPost(`/api/classes/${encodeURIComponent(c.id)}/qna`, { question: text });
      const list = await apiGet(`/api/classes/${encodeURIComponent(c.id)}/qna`).catch(() => []);
      const all = getQna();
      all[c.id] = list || [];
      setQna(all);
      $("#qnaText").value = "";
      renderQna();
    } catch (e) {
      console.error(e);
      alert("Q&A 등록 실패");
    }
  });

  renderMaterials();
  renderAssignments();
  renderReviews();
  renderQna();
}

async function renderReplaysList(classId) {
  const wrap = $("#sessionList");
  if (!wrap) return;
  const detailRoot = document.getElementById("detailRoot");
  if (detailRoot?.dataset?.classId && String(detailRoot.dataset.classId) !== String(classId)) return;

  const user = getUser();
  const cls = getClasses().find((x) => x.id === classId);
  const isOwnerTeacher = user?.role === "teacher" && ((user.id && cls?.teacherId && user.id === cls.teacherId) || user?.name === cls?.teacher);
  const activeStudent = user?.role === "student" && isEnrollmentActiveForUser(user, classId);
  const canWatch = isOwnerTeacher || activeStudent;

  if (!user || !canWatch) {
    wrap.innerHTML = `<div class="muted" style="padding:10px 2px;">로그인 후 수강(또는 선생님) 상태에서 다시보기를 볼 수 있습니다.</div>`;
    return;
  }

  wrap.innerHTML = `<div class="muted" style="padding:10px 2px;">지난 수업 불러오는 중...</div>`;

  function stateList() {
    return getReplays()[classId] || [];
  }

  async function loadReplays() {
    try {
      const listRemote = await apiGet(`/api/classes/${encodeURIComponent(classId)}/replays`, { silent: true });
      const rp = getReplays();
      rp[classId] = (listRemote || []).map((r) => ({
        ...r,
        hasVod: r.hasVod ?? !!r.vodUrl,
      }));
      setReplays(rp);
    } catch (e) {
      console.error(e);
      wrap.innerHTML = `<div class="muted" style="padding:10px 2px;">다시보기를 불러오지 못했습니다.</div>`;
    }
  }

  async function fetchReplayVod(replayId) {
    const rp = getReplays();
    const cached = (rp[classId] || []).find((x) => x.id === replayId);
    if (cached?.vodUrl) return resolveStorageUrl(cached.vodUrl) || cached.vodUrl || "";

    const full = await apiGet(`/api/replays/${encodeURIComponent(replayId)}`);
    const updated = (rp[classId] || []).map((x) => (
      x.id === replayId ? { ...x, vodUrl: full?.vodUrl, hasVod: full?.hasVod ?? !!full?.vodUrl } : x
    ));
    rp[classId] = updated;
    setReplays(rp);
    return full?.vodUrl ? (await resolveStorageUrl(full?.vodUrl) || full?.vodUrl || "") : "";
  }

  function renderList() {
    const list = stateList();

    wrap.innerHTML = `
      ${list.length ? list.map((r) => `
        <div class="session-item ${canWatch ? "" : "locked"}">
          <div>
            <div class="session-title">${escapeHtml(r.title || "다시보기")}</div>
            <div class="session-sub">
              ${r.createdAt ? new Date(r.createdAt).toLocaleString("ko-KR") : ""}
              ${(r.hasVod ?? !!r.vodUrl) ? `<span class=\"badge\" style=\"margin-left:6px;\">VOD</span>` : ``}
            </div>
          </div>
          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button class="btn ${canWatch ? "primary" : "ghost"}" ${canWatch ? "" : "disabled"} data-replay="${escapeAttr(r.id)}">재생</button>
            ${isOwnerTeacher ? `<button class=\"btn danger\" data-rdel=\"${escapeAttr(r.id)}\">삭제</button>` : ``}
          </div>
        </div>
      `).join("") : `
        <div class="muted" style="font-size:13px; padding:10px 2px;">등록된 다시보기가 없어요.</div>
      `}
      ${isOwnerTeacher ? `
        <div style="margin-top:12px; display:grid; gap:8px;">
          <input id="replayTitleInput" class="input" placeholder="제목 (예: 1주차 다시보기)">
          <input id="replayUrlInput" class="input" placeholder="VOD URL (HLS/MP4 링크)">
          <input id="replayFileInput" class="input" type="file" accept="video/*">
          <button class="btn" id="teacherAddVod">다시보기 등록</button>
          <div class="muted" style="font-size:12px;">URL 또는 영상 파일 중 하나만 입력하세요. 파일은 브라우저에서 인코딩되어 서버로 전송됩니다.</div>
        </div>
      ` : ``}
      ${(!canWatch && user?.role === "student") ? `
        <div class="muted" style="font-size:13px; margin-top:10px;">
          수강 중인 학생만 다시보기를 볼 수 있습니다.
        </div>
      ` : ``}
    `;

    $$('[data-replay]', wrap).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rid = btn.getAttribute("data-replay");
        const item = stateList().find((x) => x.id === rid);
        if (!canWatch) {
          alert("수강 중인 학생 또는 선생님만 재생할 수 있습니다.");
          return;
        }

        const prev = btn.textContent;
        btn.disabled = true;
        btn.classList.add("is-loading");
        btn.textContent = "불러오는 중...";

        try {
          const vodUrl = await fetchReplayVod(rid);
          if (!vodUrl) {
            alert("영상 데이터가 없습니다. 녹화 후 다시 시도하세요.");
            return;
          }
          if (typeof window.__openReplayModal === "function") {
            await window.__openReplayModal({ title: item?.title || "다시보기", vodUrl, classId, replayId: rid });
          } else {
            window.open(vodUrl, "_blank");
          }
        } catch (err) {
          console.error(err);
          alert("다시보기를 재생할 수 없습니다.\n" + (err?.message || ""));
        } finally {
          btn.disabled = false;
          btn.classList.remove("is-loading");
          btn.textContent = prev;
        }
      });
    });

    $("#teacherAddVod")?.addEventListener("click", async () => {
      if (!isOwnerTeacher) {
        alert("선생님 계정만 다시보기를 등록할 수 있습니다.");
        return;
      }
      const title = ($("#replayTitleInput")?.value || "").trim() || `${cls?.title || "수업"} 다시보기`;
      const url = ($("#replayUrlInput")?.value || "").trim();
      const file = $("#replayFileInput")?.files?.[0] || null;
      if (!url && !file) {
        alert("VOD URL이나 영상 파일을 입력하세요.");
        return;
      }
      try {
        let vodPayload = url;
        let path = null;
        if (!vodPayload && file) {
          if (file.size > 50 * 1024 * 1024) {
            alert("Supabase 무료 요금제는 파일당 50MB까지만 업로드 가능합니다.");
            return;
          }
          const uploaded = await uploadToSupabaseStorage(file, `replays/${classId}`);
          vodPayload = uploaded.signedUrl || uploaded.path;
          path = uploaded.path;
        }
        const created = await apiPost(`/api/classes/${encodeURIComponent(classId)}/replays`, { title, vodUrl: vodPayload, mime: file?.type || null, filePath: path });
        const rp = getReplays();
        const meta = { ...created, hasVod: created?.hasVod ?? !!created?.vodUrl, vodUrl: undefined };
        rp[classId] = [meta, ...(rp[classId] || [])];
        setReplays(rp);
        renderList();

        const titleInput = $("#replayTitleInput");
        const urlInput = $("#replayUrlInput");
        const fileInput = $("#replayFileInput");
        if (titleInput) titleInput.value = "";
        if (urlInput) urlInput.value = "";
        if (fileInput) fileInput.value = "";
        alert("다시보기를 등록했습니다.");
      } catch (e) {
        console.error(e);
        alert("다시보기 등록 실패\n" + (e?.message || ""));
      }
    });

    $$('[data-rdel]', wrap).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rid = btn.getAttribute("data-rdel");
        if (!rid) return;
        if (!confirm("이 다시보기를 삭제할까요?")) return;

        const prev = btn.textContent;
        btn.disabled = true;
        btn.textContent = "삭제중...";

        try {
          await fetch(`${API_BASE_URL}/api/replays/${encodeURIComponent(rid)}`, {
            method: "DELETE",
            headers: await apiHeaders(),
          });
          const rp = getReplays();
          rp[classId] = (rp[classId] || []).filter((x) => x.id !== rid);
          setReplays(rp);
          renderList();
        } catch (e) {
          console.error(e);
          alert("다시보기 삭제 실패\n" + (e?.message || ""));
        } finally {
          btn.disabled = false;
          btn.textContent = prev;
        }
      });
    });

    refreshReplayButtons(canWatch);
  }

  await loadReplays();
  renderList();
}


// ---------------------------
// ? CREATE / DASH / LIVE
// ---------------------------
function handleCreateClassPage() {
  const form = $("#createClassForm");
  if (!form) return;

  const guard = $("#createGuard");
  const main = $("#createMain");

  const applyGuard = (user) => {
    if (!user || user.role !== "teacher") {
      if (guard) guard.style.display = "block";
      if (main) main.style.display = "none";
      return false;
    }
    if (guard) guard.style.display = "none";
    if (main) main.style.display = "block";
    return true;
  };

  const init = () => {
    if (form.dataset.bound === "1") return;
    form.dataset.bound = "1";

    const sel = $("#cCategorySelect");
    const custom = $("#cCategoryCustom");
    const hidden = $("#cCategory");

    function syncCategory() {
      if (!sel || !hidden) return;
      if (sel.value === "__custom__") {
        if (custom) custom.style.display = "block";
        hidden.value = (custom?.value || "").trim();
      } else {
        if (custom) custom.style.display = "none";
        hidden.value = sel.value;
      }
    }

    sel?.addEventListener("change", syncCategory);
    custom?.addEventListener("input", syncCategory);
    syncCategory();

    const fileInput = $("#cThumbFile");
    const preview = $("#cThumbPreview");
    let thumbDataUrl = "";
    let thumbFile = null;

    fileInput?.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (!f) {
        thumbDataUrl = "";
        thumbFile = null;
        if (preview) preview.style.display = "none";
        return;
      }
      thumbFile = f;
      const reader = new FileReader();
      reader.onload = () => {
        thumbDataUrl = String(reader.result || "");
        if (preview) {
          preview.src = thumbDataUrl;
          preview.style.display = "block";
        }
      };
      reader.readAsDataURL(f);
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const title = ($("#cTitle")?.value || "").trim();
      syncCategory();
      const category = ($("#cCategory")?.value || "").trim();
      const description = ($("#cDesc")?.value || "").trim();
      const weeklyPrice = Number($("#cWeekly")?.value || 0);
      const monthlyPrice = Number($("#cMonthly")?.value || 0);

      if (!title || !category || !description) {
        alert("제목/카테고리/설명을 입력하세요.");
        return;
      }

      try {
        let thumbUrlFinal = thumbDataUrl || FALLBACK_THUMB;
        if (thumbFile) {
          if (thumbFile.size > 50 * 1024 * 1024) {
            alert("Supabase 무료 요금제는 파일당 50MB까지만 업로드 가능합니다.");
            return;
          }
          const uploaded = await uploadToSupabaseStorage(thumbFile, "class-thumbs");
          thumbUrlFinal = uploaded.path || FALLBACK_THUMB;
        }

        await apiPost("/api/classes", {
          title,
          category,
          description,
          weeklyPrice,
          monthlyPrice,
          thumbUrl: thumbUrlFinal,
        });
        const refreshed = await apiGet("/api/classes").catch(() => []);
        setClasses(refreshed || []);
        alert("수업 생성 완료!");
        navigateTo("teacher_dashboard.html");
      } catch (e) {
        console.error(e);
        alert("수업 생성 실패\n" + (e?.message || ""));
      }
    });
  };

  (async () => {
    let user = getUser();
    if (!user) user = await ensureUserReady();
    if (!applyGuard(user)) return;
    init();
  })();
}

function loadTeacherDashboard() {
  const wrap = $("#teacherClassList");
  if (!wrap) return;

  (async () => {
    let user = getUser();
    if (!user) user = await ensureUserReady();
    if (!user) { navigateTo("login.html", { replace: true }); return; }
    if (user.role !== "teacher") { navigateTo("student_dashboard.html", { replace: true }); return; }

    let classes = getClasses();
    if (!classes.length) {
      try {
        const refreshed = await apiGet("/api/classes", { silent: true });
        if (Array.isArray(refreshed)) {
          const normalized = refreshed.map(c => ({
            ...c,
            teacher: c.teacher?.name || c.teacherName || c.teacher || "-",
            teacherId: c.teacherId || c.teacher?.id || "",
            thumb: c.thumbUrl || c.thumb || FALLBACK_THUMB,
          }));
          setClasses(normalized);
          classes = normalized;
        }
      } catch (_) {}
    }
    const mine = classes.filter(c => isOwnerTeacherForClass(user, c));

    wrap.innerHTML = `
      <div class="grid cols-2">
        ${mine.map(c => `
          <div class="class-card wide" style="cursor:default;">
            <img class="thumb" src="${escapeAttr(initialThumbSrc(c.thumb))}" data-thumb="${escapeAttr(c.thumb || "")}" alt="">
            <div class="class-body">
              <div class="title2">${escapeHtml(c.title)}</div>
              <div class="sub2">카테고리 · ${escapeHtml(c.category || "-")}</div>
              <div class="desc2">${escapeHtml(c.description || "")}</div>
              <div class="chips">
                <span class="chip">${won(c.weeklyPrice)}</span>
                <span class="chip secondary">${won(c.monthlyPrice)}</span>
              </div>
              <div class="card-actions">
                <button class="btn primary" data-open="${escapeAttr(c.id)}">상세</button>
                <button class="btn" data-live="${escapeAttr(c.id)}">라이브</button>
                <button class="btn danger" data-del="${escapeAttr(c.id)}">삭제</button>
              </div>
            </div>
          </div>
        `).join("")}
      </div>
      ${mine.length ? "" : `<p class="muted" style="margin-top:12px;">아직 만든 수업이 없어요.</p>`}
    `;

    hydrateThumbs(wrap);

    $$('[data-open]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-open');
        goClassDetail(id);
      });
    });

    $$('[data-live]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-live');
        navigateTo(`live_class.html?id=${encodeURIComponent(id)}&s=1`);
      });
    });

    $$('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-del');
        if (!id) return;
        if (!confirm("해당 수업을 삭제할까요? (관련 녹화/자료/과제/채팅도 함께 삭제됩니다)")) return;
        (async () => {
          try {
            await apiRequest(`/api/classes/${encodeURIComponent(id)}`, "DELETE");
            const refreshed = await apiGet("/api/classes").catch(() => []);
            setClasses(refreshed || []);
            alert("수업을 삭제했습니다.");
            loadTeacherDashboard(); // 리스트 갱신
          } catch (e) {
            console.error(e);
            alert("수업 삭제 실패\n" + (e?.message || ""));
          }
        })();
      });
    });
  })();
}

function loadStudentDashboard() {
  const wrap = $("#studentClassList");
  if (!wrap) return;

  (async () => {
    let user = getUser();
    if (!user) user = await ensureUserReady();
    if (!user) { navigateTo("login.html", { replace: true }); return; }
    if (user.role !== "student") { navigateTo("teacher_dashboard.html", { replace: true }); return; }

    let classes = getClasses();
    if (!classes.length) {
      try {
        const refreshed = await apiGet("/api/classes", { silent: true });
        if (Array.isArray(refreshed)) {
          const normalized = refreshed.map(c => ({
            ...c,
            teacher: c.teacher?.name || c.teacherName || c.teacher || "-",
            teacherId: c.teacherId || c.teacher?.id || "",
            thumb: c.thumbUrl || c.thumb || FALLBACK_THUMB,
          }));
          setClasses(normalized);
          classes = normalized;
        }
      } catch (_) {}
    }
    const enrolledClasses = classes.filter(c => !!readEnrollmentForUser(user, c.id));

    wrap.innerHTML = `
      <div class="grid cols-2">
        ${enrolledClasses.map(c => {
          const e = readEnrollmentForUser(user, c.id);
          const active = isEnrollmentActiveForUser(user, c.id);
          const endText = e?.endAt ? fmtDateKR(e.endAt) : (e?.endDate || "-");
          return `
            <div class="class-card wide" style="cursor:default;">
              <img class="thumb" src="${escapeAttr(initialThumbSrc(c.thumb))}" data-thumb="${escapeAttr(c.thumb || "")}" alt="">
              <div class="class-body">
                <div class="title2">${escapeHtml(c.title)}</div>
                <div class="sub2">선생님 · ${escapeHtml(c.teacher || "-")} · ${escapeHtml(c.category || "-")}</div>
                <div class="desc2">
                  상태: ${active ? `<span class="chip mint" style="display:inline-flex;">수강중</span>` : `<span class="chip" style="display:inline-flex;background:rgba(245,158,11,.12);">만료</span>`}
                  · 종료: ${endText}
                </div>
                <div class="chips">
                  <span class="chip">${won(e?.paidAmount ?? 0)}</span>
                  <span class="chip secondary">${e?.planType === "weekly" ? `${e?.duration ?? "-"}주` : `${e?.duration ?? "-"}개월`}</span>
                </div>
                <div class="card-actions">
                  <button class="btn primary" data-open="${escapeAttr(c.id)}">상세</button>
                  <button class="btn" data-live="${escapeAttr(c.id)}" ${active ? "" : "disabled"}>라이브</button>
                </div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
      ${enrolledClasses.length ? "" : `<p class="muted" style="margin-top:12px;">아직 수강 중인 수업이 없어요.</p>`}
    `;

    $$('[data-open]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-open');
        goClassDetail(id);
      });
    });
    $$('[data-live]').forEach(btn => {
      btn.highlightBound = "1";
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-live');
        navigateTo(`live_class.html?id=${encodeURIComponent(id)}&s=1`);
      });
    });

    hydrateThumbs(wrap);
  })();
}

async function loadLivePage() {
  const root = $("#liveRoot");
  if (!root) return;

  const classId = resolveClassIdFromUrl();
  const sessionNo = getParam("s") || "1";
  if (!classId) {
    $("#liveTitle").textContent = "수업을 찾을 수 없습니다.";
    showToast("수업 ID가 필요합니다.", "warn");
    return;
  }
  rememberClassId(classId);
  let c = getClasses().find(x => x.id === classId);
  if (!c) {
    try {
      const remote = await apiGet(`/api/classes/${encodeURIComponent(classId)}`, { silent: true });
      if (remote) {
        const normalized = {
          ...remote,
          teacher: remote.teacher?.name || remote.teacherName || remote.teacher || "-",
          teacherId: remote.teacherId || remote.teacher?.id || "",
          thumb: remote.thumbUrl || remote.thumb || FALLBACK_THUMB,
        };
        const next = [...getClasses().filter(x => x.id !== classId), normalized];
        setClasses(next);
        c = normalized;
      }
    } catch (e) {
      console.error("live class fetch failed", e);
    }
  }

  if (!c) { $("#liveTitle").textContent = "수업을 찾을 수 없습니다."; return; }

  let user = getUser();
  if (!user) user = await ensureUserReady();
  if (!user) { alert("로그인이 필요합니다."); navigateTo("login.html"); return; }

  const isOwnerTeacher = isOwnerTeacherForClass(user, c);
  const isStudentActive = (user.role === "student" && isEnrollmentActiveForUser(user, classId));

  if (!isOwnerTeacher && user.role === "student" && !isStudentActive) {
    alert("수강(결제) 후 라이브에 입장할 수 있어요.");
    goClassDetail(classId);
    return;
  }

  $("#liveTitle").textContent = `${c.title} (세션 ${sessionNo})`;
  $("#liveSub").textContent = `${c.category || "LIVE"} · ${c.teacher || "-"}`;

  $("#sideSessionsLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    goClassDetail(classId, "sessions");
  });

  // 화면비율 변경
  const arSelect = $("#arSelect");
  arSelect?.addEventListener("change", () => {
    const v = arSelect.value || "16/9";
    document.documentElement.style.setProperty("--liveAR", v);
  });

  // LiveKit 연결/제어
  async function ensureLiveKitClient() {
    const LK_VERSION = "2.16.1";

    const resolveLK = () => {
      // UMD 전역 이름을 모두 확인하고, 없으면 별칭을 설정
      let candidate = window.LiveKit || window.LivekitClient || window.livekitClient || window.livekit;

      // UMD 번들에서 default로 감싸진 경우를 처리
      if (candidate && candidate.default && (candidate.default.connect || candidate.default.Room)) {
        candidate = candidate.default;
      }

      if (!window.LiveKit && candidate) window.LiveKit = candidate;
      if (!window.LivekitClient && candidate) window.LivekitClient = candidate;

      const lk = candidate || window.LiveKit || window.LivekitClient || window.livekitClient || window.livekit;
      if (lk && (lk.connect || lk.Room)) {
        window.LiveKit = window.LiveKit || lk;
        window.LivekitClient = window.LivekitClient || lk;
      }
      return lk;
    };

    let LK = resolveLK();
    if (LK && LK.connect) return LK;

    // 로컬 번들 강제 로드 (Live Server에서 404/304 캐싱될 때를 대비)
    await new Promise((resolve) => {
      const script = document.createElement("script");
    script.src = "vendor/livekit-client.umd.js?v=" + Date.now();
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = resolve;
    document.head.appendChild(script);
  });
  LK = resolveLK();
  if (LK && LK.connect) return LK;

  // 최종 CDN fallback
  // 1) UMD
  await new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = `https://cdn.jsdelivr.net/npm/livekit-client@${LK_VERSION}/dist/livekit-client.umd.min.js`;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = resolve;
    document.head.appendChild(script);
  });
  LK = resolveLK();
  if (LK && LK.connect) return LK;

  // 2) ESM 동적 import (jsdelivr, 명시 버전)
  try {
    const mod = await import(`https://cdn.jsdelivr.net/npm/livekit-client@${LK_VERSION}/dist/livekit-client.esm.mjs`);
    LK = mod?.default || mod;
    if (LK && (LK.connect || LK.Room)) {
      window.LiveKit = window.LiveKit || LK;
      window.LivekitClient = window.LivekitClient || LK;
      return LK;
    }
  } catch (_) {
    // ignore
  }

  return LK;
}

  const LK = await ensureLiveKitClient();
  if (!LK || !(LK.connect || LK.Room)) {
    alert("LiveKit 클라이언트가 로드되지 않았습니다. (네트워크/CORS/스크립트 경로를 확인하세요)");
    return;
  }

  const videoFrame = $("#videoFrame");
  const liveVideo = $("#liveVideo");
  const videoOverlay = $("#videoOverlay");
  const btnConnect = $("#btnConnect");
  const btnShare = $("#btnShare");
  const remoteWrap = $("#remoteVideos");
  const remotePrev = $("#remotePrev");
  const remoteNext = $("#remoteNext");
  const remotePageInfo = $("#remotePageInfo");
  const remoteViewGrid = $("#remoteViewGrid");
  const remoteViewSpeaker = $("#remoteViewSpeaker");
  const remotePinnedInfo = $("#remotePinnedInfo");
  const btnQuality = $("#btnQuality");

  let connected = false;
  let room = null;
  let localCamTrack = null;
  let localMicTrack = null;
  let screenPub = null;
  const remoteList = []; // [{sid, el}]
  let remotePage = 0;
  const REMOTE_PER_PAGE = 16; // 4x4
  let remoteViewMode = "grid"; // grid | speaker
  let pinnedSid = null;
  let qualityMode = "high"; // high | balanced
  renderRemotePage();

  function setOverlay(text) {
    if (!videoOverlay) return;
    videoOverlay.textContent = text;
    videoOverlay.style.display = text ? "grid" : "none";
  }

  function attachLocal(track) {
    if (!track || !liveVideo) return;
    try {
      track.attach(liveVideo);
      liveVideo.muted = true;
      const p = liveVideo.play?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      console.error(e);
    }
  }

  function renderRemotePage() {
    if (!remoteWrap) return;
    const total = remoteList.length;
    const totalPage = total ? Math.ceil(total / REMOTE_PER_PAGE) : 1;
    if (remotePage >= totalPage) remotePage = Math.max(0, totalPage - 1);

    remoteWrap.innerHTML = "";
    if (remoteViewMode === "speaker") {
      const target = remoteList.find(r => r.sid === pinnedSid) || remoteList[0];
      if (target) {
        remoteWrap.appendChild(target.el);
        pinnedSid = target.sid;
        if (remotePinnedInfo) remotePinnedInfo.textContent = `고정: ${target.el.dataset.name || target.sid}`;
      } else {
        if (remotePinnedInfo) remotePinnedInfo.textContent = "고정된 참여자 없음";
      }
    } else {
      const start = remotePage * REMOTE_PER_PAGE;
      const slice = remoteList.slice(start, start + REMOTE_PER_PAGE);
      slice.forEach(item => remoteWrap.appendChild(item.el));
      if (remotePinnedInfo) remotePinnedInfo.textContent = "";
    }

    if (remotePageInfo) {
      remotePageInfo.textContent = `${total ? remotePage + 1 : 0}/${totalPage} · 참여자 ${total}명`;
    }
    if (remotePrev) remotePrev.disabled = remotePage <= 0;
    if (remoteNext) remoteNext.disabled = remotePage >= totalPage - 1;
  }

  function addRemote(track, publication, participant) {
    if (!publication?.sid) return;
    const sid = publication.sid;

    removeRemote(sid);

    const box = document.createElement("div");
    box.className = "remoteItem";
    box.dataset.sid = sid;

    const label = document.createElement("div");
    label.className = "remoteLabel";
    const displayName = participant?.name || participant?.identity || "참여자";
    box.dataset.name = displayName;
    label.textContent = displayName;
    box.appendChild(label);

    // 선생님/관리자만 보이는 강퇴 버튼 + 시간 선택
    if (isOwnerTeacher) {
      const ctrlRow = document.createElement("div");
      ctrlRow.style.display = "flex";
      ctrlRow.style.gap = "6px";
      ctrlRow.style.alignItems = "center";
      ctrlRow.style.flexWrap = "wrap";

      const sel = document.createElement("select");
      sel.className = "input";
      sel.style.padding = "4px";
      sel.style.fontSize = "12px";
      [
        { label: "5분", value: 5 },
        { label: "10분", value: 10 },
        { label: "30분", value: 30 },
        { label: "1시간", value: 60 },
        { label: "3시간", value: 180 },
        { label: "1일", value: 1440 },
      ].forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        sel.appendChild(o);
      });

      const kickBtn = document.createElement("button");
      kickBtn.className = "btn danger";
      kickBtn.style.padding = "6px 10px";
      kickBtn.style.fontSize = "12px";
      kickBtn.textContent = "강퇴";
      kickBtn.addEventListener("click", async () => {
        const targetName = participant?.name || participant?.identity || "참여자";
        if (!confirm(`${targetName} 을(를) 강퇴할까요?`)) return;
        try {
          const mins = Number(sel.value) || 5;
          await apiPost("/api/live/kick", { classId, userId: participant?.identity, banMinutes: mins });
          removeRemote(sid);
        } catch (e) {
          console.error(e);
          alert("강퇴 실패\n" + (e?.message || ""));
        }
      });

      ctrlRow.appendChild(sel);
      ctrlRow.appendChild(kickBtn);
      box.appendChild(ctrlRow);
    } else {
      // 스피커뷰에서 고정할 때 사용
      const pinBtn = document.createElement("button");
      pinBtn.className = "btn";
      pinBtn.style.padding = "6px 10px";
      pinBtn.style.fontSize = "12px";
      pinBtn.textContent = "보기";
      pinBtn.addEventListener("click", () => {
        pinnedSid = sid;
        remoteViewMode = "speaker";
        renderRemotePage();
      });
      box.appendChild(pinBtn);
    }

    const vid = document.createElement("video");
    vid.autoplay = true;
    vid.playsInline = true;
    vid.controls = false;
    box.appendChild(vid);

    try { track.attach(vid); } catch (e) { console.error(e); }

    remoteList.push({ sid, el: box });
    renderRemotePage();
  }

  function removeRemote(sid) {
    if (!sid) return;
    const idx = remoteList.findIndex(r => r.sid === sid);
    if (idx >= 0) remoteList.splice(idx, 1);
    renderRemotePage();
  }

  function setConnectedUI(isOn) {
    connected = isOn;
    if (btnConnect) btnConnect.textContent = connected ? "연결 해제" : "카메라/마이크 연결";
    if (!connected) {
      if (liveVideo) {
        if (liveVideo.srcObject) liveVideo.srcObject = null;
        liveVideo.removeAttribute("srcObject");
      }
      setOverlay("카메라/마이크 연결 후 시작할 수 있어요");
      if (btnShare) {
        btnShare.textContent = "화면 공유";
      }
      return;
    }
    setOverlay("");
  }

  async function disconnectRoom() {
    try {
      if (room) room.disconnect();
    } catch (_) {}
    room = null;
    localCamTrack = null;
    localMicTrack = null;
    if (screenPub) {
      try { room?.localParticipant?.unpublishTrack(screenPub.track, true); } catch (_) {}
      screenPub = null;
    }
    remoteList.splice(0, remoteList.length);
    renderRemotePage();
    setConnectedUI(false);
  }

  window.addEventListener("beforeunload", disconnectRoom);

  // 화면 공유는 수강 중(선생님/학생) 모두 가능
  if (btnShare) {
    setGateDisabled(btnShare, false);
    btnShare.textContent = "화면 공유";
  }

  // 원격 페이징 버튼
  remotePrev?.addEventListener("click", () => {
    if (remotePage > 0) {
      remotePage -= 1;
      renderRemotePage();
    }
  });
  remoteNext?.addEventListener("click", () => {
    remotePage += 1;
    renderRemotePage();
  });
  remoteViewGrid?.addEventListener("click", () => {
    remoteViewMode = "grid";
    renderRemotePage();
  });
  remoteViewSpeaker?.addEventListener("click", () => {
    remoteViewMode = "speaker";
    renderRemotePage();
  });
  const updateQualityBtn = () => {
    if (!btnQuality) return;
    btnQuality.textContent = qualityMode === "high" ? "고화질 유지" : "끊김 줄이기";
    btnQuality.classList.toggle("primary", qualityMode === "high");
  };
  updateQualityBtn();

  btnQuality?.addEventListener("click", () => {
    qualityMode = qualityMode === "high" ? "balanced" : "high";
    updateQualityBtn();
    if (connected) {
      showToast("변경하려면 연결을 끊고 다시 연결하세요.", "info");
    }
  });

  btnConnect?.addEventListener("click", async () => {
    if (connected) {
      await disconnectRoom();
      return;
    }

    try {
      setOverlay("연결 중...");
      const tk = await apiPost("/api/live/token", { classId });
      const { url, token } = tk || {};
      if (!url || !token) throw new Error("LiveKit 토큰을 받을 수 없습니다.");

      const roomOpts = qualityMode === "balanced"
        ? { adaptiveStream: true, dynacast: true }
        : { adaptiveStream: false, dynacast: false };

      room = new LK.Room(roomOpts);
      await room.connect(url, token, { autoSubscribe: true });

      // 로컬 트랙 발행
      localCamTrack = await LK.createLocalVideoTrack();
      localMicTrack = await LK.createLocalAudioTrack();
      await room.localParticipant.publishTrack(localCamTrack);
      await room.localParticipant.publishTrack(localMicTrack);
      attachLocal(localCamTrack);

      // 원격 트랙 핸들러
      room.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === "video") {
          addRemote(track, publication, participant);
        } else if (track.kind === "audio") {
          try { track.attach(); } catch (_) {}
        }
      });
      room.on(LK.RoomEvent.TrackUnsubscribed, (_track, publication) => {
        removeRemote(publication?.sid);
      });
      room.on(LK.RoomEvent.Disconnected, () => {
        disconnectRoom();
      });

      setConnectedUI(true);
    } catch (err) {
      console.error(err);
      await disconnectRoom();
      alert("라이브 연결에 실패했습니다.\n- 브라우저 카메라/마이크 권한\n- .env의 LIVEKIT_URL/API_KEY/API_SECRET\n- HTTPS/localhost 환경을 확인하세요.\n\n" + (err?.message || ""));
    }
  });

  btnShare?.addEventListener("click", async () => {
    if (!(isOwnerTeacher || isStudentActive)) return;
    if (!connected) {
      alert("먼저 카메라/마이크를 연결하세요.");
      return;
    }

    try {
      if (!screenPub) {
        setOverlay("화면 공유 시작 중...");
        const tracks = await LK.createLocalScreenTracks({ audio: false });
        const vTrack = tracks.find(t => t.kind === "video");
        if (!vTrack) throw new Error("화면 공유 트랙 생성 실패");
        screenPub = await room.localParticipant.publishTrack(vTrack);
        attachLocal(vTrack);
        if (btnShare) btnShare.textContent = "화면 공유 중지";
        setOverlay("");
      } else {
        try {
          room.localParticipant.unpublishTrack(screenPub.track, true);
        } catch (_) {}
        screenPub = null;
        if (btnShare) btnShare.textContent = "화면 공유";
        if (localCamTrack) attachLocal(localCamTrack);
      }
    } catch (err) {
      console.error(err);
      setOverlay("");
      alert("화면 공유를 시작할 수 없습니다.\n" + (err?.message || ""));
    }
  });

  // 녹화: 선생님(본인수업)만 가능
  // - 실제 영상 blob은 IndexedDB에 저장
  // - 다시보기 목록에는 vodKey 메타데이터만 저장
  const btnRecord = $("#btnRecord");
  const recordHint = $("#recordHint");
  let recording = false;
  let recorder = null;
  let recordChunks = [];

  if (btnRecord) {
      if (!isOwnerTeacher) {
      setGateDisabled(btnRecord, true);
      btnRecord.textContent = "녹화(선생님 전용)";
    } else {
      setGateDisabled(btnRecord, false);
      btnRecord.textContent = "녹화 시작";
    }

    btnRecord.addEventListener("click", async () => {
      if (!isOwnerTeacher) return;
      if (!connected) {
        alert("먼저 카메라/마이크를 연결하세요. (데모)");
        return;
      }

      // start
      if (!recording) {
        const streamToRecord = liveVideo?.srcObject;
        if (!streamToRecord) {
          alert("녹화할 영상이 없습니다. 카메라/화면 공유를 먼저 연결하세요.");
          return;
        }

        recordChunks = [];
        let mimeType = "";
        const candidates = [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm"
        ];
        for (const c of candidates) {
          if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) {
            mimeType = c;
            break;
          }
        }

        try {
          recorder = mimeType ? new MediaRecorder(streamToRecord, { mimeType }) : new MediaRecorder(streamToRecord);
        } catch (e) {
          console.error(e);
          alert("이 브라우저에서는 녹화가 지원되지 않습니다. (MediaRecorder 오류)\n" + (e?.message || ""));
          recorder = null;
          return;
        }

        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) recordChunks.push(ev.data);
        };

        recorder.onstop = async () => {
          try {
            const blob = new Blob(recordChunks, { type: recordChunks?.[0]?.type || "video/webm" });
            const vodUrl = await blobToDataUrl(blob);
            const title = `(${new Date().toLocaleDateString("ko-KR")}) ${c.title} · 세션${sessionNo} · 다시보기`;

            await apiPost(`/api/classes/${encodeURIComponent(classId)}/replays`, {
              title,
              vodUrl,
              mime: blob.type || null,
            });
            const refreshed = await apiGet(`/api/classes/${encodeURIComponent(classId)}/replays`).catch(() => []);
            const rp = getReplays();
            rp[classId] = refreshed || [];
            setReplays(rp);
            renderReplaysList(classId);

            if (recordHint) recordHint.textContent = "✔ 녹화가 저장되었고, 다시보기에 등록했습니다.";
            alert("녹화를 종료했고, 다시보기에 등록했습니다.");
          } catch (e) {
            console.error(e);
            if (recordHint) recordHint.textContent = "✖ 녹화 저장에 실패했습니다.";
            alert("녹화 저장 실패\n" + (e?.message || ""));
          } finally {
            recordChunks = [];
          }
        };

        recording = true;
        btnRecord.textContent = "녹화 종료";
        if (recordHint) recordHint.textContent = "?? 녹화 중... 종료하면 다시보기에 자동 등록됩니다.";
        recorder.start();
        return;
      }

      // stop
      recording = false;
      btnRecord.textContent = "녹화 시작";
      if (recordHint) recordHint.textContent = "? 저장 중... (잠시만)";
      try {
        recorder?.stop();
      } catch (_) {
        // ignore
      }
    });
  }

  // 채팅(데모): classId별 저장
  const chatLog = $("#chatLog");
  const chatInput = $("#chatInput");
  const chatSend = $("#chatSend");
  const displayName = (m) => escapeHtml(displayUserName(m));

  async function renderChat() {
    if (!chatLog) return;
    try {
      const list = await apiGet(`/api/classes/${encodeURIComponent(classId)}/chat`);
      const all = getChat();
      all[classId] = list || [];
      setChat(all);
    } catch (e) {
      console.error(e);
    }

    const list = (getChat()[classId] || []);
    chatLog.innerHTML = list.map(m => `
      <div class="msg ${m.userId === user.id ? "me" : ""}">
        <div class="mmeta">${displayName(m)} · ${new Date(m.sentAt || m.at).toLocaleTimeString("ko-KR")}</div>
        <div class="mtext">${escapeHtml(m.message || m.text || "")}</div>
      </div>
    `).join("");
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function pushChat(text) {
    const t = String(text || "").trim();
    if (!t) return;
    try {
      await apiPost(`/api/classes/${encodeURIComponent(classId)}/chat`, { message: t });
      await renderChat();
    } catch (e) {
      console.error(e);
      alert("채팅 전송 실패");
    }
  }

  chatSend?.addEventListener("click", () => pushChat(chatInput?.value));
  chatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      pushChat(chatInput?.value);
    }
  });

  renderChat();

  $("#btnLeave")?.addEventListener("click", () => {
    disconnectRoom();
    goClassDetail(classId);
  });

  // 출석 로그(학생 활성 수강자만)
  if (user?.role === "student" && activeStudent) {
    apiPost(`/api/classes/${encodeURIComponent(classId)}/attendance`, {}).catch(console.error);
  }
}

// ---------------------------
// ? INIT
// ---------------------------
function init() {
  migrateStorage();
  normalizeUsersInStorage();
  normalizeCurrentUserInStorage(); // ? 핵심
  installGateBlockerOnce();        // ? <a> disabled blocking

  scheduleAfterPaint(() => {
    // 네트워크 핸드셰이크 단축 (Supabase/Livekit/jsdelivr)
    (function injectPreconnects() {
      const origins = [
        "https://cdn.jsdelivr.net",
        SUPABASE_URL,
        SUPABASE_URL.replace("https://", "https://*."),
        "https://*.livekit.cloud",
      ];
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

    // NAV 먼저 렌더하여 느린 API 때문에 UI가 비지 않도록 함
    updateNav();
    runReveal();
    prefetchCorePages();
    bindNavPrefetch();
    bindSoftNavigation();
    warmupBackend();

    // 화면 즉시 렌더, 데이터는 백그라운드
    if ($("#homePopular")) loadHomePopular();
    if ($("#classGrid")) loadClassesPage();
    if ($("#createClassForm")) handleCreateClassPage();
    if ($("#loginForm")) handleLoginPage();
    if ($("#signupForm")) handleSignupPage();
    if ($("#settingsRoot")) handleSettingsPage();
    if ($("#teacherDash")) loadTeacherDashboard();
    if ($("#studentDash")) loadStudentDashboard();
    if ($("#liveRoot")) loadLivePage();

    ensureSeedData();

    if (getPath() === "logout.html") doLogout(true);
  });
}

document.addEventListener("DOMContentLoaded", init);


