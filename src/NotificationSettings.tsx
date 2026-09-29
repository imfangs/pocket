import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { api } from './api';

export default function NotificationSettings() {
  const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  const [key, setKey] = useState(''), [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
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
          await subscription.unsubscribe();
        }
        setEnabled(false);
      } else {
        const bytes = Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
        subscription ||= await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
        try { await api('/api/notifications/subscription', 'POST', subscription.toJSON()); }
        catch (error) { await subscription.unsubscribe(); throw error; }
        setEnabled(true);
      }
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="notification-setting" aria-label="任务通知">
    <div><strong>任务通知</strong><p className="field-help">{supported ? '在 Pocket 打开或发送过的任务：完成、失败或需要处理时通知。' : '从手机主屏幕打开 Pocket 后可开启。'}</p></div>
    {supported && <button className="secondary" disabled={busy || !key} onClick={() => void toggle()}>
      {enabled ? <BellOff size={16}/> : <Bell size={16}/>}{busy ? '处理中…' : enabled ? '关闭通知' : '开启通知'}
    </button>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
