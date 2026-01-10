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
