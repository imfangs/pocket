import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { IconButton } from "./ui/IconButton";
import { Button } from "./ui/Button";
import PocketLogo from "./PocketLogo";
import {
  LockKeyhole,
  ArrowRight,
  WifiOff,
  LogOut,
  Eye,
  EyeOff,
  Settings2,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import PwaInstall, { usePwaInstallController } from "./PwaInstall";
import ThemeSwitch from "./ThemeSwitch";
import BootSplash from "./BootSplash";
import { api, invalidateAuthentication } from "./api";
import { clearReadingCache, subscribeReadingCacheInvalidation } from "./readingCache";
import { clearFeedbackDrafts } from "./feedbackClient";
import { createAccessCheck } from "./accessCheck";
import { holdReload, useReloadGuard } from "./updateSafety";
import { SettingsDialog } from "./Dialogs";
import { bindMachineUnloadGuard, changeMachine, currentMachineId, needsPublicMachine } from "./machineScope";

function AccessSettings() {
  useLocale();
  const [open, setOpen] = useState(false);
  return <div className="access-settings">
    <IconButton type="button" className="icon-button" aria-label={t("设置")} title={t("设置")} onClick={() => setOpen(true)}>
      <AppIcon icon={Settings2} kind="action" aria-hidden="true" />
    </IconButton>
    {open && <SettingsDialog notificationsAvailable={false} onClose={() => setOpen(false)} />}
  </div>;
}

function AppLoadFailure() {
  useLocale();
  return <main className="access-screen">
    <section className="access-card" role="alert">
      <AccessSettings />
      <div className="access-brand"><PocketLogo /><span>Pocket</span></div>
      <h1>{t("暂时无法打开 Pocket")}</h1>
      <p className="access-intro">{t("可能遇到了版本更新或网络中断。请确认网络后重新加载。")}</p>
      <Button type="button" className="primary access-submit" onClick={() => location.reload()}>{t("重新加载 Pocket")}</Button>
    </section>
  </main>;
}

// Recover only a failed first import. An already loaded App keeps ownership
// of its drafts, and no network or version event triggers a reload here.
const App = lazy(() => import("./App").catch(() => ({ default: AppLoadFailure })));
export default function AccessGate() {
  useLocale();
  const machine = currentMachineId();
  const [state, setState] = useState<
      "loading" | "locked" | "authenticated" | "offline" | "select"
    >("loading"),
    [passphrase, setPassphrase] = useState(""),
    [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const installController = usePwaInstallController();
  const cachePurge = useRef<ReturnType<typeof clearReadingCache> | null>(null);
  const purgeCache = () => {
    if (machine) invalidateAuthentication(machine);
    const pending = Promise.all([clearReadingCache(machine ?? undefined), clearFeedbackDrafts(machine ?? undefined)])
      .then(([reading, feedbackCleared]) => ({ ...reading, invalidated: reading.invalidated && feedbackCleared }));
    cachePurge.current = pending;
    return pending;
  };
  useEffect(() => bindMachineUnloadGuard(), []);
  useReloadGuard(() => busy ? "登录操作尚未完成，请稍后更新。"
    : passphrase ? "访问口令尚未提交，请登录或清空后再更新。" : null);
  const [checks] = useState(() => createAccessCheck({
    async request() {
      const d = await api<{ authenticated: boolean }>("/api/auth/status", "GET", undefined, { signal: AbortSignal.timeout(12000) });
      return d.authenticated === true;
    },
    onResult(authenticated) {
      if (!authenticated && machine) void purgeCache();
      setState(authenticated ? "authenticated" : "locked");
    },
    onFailure() {
      setState((old) => (old === "authenticated" ? old : "offline"));
    },
  }));
  const check = useCallback(() => checks.check(), [checks]);
  useEffect(() => {
    // Even an invalid target must release the shared startup screen through
    // the normal loading-stage handoff before its settings become interactive.
    if (!machine) { setState("select"); return; }
    if (needsPublicMachine(machine)) {
      const task = new URLSearchParams(location.search).get("task");
      const reason = changeMachine(machine, task && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(task) ? task : undefined);
      if (reason) { setError(reason); setState("select"); }
      return;
    }
    checks.resume();
    void check();
    const expired = (event: Event) => {
      const source = (event as CustomEvent<{ machine?: string }>).detail?.machine;
      if (source && source !== machine) return;
      checks.invalidate();
      if (machine) void purgeCache();
      setState("locked");
      setError("登录已过期，请重新输入口令。");
    };
    const online = () => void check();
    window.addEventListener("navigator-auth-expired", expired);
    const unsubscribeCache = subscribeReadingCacheInvalidation(event => {
      if (event.machine && event.machine !== machine) return;
      if (machine) invalidateAuthentication(machine);
      checks.invalidate(); setState("locked");
    });
    window.addEventListener("online", online);
    const visible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      checks.pause();
      window.removeEventListener("navigator-auth-expired", expired);
      unsubscribeCache();
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [check, checks, machine]);
  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!machine || busy) return;
    const release = holdReload();
    checks.pause();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ authenticated: boolean }>("/api/auth/login", "POST", { passphrase });
      if (!result.authenticated) throw new Error("登录未完成");
      await cachePurge.current;
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
        }
      }
      await api("/api/auth/logout", "POST", {});
      const cleared = await purgeCache();
      setState("locked");
      setError(cleared.invalidated ? "" : "已退出登录，但本地缓存未能清理，请清除本站数据。");
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
            appearanceActions={
              <div className="access-actions">
                <ThemeSwitch />
                <PwaInstall controller={installController} />
              </div>
            }
            logoutAction={
              <button type="button" className="settings-logout-button" onClick={() => void logout()} disabled={busy}>
                <AppIcon icon={LogOut} kind="auxiliary" aria-hidden="true" />
                <span>{busy ? t("正在退出…") : t("退出登录")}</span>
              </button>
            }
          />
        </Suspense>
        {error && (
          <div className="access-toast" role="alert">
            {t(error)}
          </div>
        )}
      </>
    );
  return (
    <main className="access-screen">
      <section className="access-card">
        <AccessSettings />
        <div className="access-brand">
          <PocketLogo />
          <span>Pocket</span>
        </div>
        <h1>{t("连接 Codex")}</h1>
        {state === "select" ? <p className="access-intro" role={error ? "alert" : undefined}>{error ? t(error) : t("请在设置中选择电脑。")}</p> : state === "offline" ? (
          <div className="access-offline">
            <AppIcon icon={WifiOff} kind="illustration" size={24} />
            <p>{t("暂时无法连接。")}</p>
            <small>{t("确认 Mac 和网络可用后再试。")}</small>
            <Button type="button" className="primary" onClick={() => void check()}>{t("重新连接")}</Button>
          </div>
        ) : (
          <form onSubmit={login}>
            <label htmlFor="passphrase">{t("访问口令")}</label>
            <div className="passphrase-input">
              <AppIcon icon={LockKeyhole} kind="auxiliary" />
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
                aria-label={visible ? t("隐藏口令") : t("显示口令")}
                onClick={() => setVisible((v) => !v)}
              >
                {visible ? <AppIcon icon={EyeOff} kind="action" /> : <AppIcon icon={Eye} kind="action" />}
              </button>
            </div>
            {error && (
              <p className="inline-error" role="alert">
                {t(error)}
              </p>
            )}
            <Button type="submit"
              className="primary access-submit"
              disabled={busy || !passphrase}
            >
              {busy ? t("正在验证…") : t("进入 Pocket")}
              <AppIcon icon={ArrowRight} kind="auxiliary" />
            </Button>
            <small className="access-session-note">{t("在这台设备保持登录 7 天，可随时退出。")}</small>
          </form>
        )}
        <div className="access-install">
          <PwaInstall controller={installController} />
        </div>
        <ThemeSwitch />
      </section>
    </main>
  );
}
