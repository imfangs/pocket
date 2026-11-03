// Small public-shell bootstrap: localize only explicit Pocket-owned nodes.
// It runs before React, including on the offline page, without loading catalogs.
(() => {
  const key = "pocket.language.v1";
  const resolve = () => {
    let preference;
    try { preference = localStorage.getItem(key); } catch {}
    if (preference === "zh-CN" || preference === "en") return preference;
    for (const value of navigator.languages?.length ? navigator.languages : [navigator.language]) {
      const language = String(value).toLowerCase().split(/[-_]/)[0];
      if (language === "zh") return "zh-CN";
      if (language === "en") return "en";
    }
    return "en";
  };
  const text = {
    "zh-CN": { opening: "正在打开 Pocket", reopen: "重新打开", offlineTitle: "暂时无法连接", offlineHelp: "网络或 Mac 暂时不可达。恢复连接后再试一次。", reconnect: "重新连接", pageTitle: "Pocket · 等待连接" },
    en: { opening: "Opening Pocket", reopen: "Reopen", offlineTitle: "Unable to connect", offlineHelp: "The network or your Mac is unavailable. Try again when the connection returns.", reconnect: "Reconnect", pageTitle: "Pocket · Waiting to connect" },
  };
  const apply = (selected) => {
    const language = selected === "zh-CN" || selected === "en" ? selected : resolve();
    document.documentElement.lang = language;
    const messages = text[language];
    document.getElementById("pocket-boot")?.setAttribute("aria-label", messages.opening);
    for (const node of document.querySelectorAll("[data-shell-text]")) {
      const value = messages[node.getAttribute("data-shell-text")];
      if (value) node.textContent = value;
    }
    if (document.querySelector('meta[name="pocket-offline-shell"]')) document.title = messages.pageTitle;
  };
  window.addEventListener("storage", event => { if (event.key === key || event.key === null) apply(); });
  window.addEventListener("languagechange", apply);
  window.addEventListener("pocket-language-changed", event => apply(event.detail));
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  apply();
})();
