function loadHomePopular() {
  const wrap = $("#homePopular");
  if (!wrap) return;

  const classes = getClasses();
  // Filter out demo classes if any remain
  const realClasses = classes.filter(c => !c.id.startsWith("c_demo_"));

  if (!realClasses.length) {
    wrap.innerHTML = `<div class="muted" style="padding:20px 0;">불러오는 중...</div>`;
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
