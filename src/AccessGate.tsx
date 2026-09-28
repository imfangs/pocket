import {
  Pocket,
  LockKeyhole,
  ArrowRight,
  WifiOff,
  LogOut,
  Eye,
  EyeOff,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import PwaInstall from "./PwaInstall";
import ThemeSwitch from "./ThemeSwitch";

const App = lazy(() => import("./App"));
export default function AccessGate() {
  const [state, setState] = useState<
      "loading" | "locked" | "authenticated" | "offline"
    >("loading"),
    [passphrase, setPassphrase] = useState(""),
    [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const check = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/status", { cache: "no-store" });
      if (!r.ok) throw new Error();
      const d = await r.json();
      setState(d.authenticated ? "authenticated" : "locked");
    } catch {
      setState((old) => (old === "authenticated" ? old : "offline"));
    }
  }, []);
  useEffect(() => {
    void check();
    const expired = () => {
      setState("locked");
      setError("登录已过期，请重新输入口令。");
    };
    const online = () => void check();
    window.addEventListener("navigator-auth-expired", expired);
    window.addEventListener("online", online);
    const visible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("navigator-auth-expired", expired);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [check]);
  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "登录未完成");
      setPassphrase("");
      setState("authenticated");
    } catch (e) {
      setError((e as Error).message || "无法连接 Mac");
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!r.ok) throw new Error();
      setState("locked");
      setError("");
      setPassphrase("");
    } catch {
      setError("退出未完成，请检查连接后重试。");
    } finally {
      setBusy(false);
    }
  };
  if (state === "authenticated")
    return (
      <>
        <Suspense
          fallback={
            <main className="access-screen">
              <p role="status" className="access-status">
                正在读取任务…
              </p>
            </main>
          }
        >
          <App
            footerActions={
              <div className="access-actions">
                <ThemeSwitch />
                <PwaInstall />
                <button
                  className="pwa-install"
                  onClick={() => void logout()}
                  disabled={busy}
                >
                  <LogOut size={16} />
                  <span>{busy ? "正在退出…" : "退出登录"}</span>
                </button>
              </div>
            }
          />
        </Suspense>
        {error && (
          <div className="access-toast" role="alert">
            {error}
          </div>
        )}
      </>
    );
  return (
    <main className="access-screen">
      <section className="access-card">
        <div className="access-brand">
          <Pocket size={25} />
          <span>Pocket</span>
        </div>
        <h1>
          把想做的事，
          <br />
          好好接上。
        </h1>
        <p className="access-intro">
          连接这台 Mac 上的 Codex 任务。
          <br />
          你的分组和接续说明，随时可见。
        </p>
        {state === "loading" ? (
          <p role="status" className="access-status">
            正在连接…
          </p>
        ) : state === "offline" ? (
          <div className="access-offline">
            <WifiOff size={24} />
            <p>暂时连接不到 Mac。</p>
            <small>确认 Mac 和网络可用后再试。</small>
            <button className="primary" onClick={() => void check()}>
              重新连接
            </button>
          </div>
        ) : (
          <form onSubmit={login}>
            <label htmlFor="passphrase">访问口令</label>
            <div className="passphrase-input">
              <LockKeyhole size={18} />
              <input
                id="passphrase"
                name="password"
                type={visible ? "text" : "password"}
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                placeholder="输入你的口令"
                value={passphrase}
                onInput={(e) => setPassphrase(e.currentTarget.value)}
                onChange={(e) => setPassphrase(e.target.value)}
                maxLength={128}
                required
                disabled={busy}
              />
              <button
                type="button"
                aria-label={visible ? "隐藏口令" : "显示口令"}
                onClick={() => setVisible((v) => !v)}
              >
                {visible ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary access-submit"
              disabled={busy || !passphrase}
            >
              {busy ? "正在验证…" : "进入 Pocket"}
              <ArrowRight size={17} />
            </button>
            <small className="access-session-note">
              在这台设备保持登录 7 天，可随时退出。
            </small>
          </form>
        )}
        <div className="access-install">
          <PwaInstall />
        </div>
        <p className="access-privacy">私人任务 · 口令保护</p>
        <ThemeSwitch />
      </section>
    </main>
  );
}
