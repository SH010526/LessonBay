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
      if (screenPub?.track && room?.localParticipant?.unpublishTrack) {
        try { await room.localParticipant.unpublishTrack(screenPub.track, true); } catch (_) {}
      }
      if (localCamTrack?.stop) localCamTrack.stop();
      if (localMicTrack?.stop) localMicTrack.stop();
      if (screenPub?.track?.stop) screenPub.track.stop();
      if (room) room.disconnect();
    } catch (_) {}
    room = null;
    localCamTrack = null;
    localMicTrack = null;
    screenPub = null;
    remoteList.splice(0, remoteList.length);
    renderRemotePage();
    setConnectedUI(false);
  }

  window.__pageCleanup = async () => {
    await disconnectRoom();
  };

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
  const displayRole = (m) => escapeHtml(displayUserRole(m));

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
        <div class="mmeta">${displayName(m)} | ${displayRole(m)} | ${new Date(m.sentAt || m.at).toLocaleTimeString("ko-KR")}</div>
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

  $("#btnLeave")?.addEventListener("click", async () => {
    await disconnectRoom();
    window.__pageCleanup = null;
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
