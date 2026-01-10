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
