# 任务通知

2026-09-29 用户选定实施。设置中开启当前设备的通知后，关注最近在 Pocket 打开历史的任务，发送完成、失败、等待处理三类提醒。只显示固定状态文字和加密负载中的目标任务 ID，不发送聊天正文或任务标题。默认范围是在等待用户可选偏好回复期间采用的推荐项，尚不是全 Mac 任务订阅。

## 链路与状态

手机 PushManager 订阅 → 认证后的 Pocket HTTP API → Mac 私有订阅表。Mac `Notifications` 读取原 owner 历史中的 turn/请求状态变化，使用 web-push 3.6.7、VAPID、aes128gcm 发送至 Apple/Google/Mozilla 的 Web Push 服务。Service Worker 显示通知，点击后优先发送任务 ID 给现有页面并等待 ACK，保留正常页面草稿；没有页面或离线壳不能响应时打开带任务参数的 URL，登录后进入目标任务。

它是 Web Push，不是浏览器定时器保活。Mac 仍需在线、唤醒、Pocket 服务运行。首次在 iPhone 主屏幕 App 中点击开启并允许系统通知必须在实际设备完成，服务端准备好不等于手机已收到。

- 只在实时桌面快照上判定完成/失败；保存历史回退或读取错误不推断完成。
- 首次关注不重放旧完成/旧问题；新请求按稳定指纹去重。已经处理的请求会取消未发提醒，重试前也重读原 owner。
- 10 秒调度，单轮最多检查 4 个近期任务；不是实时流式通知。读取失败仍轮转，避免一个离线任务阻塞所有任务；fallback 保留待核验的源版本。
- 最多保留 100 个最近打开任务，7 天不再打开则停止关注。订阅设备最多 10 个，30 天未重新登记则失效。需要更大范围时单独调整，不默默扫描所有历史任务。
- 发送失败最多尝试 3 次；404/410 移除失效订阅。待发事件超过 10 分钟作过期处理，服务端推送 TTL 120 秒；同一事件 tag 用于系统通知合并。推送服务接受不等于设备已呈现。
- 退出登录会删除当前订阅并调用浏览器 unsubscribe；轮换 Pocket 口令会清空所有通知订阅和待发事件。

## 私有数据

VAPID 密钥位于 Application Support/CodexNavigator/web-push-keys.json（0600），自动生成并复用，不随发布轮换。订阅 endpoint/加密 key、状态指纹、待发回执存 Pocket 私有 SQLite，不进入整理备份或 Service Worker cache。允许的订阅端点仅为 HTTPS Apple Push、FCM 和 Mozilla Push 主机，拒绝任意 URL、端口和凭据，避免让订阅接口变成网络代理。

认证接口：GET /api/notifications；POST/DELETE /api/notifications/subscription；POST /api/notifications/state。写入沿用同源、Cookie/本机 CLI 与 CSRF 边界。外网仍不能使用 loopback CLI token。

## 验证与剩余边界

自动检查覆盖端点校验、加密/VAPID、初始与 fallback 不误报、去重/重启、失败轮转、过期审批取消及重试重核对；SW 覆盖通知显示、已打开页面 ACK、离线壳恢复和新窗口目标。隔离 390px 浏览器可经真实 API 登记测试订阅；关闭页面后改变合成原任务状态，Mac 后台 sender 收到一次准确完成事件。

浏览器 PushManager/发送端使用隔离替身，未向真实推送服务发送测试。额外尝试通过 CDP 向 Chromium SW 投递事件时，该浏览器通知权限返回 denied（显式授权也未恢复），没有获得系统通知，未计作通过。iPhone 锁屏/后台通知送达、点击唤醒、平台限流仍须真机验证。证据 .local/qa/controls/。
