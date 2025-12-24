const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ===== Gmail SMTP 설정 =====
// Use env first; fallback to legacy hardcoded values (replace with your own)
const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'soong0105@gmail.com',
    pass: process.env.SMTP_PASS || 'jogsnvugkovhjumq'
  }
};

// OTP 저장소 (메모리, 실제 운영은 DB 사용)
const otpStore = {};

// ===== API 엔드포인트 =====

// 1. OTP 발송
app.post('/api/send-otp', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: '이메일을 입력하세요.' });
  }

  try {
    // 6자리 OTP 생성
    const otp = String(Math.floor(Math.random() * 900000) + 100000);
    
    // 메모리에 저장 (10분 유효)
    otpStore[email] = {
      code: otp,
      expiresAt: Date.now() + 10 * 60 * 1000
    };

    // nodemailer 설정
    const transporter = nodemailer.createTransport(SMTP_CONFIG);

    // 이메일 발송
    await transporter.sendMail({
      from: 'noreply@lessonbay.com',   // 발신자 (수정 가능)
      to: email,
      subject: 'LessonBay 회원가입 인증코드',
      html: `
        <h2>LessonBay 회원가입</h2>
        <p>아래의 6자리 인증코드를 입력해주세요:</p>
        <h1 style="color: #6D5EFC; font-size: 36px; letter-spacing: 8px;">${otp}</h1>
        <p>이 코드는 10분간 유효합니다.</p>
        <hr>
        <p style="font-size: 12px; color: #666;">이 이메일이 요청되지 않았다면 무시해주세요.</p>
      `
    });

    res.json({ success: true, message: '인증코드가 이메일로 발송되었습니다.' });
  } catch (error) {
    console.error('이메일 발송 실패:', error);
    res.status(500).json({ error: error.message || '이메일 발송 실패' });
  }
});

// 2. OTP 검증
app.post('/api/verify-otp', (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: '이메일과 인증코드를 입력하세요.' });
  }

  const stored = otpStore[email];

  if (!stored) {
    return res.status(400).json({ error: '인증코드를 먼저 요청하세요.' });
  }

  if (Date.now() > stored.expiresAt) {
    delete otpStore[email];
    return res.status(400).json({ error: '인증코드가 만료되었습니다.' });
  }

  if (code !== stored.code) {
    return res.status(400).json({ error: '인증코드가 일치하지 않습니다.' });
  }

  // 검증 성공
  delete otpStore[email];
  res.json({ success: true, message: '인증 성공' });
});

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// ===== 서버 시작 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LiveClass 백엔드 서버 시작: http://localhost:${PORT}`);
  console.log('⚠️  SMTP 설정을 확인하세요: server.js의 SMTP_CONFIG');
});
