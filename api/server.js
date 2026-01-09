require("dotenv").config();
const express = require("express");
const cors = require("cors");
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

const PORT = process.env.PORT || 3000;
const kickedMap = new Map(); // classId -> Map<userId, expiresAt>

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
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "토큰이 유효하지 않습니다." });

    const u = data.user;
    req.user = {
      id: u.id,
      email: u.email,
      name: u.user_metadata?.name || u.email?.split("@")[0] || "user",
      role: u.user_metadata?.role === "teacher" ? "teacher" : u.user_metadata?.role === "admin" ? "admin" : "student",
    };

    // Prisma User 보장 + 최신 역할/정지 상태 반영
    const ensured = await ensureUserExists(req);
    if (ensured) {
      // DB에 더 최신 역할/정지 상태가 있으면 이를 우선
      req.user.role = ensured.role;
      const suspended = ensured.status === "suspended" || (ensured.suspendedUntil && new Date(ensured.suspendedUntil) > new Date());
      if (suspended) return res.status(403).json({ error: "정지된 계정입니다. 관리자에게 문의하세요." });
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
async function disableRlsIfOn() {
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "public"."Replay" DISABLE ROW LEVEL SECURITY;');
  } catch (e) {
    console.error("disableRlsIfOn failed:", e);
  }
}
disableRlsIfOn();

// Supabase 세션 기준으로 Prisma User 존재 보장 + 기본 active
async function ensureUserExists(req) {
  if (!req?.user?.id) return null;
  const safeEmail = req.user.email || `${req.user.id}@lessonbay.local`;
  const derivedName = req.user.name || (safeEmail.includes("@") ? safeEmail.split("@")[0] : "사용자");
  const payload = {
    id: req.user.id,
    email: safeEmail,
    name: derivedName,
    role: req.user.role === "teacher" ? "teacher" : req.user.role === "admin" ? "admin" : "student",
    status: "active",
    suspendedUntil: null,
  };
  try {
    const u = await prisma.user.upsert({
      where: { id: payload.id },
      update: { email: payload.email, name: payload.name, role: payload.role },
      create: payload,
    });
    return u;
  } catch (e) {
    console.error("ensureUserExists failed:", e);
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

// Auth: verify OTP and create user
app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ error: "이메일/코드를 입력하세요." });

    const entry = otpStore.get(email.toLowerCase());
    if (!entry) return res.status(400).json({ error: "인증코드를 먼저 요청하세요." });
    if (String(entry.code) !== String(code).trim()) return res.status(400).json({ error: "인증코드가 일치하지 않습니다." });
    if (Date.now() > entry.expiresAt) return res.status(400).json({ error: "인증코드가 만료되었습니다. 다시 요청하세요." });

    const meta = { name: entry.name, role: entry.role };
    const { data, error } = await supabase.auth.admin.createUser({
      email: entry.email,
      password: entry.password,
      email_confirm: true,
      user_metadata: meta,
    });
    if (error) return res.status(400).json({ error: error.message || "계정 생성 실패" });

    otpStore.delete(email.toLowerCase());
    res.json({ ok: true, user: data.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OTP 검증 실패" });
  }
});

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
app.get("/api/classes", async (_req, res) => {
  try {
    const list = await prisma.class.findMany({
      orderBy: { createdAt: "desc" },
      include: { teacher: true },
    });
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "수업 목록 조회 실패" });
  }
});

app.get("/api/classes/:id", async (req, res) => {
  try {
    const cls = await prisma.class.findUnique({
      where: { id: req.params.id },
      include: {
        teacher: true,
        replays: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!cls) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });
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
    if (!cls) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });

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

    res.status(201).json(enrollment);
  } catch (err) {
    console.error("Enroll error:", err);
    res.status(500).json({ error: "수강 등록 실패", detail: err?.message || String(err) });
  }
});

app.get("/api/me/enrollments", requireAuth, async (req, res) => {
  try {
    const list = await prisma.enrollment.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      include: { class: true },
    });
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "수강 목록 조회 실패" });
  }
});

// Replays
app.get("/api/classes/:id/replays", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    // RLS가 켜져 있으면 삽입이 막히므로 비활성화 시도
    try { await prisma.$executeRawUnsafe('ALTER TABLE "public"."Replay" DISABLE ROW LEVEL SECURITY;'); } catch (_) {}

    const cls = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
    if (!cls) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });

    if (req.user.id !== cls.teacherId) {
      const enroll = await prisma.enrollment.findUnique({
        where: { userId_classId: { userId: req.user.id, classId } },
      });
      if (!enrollmentIsActive(enroll)) {
        return res.status(403).json({ error: "수강 중인 학생만 다시보기를 볼 수 있습니다." });
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
      hasVod: true, // vodUrl 컬럼이 필수라 재생 가능 여부를 빠르게 알 수 있음
    }));
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "다시보기 조회 실패" });
  }
});

app.post("/api/classes/:id/replays", requireAuth, requireTeacher, async (req, res) => {
  try {
    const classId = req.params.id;
    const { vodUrl, mime, title, sessionId } = req.body;
    if (!vodUrl) return res.status(400).json({ error: "vodUrl이 필요합니다." });
    const sizeBytes = estimateBase64Bytes(vodUrl);
    const maxBytes = 50 * 1024 * 1024; // Supabase Storage Free 50MB 한도 기준
    if (sizeBytes > maxBytes) return res.status(400).json({ error: "영상이 너무 큽니다. 50MB 이하로 올려주세요. (대용량은 스토리지 직접 업로드 방식 권장)" });

    const cls = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
    if (!cls) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });
    if (cls.teacherId !== req.user.id) return res.status(403).json({ error: "본인 수업에서만 등록 가능합니다." });

    const replay = await prisma.replay.create({
      data: { classId, sessionId: sessionId || null, vodUrl, mime: mime || null, title: title || null },
    });
    res.status(201).json({
      ...replay,
      vodUrl: undefined, // 목록 응답에서는 대용량 데이터 제외
      hasVod: true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "다시보기 등록 실패" });
  }
});

// Replay 단건 조회(재생 시에만 대용량 vodUrl 내려줌)
app.get("/api/replays/:id", requireAuth, async (req, res) => {
  try {
    const replayId = req.params.id;
    const replay = await prisma.replay.findUnique({ where: { id: replayId } });
    if (!replay) return res.status(404).json({ error: "다시보기를 찾을 수 없습니다." });

    const cls = await prisma.class.findUnique({ where: { id: replay.classId }, select: { teacherId: true } });
    if (!cls) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });

    const isTeacher = req.user?.role === "teacher" && req.user?.id === cls.teacherId;
    if (!isTeacher) {
      const enroll = await prisma.enrollment.findUnique({
        where: { userId_classId: { userId: req.user.id, classId: replay.classId } },
      });
      if (!enrollmentIsActive(enroll)) {
        return res.status(403).json({ error: "수강 중인 학생만 다시보기를 볼 수 있습니다." });
      }
    }

    res.json({ ...replay, hasVod: !!replay.vodUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "다시보기 조회 실패" });
  }
});

// ---------- Common helper for class access ----------
async function ensureClassAccess(req, classId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } });
  if (!cls) return { error: "수업을 찾을 수 없습니다.", cls: null, isTeacher: false, isActiveStudent: false };
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
      return res.status(403).json({ error: "수강 중인 학생만 자료를 볼 수 있습니다." });
    }

    const list = await prisma.material.findMany({
      where: { classId },
      orderBy: { createdAt: "desc" },
    });
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "자료 조회 실패" });
  }
});

app.post("/api/classes/:id/materials", requireAuth, requireTeacher, async (req, res) => {
  try {
    const classId = req.params.id;
    const { title, fileUrl, mime } = req.body;
    if (!title || !fileUrl) return res.status(400).json({ error: "title과 fileUrl이 필요합니다." });
    const sizeBytes = estimateBase64Bytes(fileUrl);
    const maxBytes = 50 * 1024 * 1024; // Free 플랜 한도
    if (sizeBytes > maxBytes) return res.status(400).json({ error: "파일이 너무 큽니다. 50MB 이하로 올려주세요." });

    const cls = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
    if (!cls) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });
    if (cls.teacherId !== req.user.id) return res.status(403).json({ error: "본인 수업에만 업로드 가능합니다." });

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
    res.status(500).json({ error: "자료 업로드 실패" });
  }
});

// ---------- Assignments ----------
app.get("/api/classes/:id/assignments", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "수강 중인 학생만 과제를 볼 수 있습니다." });
    }

    const includeSubs = access.isTeacher
      ? {
          include: {
            submissions: {
              include: { student: { select: { id: true, name: true, email: true } } },
              orderBy: { submittedAt: "desc" },
            },
          },
        }
      : { include: { submissions: { where: { studentId: req.user.id } } } };

    const list = await prisma.assignment.findMany({
      where: { classId },
      orderBy: { createdAt: "desc" },
      ...includeSubs,
    });
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "과제 조회 실패" });
  }
});

app.post("/api/classes/:id/assignments", requireAuth, requireTeacher, async (req, res) => {
  try {
    const classId = req.params.id;
    const { title, description, dueAt } = req.body;
    if (!title) return res.status(400).json({ error: "title이 필요합니다." });

    const cls = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
    if (!cls) return res.status(404).json({ error: "수업을 찾을 수 없습니다." });
    if (cls.teacherId !== req.user.id) return res.status(403).json({ error: "본인 수업에만 생성 가능합니다." });

    const a = await prisma.assignment.create({
      data: {
        classId,
        title,
        description: description || null,
        dueAt: dueAt ? new Date(dueAt) : null,
      },
    });
    res.status(201).json(a);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "과제 생성 실패" });
  }
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

    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        class: {
          select: {
            teacherId: true,
            title: true,
            category: true,
            teacher: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
    if (!assignment) return res.status(404).json({ error: "과제를 찾을 수 없습니다." });
    const teacherId = assignment.class.teacherId || assignment.class.teacher?.id || "";
    const teacherName = assignment.class.teacher?.name || "";
    const isOwner =
      req.user.role === "admin" ||
      (teacherId && teacherId === req.user.id) ||
      (!teacherId && teacherName && teacherName === req.user.name);
    if (!isOwner) return res.status(403).json({ error: "본인 수업의 과제만 채점할 수 있습니다." });

    const updated = await prisma.assignmentSubmission.update({
      where: { id: submissionId },
      data: {
        score: score === null || score === undefined ? null : Number(score),
        feedback: feedback || null,
        gradedAt: new Date(),
      },
    });
    res.json(updated);
  } catch (err) {
    console.error("Assignment grade error:", err);
    res.status(500).json({ error: "과제 채점 실패", detail: err?.message || String(err) });
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
app.get("/api/classes/:id/qna", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "수강 중인 학생만 Q&A를 볼 수 있습니다." });
    }

    const listRaw = await prisma.qna.findMany({
      where: { classId },
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
        comments: {
          orderBy: { createdAt: "asc" },
          include: { user: { select: { id: true, name: true, email: true, role: true } } },
        },
      },
    });
    const list = listRaw.map(q => ({
      ...q,
      userName: q.user?.name || null,
      userEmail: q.user?.email || null,
      userRole: q.user?.role || null,
      replies: (q.comments || []).map(c => ({
        ...c,
        userName: c.user?.name || null,
        userEmail: c.user?.email || null,
        userRole: c.user?.role || null,
      })),
      comments: undefined, // replies로 별칭
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
      return res.status(403).json({ error: "수강 중인 학생만 채팅을 볼 수 있습니다." });
    }

    const listRaw = await prisma.chatMessage.findMany({
      where: { classId },
      orderBy: { sentAt: "asc" },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    const list = listRaw.map(m => ({
      ...m,
      userName: m.user?.name || null,
      userEmail: m.user?.email || null,
    }));
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "채팅 조회 실패" });
  }
});

app.post("/api/classes/:id/chat", requireAuth, async (req, res) => {
  try {
    await ensureUserExists(req);
    const classId = req.params.id;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message가 필요합니다." });

    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "수강 중인 학생만 채팅을 보낼 수 있습니다." });
    }

    const m = await prisma.chatMessage.create({
      data: { classId, userId: req.user.id, message },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    res.status(201).json({
      ...m,
      userName: m.user?.name || null,
      userEmail: m.user?.email || null,
      userRole: m.user?.role || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "채팅 전송 실패" });
  }
});

// ---------- Attendance ----------
app.get("/api/classes/:id/attendance", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "수강 중인 학생만 출석을 볼 수 있습니다." });
    }

    const list = await prisma.attendance.findMany({
      where: { classId },
      orderBy: { joinedAt: "asc" },
    });
    const filtered = access.isTeacher ? list : list.filter((a) => a.userId === req.user.id);
    res.json(filtered);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "출석 조회 실패" });
  }
});

app.post("/api/classes/:id/attendance", requireAuth, requireStudent, async (req, res) => {
  try {
    const classId = req.params.id;
    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isActiveStudent) return res.status(403).json({ error: "수강 중인 학생만 출석을 기록할 수 있습니다." });

    const a = await prisma.attendance.create({
      data: { classId, userId: req.user.id },
    });
    res.status(201).json(a);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "출석 기록 실패" });
  }
});

// ---------- Progress ----------
app.get("/api/classes/:id/progress", requireAuth, async (req, res) => {
  try {
    const classId = req.params.id;
    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isTeacher && !access.isActiveStudent) {
      return res.status(403).json({ error: "수강 중인 학생만 진도를 볼 수 있습니다." });
    }

    if (access.isTeacher) {
      const list = await prisma.progress.findMany({ where: { classId } });
      res.json(list);
    } else {
      const my = await prisma.progress.findUnique({
        where: { classId_userId: { classId, userId: req.user.id } },
      });
      res.json(my ? [my] : []);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "진도 조회 실패" });
  }
});

app.post("/api/classes/:id/progress", requireAuth, requireStudent, async (req, res) => {
  try {
    const classId = req.params.id;
    const { percent } = req.body;
    const pct = Number(percent);
    if (Number.isNaN(pct)) return res.status(400).json({ error: "percent가 필요합니다." });

    const access = await ensureClassAccess(req, classId);
    if (access.error) return res.status(404).json({ error: access.error });
    if (!access.isActiveStudent) return res.status(403).json({ error: "수강 중인 학생만 진도를 기록할 수 있습니다." });

    const p = await prisma.progress.upsert({
      where: { classId_userId: { classId, userId: req.user.id } },
      update: { percent: pct, updatedAt: new Date() },
      create: { classId, userId: req.user.id, percent: pct },
    });
    res.status(201).json(p);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "진도 기록 실패" });
  }
});

// Admin: 사용자 정지/해제
app.post("/api/admin/users/:id/suspend", requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = req.params.id;
    const untilRaw = req.body?.until || null;
    const reason = req.body?.reason || null;
    let until = null;
    if (untilRaw) {
      const t = new Date(untilRaw);
      if (!Number.isNaN(t.getTime())) until = t;
    }
    // 보장된 사용자 레코드 확보(없으면 auth에서 가져오고, 실패 시 기본값으로 생성)
    let ensured = await prisma.user.findUnique({ where: { id: targetId } });
    if (!ensured) ensured = await ensureUserRecordById(targetId);

    // 항상 upsert로 상태를 기록해, Prisma에 사용자 레코드가 없어도 정지 처리가 되도록 함
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
      update: { status: "suspended", suspendedUntil: until },
    });
    res.json({ ok: true, status: "suspended", suspendedUntil: until });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "정지 처리 실패" });
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
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "다시보기 삭제 실패" });
  }
});

// Static frontend (online_class_platform_v4)
const clientDir = path.join(__dirname, "..", "online_class_platform_v4");

// Slug-style detail URLs (support /class_detail/:id, /live_class/:id, /classes/:id)
app.get(["/class_detail/:id", "/live_class/:id", "/classes/:id"], (req, res, next) => {
  const base = (req.path.split("/")[1] || "").toLowerCase();
  const file = path.join(clientDir, `${base}.html`);
  if (fs.existsSync(file)) return res.sendFile(file);
  next();
});

// 깔끔한 주소: .html 요청이면 확장자 없는 경로로 리다이렉트
app.use((req, res, next) => {
  if (req.path.endsWith(".html")) {
    const without = req.path.replace(/\.html$/, "") || "/";
    const query = req.originalUrl.replace(req.path, "");
    return res.redirect(301, `${without}${query || ""}`);
  }
  next();
});

// 확장자 없이 들어오면 대응하는 .html이 있으면 서빙
app.use((req, res, next) => {
  if (!path.extname(req.path)) {
    const clean = req.path === "/" ? "/index" : req.path.replace(/\/+$/, "");
    const candidate = path.join(clientDir, `${clean}.html`);
    if (fs.existsSync(candidate)) {
      return res.sendFile(candidate);
    }
  }
  next();
});

app.use(express.static(clientDir));
app.get("*", (req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

// Start
app.listen(PORT, () => {
  console.log(`LessonBay API listening on http://localhost:${PORT}`);
});
