(() => {
  const key = "pocket.theme";
  const choices = ["light", "dark", "system"];
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const read = () => { try { return localStorage.getItem(key); } catch { return null; } };
  let preference = choices.includes(read()) ? read() : "system";
  const apply = () => {
    const dark = preference === "dark" || (preference === "system" && media.matches);
    const root = document.documentElement;
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.themePreference = preference;
    root.style.colorScheme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111318" : "#f7f9fc");
    window.dispatchEvent(new Event("pocket-theme-changed"));
  };
  window.addEventListener("pocket-set-theme", event => {
    if (!choices.includes(event.detail)) return;
    preference = event.detail;
    try { localStorage.setItem(key, preference); } catch { /* This tab still works without storage. */ }
    apply();
  });
  window.addEventListener("storage", event => {
    if (event.key !== key && event.key !== null) return;
    const value = read();
    preference = choices.includes(value) ? value : "system";
    apply();
  });
  media.addEventListener("change", () => { if (preference === "system") apply(); });
  apply();
})();
