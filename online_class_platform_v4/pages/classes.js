function loadClassesPage() {
  const grid = $("#classGrid");
  if (!grid) return;

  const categorySel = $("#filterCategory");
  const searchInput = $("#searchInput");

  const classes = getClasses();
  const categories = Array.from(new Set(classes.map(c => c.category).filter(Boolean))).sort();

  if (categorySel) {
    categorySel.innerHTML =
      `<option value="all">전체 카테고리</option>` +
      categories.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
  }

  function applyFilter() {
    const q = (searchInput?.value || "").trim().toLowerCase();
    const cat = categorySel?.value || "all";

    const filtered = classes.filter(c => {
      const hitQ =
        !q ||
        (c.title || "").toLowerCase().includes(q) ||
        (c.teacher || "").toLowerCase().includes(q) ||
        (c.description || "").toLowerCase().includes(q);
      const hitC = (cat === "all") || (c.category === cat);
      return hitQ && hitC;
    });

    grid.innerHTML = filtered.map(c => renderClassCard(c, true)).join("") +
      (filtered.length ? "" : `<p class="muted" style="margin-top:14px;">조건에 맞는 수업이 없어요.</p>`);
    grid.dataset.hydrated = "1";

    $$(".class-card", grid).forEach(card => {
      card.addEventListener("click", () => {
        const id = card.getAttribute("data-id");
        goClassDetail(id);
      });
    });

    hydrateThumbs(grid);
  }

  categorySel?.addEventListener("change", applyFilter);
  searchInput?.addEventListener("input", applyFilter);
  applyFilter();
}
