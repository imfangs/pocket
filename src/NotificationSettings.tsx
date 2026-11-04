import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { Button } from "./ui/Button";
import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { api } from './api';
import { holdReload, useReloadGuard } from './updateSafety';

export default function NotificationSettings() {
  useLocale();
  const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  const [key, setKey] = useState(''), [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useReloadGuard(() => busy ? '通知设置尚未完成，请稍后更新。' : null);
  useEffect(() => {
    let cancelled = false;
    if (!supported) return;
    void (async () => {
      const config = await api<{publicKey:string}>('/api/notifications');
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      const state = subscription ? await api<{enabled:boolean}>('/api/notifications/state', 'POST', {endpoint:subscription.endpoint}) : {enabled:false};
      if (!cancelled) { setKey(config.publicKey); setEnabled(state.enabled); }
    })().catch(() => { if (!cancelled) setError('暂时无法读取通知设置'); });
    return () => { cancelled = true; };
  }, [supported]);
  const toggle = async () => {
    if (busy) return;
    const release = holdReload();
    setBusy(true); setError('');
    try {
      // iOS requires this to start directly from the button gesture.
      if (!enabled && await Notification.requestPermission() !== 'granted') {
        setError('通知未获允许，可在系统设置中开启'); return;
      }
      const registration = await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => setTimeout(() => reject(Error('通知服务未就绪，请重开页面')), 10000))]);
      let subscription = await registration.pushManager.getSubscription();
      if (enabled) {
        if (subscription) {
          await api('/api/notifications/subscription', 'DELETE', {endpoint:subscription.endpoint});
        }
        setEnabled(false);
      } else {
        const bytes = Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
        const existingKey = subscription?.options.applicationServerKey;
        if (existingKey && (new Uint8Array(existingKey).length !== bytes.length || new Uint8Array(existingKey).some((value, index) => value !== bytes[index])))
          throw Error('这台电脑的通知配置尚未同步，请稍后重试。');
        subscription ||= await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
        // One browser subscription serves all machines. A failed registration
        // or disabling this machine must not revoke another machine's delivery.
        await api('/api/notifications/subscription', 'POST', subscription.toJSON());
        setEnabled(true);
      }
    } catch (error) { setError((error as Error).message); }
    finally { release(); setBusy(false); }
  };
  return <section className="notification-setting" aria-label={t("任务通知")}>
    <div className="notification-setting-row"><strong>{t("任务通知")}</strong>
      {supported && <Button className="secondary" variant="soft" color="gray" disabled={busy || !key} onClick={() => void toggle()}>
        {enabled ? <AppIcon icon={BellOff} kind="auxiliary" /> : <AppIcon icon={Bell} kind="auxiliary" />}{busy ? t("处理中…") : enabled ? t("关闭通知") : t("开启通知")}
      </Button>}
    </div>
    <p className="field-help">{supported ? t("在 Pocket 打开或发送过的任务：完成、失败或需要处理时通知。") : t("从手机主屏幕打开 Pocket 后可开启。")}</p>
    {error && <p className="inline-error" role="alert">{t(error)}</p>}
  </section>;
}
