function loadTeacherDashboard() {
  const wrap = $("#teacherClassList");
  if (!wrap) return;

  (async () => {
    let user = getUser();
    if (!user) user = await ensureUserReady();
    if (!user) { navigateTo("login.html", { replace: true }); return; }
    if (user.role !== "teacher") { navigateTo("student_dashboard.html", { replace: true }); return; }

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
    const mine = classes.filter(c => isOwnerTeacherForClass(user, c));

    wrap.innerHTML = `
      <div class="grid cols-2">
        ${mine.map(c => `
          <div class="class-card wide" style="cursor:default;">
            <img class="thumb" src="${escapeAttr(initialThumbSrc(c.thumb))}" data-thumb="${escapeAttr(c.thumb || "")}" alt="">
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

    hydrateThumbs(wrap);

    $$('[data-open]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-open');
        goClassDetail(id);
      });
    });

    $$('[data-live]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-live');
        navigateTo(`live_class.html?id=${encodeURIComponent(id)}&s=1`);
      });
    });

    $$('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-del');
        if (!id) return;
        if (!confirm("해당 수업을 삭제할까요? (관련 녹화/자료/과제/채팅도 함께 삭제됩니다)")) return;
        (async () => {
          try {
            await apiRequest(`/api/classes/${encodeURIComponent(id)}`, "DELETE");
            const refreshed = await apiGet("/api/classes").catch(() => []);
            setClasses(refreshed || []);
            alert("수업을 삭제했습니다.");
            loadTeacherDashboard(); // 리스트 갱신
          } catch (e) {
            console.error(e);
            alert("수업 삭제 실패\n" + (e?.message || ""));
          }
        })();
      });
    });
  })();
}
