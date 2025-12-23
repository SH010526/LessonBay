﻿/* ============================
   LessonBay (Static + localStorage) — v12 FIXED (NO-REDUCE)
   - ✅ Enrollment/Enter/Replay gating 안정화 + UI 반영
     1) enrollment를 ""(빈키)로 저장하지 않음 (읽기는 레거시 호환)
     2) 수강완료 즉시 상세페이지 버튼/문구 갱신(수강중/만료/재수강)
     3) 재생 버튼은 모달로 연결
     4) 라이브에서 선생님(본인수업)만 녹화 가능 + 녹화 종료 시 다시보기 자동 등록(데모)
   - Keeps v11 fixes:
       migration/normalize, enter btn detection, tolerant endAt parsing,
       <a> disabled blocker, file upload(DataURL), dashboards separation, etc.
   ============================ */

/* ============================
   ✅ Supabase Auth (메일 인증)
   - login/signup을 localStorage가 아니라 Supabase로 통일
   - user_metadata에 name/role 저장
   - 세션 기반으로 localStorage(K.USER) 동기화해서
     기존 UI/권한 로직(teacher/student)을 그대로 살림
   ============================ */

const SUPABASE_URL = "https://pqvdexhxytahljultmjd.supabase.co";   // Project URL
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxdmRleGh4eXRhaGxqdWx0bWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NjMzNTMsImV4cCI6MjA4MTUzOTM1M30.WzJWY3-92Bwkic-Wb2rOmZ1joEUj-s69cSL2hPT79fQ";             // anon public key

// ✅ SDK가 없는 페이지에서도 크래시 나지 않게 (전역 supabase와 이름 충돌 방지)
let supabaseClient = null;
try {
  if (typeof window !== "undefined" && window.supabase && typeof window.supabase.createClient === "function") {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  }
} catch (e) {
  supabaseClient = null;
}

// OTP 백엔드 API
const API_BASE_URL = "http://localhost:3000";

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

// ✅ VOD(녹화) 저장소: IndexedDB
const VOD_DB = {
  NAME: "lc_vod_db",
  STORE: "vods",
  VER: 1,
};

/* ============================
   ✅ Supabase session -> local user sync
   ============================ */
async function syncLocalUserFromSupabaseSession() {
  if (!supabaseClient) return;

  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) return;

    const session = data?.session || null;
    if (!session || !session.user) {
      // Supabase 기준으로 로그아웃이면, 앱 로컬 user도 정리
      // (메일 인증 전/세션 만료 등에서 UI가 꼬이지 않게)
      localStorage.removeItem(K.USER);
      return;
    }

    const u = session.user;
    const email = String(u.email || "").trim();
    const name = String(u.user_metadata?.name || "").trim() || (email ? email.split("@")[0] : "사용자");
    const role = (u.user_metadata?.role === "teacher" || u.user_metadata?.role === "student")
      ? u.user_metadata.role
      : "student";

    // 기존 앱이 기대하는 user 형태로 저장
    const local = { id: u.id, name, role, email };
    localStorage.setItem(K.USER, JSON.stringify(local));
  } catch (_) {
    // ignore
  }
}

async function supabaseSignupWithEmailConfirm(name, email, password, role) {
  if (!supabaseClient) {
    alert("Supabase SDK가 로드되지 않았습니다. (signup.html에서 SDK 스크립트 순서를 확인하세요)");
    return;
  }

  const redirectTo = `${location.origin}/index.html`;

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: redirectTo,
      data: {
        name,
        role: (role === "teacher" ? "teacher" : "student"),
      },
    },
  });

  if (error) {
    alert(error.message);
    return;
  }

  // 이메일 확인이 켜져 있으면 보통 session은 null
  // (메일 인증 완료 후 로그인 페이지에서 로그인)
  alert("인증메일을 보냈습니다. 메일에서 링크를 누른 뒤 로그인하세요.");
  location.href = "login.html";
}

async function supabaseLogin(email, password) {
  if (!supabaseClient) {
    alert("Supabase SDK가 로드되지 않았습니다. (login.html에서 SDK 스크립트 순서를 확인하세요)");
    return;
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    alert(error.message);
    return;
  }

  // 로그인 성공 -> 로컬 user 동기화
  await syncLocalUserFromSupabaseSession();

  alert("로그인 성공!");
  location.href = "index.html";
}

/* ============================
   기존 코드 시작 (원본 유지)
   ============================ */

function openVodDB() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB not supported"));
      return;
    }
    const req = indexedDB.open(VOD_DB.NAME, VOD_DB.VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VOD_DB.STORE)) {
        db.createObjectStore(VOD_DB.STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function vodPut(vodKey, blob) {
  const db = await openVodDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VOD_DB.STORE, "readwrite");
    const store = tx.objectStore(VOD_DB.STORE);
    const r = store.put(blob, vodKey);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

async function vodGet(vodKey) {
  const db = await openVodDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VOD_DB.STORE, "readonly");
    const store = tx.objectStore(VOD_DB.STORE);
    const r = store.get(vodKey);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

async function vodDelete(vodKey) {
  const db = await openVodDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VOD_DB.STORE, "readwrite");
    const store = tx.objectStore(VOD_DB.STORE);
    const r = store.delete(vodKey);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

// ============================
// ✅ VOD 함수명 호환
// ============================
async function vodPutBlob(vodKey, blob) { return vodPut(vodKey, blob); }
async function vodGetBlob(vodKey) { return vodGet(vodKey); }
async function vodDeleteBlob(vodKey) { return vodDelete(vodKey); }

// 모달 코드에 saveClasses가 등장하는데, 실제 저장 함수는 setClasses임(호환 래퍼)
function saveClasses(list) { return setClasses(list); }

// ✅ VOD 데모 영상(Blob) 생성
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

// 과제 선택 유지용 임시 변수
let assignPendingSelect = null;

const $ = (sel, el = document) => el.querySelector(sel); 
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

function safeParse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}
function won(n) { return "₩" + (Number(n) || 0).toLocaleString("ko-KR"); }
function getPath() {
  const p = location.pathname.split("/").pop();
  return p || "index.html";
}
function getParam(name) { return new URLSearchParams(location.search).get(name); }
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }
function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }

// ---------------------------
// ✅ BUTTON LOADING (signup 등에서 사용)
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
// ✅ STORAGE MIGRATION
// ---------------------------
function migrateStorage() {
  if (!localStorage.getItem(K.USER)) {
    for (const key of OLD_USER_KEYS) {
      const v = localStorage.getItem(key);
      if (v) { localStorage.setItem(K.USER, v); break; }
    }
  }
  if (!localStorage.getItem(K.USERS)) {
    for (const key of OLD_USERS_KEYS) {
      const v = localStorage.getItem(key);
      if (v) { localStorage.setItem(K.USERS, v); break; }
    }
  }
  if (!localStorage.getItem(K.CLASSES)) {
    for (const key of OLD_CLASSES_KEYS) {
      const v = localStorage.getItem(key);
      if (v) { localStorage.setItem(K.CLASSES, v); break; }
    }
  }
  if (!localStorage.getItem(K.ENROLL)) {
    for (const key of OLD_ENROLL_KEYS) {
      const v = localStorage.getItem(key);
      if (v) { localStorage.setItem(K.ENROLL, v); break; }
    }
  }
}

function getUserPassword(u) {
  return String((u && (u.pw ?? u.password ?? u.pass ?? u.pwd ?? "")) || "");
}

function getUser() {
  const raw = localStorage.getItem(K.USER);
  return raw ? safeParse(raw, null) : null;
}
function setUser(u) {
  if (!u) localStorage.removeItem(K.USER);
  else localStorage.setItem(K.USER, JSON.stringify(u));
}
function getUsers() { return safeParse(localStorage.getItem(K.USERS) || "[]", []); }
function setUsers(list) { localStorage.setItem(K.USERS, JSON.stringify(list)); }

function getClasses() { return safeParse(localStorage.getItem(K.CLASSES) || "[]", []); }
function setClasses(list) { localStorage.setItem(K.CLASSES, JSON.stringify(list)); }

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

function getEnrollments() {
  const data = safeParse(localStorage.getItem(K.ENROLL) || "{}", {});
  if (Array.isArray(data)) {
    const converted = convertEnrollmentArrayToMap(data);
    localStorage.setItem(K.ENROLL, JSON.stringify(converted));
    return converted;
  }
  if (!data || typeof data !== "object") return {};
  return data;
}
function setEnrollments(v) {
  let out = v;
  if (Array.isArray(out)) out = convertEnrollmentArrayToMap(out);
  if (!out || typeof out !== "object") out = {};
  localStorage.setItem(K.ENROLL, JSON.stringify(out));
}

function getReplays() { return safeParse(localStorage.getItem(K.REPLAY) || "{}", {}); }
function setReplays(v) { localStorage.setItem(K.REPLAY, JSON.stringify(v)); }

function getChat() { return safeParse(localStorage.getItem(K.CHAT) || "{}", {}); }
function setChat(v) { localStorage.setItem(K.CHAT, JSON.stringify(v)); }

// 자료/과제/리뷰/Q&A/출결/진도
function getMaterials() { return safeParse(localStorage.getItem(K.MATERIALS) || "{}", {}); }
function setMaterials(v) { localStorage.setItem(K.MATERIALS, JSON.stringify(v)); }
function getAssignments() { return safeParse(localStorage.getItem(K.ASSIGN) || "{}", {}); }
function setAssignments(v) { localStorage.setItem(K.ASSIGN, JSON.stringify(v)); }
function getAssignMeta() { return safeParse(localStorage.getItem(K.ASSIGN_META) || "{}", {}); }
function setAssignMeta(v) { localStorage.setItem(K.ASSIGN_META, JSON.stringify(v || {})); }
function getReviews() { return safeParse(localStorage.getItem(K.REVIEWS) || "{}", {}); }
function setReviews(v) { localStorage.setItem(K.REVIEWS, JSON.stringify(v)); }
function getQna() { return safeParse(localStorage.getItem(K.QNA) || "{}", {}); }
function setQna(v) { localStorage.setItem(K.QNA, JSON.stringify(v)); }
function getAttendance() { return safeParse(localStorage.getItem(K.ATTEND) || "{}", {}); }
function setAttendance(v) { localStorage.setItem(K.ATTEND, JSON.stringify(v)); }
function getProgress() { return safeParse(localStorage.getItem(K.PROGRESS) || "{}", {}); }
function setProgress(v) { localStorage.setItem(K.PROGRESS, JSON.stringify(v)); }

// ---------------------------
// ✅ ROBUST USER KEY LIST
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
// ✅ USERS NORMALIZE/DEDUPE (legacy 유지)
// ---------------------------
function normalizeUsersInStorage() {
  const raw = safeParse(localStorage.getItem(K.USERS) || "[]", []);
  if (!Array.isArray(raw)) return;

  const norm = raw.map((u) => {
    const id = u?.id || ("u_" + Date.now() + "_" + Math.random().toString(16).slice(2));
    const name = String(u?.name ?? u?.username ?? u?.displayName ?? "").trim();
    const role = (u?.role === "teacher" || u?.role === "student") ? u.role : (u?.isTeacher ? "teacher" : "student");
    const email = String(u?.email ?? "").trim();
    const emailKey = normalizeEmail(email);
    const pw = getUserPassword(u);
    const createdAt = u?.createdAt || u?.created_at || new Date().toISOString();
    return { id, name, role, email, emailKey, pw, createdAt };
  }).filter(u => u.emailKey);

  const map = new Map();
  for (const u of norm) {
    const prev = map.get(u.emailKey);
    if (!prev) map.set(u.emailKey, u);
    else {
      const tPrev = Date.parse(prev.createdAt) || 0;
      const tNow = Date.parse(u.createdAt) || 0;
      map.set(u.emailKey, (tNow >= tPrev) ? u : prev);
    }
  }

  localStorage.setItem(K.USERS, JSON.stringify(Array.from(map.values())));
}

function normalizeCurrentUserInStorage() {
  const cu = getUser();
  if (!cu) return;

  const idOk = !!String(cu.id || "").trim();
  const emailOk = !!normalizeEmail(cu.email || cu.emailKey || "");
  if (idOk && emailOk) return;

  const users = getUsers();
  if (!Array.isArray(users) || !users.length) return;

  const cuEmailKey = normalizeEmail(cu.email || cu.emailKey || "");
  let found = null;

  if (cuEmailKey) {
    found = users.find(u => u.emailKey === cuEmailKey) || null;
  }
  if (!found) {
    const cuNameKey = String(cu.name || "").trim().toLowerCase();
    const cuRole = cu.role || "";
    if (cuNameKey) {
      const candidates = users.filter(u =>
        String(u.name || "").trim().toLowerCase() === cuNameKey &&
        (!cuRole || u.role === cuRole)
      );
      if (candidates.length) {
        candidates.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
        found = candidates[0];
      }
    }
  }

  if (found) {
    setUser({ id: found.id, name: found.name || cu.name, role: found.role || cu.role, email: found.email || cu.email });
  }
}

// ---------------------------
// ✅ SEED
// ---------------------------
async function ensureSeedData() {
  if (localStorage.getItem(K.SEEDED) === "1" && localStorage.getItem(K.CLASSES)) return;

  const existing = safeParse(localStorage.getItem(K.CLASSES) || "null", null);
  if (Array.isArray(existing) && existing.length) {
    localStorage.setItem(K.SEEDED, "1");
    return;
  }

  try {
    const res = await fetch("data/classes.json", { cache: "no-store" });
    const data = await res.json();
    localStorage.setItem(K.CLASSES, JSON.stringify(data));
    localStorage.setItem(K.SEEDED, "1");
  } catch {
    const fallback = [
      {
        id: "c_demo_1",
        title: "영어 회화 초급",
        teacher: "김선생",
        category: "영어회화",
        description: "영어 회화를 처음 시작하는 분들을 위한 기본 표현과 발음 교정.",
        weeklyPrice: 19000,
        monthlyPrice: 59000,
        thumb: FALLBACK_THUMB
      }
    ];
    localStorage.setItem(K.CLASSES, JSON.stringify(fallback));
    localStorage.setItem(K.SEEDED, "1");
  }
}

// ---------------------------
// ✅ NAV + LOGOUT
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

// ✅ Supabase 로그아웃 포함
async function doLogout(goHome = true) {
  try {
    if (supabaseClient) {
      await supabaseClient.auth.signOut();
    }
  } catch (_) {}

  setUser(null);
  clearOldAuthKeys();
  if (goHome) location.href = "index.html";
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
    : `<span class="badge student">학생</span>`;

  const dashHref = user.role === "teacher" ? "teacher_dashboard.html" : "student_dashboard.html";

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
// ✅ GLOBAL DISABLED BLOCKER (for <a> tags)
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
// ✅ AUTH (OTP + 로컬 저장 기본, Supabase는 보조)
// ---------------------------
function pickValue(...ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) return (el.value ?? "").toString();
  }
  return "";
}

function localLogin(email, password) {
  normalizeUsersInStorage();
  const users = getUsers();
  const emailKey = normalizeEmail(email);
  const found = users.find(u => normalizeEmail(u.email) === emailKey);
  if (!found) return false;

  const realPw = getUserPassword(found);
  if (String(password) !== String(realPw)) return false;

  setUser({ id: found.id, name: found.name, role: found.role, email: found.email });
  alert("로그인 성공!");
  location.href = "index.html";
  return true;
}

function handleSignupPage() {
  const form = $("#signupForm");
  if (!form) return;

  // 메시지 영역 확보
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

  // OTP UI
  function showOtpUi(email, name, pw, role) {
    const msg = ensureMsgEl();
    msg.innerHTML = `
      인증코드(6자리)를 이메일로 보냈습니다. 입력 후 확인을 눌러주세요.<br/>
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
    let attemptsLeft = 5;

    verifyBtn?.addEventListener("click", async () => {
      const token = (document.getElementById("otpInput")?.value || "").trim();
      if (!token) { msg.textContent = "인증번호를 입력하세요."; return; }
      try {
        setBtnLoading(verifyBtn, true, "확인중...");
        const verifyRes = await fetch(`${API_BASE_URL}/api/verify-otp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code: token })
        });
        if (!verifyRes.ok) {
          const err = await verifyRes.json().catch(() => ({}));
          throw new Error(err.error || "검증 실패");
        }

        const users = getUsers();
        const newUser = {
          id: `u_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          name,
          role,
          email,
          emailKey: normalizeEmail(email),
          pw,
          createdAt: new Date().toISOString()
        };
        users.push(newUser);
        setUsers(users);
        setUser({ id: newUser.id, name: newUser.name, role: newUser.role, email: newUser.email });

        msg.textContent = "인증 성공! 가입이 완료되었습니다. 홈으로 이동합니다.";
        setTimeout(() => { location.href = "index.html"; }, 1200);
      } catch (e) {
        attemptsLeft -= 1;
        const text = attemptsLeft > 0
          ? `${e?.message || "인증 실패"} (남은 시도: ${attemptsLeft}회)`
          : "인증 실패 횟수가 초과되었습니다. 재전송 후 다시 시도하세요.";
        if (statusEl) statusEl.textContent = text; else msg.textContent = text;
        if (attemptsLeft <= 0 && verifyBtn) verifyBtn.disabled = true;
      } finally {
        setBtnLoading(verifyBtn, false);
      }
    });

    resendBtn?.addEventListener("click", async () => {
      try {
        setBtnLoading(resendBtn, true, "재전송 중...");
        const sendRes = await fetch(`${API_BASE_URL}/api/send-otp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email })
        });
        if (!sendRes.ok) {
          const err = await sendRes.json().catch(() => ({}));
          throw new Error(err.error || "재전송 실패");
        }
        if (statusEl) statusEl.textContent = "인증코드를 재전송했습니다. 메일을 확인하세요.";
        attemptsLeft = 5;
        if (verifyBtn) verifyBtn.disabled = false;
      } catch (e) {
        if (statusEl) statusEl.textContent = e?.message || "재전송 실패";
        else msg.textContent = e?.message || "재전송 실패";
      } finally {
        setBtnLoading(resendBtn, false);
      }
    });
  }

  async function submitSignup(ev) {
    ev.preventDefault();
    const name = pickValue("suName", "signupName", "name").trim();
    const email = pickValue("suEmail", "signupEmail", "email").trim();
    const pw = pickValue("suPass", "signupPw", "password", "pw");
    const role = pickValue("suRole", "signupRole", "role") || "student";
    const msg = ensureMsgEl();

    if (!name || !email || !pw) {
      alert("이름/이메일/비밀번호를 입력하세요.");
      return;
    }

    normalizeUsersInStorage();
    const users = getUsers();
    const emailKey = normalizeEmail(email);
    if (users.some(u => u.emailKey === emailKey)) {
      msg.textContent = "이미 가입된 이메일입니다. 로그인하세요.";
      return;
    }

    const submitBtn = form.querySelector("button");
    try {
      setBtnLoading(submitBtn, true, "전송중...");
      const sendRes = await fetch(`${API_BASE_URL}/api/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      if (!sendRes.ok) {
        const err = await sendRes.json().catch(() => ({}));
        throw new Error(err.error || "인증메일 전송 실패");
      }
      showOtpUi(email, name, pw, role);
    } catch (e) {
      msg.textContent = e?.message || "인증메일 전송 실패";
    } finally {
      setBtnLoading(submitBtn, false);
    }
  }

  form.addEventListener("submit", submitSignup);
  const submitBtn = form.querySelector('button');
  submitBtn?.addEventListener('click', submitSignup);
}

function handleLoginPage() {
  const form = $("#loginForm");
  if (!form) return;

  // 기본적으로 form의 submit 이벤트를 가로채서 페이지 새로고침을 막고 로그인 로직을 수행합니다.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = pickValue("liEmail", "loginEmail", "email").trim();
    const pw = pickValue("liPass", "loginPw", "password", "pw");

    if (!email || !pw) {
      alert("이메일/비밀번호를 입력하세요.");
      return;
    }

    // 로컬 로그인 우선 (OTP 가입)
    const ok = localLogin(email, pw);
    if (!ok) alert("이메일 또는 비밀번호가 올바르지 않습니다.");
  });

  // 추가 안전장치: 일부 환경에서는 submit 이벤트가 아닌 button의 클릭이 발생할 수 있으므로
  // 로그인 버튼 클릭 시에도 기본 동작을 막고 같은 로직을 실행합니다.
  const submitBtn = form.querySelector('button');
  if (submitBtn) {
    submitBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const email = pickValue("liEmail", "loginEmail", "email").trim();
      const pw = pickValue("liPass", "loginPw", "password", "pw");
      if (!email || !pw) {
        alert("이메일/비밀번호를 입력하세요.");
        return;
      }
      const ok = localLogin(email, pw);
      if (!ok) alert("이메일 또는 비밀번호가 올바르지 않습니다.");
    });
  }
}

// ---------------------------
// ✅ SETTINGS (계정 삭제)
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

  const user = getUser();
  if (!user) { location.href = "login.html"; return; }

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

  delBtn?.addEventListener("click", () => {
    const pw = (pwInput?.value || "").trim();
    normalizeUsersInStorage();
    const users = getUsers();
    const me = users.find(x => normalizeEmail(x.email) === normalizeEmail(user.email)) || null;
    if (!me) {
      msg.textContent = "계정을 찾을 수 없습니다.";
      return;
    }
    const realPw = getUserPassword(me);
    if (String(pw) !== String(realPw)) {
      msg.textContent = "비밀번호가 일치하지 않습니다.";
      return;
    }

    if (!confirm("정말로 계정을 삭제하시겠습니까?")) return;

    removeUserData(user);
    alert("계정을 삭제했습니다.");
    location.href = "signup.html";
  });
}

/* ============================
   ✅ HOME / LIST / DETAIL / LIVE
   (아래부터는 네 원본 코드 그대로)
   ============================ */

function renderClassCard(c, wide = false) {
  return `
    <div class="class-card ${wide ? "wide" : ""}" data-id="${escapeAttr(c.id)}">
      <img class="thumb" src="${escapeAttr(c.thumb || FALLBACK_THUMB)}" alt="">
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

  wrap.innerHTML = top.map(c => renderClassCard(c)).join("");

  $$(".class-card", wrap).forEach(card => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-id");
      location.href = `class_detail.html?id=${encodeURIComponent(id)}`;
    });
  });
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
        location.href = `class_detail.html?id=${encodeURIComponent(id)}`;
      });
    });
  }

  categorySel?.addEventListener("change", applyFilter);
  searchInput?.addEventListener("input", applyFilter);
  applyFilter();
}

// ---------------------------
// ✅ CLASS DETAIL (핵심)
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
    //  - { title, vodKey, classId, replayId }
    const title = (typeof payload === "string") ? payload : (payload?.title || "다시보기");
    let vodKey = (typeof payload === "object") ? (payload?.vodKey || null) : null;
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
    // ✅ 없으면(예: 이전 데이터에 vodKey만 있고 blob 누락) 데모 영상을 "자동 생성"해서 보여줌
    if (vodVideo) {
      let blob = null;

      if (vodKey) {
        try { blob = await vodGetBlob(vodKey); } catch (_) { blob = null; }
      }

      // blob이 없으면: 데모 blob을 만들어서 저장 후 재생
      if (!blob) {
        try {
          const newKey = vodKey || `vod_autogen_${Date.now()}`;
          const demo = await makeDemoVodBlob(title || "VOD");
          await vodPutBlob(newKey, demo);
          blob = demo;
          vodKey = newKey;

          // replays 메타데이터에 vodKey가 없던 케이스면, localStorage에 다시 써서 다음에도 재생되게 함
          if (classId && replayId) {
            try {
              const classes = getClasses();
              const cls = classes.find(c => c.id === classId);
              const r = cls?.replays?.find(x => x.id === replayId);
              if (r) {
                r.vodKey = vodKey;
                saveClasses(classes);
              }
            } catch (_) {}
          }
        } catch (_) {
          // 생성도 실패하면 빈 상태 유지
        }
      }

      if (blob) {
        currentVodObjectUrl = URL.createObjectURL(blob);
        vodVideo.src = currentVodObjectUrl;
        vodVideo.style.display = "block";
        if (vodEmpty) vodEmpty.style.display = "none";
        // 자동재생 시도 (브라우저 정책에 따라 실패할 수 있음)
        vodVideo.play().catch(() => {});
      }
    }

    backdrop.style.display = "flex";
  };
}

// ✅ 강력한 버튼 탐지 (입장/수강 등록 후 입장 포함)
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

// ✅ 재생 버튼도 강제로 갱신
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

function loadClassDetailPage() {
  const root = $("#detailRoot");
  if (!root) return;

  ensureReplayModalBinding();

  const id = getParam("id");
  const classes = getClasses();
  const c = classes.find(x => x.id === id);
  const user = getUser();

  if (!c) {
    $("#detailTitle").textContent = "수업을 찾을 수 없습니다.";
    return;
  }

  $("#detailImg").src = c.thumb || FALLBACK_THUMB;
  $("#detailTitle").textContent = c.title || "-";
  $("#detailTeacher").textContent = c.teacher || "-";
  $("#detailCategory").textContent = c.category || "-";
  $("#detailDesc").textContent = c.description || "";
  $("#detailWeekly").textContent = won(c.weeklyPrice);
  $("#detailMonthly").textContent = won(c.monthlyPrice);

  const planWeekly = $("#planWeekly");
  const planMonthly = $("#planMonthly");
  const durationLabel = $("#durationLabel");
  const durationSel = $("#durationSelect");
  const payAmount = $("#payAmount");
  const endDate = $("#endDate");

  const enrollStateText = $("#enrollStateText");
  const teacherHint = $("#teacherHint");

  // ✅ buy button id가 다를 수도 있으니 강제로 찾아줌
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
      const isOwnerTeacher = (user.name === c.teacher);
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

  function refreshGates() {
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
          location.href = "login.html";
          return;
        }

        const isOwnerTeacher = (u.role === "teacher" && u.name === c.teacher);

        if (u.role === "teacher") {
          if (!isOwnerTeacher) {
            alert("선생님은 본인 수업만 라이브에 들어갈 수 있습니다.");
            return;
          }
          location.href = `live_class.html?id=${encodeURIComponent(c.id)}&s=1`;
          return;
        }

        if (!isEnrollmentActiveForUser(u, c.id)) {
          alert("수강(결제) 후 라이브 입장이 가능합니다.");
          $("#purchase")?.scrollIntoView({ behavior: "smooth", block: "start" });
          refreshGates();
          return;
        }

        location.href = `live_class.html?id=${encodeURIComponent(c.id)}&s=1`;
      });
    });
  }

  // v13: 페이지 진입 시에도 한번 정규화(과거 키 혼재로 상태 판정이 꼬이는 경우 방지)
  const u0 = getUser();
  if (u0) normalizeEnrollmentsForUser(u0, c.id);

  refreshGates();
  bindEnterClicks();

  buyBtn?.addEventListener("click", () => {
    const user = getUser();
    if (!user) {
      alert("로그인이 필요합니다.");
      location.href = "login.html";
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

    const { weekly, dur, total, start, end } = calc();

    const enroll = getEnrollments();

    // ✅ v12: 저장키에는 빈키("")를 포함하지 않는다 (읽기는 호환)
    const keys = userKeyList(user, false).filter(k => k !== "");

    if (!keys.length) {
      alert("계정 정보가 부족해 수강 등록을 저장할 수 없습니다. (id/email 확인 필요)");
      return;
    }

    const record = {
      planType: weekly ? "weekly" : "monthly",
      duration: dur,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      paidAmount: total
    };

    keys.forEach(k => {
      enroll[k] = enroll[k] || {};
      enroll[k][c.id] = record;
    });

    setEnrollments(enroll);

    // ✅ v13: 저장 직후, 현재 로그인 사용자 키로 다시 한번 정규화/검증
    // (특히 같은 이름/역할 중복, 예전 저장키 혼재 등으로 UI가 안 바뀌는 케이스 방어)
    const userNow = getUser() || user;
    normalizeEnrollmentsForUser(userNow, c.id);
    const verify = readEnrollmentForUser(userNow, c.id);
    if (!verify) {
      // 마지막 방어: 아주 구형 저장키(빈키 "")에도 1회 기록
      const enroll2 = getEnrollments();
      enroll2[""] = enroll2[""] || {};
      enroll2[""][c.id] = record;
      setEnrollments(enroll2);
    }

    alert("수강 등록 완료!");

    refreshGates();
    bindEnterClicks();
    renderReplaysList(c.id);
    refreshGates();
  });

  renderReplaysList(c.id);

  // ---------------------------
  // 자료실 / 과제 / 리뷰 / Q&A 렌더링
  // ---------------------------
  function renderMaterials() {
    const list = $("#materialList");
    if (!list) return;
    const mats = getMaterials()[c.id] || [];
    list.innerHTML = mats.length
      ? mats.map(m => `
        <div class="session-item">
          <div>
            <div class="session-title">${escapeHtml(m.title)}</div>
            <div class="session-sub">${new Date(m.at).toLocaleString("ko-KR")} · ${escapeHtml(m.author || "")}</div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <a class="btn primary" href="${escapeAttr(m.url)}" download>다운로드</a>
          </div>
        </div>
      `).join("")
      : `<div class="muted" style="font-size:13px;">아직 등록된 자료가 없습니다.</div>`;
  }

  function renderAssignments() {
    const list = $("#assignList");
    if (!list) return;
    const assigns = getAssignments()[c.id] || [];
    const metaAll = getAssignMeta();
    // 과제 목록을 배열로 정규화 (기존 단일 객체 저장 호환)
    let assignList = [];
    if (Array.isArray(metaAll[c.id])) {
      assignList = metaAll[c.id];
    } else if (metaAll[c.id]) {
      assignList = [{ id: metaAll[c.id].id || ("asg_" + Date.now()), ...metaAll[c.id] }];
    }
    assignList = assignList.map(a => a.id ? a : { ...a, id: "asg_" + Date.now() + "_" + Math.random().toString(16).slice(2) });
    metaAll[c.id] = assignList;
    setAssignMeta(metaAll);

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
    }
    const submitBtn = $("#assignSubmitBtn");
    if (submitBtn) submitBtn.disabled = !assignList.length;
    let selectedAssignId = selectEl?.value || latestAssignId;
    assignPendingSelect = null;
    const meta = (selectedAssignId && assignMap[selectedAssignId]) ? assignMap[selectedAssignId] : (assignList[assignList.length - 1] || {});

    const isOwnerTeacher = user?.role === "teacher" && user?.name === c.teacher;
    const myEmail = normalizeEmail(user?.email || "");
    const myAssign = assigns.find(a => normalizeEmail(a.userEmail) === myEmail && (!a.assignId || a.assignId === selectedAssignId));

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
          statusEl.textContent = `제출 완료 (${new Date(submitted).toLocaleString("ko-KR")}${updated}) · ${dueTxt}`;
        } else {
          statusEl.textContent = `아직 제출하지 않았습니다. ${dueTxt}`;
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
            <input type="datetime-local" id="assignDueInput" class="input" style="width:200px;" step="60" min="2000-01-01T00:00" value="${dueVal}">
            <button class="btn" id="assignDueSave">저장</button>
            <button class="btn" id="assignDueClear">초기화</button>
          </div>
          <textarea id="assignDescInput" class="input" placeholder="과제 설명을 입력하세요.">${escapeHtml(meta.desc || "")}</textarea>
          <div class="muted" style="font-size:12px;">마감 이후 제출/수정은 차단됩니다.</div>
        </div>
        <div id="assignListMeta" style="margin-top:8px;"></div>
      `;
      const dueInputEl = document.getElementById("assignDueInput");
      // 마우스 휠로 시간/분이 계속 순환되는 것을 방지
      if (dueInputEl) {
        dueInputEl.addEventListener("wheel", (e) => { e.preventDefault(); }, { passive: false });
      }
      // 선택된 과제 내용을 설정 폼에 반영 (편집 중이 아닐 때)
      if (!metaBox.dataset.editing) {
        const t = document.getElementById("assignTitleInput");
        const d = document.getElementById("assignDescInput");
        const due = document.getElementById("assignDueInput");
        if (t) t.value = meta?.title || "";
        if (d) d.value = meta?.desc || "";
        if (due) due.value = meta?.dueAt || "";
      }
      document.getElementById("assignDueSave")?.addEventListener("click", () => {
        const v = document.getElementById("assignDueInput")?.value || "";
        const title = (document.getElementById("assignTitleInput")?.value || "").trim();
        const desc = (document.getElementById("assignDescInput")?.value || "").trim();
        const metaAll2 = getAssignMeta();
        let listArr = Array.isArray(metaAll2[c.id]) ? metaAll2[c.id] : [];
        const editId = metaBox.dataset.editing || null;
        if (editId) {
          listArr = listArr.map(m => m.id === editId ? { ...m, title, desc, dueAt: v || null, updatedAt: new Date().toISOString() } : m);
          assignPendingSelect = editId;
        } else {
          const newId = "asg_" + Date.now();
          listArr.push({ id: newId, title, desc, dueAt: v || null, createdAt: new Date().toISOString(), updatedAt: null });
          assignPendingSelect = newId;
        }
        metaBox.dataset.editing = "";
        metaAll2[c.id] = listArr;
        setAssignMeta(metaAll2);
        // 저장 후에도 현재 입력값을 그대로 유지
        if (!metaBox.dataset.editing) {
          const t = document.getElementById("assignTitleInput");
          const d = document.getElementById("assignDescInput");
          const due = document.getElementById("assignDueInput");
          if (t) t.value = title;
          if (d) d.value = desc;
          if (due) due.value = v;
        }
        renderAssignments();
      });
      document.getElementById("assignDueClear")?.addEventListener("click", () => {
        metaBox.dataset.editing = "";
        assignPendingSelect = null;
        const t = document.getElementById("assignTitleInput");
        const d = document.getElementById("assignDescInput");
        const due = document.getElementById("assignDueInput");
        if (t) t.value = "";
        if (d) d.value = "";
        if (due) due.value = "";
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
            const due = document.getElementById("assignDueInput");
            if (t) t.value = target.title || "";
            if (d) d.value = target.desc || "";
            if (due) due.value = target.dueAt || "";
            if (selectEl) selectEl.value = id;
            const submitBtn2 = document.getElementById("assignSubmitBtn");
            if (submitBtn2) submitBtn2.disabled = false;
          });
        });
        $$("[data-assign-delete]").forEach(btn => {
          btn.addEventListener("click", () => {
            const id = btn.getAttribute("data-assign-delete");
            if (!confirm("해당 과제를 삭제할까요?")) return;
            const metaAll3 = getAssignMeta();
            const listArr = (Array.isArray(metaAll3[c.id]) ? metaAll3[c.id] : []).filter(m => m.id !== id);
            metaAll3[c.id] = listArr;
            setAssignMeta(metaAll3);
            const assignsAll = getAssignments();
            assignsAll[c.id] = (assignsAll[c.id] || []).filter(a => a.assignId !== id);
            setAssignments(assignsAll);
            if (selectEl && listArr.length) {
              selectEl.value = listArr[listArr.length - 1].id;
            }
            renderAssignments();
          });
        });
      }
    } else {
      const metaBox = document.getElementById("assignMetaBox");
      if (metaBox) metaBox.remove();
    }

    if (!isOwnerTeacher) {
      list.innerHTML = `<div class="muted" style="font-size:13px;">제출한 과제는 선생님만 확인할 수 있습니다.</div>`;
      return;
    }

    list.innerHTML = assigns.length
      ? `<div class="muted" style="margin-bottom:6px;">제출 목록 (${assigns.length})</div>` +
        assigns.map(a => `
        <div class="session-item" style="border-left:4px solid rgba(109,94,252,.45); background:linear-gradient(90deg, rgba(109,94,252,.06), rgba(109,94,252,.02));">
          <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
            <div class="session-title">${escapeHtml(a.userName || a.userEmail || "-")}</div>
            <span class="chip" style="background:rgba(109,94,252,.12);">${escapeHtml(assignMap[a.assignId || latestAssignId || ""]?.title || "학생 제출")}</span>
          </div>
          <div class="session-sub">제출: ${new Date(a.submittedAt || a.at).toLocaleString("ko-KR")}${a.updatedAt ? ` / 수정: ${new Date(a.updatedAt).toLocaleString("ko-KR")}` : ""}</div>
          <div class="session-sub" style="white-space:pre-wrap;">${escapeHtml(a.text || "")}</div>
          ${a.url ? `<div class="session-sub"><a href="${escapeAttr(a.url)}" target="_blank">링크 열기</a></div>` : ``}
          ${a.fileName && a.fileData ? `<div class="session-sub"><a href="${escapeAttr(a.fileData)}" download="${escapeAttr(a.fileName)}">첨부파일 다운로드 (${escapeHtml(a.fileName)})</a></div>` : ``}
          ${typeof a.score === "number" ? `<div class="session-sub">점수: ${a.score} / 피드백: ${escapeHtml(a.comment || "-")}</div>` : ``}
          <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:8px;">
            <input type="number" min="0" max="100" data-ascore="${escapeAttr(a.id)}" class="input" style="width:90px;" placeholder="점수">
            <input type="text" data-acmt="${escapeAttr(a.id)}" class="input" style="width:160px;" placeholder="피드백">
            <button class="btn primary" data-agrade="${escapeAttr(a.id)}">저장</button>
          </div>
        </div>
      `).join("")
      : `<div class="muted" style="font-size:13px;">제출된 과제가 없습니다.</div>`;

    if (isOwnerTeacher) {
      $$("[data-agrade]").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-agrade");
          const scoreInput = document.querySelector(`[data-ascore="${CSS.escape(id)}"]`);
          const cmtInput = document.querySelector(`[data-acmt="${CSS.escape(id)}"]`);
          const score = Number(scoreInput?.value || 0);
          const comment = (cmtInput?.value || "").trim();
          const all = getAssignments();
          all[c.id] = (all[c.id] || []).map(a => a.id === id ? { ...a, score, comment } : a);
          setAssignments(all);
          renderAssignments();
        });
      });
    }
  }

  function renderReviews() {
    const list = $("#reviewList");
    if (!list) return;
    const revs = getReviews()[c.id] || [];
    const avg = revs.length ? (revs.reduce((s,r)=>s+(r.rating||0),0)/revs.length).toFixed(1) : "-";
    list.innerHTML = `
      <div class="muted" style="margin-bottom:8px;">평점: ${avg} / 5 (${revs.length}명)</div>
      ${revs.length ? revs.map(r => `
        <div class="session-item">
          <div>
            <div class="session-title">⭐ ${r.rating} · ${escapeHtml(r.userName || r.userEmail || "")}</div>
            <div class="session-sub">${new Date(r.at).toLocaleString("ko-KR")}</div>
            <div class="session-sub" style="white-space:pre-wrap;">${escapeHtml(r.text || "")}</div>
          </div>
        </div>
      `).join("") : `<div class="muted" style="font-size:13px;">아직 리뷰가 없습니다.</div>`}
    `;
  }

  function renderQna() {
    const list = $("#qnaList");
    if (!list) return;
    const qnas = getQna()[c.id] || [];
    list.innerHTML = qnas.length ? qnas.map(q => `
      <div class="session-item">
        <div>
          <div class="session-title">${escapeHtml(q.userName || q.userEmail || "")} · ${escapeHtml(q.role || "")}</div>
          <div class="session-sub">${new Date(q.at).toLocaleString("ko-KR")}</div>
          <div class="session-sub" style="white-space:pre-wrap;">${escapeHtml(q.text || "")}</div>
          <div style="margin-top:8px; display:grid; gap:6px;">
            ${(q.replies || []).map(r => `
              <div class="session-sub" style="background:rgba(15,23,42,.04); padding:6px 8px; border-radius:10px;">
                <strong>${escapeHtml(r.userName || r.userEmail || "")} · ${escapeHtml(r.role || "")}</strong><br/>
                ${escapeHtml(r.text || "")} <span style="color:var(--muted2);">(${new Date(r.at).toLocaleString("ko-KR")})</span>
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
      btn.addEventListener("click", () => {
        if (!user) { alert("로그인이 필요합니다."); return; }
        const qid = btn.getAttribute("data-qreplybtn");
        const inp = document.querySelector(`[data-qreply="${CSS.escape(qid)}"]`);
        const text = (inp?.value || "").trim();
        if (!text) return;
        const all = getQna();
        all[c.id] = (all[c.id] || []).map(q => q.id === qid ? {
          ...q,
          replies: [ ...(q.replies||[]), { userEmail: user.email, userName: user.name, role: user.role, text, at: new Date().toISOString() } ]
        } : q);
        setQna(all);
        renderQna();
      });
    });
  }

  // 자료 업로드 (선생님만)
  const matForm = $("#materialFormWrap");
  if (matForm) matForm.style.display = (user?.role === "teacher" && user?.name === c.teacher) ? "block" : "none";
  $("#matUploadBtn")?.addEventListener("click", () => {
    if (!(user?.role === "teacher" && user?.name === c.teacher)) return;
    const title = ($("#matTitle")?.value || "").trim();
    const file = $("#matFile")?.files?.[0] || null;
    if (!title || !file) { alert("제목과 파일을 입력하세요."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const mats = getMaterials();
      mats[c.id] = mats[c.id] || [];
      mats[c.id].push({
        id: "m_" + Date.now(),
        title,
        url: String(reader.result || ""),
        author: user.name || user.email,
        at: new Date().toISOString()
      });
      setMaterials(mats);
      renderMaterials();
      $("#matTitle").value = "";
      $("#matFile").value = "";
    };
    reader.readAsDataURL(file);
  });

  // 과제 제출 (학생만)
  const assignForm = $("#assignFormWrap");
  if (assignForm) assignForm.style.display = (user?.role === "student") ? "block" : "none";
  $("#assignSubmitBtn")?.addEventListener("click", () => {
    if (!user || user.role !== "student") return;
    const metaMap = getAssignMeta();
    const assignList = Array.isArray(metaMap[c.id]) ? metaMap[c.id] : [];
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
    if (!text && !file) { alert("제출 내용 또는 파일을 입력하세요."); return; }

    const saveAssignment = (fileData, fileName) => {
      const assigns = getAssignments();
      assigns[c.id] = assigns[c.id] || [];
      const nowIso = new Date().toISOString();
      const idx = assigns[c.id].findIndex(a => normalizeEmail(a.userEmail) === normalizeEmail(user.email));
      const base = {
        userEmail: user.email,
        userName: user.name,
        text,
        url: null,
        fileName: fileName || "",
        fileData: fileData || "",
        assignId: currentAssignId,
      };
      if (idx >= 0) {
        const prev = assigns[c.id][idx];
        assigns[c.id][idx] = {
          ...prev,
          ...base,
          submittedAt: prev.submittedAt || prev.at || nowIso,
          updatedAt: nowIso
        };
      } else {
        assigns[c.id].push({
          id: "a_" + Date.now(),
          ...base,
          submittedAt: nowIso,
          updatedAt: null,
          at: nowIso
        });
      }
      setAssignments(assigns);
      $("#assignText").value = "";
      if ($("#assignFile")) $("#assignFile").value = "";
      renderAssignments();
    };

    if (file) {
      const reader = new FileReader();
      reader.onload = () => saveAssignment(String(reader.result || ""), file.name);
      reader.readAsDataURL(file);
    } else {
      saveAssignment("", "");
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
    reviewBtn.addEventListener("click", () => {
    if (!canReview) return;
    const rating = Number($("#reviewRating")?.value || 5);
    const text = ($("#reviewText")?.value || "").trim();
    const revs = getReviews();
    revs[c.id] = revs[c.id] || [];
    const emailKey = normalizeEmail(user.email);
    const now = new Date().toISOString();
    const idx = revs[c.id].findIndex(r => normalizeEmail(r.userEmail) === emailKey);
    const payload = {
      id: idx >= 0 ? revs[c.id][idx].id : "rv_" + Date.now(),
      userEmail: user.email,
      userName: user.name,
      rating,
      text,
      at: now
    };
    if (idx >= 0) {
      revs[c.id][idx] = payload;
      alert("기존 리뷰를 업데이트했습니다.");
    } else {
      revs[c.id].push(payload);
    }
    setReviews(revs);
    $("#reviewText").value = "";
    renderReviews();
  });
  }

  // Q&A 작성 (로그인 필요)
  const qnaForm = $("#qnaFormWrap");
  if (qnaForm) qnaForm.style.display = user ? "block" : "none";
  $("#qnaSubmitBtn")?.addEventListener("click", () => {
    if (!user) { alert("로그인이 필요합니다."); return; }
    const text = ($("#qnaText")?.value || "").trim();
    if (!text) return;
    const all = getQna();
    all[c.id] = all[c.id] || [];
    all[c.id].push({
      id: "q_" + Date.now(),
      userEmail: user.email,
      userName: user.name,
      role: user.role,
      text,
      replies: [],
      at: new Date().toISOString()
    });
    setQna(all);
    $("#qnaText").value = "";
    renderQna();
  });

  renderMaterials();
  renderAssignments();
  renderReviews();
  renderQna();
}

function renderReplaysList(classId) {
  const wrap = $("#sessionList");
  if (!wrap) return;

  const user = getUser();
  const c = getClasses().find(x => x.id === classId);
  const isOwnerTeacher = user?.role === "teacher" && user?.name === c?.teacher;
  const activeStudent = user?.role === "student" && isEnrollmentActiveForUser(user, classId);
  const canWatch = isOwnerTeacher || activeStudent;

  const replays = getReplays();
  const list = replays[classId] || [];

  wrap.innerHTML = `
    ${list.length ? list.map(r => `
      <div class="session-item ${canWatch ? "" : "locked"}">
        <div>
          <div class="session-title">${escapeHtml(r.title)}</div>
          <div class="session-sub">
            ${new Date(r.createdAt).toLocaleString("ko-KR")}
            ${r.vodKey ? ` · <span class="badge" style="margin-left:6px;">영상</span>` : ``}
          </div>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn ${canWatch ? "primary":"ghost"}" ${canWatch ? "" : "disabled"} data-replay="${escapeAttr(r.id)}">재생</button>
          ${isOwnerTeacher ? `<button class="btn danger" data-rdel="${escapeAttr(r.id)}">삭제</button>` : ``}
        </div>
      </div>
    `).join("") : `
      <div class="muted" style="font-size:13px; padding:10px 2px;">
        아직 저장된 다시보기가 없어요.
      </div>
    `}
    ${isOwnerTeacher ? `
      <div style="margin-top:12px;">
        <button class="btn" id="teacherAddVod">선생님: 데모 다시보기 추가</button>
      </div>
    ` : ``}
    ${(!canWatch && user?.role === "student") ? `
      <div class="muted" style="font-size:13px; margin-top:10px;">
        수강 중인 학생만 다시보기를 볼 수 있어요.
      </div>
    ` : ``}
  `;

  $$('[data-replay]', wrap).forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const rid = btn.getAttribute("data-replay");
      const rp = getReplays();
      const item = (rp[classId] || []).find(x => x.id === rid);
      const title = item?.title || "VOD 데모";

      if (typeof window.__openReplayModal === "function") {
        window.__openReplayModal({
          title,
          vodKey: item?.vodKey || null,
          classId,
          replayId: rid,
        });
      } else {
        alert("VOD 데모 재생");
      }
    });
  });

  $("#teacherAddVod")?.addEventListener('click', async () => {
    if (!isOwnerTeacher) {
      alert("선생님(본인 수업)만 추가할 수 있어요.");
      return;
    }

    const btn = $("#teacherAddVod");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "데모 VOD 생성 중...";
    }

    // 아주 짧은 데모 영상(캔버스 애니메이션)을 만들어 IndexedDB에 저장
    async function makeDemoBlob() {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas ctx");

      const stream = canvas.captureStream(30);
      const mimeCandidates = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm"
      ];
      let mimeType = "";
      for (const m of mimeCandidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) {
          mimeType = m;
          break;
        }
      }

      return new Promise((resolve, reject) => {
        if (!window.MediaRecorder) return reject(new Error("MediaRecorder unsupported"));
        const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const chunks = [];
        let startTs = performance.now();

        rec.ondataavailable = (ev) => {
          if (ev.data && ev.data.size) chunks.push(ev.data);
        };
        rec.onerror = () => reject(new Error("MediaRecorder error"));
        rec.onstop = () => {
          const type = mimeType || (chunks[0] && chunks[0].type) || "video/webm";
          resolve(new Blob(chunks, { type }));
        };

        function drawFrame(now) {
          const t = (now - startTs) / 1000;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          // 배경
          const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
          g.addColorStop(0, "rgba(109,94,252,.20)");
          g.addColorStop(1, "rgba(0,211,255,.18)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // 제목
          ctx.fillStyle = "rgba(15,23,42,.85)";
          ctx.font = "700 48px system-ui, -apple-system, Segoe UI, Roboto";
          ctx.fillText("LessonBay VOD Demo", 70, 110);
          ctx.font = "500 28px system-ui, -apple-system, Segoe UI, Roboto";
          ctx.fillStyle = "rgba(15,23,42,.65)";
          ctx.fillText("녹화/다시보기 동작 확인용 샘플", 70, 160);

          // 움직이는 도형
          const cx = 200 + (Math.sin(t * 1.7) * 1) * 420;
          const cy = 420 + Math.cos(t * 1.3) * 120;
          ctx.beginPath();
          ctx.arc(cx, cy, 90, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(109,94,252,.55)";
          ctx.fill();

          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(520, 330, 620, 210, 32);
          else ctx.rect(520, 330, 620, 210);
          ctx.fillStyle = "rgba(255,255,255,.75)";
          ctx.fill();
          ctx.fillStyle = "rgba(15,23,42,.85)";
          ctx.font = "800 44px system-ui";
          ctx.fillText("00:" + String(Math.floor(t)).padStart(2, "0"), 570, 420);

          if (t < 2.2) {
            requestAnimationFrame(drawFrame);
          } else {
            rec.stop();
          }
        }

        rec.start(200);
        requestAnimationFrame(drawFrame);
      });
    }

    try {
      const demoBlob = await makeDemoBlob();
      const vodKey = `vod_demo_${classId}_${Date.now()}`;
      await vodPut(vodKey, demoBlob);

      const rp = getReplays();
      rp[classId] = rp[classId] || [];
      rp[classId].unshift({
        id: "r_" + Date.now(),
        title: `(${new Date().toLocaleDateString("ko-KR")}) ${getClasses().find(x => x.id === classId)?.title || "수업"} · VOD 데모`,
        createdAt: new Date().toISOString(),
        vodKey
      });
      setReplays(rp);
      renderReplaysList(classId);
      alert('데모 다시보기를 추가했습니다. (재생하면 실제 영상이 나옵니다)');
    } catch (e) {
      console.error(e);
      alert("데모 VOD 생성에 실패했습니다. (브라우저가 MediaRecorder/captureStream을 지원하지 않을 수 있어요)");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "선생님: 데모 다시보기 추가";
      }
    }
  });

  $$('[data-rdel]', wrap).forEach(btn => {
    btn.addEventListener('click', () => {
      const rid = btn.getAttribute('data-rdel');
      if (!confirm('이 다시보기를 삭제할까요?')) return;
      const rp = getReplays();
      const target = (rp[classId] || []).find(x => x.id === rid);
      rp[classId] = (rp[classId] || []).filter(x => x.id !== rid);
      setReplays(rp);
      // IndexedDB에 저장된 영상도 함께 삭제
      if (target?.vodKey) {
        vodDelete(target.vodKey).catch(() => {});
      }
      renderReplaysList(classId);
    });
  });

  refreshReplayButtons(canWatch);
}

// ---------------------------
// ✅ CREATE / DASH / LIVE
// ---------------------------
function handleCreateClassPage() {
  const form = $("#createClassForm");
  if (!form) return;

  const guard = $("#createGuard");
  const main = $("#createMain");

  const user = getUser();
  if (!user || user.role !== "teacher") {
    if (guard) guard.style.display = "block";
    if (main) main.style.display = "none";
    return;
  }

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

  fileInput?.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) {
      thumbDataUrl = "";
      if (preview) preview.style.display = "none";
      return;
    }
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

  form.addEventListener("submit", (e) => {
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

    const classes = getClasses();
    const newC = {
      id: "c_" + Date.now(),
      title,
      teacher: user.name,
      category,
      description,
      weeklyPrice,
      monthlyPrice,
      thumb: thumbDataUrl || FALLBACK_THUMB
    };

    classes.unshift(newC);
    setClasses(classes);

    alert("수업 생성 완료!");
    location.href = "teacher_dashboard.html";
  });
}

function loadTeacherDashboard() {
  const wrap = $("#teacherClassList");
  if (!wrap) return;

  const user = getUser();
  if (!user) { location.href = "login.html"; return; }
  if (user.role !== "teacher") { location.href = "student_dashboard.html"; return; }

  const mine = getClasses().filter(c => c.teacher === user.name);

  wrap.innerHTML = `
    <div class="grid cols-2">
      ${mine.map(c => `
        <div class="class-card wide" style="cursor:default;">
          <img class="thumb" src="${escapeAttr(c.thumb || FALLBACK_THUMB)}" alt="">
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

  $$('[data-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-open');
      location.href = `class_detail.html?id=${encodeURIComponent(id)}`;
    });
  });

  $$('[data-live]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-live');
      location.href = `live_class.html?id=${encodeURIComponent(id)}&s=1`;
    });
  });

  $$('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-del');
      if (!confirm('정말 삭제할까요?')) return;

      const all = getClasses().filter(c => c.id !== id);
      setClasses(all);

      const rp = getReplays();
      delete rp[id];
      setReplays(rp);

      const en = getEnrollments();
      Object.keys(en).forEach(uid => { if (en[uid] && en[uid][id]) delete en[uid][id]; });
      setEnrollments(en);

      loadTeacherDashboard();
    });
  });
}

function loadStudentDashboard() {
  const wrap = $("#studentClassList");
  if (!wrap) return;

  const user = getUser();
  if (!user) { location.href = "login.html"; return; }
  if (user.role !== "student") { location.href = "teacher_dashboard.html"; return; }

  const classes = getClasses().filter(c => !!readEnrollmentForUser(user, c.id));

  wrap.innerHTML = `
    <div class="grid cols-2">
      ${classes.map(c => {
        const e = readEnrollmentForUser(user, c.id);
        const active = isEnrollmentActiveForUser(user, c.id);
        const endText = e?.endAt ? fmtDateKR(e.endAt) : (e?.endDate || "-");
        return `
          <div class="class-card wide" style="cursor:default;">
            <img class="thumb" src="${escapeAttr(c.thumb || FALLBACK_THUMB)}" alt="">
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
    ${classes.length ? "" : `<p class="muted" style="margin-top:12px;">아직 수강 중인 수업이 없어요.</p>`}
  `;

  $$('[data-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-open');
      location.href = `class_detail.html?id=${encodeURIComponent(id)}`;
    });
  });
  $$('[data-live]').forEach(btn => {
    btn.highlightBound = "1";
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-live');
      location.href = `live_class.html?id=${encodeURIComponent(id)}&s=1`;
    });
  });
}

function loadLivePage() {
  const root = $("#liveRoot");
  if (!root) return;

  const classId = getParam("id");
  const sessionNo = getParam("s") || "1";
  const c = getClasses().find(x => x.id === classId);

  if (!c) { $("#liveTitle").textContent = "수업을 찾을 수 없습니다."; return; }

  const user = getUser();
  if (!user) { alert("로그인이 필요합니다."); location.href = "login.html"; return; }

  const isOwnerTeacher = (user.role === "teacher" && user.name === c.teacher);
  const isStudentActive = (user.role === "student" && isEnrollmentActiveForUser(user, classId));

  if (!isOwnerTeacher && user.role === "student" && !isStudentActive) {
    alert("수강(결제) 후 라이브에 입장할 수 있어요.");
    location.href = `class_detail.html?id=${encodeURIComponent(classId)}`;
    return;
  }

  $("#liveTitle").textContent = `${c.title} (세션 ${sessionNo})`;
  $("#liveSub").textContent = `${c.category || "LIVE"} · ${c.teacher || "-"}`;

  $("#sideSessionsLink")?.setAttribute("href", `class_detail.html?id=${encodeURIComponent(classId)}#sessions`);

  // 화면비율 변경(데모)
  const arSelect = $("#arSelect");
  arSelect?.addEventListener("change", () => {
    const v = arSelect.value || "16/9";
    document.documentElement.style.setProperty("--liveAR", v);
  });

  // 카메라/마이크 연결(로컬 프리뷰) + 화면 공유(선택)
  const videoFrame = $("#videoFrame");
  const liveVideo = $("#liveVideo");
  const videoOverlay = $("#videoOverlay");
  const btnConnect = $("#btnConnect");
  const btnShare = $("#btnShare");

  let connected = false;
  let cameraStream = null;
  let screenStream = null;
  let mode = "camera"; // camera | screen

  function setOverlay(text) {
    if (!videoOverlay) return;
    videoOverlay.textContent = text;
    videoOverlay.style.display = text ? "grid" : "none";
  }

  function attachStream(stream) {
    if (!liveVideo) return;
    liveVideo.srcObject = stream;
    // 로컬 프리뷰는 무조건 mute (하울링 방지)
    liveVideo.muted = true;
    const p = liveVideo.play?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }

  function stopStream(stream) {
    try {
      stream?.getTracks?.().forEach(t => t.stop());
    } catch (e) {}
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("이 브라우저에서 카메라/마이크를 지원하지 않습니다.");
    }
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    return cameraStream;
  }

  async function startScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("이 브라우저에서 화면 공유를 지원하지 않습니다.");
    }
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const vt = screenStream.getVideoTracks?.()[0];
    // 사용자가 '공유 중지'를 누르면 자동으로 카메라로 복귀
    vt?.addEventListener?.("ended", () => {
      if (mode === "screen") {
        stopStream(screenStream);
        screenStream = null;
        mode = "camera";
        if (cameraStream) attachStream(cameraStream);
        if (btnShare) btnShare.textContent = "화면 공유";
        setOverlay("");
      }
    });
    return screenStream;
  }

  function setConnectedUI(isOn) {
    connected = isOn;
    if (btnConnect) btnConnect.textContent = connected ? "연결 해제" : "카메라/마이크 연결";
    if (!connected) {
      if (liveVideo) liveVideo.srcObject = null;
      setOverlay("카메라/마이크 연결 후 시작할 수 있어요");
      if (btnShare) {
        btnShare.textContent = "화면 공유";
        // 학생/미지원 환경에서도 버튼은 남겨두되 연결 전엔 동작 X
      }
      return;
    }
    setOverlay("");
  }

  // 페이지 이동/닫힘 시 카메라/화면 공유 스트림 정리
  function stopAllStreams() {
    stopStream(screenStream);
    stopStream(cameraStream);
    screenStream = null;
    cameraStream = null;
    mode = "camera";
    setConnectedUI(false);
  }

  window.addEventListener("beforeunload", stopAllStreams);

  // 화면 공유는 수강 중(선생님/학생) 모두 가능
  if (btnShare) {
    setGateDisabled(btnShare, false);
    btnShare.textContent = "화면 공유";
  }

  btnConnect?.addEventListener("click", async () => {
    if (connected) {
      // 연결 해제
      stopStream(screenStream);
      stopStream(cameraStream);
      screenStream = null;
      cameraStream = null;
      mode = "camera";
      setConnectedUI(false);
      return;
    }

    try {
      setOverlay("연결 중...");
      const s = await startCamera();
      attachStream(s);
      mode = "camera";
      setConnectedUI(true);
    } catch (err) {
      console.error(err);
      setConnectedUI(false);
      alert("카메라/마이크 연결에 실패했습니다.\n- 브라우저 권한을 허용했는지 확인하세요.\n- HTTPS/localhost 환경인지 확인하세요.\n\n" + (err?.message || ""));
    }
  });

  btnShare?.addEventListener("click", async () => {
    if (!(isOwnerTeacher || isStudentActive)) return;
    if (!connected) {
      alert("먼저 카메라/마이크를 연결하세요.");
      return;
    }

    try {
      if (mode !== "screen") {
        setOverlay("화면 공유 시작 중...");
        const ss = await startScreen();
        attachStream(ss);
        mode = "screen";
        if (btnShare) btnShare.textContent = "화면 공유 중지";
        setOverlay("");
      } else {
        stopStream(screenStream);
        screenStream = null;
        mode = "camera";
        if (cameraStream) attachStream(cameraStream);
        if (btnShare) btnShare.textContent = "화면 공유";
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
            const vodKey = `vod_${classId}_${Date.now()}`;

            await vodPut(vodKey, blob);

            const rp = getReplays();
            rp[classId] = rp[classId] || [];
            rp[classId].unshift({
              id: "r_" + Date.now(),
              title: `(${new Date().toLocaleDateString("ko-KR")}) ${c.title} · 세션${sessionNo} · 다시보기`,
              createdAt: new Date().toISOString(),
              vodKey,
              mime: blob.type
            });
            setReplays(rp);

            if (recordHint) recordHint.textContent = "✅ 녹화가 저장되었고, 다시보기에 등록했습니다.";
            alert("녹화를 종료했고, 다시보기에 등록했습니다.");
          } catch (e) {
            console.error(e);
            if (recordHint) recordHint.textContent = "⚠️ 녹화 저장에 실패했습니다.";
            alert("녹화 저장 실패\n" + (e?.message || ""));
          } finally {
            recordChunks = [];
          }
        };

        recording = true;
        btnRecord.textContent = "녹화 종료";
        if (recordHint) recordHint.textContent = "🔴 녹화 중... 종료하면 다시보기에 자동 등록됩니다.";
        recorder.start();
        return;
      }

      // stop
      recording = false;
      btnRecord.textContent = "녹화 시작";
      if (recordHint) recordHint.textContent = "⏳ 저장 중... (잠시만)";
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

  function renderChat() {
    if (!chatLog) return;
    const all = getChat();
    const list = all[classId] || [];
    chatLog.innerHTML = list.map(m => `
      <div class="msg ${m.emailKey === normalizeEmail(user.email) ? "me" : ""}">
        <div class="mmeta">${escapeHtml(m.name || "-")} · ${new Date(m.at).toLocaleTimeString("ko-KR")}</div>
        <div class="mtext">${escapeHtml(m.text || "")}</div>
      </div>
    `).join("");
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function pushChat(text) {
    const t = String(text || "").trim();
    if (!t) return;
    const all = getChat();
    all[classId] = all[classId] || [];
    all[classId].push({
      name: user.name,
      emailKey: normalizeEmail(user.email),
      text: t,
      at: new Date().toISOString()
    });
    setChat(all);
    renderChat();
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
    stopAllStreams();
    location.href = `class_detail.html?id=${encodeURIComponent(classId)}`;
  });

  // 출석 로그(학생 활성 수강자만)
  if (user?.role === "student" && activeStudent) {
    const att = getAttendance();
    att[classId] = att[classId] || [];
    att[classId].push({ email: user.email, at: new Date().toISOString() });
    setAttendance(att);
  }
}

// ---------------------------
// ✅ INIT
// ---------------------------
function init() {
  migrateStorage();
  normalizeUsersInStorage();
  normalizeCurrentUserInStorage(); // ✅ 핵심
  installGateBlockerOnce();        // ✅ <a> disabled blocking

  ensureSeedData().then(() => {
    updateNav();
    runReveal();

    if ($("#homePopular")) loadHomePopular();
    if ($("#classGrid")) loadClassesPage();
    if ($("#detailRoot")) loadClassDetailPage();
    if ($("#createClassForm")) handleCreateClassPage();
    if ($("#loginForm")) handleLoginPage();
    if ($("#signupForm")) handleSignupPage();
    if ($("#settingsRoot")) handleSettingsPage();
    if ($("#teacherDash")) loadTeacherDashboard();
    if ($("#studentDash")) loadStudentDashboard();
    if ($("#liveRoot")) loadLivePage();

    if (getPath() === "logout.html") doLogout(true);
  });
}

document.addEventListener("DOMContentLoaded", init);
