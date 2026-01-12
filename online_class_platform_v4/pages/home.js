function loadHomePopular() {
  const wrap = $("#homePopular");
  if (!wrap) return;

  const classes = getClasses();
  // Filter out demo classes if any remain
  const realClasses = classes.filter(c => !c.id.startsWith("c_demo_"));

  if (!realClasses.length) {
    wrap.innerHTML = `<div class="muted" style="padding:20px 0;">불러오는 중...</div>`;
    // Force a fresh fetch if we have no real classes
    apiGet("/api/classes", { silent: true, cache: "no-store" })
      .then(res => {
        if (Array.isArray(res)) {
          setClasses(res);
          // Rerender self
          const freshClasses = res.filter(c => !c.id.startsWith("c_demo_"));
          if (!freshClasses.length) {
            wrap.innerHTML = `<div class="muted" style="padding:20px 0;">등록된 수업이 없습니다.</div>`;
            return;
          }
          const freshTop = freshClasses.slice(0, 6);
          wrap.innerHTML = freshTop.map(c => renderClassCard(c)).join("");
          wrap.dataset.hydrated = "1";
          $$(".class-card", wrap).forEach(card => {
            card.addEventListener("click", () => goClassDetail(card.getAttribute("data-id")));
          });
          hydrateThumbs(wrap);
        }
      })
      .catch(() => {
        wrap.innerHTML = `<div class="muted" style="padding:20px 0;">수업을 불러오지 못했습니다.</div>`;
      });
    return;
  }

  const top = realClasses.slice(0, 6);

  wrap.innerHTML = top.map(c => renderClassCard(c)).join("");
  wrap.dataset.hydrated = "1";

  $$(".class-card", wrap).forEach(card => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-id");
      goClassDetail(id);
    });
  });

  hydrateThumbs(wrap);
}
