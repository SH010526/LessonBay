function loadHomePopular() {
  const wrap = $("#homePopular");
  if (!wrap) return;

  const classes = getClasses();
  const top = classes.slice(0, 6);
  if (!top.length) return;

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
