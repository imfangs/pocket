type BrowserPlatform = {
  platform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
};

// This controls one convenience button, not authorization. iPadOS can report
// MacIntel and a desktop Safari UA, so it must be excluded by touch capability.
export function isMacBrowser(browser?: BrowserPlatform): boolean {
  if (!browser) return false;
  const platform = browser.platform || "", userAgent = browser.userAgent || "";
  if (/iPhone|iPad|iPod|Android/i.test(`${platform} ${userAgent}`)) return false;
  const mac = platform ? /^Mac/i.test(platform) : /Macintosh|Mac OS X/i.test(userAgent);
  return mac && (browser.maxTouchPoints ?? 0) <= 1;
}
