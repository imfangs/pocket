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
import BootSplash from "./BootSplash";
import { api } from "./api";
import { createAccessCheck } from "./accessCheck";
import { holdReload, useReloadGuard } from "./updateSafety";

function AppLoadFailure() {
  return <main className="access-screen">
    <section className="access-card" role="alert">
      <div className="access-brand"><Pocket size={25} /><span>Pocket</span></div>
      <h1>暂时无法打开 Pocket</h1>
      <p className="access-intro">可能遇到了版本更新或网络中断。请确认网络后重新加载。</p>
      <button type="button" className="primary access-submit" onClick={() => location.reload()}>重新加载 Pocket</button>
    </section>
  </main>;
}

// Recover only a failed first import. An already loaded App keeps ownership
// of its drafts, and no network or version event triggers a reload here.
const App = lazy(() => import("./App").catch(() => ({ default: AppLoadFailure })));
export default function AccessGate() {
  const [state, setState] = useState<
      "loading" | "locked" | "authenticated" | "offline"
    >("loading"),
    [passphrase, setPassphrase] = useState(""),
    [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useReloadGuard(() => busy ? "登录操作尚未完成，请稍后更新。"
    : passphrase ? "访问口令尚未提交，请登录或清空后再更新。" : null);
  const [checks] = useState(() => createAccessCheck({
    async request() {
      const r = await fetch("/api/auth/status", { cache: "no-store", signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error();
      const d = await r.json();
      return d.authenticated === true;
    },
    onResult(authenticated) { setState(authenticated ? "authenticated" : "locked"); },
    onFailure() {
      setState((old) => (old === "authenticated" ? old : "offline"));
    },
  }));
  const check = useCallback(() => checks.check(), [checks]);
  useEffect(() => {
    checks.resume();
    void check();
    const expired = () => {
      checks.invalidate();
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
      checks.pause();
      window.removeEventListener("navigator-auth-expired", expired);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [check, checks]);
  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const release = holdReload();
    checks.pause();
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
      release();
      checks.resume();
      setBusy(false);
    }
  };
  const logout = async () => {
    if (busy) return;
    const release = holdReload();
    checks.pause();
    setBusy(true);
    try {
      if ('serviceWorker' in navigator && 'PushManager' in window) {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          await api('/api/notifications/subscription', 'DELETE', {endpoint: subscription.endpoint});
          await subscription.unsubscribe();
        }
      }
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
      release();
      checks.resume();
      setBusy(false);
    }
  };
  if (state === "loading") return <BootSplash />;
  if (state === "authenticated")
    return (
      <>
        <Suspense fallback={<BootSplash />}>
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
        {state === "offline" ? (
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
