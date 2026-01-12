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
      let candidate = window.LiveKit || window.LivekitClient || window.livekitClient || window.livekit;
      if (candidate && candidate.default && (candidate.default.connect || candidate.default.Room)) {
        candidate = candidate.default;
      }
      if (!window.LiveKit && candidate) window.LiveKit = candidate;
      if (lk && (lk.connect || lk.Room)) {
        window.LiveKit = window.LiveKit || lk;
      }
      return candidate;
    };

    let LK = resolveLK();
    if (LK && LK.connect) return LK;

    // 로컬 번들 강제 로드
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

    // CDN fallback
    await new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = `https://cdn.jsdelivr.net/npm/livekit-client@${LK_VERSION}/dist/livekit-client.umd.min.js`;
      script.crossOrigin = "anonymous";
      script.onload = resolve;
      script.onerror = resolve;
      document.head.appendChild(script);
    });
    return resolveLK();
  }

  const LK = await ensureLiveKitClient();
  if (!LK || !(LK.connect || LK.Room)) {
    alert("LiveKit 클라이언트가 로드되지 않았습니다.");
    return;
  }

  const preJoinView = $("#preJoinView");
  const liveRoomView = $("#liveRoomView");
  const previewVideo = $("#previewVideo");
  const previewCamBtn = $("#previewCamBtn");
  const previewMicBtn = $("#previewMicBtn");
  const btnJoinRoom = $("#btnJoinRoom");

  const liveVideo = $("#liveVideo");
  const videoOverlay = $("#videoOverlay");
  const remoteWrap = $("#remoteVideos");
  const remotePrev = $("#remotePrev");
  const remoteNext = $("#remoteNext");
  const remotePageInfo = $("#remotePageInfo");
  const remoteViewGrid = $("#remoteViewGrid");
  const remoteViewSpeaker = $("#remoteViewSpeaker");
  const remotePinnedInfo = $("#remotePinnedInfo");
  const btnQuality = $("#btnQuality");

  const btnLocalCam = $("#btnLocalCam");
  const btnLocalMic = $("#btnLocalMic");
  const btnShare = $("#btnShare");
  const btnLeave = $("#btnLeave");
  const btnRecord = $("#btnRecord");
  const recordHint = $("#recordHint");

  let connected = false;
  let room = null;
  let localCamTrack = null;
  let localMicTrack = null;
  let screenPub = null;

  // Local state for toggles
  let isCamOn = true;
  let isMicOn = true;

  const remoteList = [];
  let remotePage = 0;
  const REMOTE_PER_PAGE = 16;
  let remoteViewMode = "grid";
  let pinnedSid = null;
  let qualityMode = "high";

  // --- PREVIEW LOGIC ---
  let previewStream = null;

  async function startPreview() {
    preJoinView.style.display = "block";
    liveRoomView.style.display = "none";

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      previewStream = stream;
      if (previewVideo) {
        previewVideo.srcObject = stream;
        previewVideo.volume = 0; // mute self preview
      }
      isCamOn = true;
      isMicOn = true;
      updatePreviewBtns();
    } catch (e) {
      console.warn("Preview failed", e);
      // 권한 거부됨 -> 버튼 상태 업데이트
      isCamOn = false;
      isMicOn = false;
      updatePreviewBtns();
      showToast("카메라/마이크 권한이 필요합니다.", "warn");
    }
  }

  function updatePreviewBtns() {
    if (previewCamBtn) {
      previewCamBtn.textContent = isCamOn ? "카메라 끄기" : "카메라 켜기";
      previewCamBtn.className = isCamOn ? "btn" : "btn danger";
    }
    if (previewMicBtn) {
      previewMicBtn.textContent = isMicOn ? "마이크 끄기" : "마이크 켜기";
      previewMicBtn.className = isMicOn ? "btn" : "btn danger";
    }
    if (previewStream) {
      const vTrack = previewStream.getVideoTracks()[0];
      const aTrack = previewStream.getAudioTracks()[0];
      if (vTrack) vTrack.enabled = isCamOn;
      if (aTrack) aTrack.enabled = isMicOn;
    }
  }

  previewCamBtn?.addEventListener("click", () => {
    isCamOn = !isCamOn;
    updatePreviewBtns();
  });
  previewMicBtn?.addEventListener("click", () => {
    isMicOn = !isMicOn;
    updatePreviewBtns();
  });

  btnJoinRoom?.addEventListener("click", async () => {
    // Stop preview stream before joining (LiveKit will create new tracks)
    if (previewStream) {
      previewStream.getTracks().forEach(t => t.stop());
      previewStream = null;
    }
    await joinRoom();
  });


  // --- ROOM LOGIC ---

  async function joinRoom() {
    preJoinView.style.display = "none";
    liveRoomView.style.display = "block";
    setOverlay("연결 중...");

    try {
      const tk = await apiPost("/api/live/token", { classId });
      const { url, token } = tk || {};
      if (!url || !token) throw new Error("LiveKit 토큰 오류");

      const roomOpts = qualityMode === "balanced"
        ? { adaptiveStream: true, dynacast: true }
        : { adaptiveStream: false, dynacast: false };

      room = new LK.Room(roomOpts);
      await room.connect(url, token, { autoSubscribe: true });

      // Create Local Tracks based on user preference
      if (isCamOn) {
        localCamTrack = await LK.createLocalVideoTrack();
        await room.localParticipant.publishTrack(localCamTrack);
        attachLocal(localCamTrack);
      }
      if (isMicOn) {
        localMicTrack = await LK.createLocalAudioTrack();
        await room.localParticipant.publishTrack(localMicTrack);
      }

      // Update In-Room Buttons
      updateLocalBtns();

      // Remote Handlers
      room.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === "video") addRemote(track, publication, participant);
      });
      room.on(LK.RoomEvent.TrackUnsubscribed, (_track, publication) => {
        removeRemote(publication?.sid);
      });
      room.on(LK.RoomEvent.Disconnected, () => disconnectRoom());

      connected = true;
      setOverlay("");

    } catch (e) {
      console.error(e);
      alert("입장 실패: " + (e?.message || "Error"));
      disconnectRoom();
    }
  }

  function updateLocalBtns() {
    if (btnLocalCam) {
      btnLocalCam.textContent = isCamOn ? "카메라 끄기" : "카메라 켜기";
      btnLocalCam.classList.toggle("danger", !isCamOn);
    }
    if (btnLocalMic) {
      btnLocalMic.textContent = isMicOn ? "마이크 끄기" : "마이크 켜기";
      btnLocalMic.classList.toggle("danger", !isMicOn);
    }
  }

  // In-room toggles
  btnLocalCam?.addEventListener("click", async () => {
    if (!room) return;
    try {
      if (isCamOn) {
        // Turn OFF
        if (localCamTrack) {
          localCamTrack.stop();
          await room.localParticipant.unpublishTrack(localCamTrack);
          localCamTrack = null;
        }
        isCamOn = false;
      } else {
        // Turn ON
        localCamTrack = await LK.createLocalVideoTrack();
        await room.localParticipant.publishTrack(localCamTrack);
        attachLocal(localCamTrack);
        isCamOn = true;
      }
      updateLocalBtns();
    } catch (e) { console.error(e); }
  });

  btnLocalMic?.addEventListener("click", async () => {
    if (!room) return;
    try {
      if (isMicOn) {
        // Turn OFF
        if (localMicTrack) {
          localMicTrack.stop();
          await room.localParticipant.unpublishTrack(localMicTrack);
          localMicTrack = null;
        }
        isMicOn = false;
      } else {
        // Turn ON
        localMicTrack = await LK.createLocalAudioTrack();
        await room.localParticipant.publishTrack(localMicTrack);
        isMicOn = true;
      }
      updateLocalBtns();
    } catch (e) { console.error(e); }
  });

  // --- COMMON UI HELPERS ---

  function setOverlay(text) {
    if (!videoOverlay) return;
    videoOverlay.textContent = text;
    videoOverlay.style.display = text ? "grid" : "none";
  }

  function attachLocal(track) {
    if (!track || !liveVideo) return;
    track.attach(liveVideo);
    liveVideo.muted = true;
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

    const vid = document.createElement("video");
    vid.autoplay = true;
    vid.playsInline = true;
    vid.controls = false;
    box.appendChild(vid);
    track.attach(vid);

    // KICK / PIN logic
    if (isOwnerTeacher) {
      const kickBtn = document.createElement("button");
      kickBtn.className = "btn danger";
      kickBtn.style.position = "absolute";
      kickBtn.style.top = "6px";
      kickBtn.style.right = "6px";
      kickBtn.style.padding = "4px 8px";
      kickBtn.style.fontSize = "10px";
      kickBtn.textContent = "강퇴";
      kickBtn.addEventListener("click", async () => {
        if (!confirm("강퇴하시겠습니까? (5분 차단)")) return;
        try {
          await apiPost("/api/live/kick", { classId, userId: participant?.identity, banMinutes: 5 });
          removeRemote(sid);
        } catch (e) { alert(e.message); }
      });
      box.appendChild(kickBtn);
    } else {
      const pinBtn = document.createElement("button");
      pinBtn.className = "btn";
      pinBtn.style.position = "absolute";
      pinBtn.style.top = "6px";
      pinBtn.style.right = "6px";
      pinBtn.style.padding = "4px 8px";
      pinBtn.style.fontSize = "10px";
      pinBtn.textContent = "보기";
      pinBtn.addEventListener("click", () => {
        pinnedSid = sid;
        remoteViewMode = "speaker";
        renderRemotePage();
      });
      box.appendChild(pinBtn);
    }

    remoteList.push({ sid, el: box });
    renderRemotePage();
  }

  function removeRemote(sid) {
    if (!sid) return;
    const idx = remoteList.findIndex(r => r.sid === sid);
    if (idx >= 0) remoteList.splice(idx, 1);
    renderRemotePage();
  }

  async function disconnectRoom() {
    try {
      if (room) room.disconnect();
      if (localCamTrack) localCamTrack.stop();
      if (localMicTrack) localMicTrack.stop();
    } catch (_) { }
    room = null;
    localCamTrack = null;
    localMicTrack = null;
    connected = false;
    remoteList.length = 0;
    renderRemotePage();

    // Reset UI to Pre-Join (or just reload?)
    // Simplest: Go back to detail
    goClassDetail(classId);
  }

  // --- OTHER FEATURES (Share, Record, Chat) ---

  btnShare?.addEventListener("click", async () => {
    if (!room) return;
    try {
      if (!screenPub) {
        const tracks = await LK.createLocalScreenTracks({ audio: false });
        const vTrack = tracks.find(t => t.kind === "video");
        screenPub = await room.localParticipant.publishTrack(vTrack);
        attachLocal(vTrack); // Show screen in main view
        btnShare.textContent = "공유 중지";
      } else {
        await room.localParticipant.unpublishTrack(screenPub.track);
        screenPub.track.stop();
        screenPub = null;
        btnShare.textContent = "화면 공유";
        if (localCamTrack && isCamOn) attachLocal(localCamTrack);
        else {
          if (liveVideo) liveVideo.srcObject = null;
          setOverlay("카메라 꺼짐");
        }
      }
    } catch (e) { console.error(e); alert("화면 공유 실패"); }
  });

  btnLeave?.addEventListener("click", () => disconnectRoom());
  window.addEventListener("beforeunload", disconnectRoom);

  // START PREVIEW ON LOAD
  startPreview();

  // -- Chat & Record logic (simplified/preserved from original) --
  // (Chat Init)
  const chatLog = $("#chatLog");
  const chatInput = $("#chatInput");
  const chatSend = $("#chatSend");
  const displayName = (m) => escapeHtml(displayUserName(m));

  function renderMessageHtml(m) {
    return `
      <div class="msg ${m.userId === user.id ? "me" : ""} ${m.isOptimistic ? "optimistic" : ""}">
        <div class="mmeta">${displayName(m)} | ${new Date(m.sentAt || Date.now()).toLocaleTimeString("ko-KR")}</div>
        <div class="mtext">${escapeHtml(m.message || m.text || "")}</div>
      </div>`;
  }
  async function renderChat() {
    if (!chatLog) return;
    const list = await apiGet(`/api/classes/${encodeURIComponent(classId)}/chat`) || [];
    chatLog.innerHTML = list.map(m => renderMessageHtml(m)).join("");
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  async function pushChat(text) {
    if (!text) return;
    if (chatInput) chatInput.value = "";
    // optimistic
    if (chatLog) chatLog.insertAdjacentHTML("beforeend", renderMessageHtml({ userId: user.id, name: user.name, message: text, isOptimistic: true }));
    try {
      await apiPost(`/api/classes/${encodeURIComponent(classId)}/chat`, { message: text });
    } catch (e) { }
  }
  chatSend?.addEventListener("click", () => pushChat(chatInput?.value));
  chatInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") pushChat(chatInput?.value); });
  renderChat();

  // (Rec Logic - Stub)
  btnRecord?.addEventListener("click", () => {
    alert("녹화 기능은 데모 환경에서 제한됩니다.");
  });

  // Attendance
  if (user?.role === "student" && isStudentActive) {
    apiPost(`/api/classes/${encodeURIComponent(classId)}/attendance`, {}).catch(() => { });
  }
}

document.addEventListener("DOMContentLoaded", init);
