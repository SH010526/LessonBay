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
              <img class="thumb" loading="lazy" decoding="async" src="${escapeAttr(initialThumbSrc(c.thumb))}" data-thumb="${escapeAttr(c.thumb || "")}" alt="">
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
    wrap.dataset.hydrated = "1";

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
