# Pocket 标志

2026-10-11 推荐并实施稿。面向手机上接续原 Codex 会话的个人工具，气质为安静、清楚、轻巧。以“把正在做的事装进口袋，随时接上”为概念：一个开口的口袋，上方露出折页；斜向开口提供识别特征。

本轮按 FBT `logo-design` 流程比较了三种轮廓。`concepts/a-pocket-fold.svg` 的开口与负空间最清楚，最终软化底部，减少盾牌感；普通 P 字母缺少特征，方形接续页缩小后近似封闭方框，未选。旧启动图是绿色叠层，菜单是另一枚 Lucide 线框口袋，不能作为统一主稿。参考库中的 Pagekit 与 Framer 仅研究几何和负空间构造，没有使用其路径。

## 单一主稿与生成

- `symbol.svg` 是轮廓主稿；`symbol-black.svg`、`symbol-white.svg` 是单色和反白导出。
- 深松绿 `#315A4A` 与米白 `#F7F5EF` 用于应用图标。保留旧图标的绿色情绪，换成更简洁的口袋符号。图形全为填充路径，孔洞是真透明负空间，无字体、滤镜、描边或嵌入位图。
- 界面中的 Pocket 字样沿用系统字体；本轮没有新建字体字标。
- 菜单、登录/加载失败、启动、离线页统一使用 `/icons/pocket-v1.svg`。favicon、PWA、Apple touch 和通知图片由同一主稿生成；历史 PNG URL 保留为同稿兼容副本。

重新生成：

```sh
python3 bin/build-brand.py --renderer /Users/fangs/workspace/fbt/workflows/logo-design/scripts/render_png.py
```

渲染器复用 FBT 的 rsvg-convert 后端；无需引入运行时依赖。生产图标采用带版本的新 URL，公开 Service Worker 升到 v6，避免已安装 v5 壳把旧启动图片带回新页面。iOS 已安装的主屏幕图标刷新仍由系统决定。

## 使用与验证

应用中建议 32 px；启动 64 px；favicon 单独导出 16/32 px。图标使用统一正方形比例和 22% 圆角，原生平台按自己的蒙版裁切。主体置于 maskable 中心安全圆内，不额外加描边、阴影或改成长方形。

FBT SVG 审计、原生 16/32 px 像素、64 px、单色/反白及圆形裁切检查记录在 `.local/qa/brand-2026-10-11/`。审计和参考比较只反映本次构造与视觉检查，不代表商标检索。发布与真实应用验收以 `CURRENT.md` 为准。
