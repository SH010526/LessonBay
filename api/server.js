require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const morgan = require("morgan");
const fs = require("fs");
const path = require("path");
const { PrismaClient, PlanType, EnrollmentStatus } = require("@prisma/client");
const { createClient } = require("@supabase/supabase-js");
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");
const nodemailer = require("nodemailer");

const app = express();
const prisma = new PrismaClient();
const CDN_BASE_URL = String(process.env.CDN_BASE_URL || "").trim().replace(/\/+$/, "");
const STORAGE_BUCKET = String(process.env.SUPABASE_STORAGE_BUCKET || "LessonBay").trim();
const STORAGE_ALLOWED_PREFIXES = new Set(["class-thumbs", "materials", "replays", "uploads"]);

// Warm up DB connection to reduce first-request latency.
prisma.$connect().catch((err) => {
  console.error("Prisma connect failed:", err);
});

// 로그 파일 설정
const logDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const accessLogStream = fs.createWriteStream(path.join(logDir, "access.log"), { flags: "a" });

// Supabase admin client for JWT 검증
const supabase = createClient(
  process.env.SUPABASE_URL || "https://pqvdexhxytahljultmjd.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// HTTPS 리다이렉트 (배포 환경에서 FORCE_HTTPS=1 설정 시 동작)
app.set("trust proxy", 1);
app.use((req, res, next) => {
  if (process.env.FORCE_HTTPS === "1") {
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    if (proto !== "https") {
      const host = req.headers.host || "";
      const url = req.originalUrl || "/";
      return res.redirect(301, `https://${host}${url}`);
    }
  }
  next();
});

// Helmet + 기본 CSP(배포 시 HTTPS 전제)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'", "data:", "blob:", "https://cdn.jsdelivr.net", "https://*.supabase.co"],
      "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://*.supabase.co"],
      "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      // supabase storage/unsplash 썸네일 허용
      "img-src": [
        "'self'",
        "data:",
        "blob:",
        "https://cdn.jsdelivr.net",
        "https://*.supabase.co",
        "https://images.unsplash.com",
      ],
      "connect-src": ["'self'", "https://*.supabase.co", "wss://*.supabase.co", "https://*.livekit.cloud", "wss://*.livekit.cloud"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

app.use(compression({ threshold: 1024 }));

// CORS: 기본으로 로컬 허용, FRONTEND_ORIGINS(콤마) 지정 시 그 도메인만 허용
const defaultOrigins = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
const envOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);
const allowOrigins = envOrigins.length ? envOrigins : defaultOrigins;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowOrigins.includes(origin)) return true;
  // Railway 도메인 자동 허용
  if (origin.endsWith(".railway.app")) return true;
  if (process.env.RAILWAY_PUBLIC_DOMAIN && origin.includes(process.env.RAILWAY_PUBLIC_DOMAIN)) return true;
  if (process.env.RAILWAY_PRIVATE_DOMAIN && origin.includes(process.env.RAILWAY_PRIVATE_DOMAIN)) return true;
  return false;
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error("CORS: 허용되지 않은 도메인입니다."), false);
  },
  credentials: true,
}));
// Allow larger JSON payloads for base64 uploads (materials/replays)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(morgan("tiny"));
app.use(morgan("combined", { stream: accessLogStream }));

// Health check (fast response for warmup/ping)
app.get("/api/health", (_req, res) => {
  setCacheHeaders(res, 10, 30);
  res.json({ ok: true, ts: Date.now() });
});

const PORT = process.env.PORT || 3000;
const kickedMap = new Map(); // classId -> Map<userId, expiresAt>
const responseCache = new Map(); // key -> { value, expiresAt }
const CLASS_LIST_CACHE_TTL_MS = 5 * 60 * 1000;// 의미 : 5분 동안 캐시 유지
const CLASS_DETAIL_CACHE_TTL_MS = 2 * 60 * 1000;
const REPLAYS_CACHE_TTL_MS = 60 * 1000;
const ASSIGNMENTS_CACHE_TTL_MS = 60 * 1000;
const AUTH_CACHE_TTL_MS = 60 * 1000;
const STORAGE_SIGN_CACHE_TTL_MS = 20 * 60 * 1000;
const KEEP_WARM_URL = String(process.env.KEEP_WARM_URL || "").trim();
const KEEP_WARM_INTERVAL_MS = Math.max(10_000, Number(process.env.KEEP_WARM_INTERVAL_MS) || 5 * 60 * 1000);
const WARMUP_CLASS_LIMIT = Number.isFinite(Number(process.env.WARMUP_CLASS_LIMIT))
  ? Math.max(0, Number(process.env.WARMUP_CLASS_LIMIT))
  : 0;
const CLASS_SUMMARY_SELECT = {
  id: true,
  title: true,
  category: true,
  description: true,
  weeklyPrice: true,
  monthlyPrice: true,
  thumbUrl: true,
  teacherId: true,
  createdAt: true,
  teacher: { select: { id: true, name: true } },
};

function buildClassDetailSelect(includeReplays) {
  if (!includeReplays) {
    return { ...CLASS_SUMMARY_SELECT, updatedAt: true };
  }
  return {
    ...CLASS_SUMMARY_SELECT,
    updatedAt: true,
    replays: {
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        classId: true,
        sessionId: true,
        title: true,
        mime: true,
        createdAt: true,
      },
    },
  };
}

function cacheGet(key) {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function cacheDel(key) {
  responseCache.delete(key);
}

function cacheDelPrefix(prefix) {
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) responseCache.delete(key);
  }
}

function parseSupabaseStorageRef(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw || raw.startsWith("data:")) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (!u.hostname.includes("supabase.co")) return null;
      const m = u.pathname.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)/);
      if (!m) return null;
      let path = m[2];
      try { path = decodeURIComponent(path); } catch (_) {}
      return { bucket: m[1], path };
    } catch (_) {
      return null;
    }
  }
  const clean = raw.replace(/^\/+/, "");
  if (!clean) return null;
  const parts = clean.split("/");
  if (parts.length >= 2) {
    if (STORAGE_BUCKET && parts[0] === STORAGE_BUCKET) {
      return { bucket: parts[0], path: parts.slice(1).join("/") };
    }
    if (STORAGE_ALLOWED_PREFIXES.has(parts[0])) {
      return { bucket: STORAGE_BUCKET, path: clean };
    }
    if (STORAGE_ALLOWED_PREFIXES.has(parts[1])) {
      return { bucket: parts[0], path: parts.slice(1).join("/") };
    }
  }
  return { bucket: STORAGE_BUCKET, path: clean };
}

function chunkArray(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

async function deleteStorageObjects(values) {
  if (!Array.isArray(values) || !values.length) return;
  const byBucket = new Map();
  values.forEach((value) => {
    const parsed = parseSupabaseStorageRef(value);
    if (!parsed?.bucket || !parsed?.path) return;
    const bucket = String(parsed.bucket || STORAGE_BUCKET).trim();
    const path = String(parsed.path || "").replace(/^\/+/, "");
    if (!bucket || !path) return;
    if (!byBucket.has(bucket)) byBucket.set(bucket, new Set());
    byBucket.get(bucket).add(path);
  });
  for (const [bucket, pathsSet] of byBucket) {
    const paths = Array.from(pathsSet);
    if (!paths.length) continue;
    for (const chunk of chunkArray(paths, 100)) {
      const { error } = await supabase.storage.from(bucket).remove(chunk);
      if (error) console.error("storage remove failed:", bucket, error);
    }
  }
}

let keepWarmTimer = null;
function startKeepWarm() {
  if (!KEEP_WARM_URL || keepWarmTimer) return;
  if (typeof fetch !== "function") return;
  const ping = () => fetch(KEEP_WARM_URL, { cache: "no-store" }).catch(() => {});
  ping();
  keepWarmTimer = setInterval(() => {
    ping();
  }, KEEP_WARM_INTERVAL_MS);
}

async function prewarmCaches() {
  try {
    const limit = WARMUP_CLASS_LIMIT > 0 ? Math.min(WARMUP_CLASS_LIMIT, 200) : 0;
    const cacheKey = `classes:list:${limit || "all"}`;
    const list = await prisma.class.findMany({
      orderBy: { createdAt: "desc" },
      ...(limit ? { take: limit } : {}),
      select: CLASS_SUMMARY_SELECT,
    });
    cacheSet(cacheKey, list, CLASS_LIST_CACHE_TTL_MS);
  } catch (err) {
    console.error("prewarm caches failed:", err);
  }
}

const authCache = new Map(); // token -> { user, expiresAt }
function authCacheGet(token) {
  const hit = authCache.get(token);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    authCache.delete(token);
    return null;
  }
  return hit.user || null;
}
function authCacheSet(token, user) {
  if (!token || !user) return;
  authCache.set(token, { user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
}
const ENSURE_USER_TTL_MS = 5 * 60 * 1000;
const ensureUserCache = new Map(); // userId -> { role, status, suspendedUntil, expiresAt }
function ensureUserCacheGet(userId) {
  if (!userId) return null;
  const hit = ensureUserCache.get(userId);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    ensureUserCache.delete(userId);
    return null;
  }
  return hit;
}
function ensureUserCacheSet(user) {
  if (!user?.id) return;
  ensureUserCache.set(user.id, {
    role: user.role,
    status: user.status,
    suspendedUntil: user.suspendedUntil || null,
    expiresAt: Date.now() + ENSURE_USER_TTL_MS,
  });
}

function setCacheHeaders(res, maxAgeSec = 30, swrSec = 120) {
  res.set("Cache-Control", `public, max-age=${maxAgeSec}, stale-while-revalidate=${swrSec}`);
}

function setHtmlCacheHeaders(res) {
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
}

function isStaticAssetPath(p) {
  return /\.(css|js|mjs|map|png|jpg|jpeg|gif|svg|webp|ico|mp4|woff2?|ttf|eot)$/i.test(p || "");
}

function withCdnUrl(url) {
  if (!CDN_BASE_URL) return url;
  if (!url) return url;
  if (/^(https?:)?\/\//i.test(url)) return url;
  if (url.startsWith("data:")) return url;
  if (!isStaticAssetPath(url)) return url;
  return `${CDN_BASE_URL}/${url.replace(/^\/+/, "")}`;
}

function rewriteHtmlForCdn(html) {
  if (!CDN_BASE_URL) return html;
  return String(html).replace(/\b(href|src)=["']([^"']+)["']/gi, (m, attr, url) => {
    return `${attr}="${withCdnUrl(url)}"`;
  });
}

function sendHtml(res, filePath) {
  setHtmlCacheHeaders(res);
  if (!CDN_BASE_URL) return res.sendFile(filePath);
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("HTML read failed", err);
      return res.status(500).send("Failed to load page.");
    }
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(rewriteHtmlForCdn(html));
  });
}

function stripTimestampPrefix(name) {
  if (!name) return "";
  return String(name).replace(/^\d{10,}-/, "") || String(name);
}

function inferFileNameFromUrl(url) {
  if (!url) return "";
  try {
    if (String(url).startsWith("data:")) {
      const nameMatch = String(url).match(/;name=([^;]+);base64,/);
      if (nameMatch && nameMatch[1]) return stripTimestampPrefix(decodeURIComponent(nameMatch[1]));
      return "attachment";
    }
    const raw = String(url);
    if (!/^https?:\/\//i.test(raw)) {
      const base = raw.split("/").pop() || "";
      return stripTimestampPrefix(decodeURIComponent(base));
    }
    const u = new URL(raw);
    const path = u.pathname.split("/").pop() || "";
    const decoded = path ? decodeURIComponent(path.split("?")[0]) : "";
    return stripTimestampPrefix(decoded);
  } catch (_) {
    return "";
  }
}

// OTP store (in-memory)
const otpStore = new Map();

// SMTP config for OTP email
const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },
};

// Helpers
function bearerToken(req) {
  const raw = req.headers.authorization || "";
  if (!raw.toLowerCase().startsWith("bearer ")) return null;
  return raw.slice(7).trim();
}

// 간단한 IP 기반 rate limit (슬라이딩 윈도우 X, 카운트 리셋)
function makeRateLimiter({ windowMs, limit }) {
  const hits = new Map(); // ip -> {count, expires}
  return (req, res, next) => {
    const ip = req.ip || "unknown";
    const now = Date.now();
    const rec = hits.get(ip);
    if (rec && rec.expires > now) {
      if (rec.count >= limit) {
        return res.status(429).json({ error: "잠시 후 다시 시도하세요. (요청이 너무 많습니다)" });
      }
      rec.count += 1;
      hits.set(ip, rec);
    } else {
      hits.set(ip, { count: 1, expires: now + windowMs });
    }
    next();
  };
}

const otpLimiter = makeRateLimiter({ windowMs: 5 * 60 * 1000, limit: 5 }); // 5분에 5회
const signupLimiter = makeRateLimiter({ windowMs: 10 * 60 * 1000, limit: 10 }); // 10분에 10회

async function requireAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "인증 토큰이 없습니다." });

  try {
    const cachedUser = authCacheGet(token);
    if (cachedUser) {
      req.user = { ...cachedUser };
      const cachedEnsure = ensureUserCacheGet(req.user.id);
      if (cachedEnsure) {
        req.user.role = cachedEnsure.role || req.user.role;
        const suspended = cachedEnsure.status === "suspended" || (cachedEnsure.suspendedUntil && new Date(cachedEnsure.suspendedUntil) > new Date());
        if (suspended) return res.status(403).json({ error: "Account suspended." });
        return next();
      }
      const ensured = await ensureUserExists(req);
      if (ensured) {
        req.user.role = ensured.role;
        ensureUserCacheSet(ensured);
        const suspended = ensured.status === "suspended" || (ensured.suspendedUntil && new Date(ensured.suspendedUntil) > new Date());
        if (suspended) return res.status(403).json({ error: "Account suspended." });
      }
      return next();
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "토큰이 유효하지 않습니다." });

    const u = data.user;
    req.user = {
      id: u.id,
      email: u.email,
      name: u.user_metadata?.name || u.email?.split("@")[0] || "user",
      role: u.user_metadata?.role === "teacher" ? "teacher" : u.user_metadata?.role === "admin" ? "admin" : "student",
    };
    authCacheSet(token, req.user);

    // Prisma User ?????? + ?????? ????/???? ????? ??????
    const cachedEnsure = ensureUserCacheGet(req.user.id);
    if (cachedEnsure) {
      req.user.role = cachedEnsure.role || req.user.role;
      const suspended = cachedEnsure.status === "suspended" || (cachedEnsure.suspendedUntil && new Date(cachedEnsure.suspendedUntil) > new Date());
      if (suspended) return res.status(403).json({ error: "Account suspended." });
      return next();
    }
    const ensured = await ensureUserExists(req);
    if (ensured) {
      // DB?????????? ????/???? ???????? ???????????? ?????
      req.user.role = ensured.role;
      ensureUserCacheSet(ensured);
      const suspended = ensured.status === "suspended" || (ensured.suspendedUntil && new Date(ensured.suspendedUntil) > new Date());
      if (suspended) return res.status(403).json({ error: "Account suspended." });
    }

    return next();
  } catch (err) {
    console.error(err);
    return res.status(401).json({ error: "인증 실패" });
  }
}

function requireTeacher(req, res, next) {
  if (req.user?.role !== "teacher") {
    return res.status(403).json({ error: "선생님 권한이 필요합니다." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "관리자 권한이 필요합니다." });
  }
  next();
}

function requireStudent(req, res, next) {
  if (req.user?.role !== "student") {
    return res.status(403).json({ error: "학생 계정에서만 가능합니다." });
  }
  next();
}

function enrollmentIsActive(en) {
  if (!en) return false;
  if (en.status !== EnrollmentStatus.active) return false;
  return new Date(en.endAt) > new Date();
}

function ensureLivekitConfig() {
  const miss = [];
  if (!process.env.LIVEKIT_URL) miss.push("LIVEKIT_URL");
  if (!process.env.LIVEKIT_API_KEY) miss.push("LIVEKIT_API_KEY");
  if (!process.env.LIVEKIT_API_SECRET) miss.push("LIVEKIT_API_SECRET");
  if (miss.length) {
    throw new Error(`LiveKit env missing: ${miss.join(", ")}`);
  }
}

function getLivekitAdminClient() {
  const LK_URL = (process.env.LIVEKIT_URL || "").trim();
  const LK_KEY = (process.env.LIVEKIT_API_KEY || "").trim();
  const LK_SECRET = (process.env.LIVEKIT_API_SECRET || "").trim();
  if (!LK_URL || !LK_KEY || !LK_SECRET) return null;

  // wss://... -> https://... 로 변환 (RoomService는 HTTP(S) 엔드포인트 사용)
  const adminUrl = LK_URL.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  return new RoomServiceClient(adminUrl, LK_KEY, LK_SECRET);
}

function markKicked(classId, userId, minutes = 5) {
  if (!classId || !userId) return;
  const until = Date.now() + minutes * 60 * 1000;
  if (!kickedMap.has(classId)) kickedMap.set(classId, new Map());
  kickedMap.get(classId).set(userId, until);
}

function isKicked(classId, userId) {
  if (!classId || !userId) return false;
  const byClass = kickedMap.get(classId);
  if (!byClass) return false;
  const until = byClass.get(userId);
  if (!until) return false;
  if (Date.now() > until) {
    byClass.delete(userId);
    return false;
  }
  return true;
}

function estimateBase64Bytes(str) {
  if (!str) return 0;
  const cleaned = String(str).split(",").pop(); // data:...;base64, 제거
  return Math.floor((cleaned.length * 3) / 4);
}

// 단순 에러 로거
function logError(err, req) {
  try {
    const line = `[${new Date().toISOString()}] ${req?.method || ""} ${req?.originalUrl || ""} :: ${err?.stack || err}\n`;
    fs.appendFile(path.join(logDir, "error.log"), line, () => {});
  } catch (_) {}
}

// RLS가 켜져 있으면 삽입이 막히므로 비활성화 (Supabase 테이블)
let replayRlsDisabled = false;
async function disableRlsIfOn() {
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "public"."Replay" DISABLE ROW LEVEL SECURITY;');
    replayRlsDisabled = true;
  } catch (e) {
    console.error("disableRlsIfOn failed:", e);
  }
}
disableRlsIfOn();

// Supabase 세션 기준으로 Prisma User 존재 보장 + 기본 active (Optimized)
async function ensureUserExists(req) {
  if (!req?.user?.id) return null;
  const userId = req.user.id;

  try {
    let user = await prisma.user.findUnique({
      where: { id: userId },
    });

    const safeEmail = req.user.email || `${userId}@lessonbay.local`;
    const derivedName = req.user.name || (safeEmail.includes("@") ? safeEmail.split("@")[0] : "사용자");
    const roleFromToken = req.user.role === "teacher" ? "teacher" : req.user.role === "admin" ? "admin" : "student";

    if (user) {
      // User found (common case). Sync name/email in the background if they differ.
      if (user.name !== derivedName || user.email !== safeEmail) {
        prisma.user.update({
          where: { id: userId },
          data: { name: derivedName, email: safeEmail },
        }).catch(err => console.error(`Async user sync failed for ${userId}:`, err));
      }
      // Return the user from the DB (source of truth for role/status).
      return user;
    }

    // User not found (rare case, first login). Create them.
    try {
      user = await prisma.user.create({
        data: {
          id: userId,
          email: safeEmail,
          name: derivedName,
          role: roleFromToken,
          status: "active",
        },
      });
      return user;
    } catch (e) {
      if (e.code === 'P2002') { // Prisma unique constraint error code
        // The user was created by a concurrent request. Read them again.
        return await prisma.user.findUnique({ where: { id: userId } });
      }
      throw e; // Re-throw other errors
    }
  } catch (e) {
    console.error(`ensureUserExists failed for user ${userId}:`, e);
    return null;
  }
}

// Supabase userId 기준으로 Prisma User 보장 (admin API에서 사용)
async function ensureUserRecordById(userId) {
  if (!userId) return null;
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) return null;
    const u = data.user;
    const meta = u.user_metadata || {};
    const email = u.email || `${u.id}@lessonbay.local`;
    const name = meta.name || (email.includes("@") ? email.split("@")[0] : "사용자");
    const role = meta.role === "teacher" ? "teacher" : meta.role === "admin" ? "admin" : "student";

    const record = await prisma.user.upsert({
      where: { id: u.id },
      update: { email, name, role },
      create: {
        id: u.id,
        email,
        name,
        role,
        status: "active",
        suspendedUntil: null,
      },
    });
    return record;
  } catch (e) {
    console.error("ensureUserRecordById failed:", e);
    return null;
  }
}

// Routes
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
    forceHttps: process.env.FORCE_HTTPS === "1",
    origins: allowOrigins,
  });
});

// Auth: service-role 가입 (이메일 확인 없이 바로 활성화)
app.post("/api/auth/signup", signupLimiter, async (req, res) => {
  try {
    const { email, password, name, role } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "이메일과 비밀번호가 필요합니다." });
    }

    const meta = {
      name: name || (email ? email.split("@")[0] : "user"),
      role: role === "teacher" ? "teacher" : "student",
    };

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // 바로 사용 가능하도록 확인 처리
      user_metadata: meta,
    });

    if (error) {
      return res.status(400).json({ error: error.message || "가입 실패" });
    }

    // Prisma에도 즉시 사용자 레코드 생성
    try {
      await prisma.user.upsert({
        where: { id: data.user.id },
        update: {
          email,
          name: meta.name,
          role: meta.role,
          status: "active",
          suspendedUntil: null,
        },
        create: {
          id: data.user.id,
          email,
          name: meta.name,
          role: meta.role,
          status: "active",
          suspendedUntil: null,
        },
      });
    } catch (e) {
      console.error("Prisma user create on signup failed:", e);
    }

    res.status(201).json({ user: data.user });
  } catch (err) {
    console.error(err);
    logError(err, req);
    res.status(500).json({ error: "회원가입 처리 중 오류" });
  }
});

// Auth: send OTP (6 digits) by email
app.post("/api/auth/send-otp", otpLimiter, async (req, res) => {
  try {
    const { email, password, name, role } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "이메일/비밀번호가 필요합니다." });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(email.toLowerCase(), {
      code,
      email,
      password,
      name: name || (email ? email.split("@")[0] : "user"),
      role: role === "teacher" ? "teacher" : "student",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    try {
      if (!SMTP_CONFIG.auth.user || !SMTP_CONFIG.auth.pass) {
        console.warn("SMTP 정보가 없어 이메일을 실제 발송하지 못했습니다.");
      } else {
        const transporter = nodemailer.createTransport(SMTP_CONFIG);
        await transporter.sendMail({
          from: process.env.SMTP_FROM || SMTP_CONFIG.auth.user,
          to: email,
          subject: "LessonBay 회원가입 인증코드",
          html: `<p>아래 6자리 인증코드를 입력하세요.</p><h2 style="letter-spacing:6px;color:#6D5EFC;">${code}</h2><p>10분간 유효합니다.</p>`,
        });
      }
    } catch (mailErr) {
      console.error("OTP 메일 발송 실패", mailErr);
      return res.status(500).json({ error: "인증 메일 발송에 실패했습니다." });
    }

    res.json({ ok: true, message: "인증코드를 이메일로 보냈습니다." });
  } catch (err) {
    console.error(err);
    logError(err, req);
    res.status(500).json({ error: "OTP 발송 실패" });
  }
});

// Logging middleware (access log handled above)

// Account delete (Supabase admin + DB 정리)
app.post("/api/account/delete", requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const myClasses = await prisma.class.findMany({
      where: { teacherId: userId },
      select: { id: true },
    });
    const classIds = myClasses.map((c) => c.id);

    await prisma.$transaction([
      prisma.chatMessage.deleteMany({ where: { OR: [{ userId }, { classId: { in: classIds } }] } }),
      prisma.attendance.deleteMany({ where: { OR: [{ userId }, { classId: { in: classIds } }] } }),
      prisma.progress.deleteMany({ where: { OR: [{ userId }, { classId: { in: classIds } }] } }),
      prisma.review.deleteMany({ where: { OR: [{ userId }, { classId: { in: classIds } }] } }),
      prisma.qnaComment.deleteMany({
        where: {
          OR: [
            { userId },
            { qna: { classId: { in: classIds } } },
          ],
        },
      }),
      prisma.qna.deleteMany({ where: { OR: [{ userId }, { classId: { in: classIds } }] } }),
      prisma.assignmentSubmission.deleteMany({
        where: {
          OR: [
            { studentId: userId },
            { assignment: { classId: { in: classIds } } },
          ],
        },
      }),
      prisma.assignment.deleteMany({ where: { classId: { in: classIds } } }),
      prisma.material.deleteMany({
        where: {
          OR: [
            { uploaderId: userId },
            { classId: { in: classIds } },
          ],
        },
      }),
      prisma.replay.deleteMany({ where: { classId: { in: classIds } } }),
      prisma.session.deleteMany({ where: { classId: { in: classIds } } }),
      prisma.enrollment.deleteMany({ where: { OR: [{ userId }, { classId: { in: classIds } }] } }),
      prisma.class.deleteMany({ where: { teacherId: userId } }),
      prisma.user.deleteMany({ where: { id: userId } }),
    ]);

    try {
      await supabase.auth.admin.deleteUser(userId);
    } catch (e) {
      console.error("supabase admin delete failed", e);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "계정 삭제 실패" });
  }
});

// Classes
app.get("/api/classes", async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 0;
    const cacheKey = `classes:list:${limit || "all"}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      setCacheHeaders(res, 300, 600);
      return res.json(cached);
    }
    const list = await prisma.class.findMany({
      orderBy: { createdAt: "desc" },
      ...(limit ? { take: limit } : {}),
      select: CLASS_SUMMARY_SELECT,
    });
    cacheSet(cacheKey, list, CLASS_LIST_CACHE_TTL_MS);
    setCacheHeaders(res, 300, 600);
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "수업 목록 조회 실패" });
  }
});

app.get("/api/classes/:id", async (req, res) => {
  try {
    const includeReplays = ["1", "true", "yes"].includes(String(req.query.includeReplays || "").toLowerCase());
    const cacheKey = `classes:detail:${req.params.id}:${includeReplays ? "replays" : "base"}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      setCacheHeaders(res, 120, 300);
      return res.json(cached);
    }
    const cls = await prisma.class.findUnique({
      where: { id: req.params.id },
      select: buildClassDetailSelect(includeReplays),
    });
    if (!cls) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });
    cacheSet(cacheKey, cls, CLASS_DETAIL_CACHE_TTL_MS);
    setCacheHeaders(res, 120, 300);
    res.json(cls);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "수업 조회 실패" });
  }
});

app.post("/api/classes", requireAuth, requireTeacher, async (req, res) => {
  try {
    // 선생님 사용자 레코드 보장 (FK 오류 방지)
    await ensureUserExists(req);
    const { title, category, description, weeklyPrice, monthlyPrice, thumbUrl } = req.body;
    if (!title) return res.status(400).json({ error: "제목이 필요합니다." });

    // Ensure teacher user exists in local DB (mirror Supabase)
    const existingTeacher = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!existingTeacher) {
      await prisma.user.create({
        data: {
          id: req.user.id,
          email: req.user.email,
          name: req.user.name || req.user.email,
          role: "teacher",
        },
      });
    }

    const cls = await prisma.class.create({
      data: {
        title,
        category,
        description,
        weeklyPrice: Number(weeklyPrice) || 0,
        monthlyPrice: Number(monthlyPrice) || 0,
        thumbUrl: thumbUrl || null,
        teacherId: req.user.id,
      },
    });
    cacheDelPrefix("classes:list");
    res.status(201).json(cls);
  } catch (err) {
    console.error("class create error:", err);
    res.status(500).json({ error: "수업 생성 실패", detail: err?.message || String(err) });
  }
});

// 수업 삭제 (선생님 본인 또는 관리자)
app.delete("/api/classes/:id", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const cls = await prisma.class.findUnique({ where: { id: classId } });
    if (!cls) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });

    const isOwner = req.user.role === "teacher" && cls.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "삭제 권한이 없습니다." });
    }

    await prisma.$transaction([
      prisma.assignmentSubmission.deleteMany({ where: { assignment: { classId } } }),
      prisma.assignment.deleteMany({ where: { classId } }),
      prisma.qnaComment.deleteMany({ where: { qna: { classId } } }),
      prisma.qna.deleteMany({ where: { classId } }),
      prisma.review.deleteMany({ where: { classId } }),
      prisma.chatMessage.deleteMany({ where: { classId } }),
      prisma.attendance.deleteMany({ where: { classId } }),
      prisma.progress.deleteMany({ where: { classId } }),
      prisma.replay.deleteMany({ where: { classId } }),
      prisma.material.deleteMany({ where: { classId } }),
      prisma.enrollment.deleteMany({ where: { classId } }),
      prisma.session.deleteMany({ where: { classId } }),
      prisma.class.delete({ where: { id: classId } }),
    ]);
    cacheDelPrefix("classes:list");
    cacheDelPrefix(`classes:detail:${classId}:`);
    cacheDelPrefix(`replays:${classId}:`);
    cacheDelPrefix(`assign:${classId}:`);
    cacheDelPrefix("enroll:");

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "수업 삭제 실패" });
  }
});


// Enrollment
function calcEndAt(planType, duration) {
  const now = new Date();
  const d = Number(duration) || 1;
  const end = new Date(now);
  if (planType === PlanType.monthly) {
    end.setDate(end.getDate() + 30 * d);
  } else {
    end.setDate(end.getDate() + 7 * d);
  }
  return end;
}

app.post("/api/classes/:id/enroll", requireAuth, requireStudent, async (req, res) => {
  try {
    await ensureUserExists(req);
    const classId = req.params.id;
    const planType = req.body.planType === "monthly" ? PlanType.monthly : PlanType.weekly;
    const duration = Number(req.body.duration) || 1;
    const paidAmount = Number(req.body.paidAmount) || 0;
    const endAt = calcEndAt(planType, duration);

    const cls = await prisma.class.findUnique({ where: { id: classId } });
    if (!cls) return res.status(404).json({ error: "????????????? ????????????." });

    const enrollment = await prisma.enrollment.upsert({
      where: { userId_classId: { userId: req.user.id, classId } },
      update: { planType, duration, paidAmount, endAt, status: EnrollmentStatus.active },
      create: {
        userId: req.user.id,
        classId,
        planType,
        duration,
        paidAmount,
        endAt,
        status: EnrollmentStatus.active,
      },
    });
    cacheDelPrefix("enroll:");
    res.status(201).json(enrollment);
  } catch (err) {
    console.error("Enroll error:", err);
    res.status(500).json({ error: "????? ????? ?????", detail: err?.message || String(err) });
  }
});

app.get("/api/me/enrollments", requireAuth, async (req, res) => {
  try {
    const cacheKey = `enroll:${req.user.id}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      setCacheHeaders(res, 20, 60);
      return res.json(cached);
    }
    const list = await prisma.enrollment.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      include: { class: { select: CLASS_SUMMARY_SELECT } }, // Optimized selection
    });
    cacheSet(cacheKey, list, 20 * 1000);
    setCacheHeaders(res, 20, 60);
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "????? ?????? ?????? ?????" });
  }
});

// Replays
app.get("/api/classes/:id/replays", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const cacheKey = `replays:${classId}:u:${req.user.id}:r:${req.user.role}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      setCacheHeaders(res, 60, 120);
      return res.json(cached);
    }
    if (!replayRlsDisabled) {
      await disableRlsIfOn();
    }

    const cls = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
    if (!cls) return res.status(404).json({ error: "????????????? ????????????." });

    if (req.user.id !== cls.teacherId) {
      const enroll = await prisma.enrollment.findUnique({
        where: { userId_classId: { userId: req.user.id, classId } },
      });
      if (!enrollmentIsActive(enroll)) {
        return res.status(403).json({ error: "????? ?????? ?????????????????????????????????????." });
      }
    }

    const listRaw = await prisma.replay.findMany({
      where: { classId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        classId: true,
        sessionId: true,
        title: true,
        mime: true,
        createdAt: true,
      },
    });
    const list = listRaw.map((r) => ({
      ...r,
      hasVod: true,
    }));
    cacheSet(cacheKey, list, REPLAYS_CACHE_TTL_MS);
    setCacheHeaders(res, 60, 120);
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "??????????? ?????? ?????" });
  }
});

app.post("/api/classes/:id/replays", requireAuth, requireTeacher, async (req, res) => {
  try {
    const classId = req.params.id;
    const { vodUrl, mime, title, sessionId } = req.body;
    if (!vodUrl) return res.status(400).json({ error: "vodUrl??????????????" });

    const cls = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
    if (!cls) return res.status(404).json({ error: "????????????? ????????????." });
    if (cls.teacherId !== req.user.id) return res.status(403).json({ error: "?????? ?????????????????? ?????????????." });

    const replay = await prisma.replay.create({
      data: { classId, sessionId: sessionId || null, vodUrl, mime: mime || null, title: title || null },
    });
    cacheDelPrefix(`replays:${classId}:`);
    cacheDelPrefix(`classes:detail:${classId}:`);
    res.status(201).json({
      ...replay,
      vodUrl: undefined,
      hasVod: true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "??????????? ????? ?????" });
  }
});

app.get("/api/replays/:id", requireAuth, async (req, res) => {
  try {
    const replayId = req.params.id;
    const replay = await prisma.replay.findUnique({ where: { id: replayId } });
    if (!replay) return res.status(404).json({ error: "???????????????????? ????????????." });

    const cls = await prisma.class.findUnique({ where: { id: replay.classId }, select: { teacherId: true } });
    if (!cls) return res.status(404).json({ error: "????????????? ????????????." });

    const isTeacher = req.user?.role === "teacher" && req.user?.id === cls.teacherId;
    if (!isTeacher) {
      const enroll = await prisma.enrollment.findUnique({
        where: { userId_classId: { userId: req.user.id, classId: replay.classId } },
      });
      if (!enrollmentIsActive(enroll)) {
        return res.status(403).json({ error: "????? ?????? ?????????????????????????????????????." });
      }
    }

    res.json({ ...replay, hasVod: !!replay.vodUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "??????????? ?????? ?????" });
  }
});

// ---------- Common helper for class access ----------
async function ensureClassAccess(req, classId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } });
  if (!cls) return { error: "????????????? ????????????.", cls: null, isTeacher: false, isActiveStudent: false };
  const isTeacher = req.user?.role === "teacher" && req.user?.id === cls.teacherId;
  let isActiveStudent = false;
  if (!isTeacher) {
    const enroll = await prisma.enrollment.findUnique({
      where: { userId_classId: { userId: req.user.id, classId } },
    });
    isActiveStudent = enrollmentIsActive(enroll);
  }
  return { cls, isTeacher, isActiveStudent, error: null };
}

// ---------- Materials ----------
app.get("/api/classes/:id/materials", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "????? ?????? ???????????????????????????????." });
    }

    const list = await prisma.material.findMany({
      where: { classId },
      orderBy: { createdAt: "desc" },
    });
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "????? ?????? ?????" });
  }
});

app.post("/api/classes/:id/materials", requireAuth, requireTeacher, async (req, res) => {
  try {
    const classId = req.params.id;
    const { title, fileUrl, mime } = req.body;
    if (!title || !fileUrl) return res.status(400).json({ error: "title???fileUrl??????????????" });

    const cls = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
    if (!cls) return res.status(404).json({ error: "????????????? ????????????." });
    if (cls.teacherId !== req.user.id) return res.status(403).json({ error: "?????? ?????????? ????????????????????." });

    const m = await prisma.material.create({
      data: {
        classId,
        title,
        fileUrl,
        mime: mime || null,
        uploaderId: req.user.id,
      },
    });
    res.status(201).json(m);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "????? ????????????" });
  }
});

// ---------- Assignments ----------
// Refactored: Returns a list of assignments with submission counts for teachers,
// or with the student's own submission for students.
app.get("/api/classes/:id/assignments", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const cacheKey = `assign:${classId}:u:${req.user.id}:r:${req.user.role}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      setCacheHeaders(res, 30, 60);
      return res.json(cached);
    }

    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "수강 중인 학생/선생님만 접근 가능합니다." });
    }

    let includeClause = {};
    if (access.isTeacher) {
      // Teachers get a count of submissions
      includeClause = {
        include: {
          _count: {
            select: { submissions: true },
          },
        },
      };
    } else {
      // Students get their own submission for each assignment
      includeClause = {
        include: {
          submissions: {
            where: { studentId: req.user.id },
          },
        },
      };
    }

    const assignments = await prisma.assignment.findMany({
      where: { classId },
      orderBy: { createdAt: "desc" },
      ...includeClause,
    });

    // Process the list to a consistent format
    const list = assignments.map((a) => {
      const submissionCount = a._count?.submissions ?? 0;
      const mySubmission = a.submissions?.[0] || null;
      return {
        ...a,
        // For students, submissions will contain their single submission. For teachers, it's an empty array.
        submissions: mySubmission ? [mySubmission] : [],
        submissionCount: submissionCount, // Useful for teachers
        _count: undefined, // clean up
      };
    });

    cacheSet(cacheKey, list, ASSIGNMENTS_CACHE_TTL_MS);
    setCacheHeaders(res, 30, 60);
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "과제 목록 조회 실패" });
  }
});

// New endpoint for fetching submissions for a single assignment (for teachers, paginated)
app.get("/api/assignments/:id/submissions", requireAuth, requireTeacher, async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: { class: { select: { teacherId: true } } },
    });

    if (!assignment) {
      return res.status(404).json({ error: "과제를 찾을 수 없습니다." });
    }
    if (assignment.class.teacherId !== req.user.id) {
      return res.status(403).json({ error: "본인 수업의 과제만 조회할 수 있습니다." });
    }

    const [submissions, total] = await prisma.$transaction([
      prisma.assignmentSubmission.findMany({
        where: { assignmentId },
        select: {
          id: true,
          assignmentId: true,
          studentId: true,
          content: true,
          score: true,
          feedback: true,
          submittedAt: true,
          gradedAt: true,
          fileUrl: true,
          student: { select: { id: true, name: true, email: true } },
        },
        orderBy: { submittedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.assignmentSubmission.count({ where: { assignmentId } })
    ]);

    const list = submissions.map((s) => ({
      ...s,
      studentName: s.student?.name || null,
      studentEmail: s.student?.email || null,
      hasFile: !!s.fileUrl,
      fileName: inferFileNameFromUrl(s.fileUrl || ""),
      fileUrl: undefined, // Do not expose fileUrl directly in the list
      student: undefined,
    }));

    res.json({
      data: list,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "제출물 조회 실패" });
  }
});

app.post("/api/classes/:id/assignments", requireAuth, requireTeacher, async (req, res) => {
  try {
    const classId = req.params.id;
    const { title, description, dueAt } = req.body;
    if (!title) return res.status(400).json({ error: "title??????????????" });

    const cls = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
    if (!cls) return res.status(404).json({ error: "????????????? ????????????." });
    if (cls.teacherId !== req.user.id) return res.status(403).json({ error: "?????? ?????????? ????? ?????????????." });

    const a = await prisma.assignment.create({
      data: {
        classId,
        title,
        description: description || null,
        dueAt: dueAt ? new Date(dueAt) : null,
      },
    });
    cacheDelPrefix(`assign:${classId}:`);
    res.status(201).json(a);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "?????? ????? ?????" });
  }
});

// Health Check Endpoint (lightweight)
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Assignment 수정 (선생님만)
app.put("/api/assignments/:id", requireAuth, requireTeacher, async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const { title, description, dueAt } = req.body || {};
    if (!title) return res.status(400).json({ error: "title이 필요합니다." });

    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: { select: { teacherId: true } } },
    });
    if (!assignment) return res.status(404).json({ error: "과제를 찾을 수 없습니다." });
    if (assignment.class.teacherId !== req.user.id) return res.status(403).json({ error: "본인 수업의 과제만 수정 가능합니다." });

    const updated = await prisma.assignment.update({
      where: { id: assignmentId },
      data: {
        title,
        description: description || null,
        dueAt: dueAt ? new Date(dueAt) : null,
      },
    });
    cacheDelPrefix(`assign:${assignment.classId}:`);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "과제 수정 실패" });
  }
});

// Assignment 삭제 (선생님만)
app.delete("/api/assignments/:id", requireAuth, requireTeacher, async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: { select: { teacherId: true } } },
    });
    if (!assignment) return res.status(404).json({ error: "과제를 찾을 수 없습니다." });
    if (assignment.class.teacherId !== req.user.id) return res.status(403).json({ error: "본인 수업의 과제만 삭제 가능합니다." });

    await prisma.assignmentSubmission.deleteMany({ where: { assignmentId } });
    await prisma.assignment.delete({ where: { id: assignmentId } });
    cacheDelPrefix(`assign:${assignment.classId}:`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "과제 삭제 실패" });
  }
});

app.post("/api/assignments/:id/submissions", requireAuth, requireStudent, async (req, res) => {
  try {
    await ensureUserExists(req);
    const assignmentId = req.params.id;
    const { content, fileUrl } = req.body;
    const sizeBytes = estimateBase64Bytes(fileUrl);
    const maxBytes = 50 * 1024 * 1024;
    if (sizeBytes > maxBytes) return res.status(400).json({ error: "첨부파일이 너무 큽니다. 50MB 이하로 올려주세요." });

    const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } });
    if (!assignment) return res.status(404).json({ error: "과제를 찾을 수 없습니다." });

    const access = await ensureClassAccess(req, assignment.classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isActiveStudent) return res.status(403).json({ error: "수강 중인 학생만 제출할 수 있습니다." });

    const existing = await prisma.assignmentSubmission.findFirst({
      where: { assignmentId, studentId: req.user.id },
    });

    let sub = null;
    if (existing) {
      sub = await prisma.assignmentSubmission.update({
        where: { id: existing.id },
        data: {
          content: content || null,
          fileUrl: fileUrl || null,
          submittedAt: new Date(),
        },
      });
    } else {
      sub = await prisma.assignmentSubmission.create({
        data: {
          assignmentId,
          studentId: req.user.id,
          content: content || null,
          fileUrl: fileUrl || null,
        },
      });
    }
    cacheDelPrefix(`assign:${assignment.classId}:`);
    res.status(201).json(sub);
  } catch (err) {
    console.error("Assignment submit error:", err);
    res.status(500).json({ error: "과제 제출 실패", detail: err?.message || String(err) });
  }
});

// Assignment grading (teacher/admin)
app.post("/api/assignments/:assignmentId/submissions/:submissionId/grade", requireAuth, requireTeacher, async (req, res) => {
  try {
    const { assignmentId, submissionId } = req.params;
    const { score, feedback } = req.body || {};

    // 안전을 위해 class 존재만 확인하고, teacher/admin이면 허용 (소유자 검증이 빈 teacherId로 막히는 케이스 방지)
    const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } });
    if (!assignment) return res.status(404).json({ error: "과제를 찾을 수 없습니다." });

    await prisma.assignmentSubmission.update({
      where: { id: submissionId },
      data: {
        score: score === null || score === undefined ? null : Number(score),
        feedback: feedback || null,
        gradedAt: new Date(),
      },
    });
    cacheDelPrefix(`assign:${assignment.classId}:`);
    // 파일(base64) 등 대용량을 보내지 않고 최소 정보만 반환
    res.json({
      id: submissionId,
      assignmentId,
      score: score === null || score === undefined ? null : Number(score),
      feedback: feedback || null,
      gradedAt: new Date(),
    });
  } catch (err) {
    console.error("Assignment grade error:", err);
    res.status(500).json({ error: "과제 채점 실패", detail: err?.message || String(err) });
  }
});

// Submission file fetch (on-demand)
app.get("/api/submissions/:id/file", requireAuth, async (req, res) => {
  try {
    const sub = await prisma.assignmentSubmission.findUnique({
      where: { id: req.params.id },
      include: {
        assignment: {
          select: {
            classId: true,
            class: { select: { teacherId: true, teacher: { select: { id: true, name: true } } } },
          },
        },
      },
    });
    if (!sub) return res.status(404).json({ error: "제출을 찾을 수 없습니다." });

    const access = await ensureClassAccess(req, sub.assignment.classId);
    if (access.error) return res.status(404).json({ error: access.error });

    const isOwner = sub.studentId === req.user.id;
    const teacherId = sub.assignment.class?.teacherId || sub.assignment.class?.teacher?.id || "";
    const teacherName = sub.assignment.class?.teacher?.name || "";
    const isTeacher = access.isTeacher || teacherId === req.user.id || (!!teacherName && teacherName === req.user.name);
    if (!(isOwner || isTeacher || access.isAdmin)) {
      return res.status(403).json({ error: "조회 권한이 없습니다." });
    }

    res.json({ fileUrl: sub.fileUrl || null, fileName: sub.fileName || inferFileNameFromUrl(sub.fileUrl || "") || null });
  } catch (err) {
    console.error("Submission file fetch error:", err);
    res.status(500).json({ error: "첨부 조회 실패", detail: err?.message || String(err) });
  }
});

// Storage signed URL (server-side signing for private bucket)
app.get("/api/storage/sign", async (req, res) => {
  try {
    const bucket = String(req.query.bucket || "LessonBay");
    const rawPath = String(req.query.path || "");
    const download = req.query.download ? String(req.query.download) : "";
    if (!rawPath) return res.status(400).json({ error: "path is required" });

    const cleanPath = rawPath.replace(/^\/+/, "");
    const prefix = cleanPath.split("/")[0] || "";
    const allowedPrefixes = new Set(["class-thumbs", "materials", "replays", "uploads"]);
    if (!allowedPrefixes.has(prefix)) {
      return res.status(400).json({ error: "path not allowed" });
    }
    const cacheKey = `storage:sign:${bucket}:${cleanPath}:${download || ""}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      setCacheHeaders(res, 1200, 3600);
      return res.json(cached);
    }
    const opts = download ? { download } : undefined;
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(cleanPath, 60 * 60 * 24, opts);
    if (error) {
      return res.status(400).json({ error: "sign failed", detail: error.message || String(error) });
    }
    const payload = { signedUrl: data?.signedUrl || null };
    cacheSet(cacheKey, payload, STORAGE_SIGN_CACHE_TTL_MS);
    setCacheHeaders(res, 1200, 3600);
    res.json(payload);
  } catch (err) {
    console.error("storage sign error:", err);
    res.status(500).json({ error: "storage sign failed" });
  }
});

// ---------- Reviews ----------
app.get("/api/classes/:id/reviews", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "수강 중인 학생만 리뷰를 볼 수 있습니다." });
    }

    const listRaw = await prisma.review.findMany({
      where: { classId },
      orderBy: { createdAt: "desc" },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    const list = listRaw.map(r => ({
      ...r,
      userName: r.user?.name || null,
      userEmail: r.user?.email || null,
    }));
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "리뷰 조회 실패" });
  }
});

app.post("/api/classes/:id/reviews", requireAuth, requireStudent, async (req, res) => {
  try {
    await ensureUserExists(req);
    const classId = req.params.id;
    const { rating, comment } = req.body;
    if (!rating) return res.status(400).json({ error: "rating이 필요합니다." });

    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isActiveStudent) return res.status(403).json({ error: "수강 중인 학생만 리뷰를 남길 수 있습니다." });

    const r = await prisma.review.upsert({
      where: { classId_userId: { classId, userId: req.user.id } },
      update: { rating: Number(rating), comment: comment || null },
      create: { classId, userId: req.user.id, rating: Number(rating), comment: comment || null },
    });
    res.status(201).json(r);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "리뷰 저장 실패" });
  }
});

// ---------- Q&A ----------
// Refactored: Returns a list of Q&A posts with a count of replies.
app.get("/api/classes/:id/qna", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "수강 중인 학생만 Q&A를 볼 수 있습니다." });
    }

    const qnaPosts = await prisma.qna.findMany({
      where: { classId },
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
        _count: {
          select: { comments: true },
        },
      },
    });

    const list = qnaPosts.map(q => ({
      ...q,
      userName: q.user?.name || null,
      userEmail: q.user?.email || null,
      userRole: q.user?.role || null,
      user: undefined, // clean up
      repliesCount: q._count?.comments ?? 0,
      _count: undefined, // clean up
    }));

    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Q&A 조회 실패" });
  }
});

app.post("/api/classes/:id/qna", requireAuth, async (req, res) => {
  try {
    await ensureUserExists(req);
    const classId = req.params.id;
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "question이 필요합니다." });

    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "수강 중인 학생만 질문을 올릴 수 있습니다." });
    }

    const q = await prisma.qna.create({
      data: { classId, userId: req.user.id, question },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });
    res.status(201).json({
      ...q,
      userName: q.user?.name || null,
      userEmail: q.user?.email || null,
      userRole: q.user?.role || null,
      replies: [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Q&A 저장 실패" });
  }
});

// New endpoint for fetching comments for a single Q&A post
app.get("/api/qna/:id/comments", requireAuth, async (req, res) => {
  try {
    const qnaId = req.params.id;
    const qnaPost = await prisma.qna.findUnique({
      where: { id: qnaId },
      select: { classId: true },
    });

    if (!qnaPost) {
      return res.status(404).json({ error: "Q&A 게시글을 찾을 수 없습니다." });
    }

    const access = await ensureClassAccess(req, qnaPost.classId);
    if (access.error) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "수강생 또는 선생님만 댓글을 볼 수 있습니다." });
    }

    const commentsRaw = await prisma.qnaComment.findMany({
      where: { qnaId },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });

    const comments = commentsRaw.map(c => ({
      ...c,
      userName: c.user?.name || null,
      userEmail: c.user?.email || null,
      userRole: c.user?.role || null,
      user: undefined, // clean up
    }));

    res.json(comments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "댓글 조회 실패" });
  }
});

app.post("/api/qna/:id/comments", requireAuth, async (req, res) => {
  try {
    await ensureUserExists(req);
    const qnaId = req.params.id;
    const { comment } = req.body;
    if (!comment) return res.status(400).json({ error: "comment가 필요합니다." });

    const q = await prisma.qna.findUnique({ where: { id: qnaId } });
    if (!q) return res.status(404).json({ error: "질문을 찾을 수 없습니다." });

    const access = await ensureClassAccess(req, q.classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "수강 중인 학생/선생님만 댓글을 달 수 있습니다." });
    }

    const c = await prisma.qnaComment.create({
      data: { qnaId, userId: req.user.id, comment },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });
    res.status(201).json({
      ...c,
      userName: c.user?.name || null,
      userEmail: c.user?.email || null,
      userRole: c.user?.role || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "댓글 저장 실패" });
  }
});


// ---------- Chat ----------
app.get("/api/classes/:id/chat", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "?? ?? ??? ??? ? ? ????." });
    }

    const listRaw = await prisma.chatMessage.findMany({
      where: { classId },
      orderBy: { sentAt: "asc" },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });
    const list = listRaw.map((m) => ({
      ...m,
      userName: m.user?.name || null,
      userEmail: m.user?.email || null,
      userRole: m.user?.role || null,
      user: undefined,
    }));
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "?? ?? ??" });
  }
});

app.post("/api/classes/:id/chat", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: "message? ?????." });

    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "?? ?? ??? ??? ?? ? ????." });
    }

    const m = await prisma.chatMessage.create({
      data: { classId, userId: req.user.id, message },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });
    res.status(201).json({
      ...m,
      userName: m.user?.name || null,
      userEmail: m.user?.email || null,
      userRole: m.user?.role || null,
      user: undefined,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "?? ?? ??" });
  }
});

// ---------- Attendance ----------
app.get("/api/classes/:id/attendance", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "?? ?? ??? ??? ? ? ????." });
    }

    const list = await prisma.attendance.findMany({
      where: { classId },
      orderBy: { joinedAt: "asc" },
    });
    const filtered = access.isTeacher ? list : list.filter((a) => a.userId === req.user.id);
    res.json(filtered);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "?? ?? ??" });
  }
});

app.post("/api/classes/:id/attendance", requireAuth, requireStudent, async (req, res) => {
  try {
    const classId = req.params.id;
    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isActiveStudent) return res.status(403).json({ error: "?? ?? ??? ??? ??? ? ????." });

    const a = await prisma.attendance.create({
      data: { classId, userId: req.user.id },
    });
    res.status(201).json(a);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "?? ?? ??" });
  }
});

// Admin: suspend user
app.post("/api/admin/users/:id/suspend", requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = req.params.id;
    const minutes = Number(req.body?.minutes || req.query?.minutes || 0);
    const until = minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000) : null;
    let ensured = await prisma.user.findUnique({ where: { id: targetId } });
    if (!ensured) ensured = await ensureUserRecordById(targetId);

    const createdFallback = {
      id: targetId,
      email: `${targetId}@lessonbay.local`,
      name: "user",
      role: "student",
      status: "active",
      suspendedUntil: null,
    };
    await prisma.user.upsert({
      where: { id: targetId },
      create: createdFallback,
      update: { status: "suspended", suspendedUntil: until },
    });
    res.json({ ok: true, status: "suspended", suspendedUntil: until });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "suspend failed" });
  }
});

app.post("/api/admin/users/:id/unsuspend", requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = req.params.id;
    let ensured = await prisma.user.findUnique({ where: { id: targetId } });
    if (!ensured) ensured = await ensureUserRecordById(targetId);

    const createdFallback = {
      id: targetId,
      email: `${targetId}@lessonbay.local`,
      name: "사용자",
      role: "student",
      status: "active",
      suspendedUntil: null,
    };
    await prisma.user.upsert({
      where: { id: targetId },
      create: createdFallback,
      update: { status: "active", suspendedUntil: null },
    });
    res.json({ ok: true, status: "active" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "정지 해제 실패" });
  }
});

// Admin: 사용자 목록
app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    // Supabase auth 기준 사용자 목록 조회
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;

    const authUsers = data?.users || [];
    const ids = authUsers.map((u) => u.id);

    // Prisma User 테이블의 상태/정지정보 매핑
    const localUsers = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, suspendedUntil: true },
    });
    const localMap = Object.fromEntries(localUsers.map((u) => [u.id, u]));

    const list = authUsers.map((u) => {
      const meta = u.user_metadata || {};
      const local = localMap[u.id] || {};
      return {
        id: u.id,
        email: u.email,
        name: meta.name || (u.email ? u.email.split("@")[0] : "사용자"),
        role: meta.role || "student",
        status: local.status || "active",
        suspendedUntil: local.suspendedUntil || null,
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at,
      };
    });

    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "사용자 목록 조회 실패" });
  }
});

// LiveKit 토큰 발급 (선생님: 본인 수업만, 학생: 수강중인 수업만)
app.post("/api/live/token", requireAuth, async (req, res) => {
  try {
    ensureLivekitConfig();
    const LK_URL = (process.env.LIVEKIT_URL || "").trim();
    const LK_KEY = (process.env.LIVEKIT_API_KEY || "").trim();
    const LK_SECRET = (process.env.LIVEKIT_API_SECRET || "").trim();
    const classId = req.body.classId || req.query.classId;
    if (!classId) return res.status(400).json({ error: "classId가 필요합니다." });

    if (isKicked(classId, req.user.id)) {
      return res.status(403).json({ error: "강퇴된 사용자입니다. 잠시 후 다시 시도하세요." });
    }

    const cls = await prisma.class.findUnique({ where: { id: classId }, select: { id: true, teacherId: true, title: true } });
    if (!cls) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });

    const isTeacher = req.user.role === "teacher" && req.user.id === cls.teacherId;
    if (!isTeacher) {
      const enroll = await prisma.enrollment.findUnique({
        where: { userId_classId: { userId: req.user.id, classId } },
      });
      if (!enrollmentIsActive(enroll)) {
        return res.status(403).json({ error: "수강 중인 학생만 라이브에 입장할 수 있습니다." });
      }
    }

    const token = new AccessToken(LK_KEY, LK_SECRET, {
      identity: req.user.id,
      name: req.user.name || req.user.email || "user",
    });
    token.addGrant({
      room: classId,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    const jwt = await token.toJwt();

    res.json({
      url: LK_URL,
      token: jwt,
      room: classId,
      title: cls.title,
    });
  } catch (err) {
    console.error("LiveKit token error:", err);
    res.status(500).json({ error: "LiveKit 토큰 발급 실패", detail: err?.message || String(err) });
  }
});

// Live: 강퇴 (선생님 본인 수업 또는 관리자)
app.post("/api/live/kick", requireAuth, async (req, res) => {
  try {
    ensureLivekitConfig();
    const { classId, userId, banMinutes } = req.body || {};
    if (!classId || !userId) return res.status(400).json({ error: "classId와 userId가 필요합니다." });

    const cls = await prisma.class.findUnique({ where: { id: classId }, select: { id: true, teacherId: true, title: true } });
    if (!cls) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });

    const isOwner = req.user.role === "teacher" && req.user.id === cls.teacherId;
    const isAdmin = req.user.role === "admin";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "강퇴 권한이 없습니다." });
    }

    const client = getLivekitAdminClient();
    if (!client) throw new Error("LiveKit 관리 클라이언트 생성 실패");

    const minutes = Math.max(1, Math.min(1440, Number(banMinutes) || 5)); // 최소 1분, 최대 1일(1440분)

    await client.removeParticipant(classId, userId);
    markKicked(classId, userId, minutes);
    res.json({ ok: true, bannedMinutes: minutes });
  } catch (err) {
    console.error("LiveKit kick error:", err);
    logError(err, req);
    res.status(500).json({ error: "강퇴 실패", detail: err?.message || String(err) });
  }
});

// Replay 삭제 (teacher)
app.delete("/api/replays/:id", requireAuth, requireTeacher, async (req, res) => {
  try {
    const replayId = req.params.id;
    const replay = await prisma.replay.findUnique({ where: { id: replayId } });
    if (!replay) return res.status(404).json({ error: "다시보기를 찾을 수 없습니다." });

    const cls = await prisma.class.findUnique({ where: { id: replay.classId }, select: { teacherId: true } });
    if (!cls || cls.teacherId !== req.user.id) {
      return res.status(403).json({ error: "본인 수업의 다시보기만 삭제할 수 있습니다." });
    }

    await prisma.replay.delete({ where: { id: replayId } });
    cacheDelPrefix(`replays:${replay.classId}:`);
    cacheDelPrefix(`classes:detail:${replay.classId}:`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "다시보기 삭제 실패" });
  }
});

// Static frontend (online_class_platform_v4)
const clientDir = path.join(__dirname, "..", "online_class_platform_v4");

// Avoid favicon 404 noise in console
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Serve root and static assets
app.get("/", (_req, res) => sendHtml(res, path.join(clientDir, "index.html")));
app.use(express.static(clientDir));

// Slug-style detail URLs (support /class_detail/:id, /live_class/:id, /classes/:id)
app.get(["/class_detail/:id", "/live_class/:id", "/classes/:id"], (req, res, next) => {
  const base = (req.path.split("/")[1] || "").toLowerCase();
  const file = path.join(clientDir, `${base}.html`);
  if (fs.existsSync(file)) {
    return sendHtml(res, file);
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  setTimeout(() => {
    startKeepWarm();
    prewarmCaches();
  }, 1000);
});

module.exports = app;
