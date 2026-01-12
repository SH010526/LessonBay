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
    // ?? ?? ? ?? ??
    if (vodVideo) {
      try { vodVideo.pause(); } catch (_) { }
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
    const title = (typeof payload === "string") ? payload : (payload?.title || "????");
    let vodKey = (typeof payload === "object") ? (payload?.vodKey || null) : null;
    const vodUrl = (typeof payload === "object") ? (payload?.vodUrl || null) : null;
    const classId = (typeof payload === "object") ? (payload?.classId || null) : null;
    const replayId = (typeof payload === "object") ? (payload?.replayId || null) : null;

    const t = $("#modalTitle");
    if (t) t.textContent = title || "????";

    // ??? '? ??' ????
    if (vodEmpty) vodEmpty.style.display = "grid";
    if (vodVideo) vodVideo.style.display = "none";

    // ?? URL ??
    cleanupVodUrl();

    // ??? ??? IndexedDB?? ??? ??
    if (vodVideo) {
      let blob = null;
      let urlToPlay = vodUrl || null;

      if (!urlToPlay && vodKey) {
        try { blob = await vodGetBlob(vodKey); } catch (_) { blob = null; }
      }

      // vodUrl? ??, ??? blob?? ??
      if (urlToPlay || blob) {
        const src = urlToPlay || URL.createObjectURL(blob);
        if (!urlToPlay) currentVodObjectUrl = src;
        vodVideo.src = src;
        vodVideo.style.display = "block";
        if (vodEmpty) vodEmpty.style.display = "none";
        // ???? ?? (???? ??? ?? ??? ? ??)
        vodVideo.play().catch(() => { });
      }
    }

    backdrop.style.display = "flex";
  };
}

// ??? ?? ?? (??/?? ?? ? ?? ??)
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
      txt.includes("?? ??") || txt.includes("????") || txt.includes("??") ||
      txt.includes("???") || txt.includes("??") || txt.includes("??") ||
      txt.includes("??") || txt.includes("????");
    if (bad) return false;

    if (txt.includes("??")) return true;
    if (id.includes("live") || id.includes("enter") || cls.includes("live") || cls.includes("enter")) return true;
    if (el.hasAttribute("data-live-enter")) return true;

    return false;
  });
}

// ?? ??? ??? ??
function refreshReplayButtons(canWatch) {
  const btns = Array.from(new Set([
    ...$$("#sessionList button"),
    ...$$(".session-item button"),
    ...$$("button")
  ])).filter(b => ((b.textContent || "").trim() === "??"));

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
  let usedCachedDetail = false;

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
    const cachedDetail = loadCachedClassDetail(id);
    if (cachedDetail) {
      c = cachedDetail;
      usedCachedDetail = true;
      const merged = [...classes.filter(x => x.id !== cachedDetail.id), cachedDetail];
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
  } else if (usedCachedDetail) {
    needsRemote = false;
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
        cacheClassDetail(normalized);
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
      const mats = await apiGet(`/api/classes/${encodeURIComponent(id)}/materials`, { silent: true, timeout: 4000, tolerateTimeout: true }).catch(() => null);
      if (!mats) { detailLoadCache.mats = false; return; }
      if (!isDetailPageActive()) return;
      const map = getMaterials();
      map[id] = Array.isArray(mats) ? mats : [];
      setMaterials(map);
      renderMaterials();
    } catch (e) {
      detailLoadCache.mats = false;
      console.error("materials fetch failed", e);
    }
  }
  async function fetchAssignmentsData() {
    if (!isDetailPageActive()) return;
    if (!getUser()) return; // GUEST: Do not fetch assignments (protected)
    if (detailLoadCache.assigns) return;
    detailLoadCache.assigns = true;
    try {
      const assigns = await apiGet(`/api/classes/${encodeURIComponent(id)}/assignments`, { silent: true, timeout: 4000, tolerateTimeout: true }).catch(() => null);
      if (!assigns) { detailLoadCache.assigns = false; return; }
      if (!isDetailPageActive()) return;
      const map = getAssignments();
      map[id] = Array.isArray(assigns) ? assigns : [];
      setAssignments(map);
      renderAssignments();
    } catch (e) {
      detailLoadCache.assigns = false;
      console.error("assignments fetch failed", e);
    }
  }
  async function fetchReviewsData() {
    if (!isDetailPageActive()) return;
    if (detailLoadCache.revs) return;
    detailLoadCache.revs = true;
    try {
      const revs = await apiGet(`/api/classes/${encodeURIComponent(id)}/reviews`, { silent: true, timeout: 4000, tolerateTimeout: true }).catch(() => null);
      if (!revs) { detailLoadCache.revs = false; return; }
      if (!isDetailPageActive()) return;
      const map = getReviews();
      map[id] = Array.isArray(revs) ? revs : [];
      setReviews(map);
      renderReviews();
    } catch (e) {
      detailLoadCache.revs = false;
      console.error("reviews fetch failed", e);
    }
  }
  async function fetchQnaData() {
    if (!isDetailPageActive()) return;
    if (detailLoadCache.qnas) return;
    detailLoadCache.qnas = true;
    try {
      const qnas = await apiGet(`/api/classes/${encodeURIComponent(id)}/qna`, { silent: true, timeout: 4000, tolerateTimeout: true }).catch(() => null);
      if (!qnas) { detailLoadCache.qnas = false; return; }
      if (!isDetailPageActive()) return;
      const map = getQna();
      map[id] = Array.isArray(qnas) ? qnas : [];
      setQna(map);
      renderQna();
    } catch (e) {
      detailLoadCache.qnas = false;
      console.error("qna fetch failed", e);
    }
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
      ? [1, 2, 3, 4, 6, 8, 12].map(n => ({ v: n, t: `${n}주` }))
      : [1, 2, 3, 4, 6, 12].map(n => ({ v: n, t: `${n}개월` }));

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
      const enrollReady = (typeof isEnrollmentsSynced === "function") ? isEnrollmentsSynced() : true;
      const enrollSyncing = (typeof isEnrollmentsSyncing === "function") ? isEnrollmentsSyncing() : false;
      if (!e) {
        if (!enrollReady || enrollSyncing) return { state: "student_pending", e: null, active: false, endText: "-" };
        return { state: "student_not_enrolled", e: null, active: false, endText: "-" };
      }
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
    if (status.state === "student_pending") {
      if (typeof fetchEnrollmentsForUser === "function" && user) {
        const syncing = (typeof isEnrollmentsSyncing === "function") ? isEnrollmentsSyncing() : false;
        if (!syncing) {
          fetchEnrollmentsForUser(user, 0, { force: true })
            .then(() => { if (isDetailPageActive()) refreshGates(); })
            .catch(() => { });
        }
      }
    }

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
      if (status.state === "student_pending") {
        setGateDisabled(btn, true);
        btn.textContent = "수강 확인중...";
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
      } else if (status.state === "student_pending") {
        buyBtn.textContent = "수강 상태 확인중...";
        setGateDisabled(buyBtn, true);
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
      } else if (status.state === "student_pending") {
        enrollStateText.textContent = "수강 상태를 확인중입니다. 잠시만 기다려 주세요.";
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
      cacheEnrollments(user, latest || []);
      markEnrollmentsSynced();
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
        ? assignList.map(a => {
          const isSub = a.submissions && a.submissions.length > 0;
          const badge = isSub ? " ✅ (제출됨)" : "";
          return `<option value="${escapeAttr(a.id)}">${escapeHtml(a.title || "무제")}${badge} · ${a.dueAt ? new Date(a.dueAt).toLocaleString("ko-KR") : "마감 없음"}</option>`;
        }).join("")
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
    // SECURITY FIX: Ensure user exists and has email before finding submission.
    // Guests (user=null) should never match any submission, even one with missing email.
    const myAssign = (user && myEmail)
      ? submissions.find(a => normalizeEmail(a.userEmail || a.studentEmail || "") === myEmail || a.studentId === user.id)
      : null;
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
      // 학생/게스트 로직
      if (!user) {
        // 게스트: 폼 숨기고 로그인 유도 메시지 표시
        toggleStudentFields(false);
        if (formWrap) formWrap.style.display = "none";
        // 상태 메시지는 아래에서 처리
      } else {
        // 로그인한 학생: 선택된 과제 기준으로 편집/제출 UI 노출
        const hasSubmission = !!myAssign;
        if (hasSubmission) {
          if (isEditingStudent) {
            toggleStudentFields(true);
          } else {
            if (formWrap) formWrap.dataset.editing = "0";
            toggleStudentFields(false);
          }
        } else {
          // 미제출 상태면 작성 폼 노출
          if (formWrap) formWrap.dataset.editing = "1";
          toggleStudentFields(true);
        }
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
      if (!user) {
        statusEl.innerHTML = `<span class="muted">과제를 제출하거나 확인하려면 <a href="#" onclick="window.AuthModal?.open(); return false;" style="text-decoration:underline;">로그인</a>이 필요합니다.</span>`;
      } else if (!assignList.length) {
        statusEl.textContent = "등록된 과제가 없습니다.";
      } else {
        const dueTxt = meta?.dueAt ? `마감: ${new Date(meta.dueAt).toLocaleString("ko-KR")}` : "마감 설정 없음";
        if (myAssign) {
          const submitted = myAssign.submittedAt || myAssign.at;
          const updated = myAssign.updatedAt ? ` / 수정: ${new Date(myAssign.updatedAt).toLocaleString("ko-KR")}` : "";
          const titleTxt = assignMap[myAssign.assignId || selectedAssignId || ""]?.title || "과제";
          // Highlight "Submitted" status
          statusEl.innerHTML = `<strong>[제출 완료]</strong> ${titleTxt} (${new Date(submitted).toLocaleString("ko-KR")}${updated}) · ${dueTxt} · <span style="color:#6d5efc;">수정하려면 아래 '수정' 버튼을 누르세요.</span>`;
        } else {
          statusEl.textContent = `선택된 과제: ${assignMap[selectedAssignId || latestAssignId || ""]?.title || "과제"} · ${dueTxt} · 미제출`;
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
              ${Array.from({ length: 24 }, (_, i) => `<option value="${i}">${String(i).padStart(2, "0")}시</option>`).join("")}
            </select>
            <select id="assignDueMin" class="input" style="width:90px;">
              ${["00", "10", "20", "30", "40", "50"].map(m => `<option value="${Number(m)}">${m}분</option>`).join("")}
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
          dueDate.value = dt.toISOString().slice(0, 10);
          dueHour.value = dt.getHours();
          const m = dt.getMinutes();
          dueMin.value = [0, 10, 20, 30, 40, 50].includes(m) ? m : 0;
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
          const [y, m, dv] = dateStr.split("-").map(Number);
          const hh = Number(hourStr);
          const mm = Number(minStr);
          const dt = new Date(y, (m || 1) - 1, dv || 1, hh || 0, mm || 0, 0, 0);
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
              dueDate.value = dt.toISOString().slice(0, 10);
              dueHour.value = dt.getHours();
              const m = dt.getMinutes();
              dueMin.value = [0, 10, 20, 30, 40, 50].includes(m) ? m : 0;
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
          const whoRaw = s.student?.name || s.student?.email || s.studentName || s.studentEmail || "";
          const who = escapeHtml(whoRaw || "학생");
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
          try { btn.closest("form")?.addEventListener("submit", (ev) => ev.preventDefault(), { once: true }); } catch (_) { }
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
    const avg = revs.length ? (revs.reduce((s, r) => s + (r.rating || 0), 0) / revs.length).toFixed(1) : "-";
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
