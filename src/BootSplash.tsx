// Keep the pre-JavaScript fallback in index.html visually identical.
export default function BootSplash() {
  return <main className="boot-screen" role="status" aria-label="正在打开 Pocket">
    <img className="boot-symbol" src="/icons/icon-192.png" width="64" height="64" alt="" />
    <span className="boot-name">Pocket</span>
    <span className="boot-dots" aria-hidden="true"><i /><i /><i /></span>
    <a className="boot-retry" href="">重新打开</a>
  </main>;
}
