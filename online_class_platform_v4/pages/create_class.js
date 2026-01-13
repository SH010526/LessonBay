function handleCreateClassPage() {
  const $ = (s) => document.querySelector(s);
  const form = $("#createClassForm");
  if (!form) return;

  const guard = $("#createGuard");
  const main = $("#createMain");

  const applyGuard = (user) => {
    if (!user || user.role !== "teacher") {
      if (guard) guard.style.display = "block";
      if (main) main.style.display = "none";
      return false;
    }
    if (guard) guard.style.display = "none";
    if (main) main.style.display = "block";
    return true;
  };

  const init = () => {
    if (form.dataset.bound === "1") return;
    form.dataset.bound = "1";

    const sel = $("#cCategorySelect");
    const custom = $("#cCategoryCustom");
    const hidden = $("#cCategory");

    function syncCategory() {
      if (!sel || !hidden) return;
      if (sel.value === "__custom__") {
        if (custom) custom.style.display = "block";
        hidden.value = (custom?.value || "").trim();
      } else {
        if (custom) custom.style.display = "none";
        hidden.value = sel.value;
      }
    }

    sel?.addEventListener("change", syncCategory);
    custom?.addEventListener("input", syncCategory);
    syncCategory();

    const fileInput = $("#cThumbFile");
    const preview = $("#cThumbPreview");
    let thumbDataUrl = "";
    let thumbFile = null;

    fileInput?.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (!f) {
        thumbDataUrl = "";
        thumbFile = null;
        if (preview) preview.style.display = "none";
        return;
      }
      thumbFile = f;
      const reader = new FileReader();
      reader.onload = () => {
        thumbDataUrl = String(reader.result || "");
        if (preview) {
          preview.src = thumbDataUrl;
          preview.style.display = "block";
        }
      };
      reader.readAsDataURL(f);
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const title = ($("#cTitle")?.value || "").trim();
      syncCategory();
      const category = ($("#cCategory")?.value || "").trim();
      const description = ($("#cDesc")?.value || "").trim();
      const weeklyPrice = Number($("#cWeekly")?.value || 0);
      const monthlyPrice = Number($("#cMonthly")?.value || 0);
      const scheduleInput = $("#cDate")?.value;

      if (!title || !category || !description) {
        alert("제목, 카테고리, 설명을 입력하세요.");
        return;
      }

      if (!scheduleInput) {
        alert("수업 시작 일시를 선택하세요.");
        return;
      }

      try {
        let thumbUrlFinal = thumbDataUrl || FALLBACK_THUMB;

        // Ensure Supabase client is ready
        if (!supabaseClient) await waitForSupabaseClient();

        const user = getUser();
        if (!user) {
          alert("로그인이 필요합니다.");
          return;
        }

        if (thumbFile) {
          if (thumbFile.size > 50 * 1024 * 1024) {
            alert("Supabase 무료 요금제는 파일당 50MB까지만 업로드 가능합니다.");
            return;
          }
          const uploaded = await uploadToSupabaseStorage(thumbFile, "class-thumbs");
          thumbUrlFinal = uploaded.path || FALLBACK_THUMB;
        }

        // Direct Supabase Insert
        const { data, error } = await supabaseClient
          .from('classes')
          .insert({
            title,
            category,
            description,
            price_weekly: weeklyPrice,
            price_monthly: monthlyPrice, // Check if DB column is price_monthly
            thumbnail_url: thumbUrlFinal,
            schedule: new Date(scheduleInput).toISOString(),
            instructor_id: user.id
          })
          .select()
          .single();

        if (error) throw error;

        alert("수업 생성 완료!");

        // Navigation helper check
        if (typeof navigateTo === 'function') {
          navigateTo("teacher_dashboard.html");
        } else {
          window.location.href = "teacher_dashboard.html";
        }

      } catch (e) {
        console.error(e);
        alert("수업 생성 실패\n" + (e?.message || ""));
      }
    });
  };

  (async () => {
    let user = getUser();
    if (typeof ensureUserReady === 'function' && !user) user = await ensureUserReady();
    if (!applyGuard(user)) return;
    init();
  })();
}
