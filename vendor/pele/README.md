# Pele：Pocket 的固定版本图表渲染器

本目录提供从上游固定源码构建的本地 npm 包，**不是 Pele 官方 npm 发布版**。首次引入于 2026-10-19；范围仅为 Mermaid 围栏中的流程图、时序图和状态图阅读。

## 来源与选择

- 上游：[obsidianmd/pele](https://github.com/obsidianmd/pele)，MIT；完整许可在 [LICENSE](LICENSE)。
- 固定 commit：[`44da152bbb79b91f03e68016f42499bb25bf6e82`](https://github.com/obsidianmd/pele/tree/44da152bbb79b91f03e68016f42499bb25bf6e82)。
- 本地包版本：`pele@1.6.0-pocket.44da152`。
- npm 正式 `pele@1.6.0` 的 registry provenance 指向 [`659c3593ce43794dce7ec7ab45d424ad2de182a5`](https://github.com/obsidianmd/pele/tree/659c3593ce43794dce7ec7ab45d424ad2de182a5)；tarball integrity 已独立核对。这里回读了 registry 提供的 provenance，没有另行执行签名证明验证。
- 固定 commit 比正式版前进 7 个 commits。唯一运行时代码差异是 `src/text/label.ts` 的中日文断行修复，另有对应测试和文档。合成中文流程图在 320px 约束下，正式版输出宽 559px，固定版输出宽 362px；固定版仍不保证所有图都完全适配窄屏。
- 没有修改上游运行时代码。不同之处是本地打包范围、包版本和导出入口。首轮不引入其余图类型，也不提供 33 类型的 `lazy` 入口。

## 使用范围

包导出 `pele/core` 和 `pele/diagrams/flowchart`、`pele/diagrams/sequence`、`pele/diagrams/state`。根 `pele` 导出也是 core，**不会自动注册图类型**。

```ts
import { register, render } from 'pele/core';
import flowchart from 'pele/diagrams/flowchart';

register(flowchart);
const result = render('flowchart TD\nA[开始] --> B[完成]', {
  links: false,
  images: false,
  limit: 20_000,
  outputLimit: 700_000,
  maxEdges: 200,
  maxWidth: 320,
});
```

实际应用仍需负责围栏闭合判断、语法失败的源码回退、可终止 Worker、输出大小与尺寸限制、缓存上限、主题与阅读交互。这些策略不由本包实现。`maxEdges` 上游只约束 flowchart/agentflow，不约束 sequence/state；`outputLimit` 在 SVG 构造完成后检查，不能代替时间限制。

不可信图表应禁用 links/images，不提供 icons resolver；后者的返回值被上游作为可信 SVG 直接使用。Pele 默认允许图片联网，不可沿用默认值。作为 `img` 内容显示时，主题变量需要写入 SVG 本身，不能依赖页面 CSS 继承。源内样式可能覆盖部分主题色。

## 离线重建

在 Pocket 仓库根目录运行：

```sh
node vendor/pele/build.mjs
```

脚本只使用仓库现有的 **esbuild 0.28.2** 和 **TypeScript 5.9.3**，以及 Node、npm 和系统 tar；不联网、不安装上游开发依赖、不修改根 package.json/lock。工具版本不符会停止，避免不知情地产生不同包。

输入为 [source-44da152.tar.gz](source-44da152.tar.gz)，包含固定源码的 `src/`、原 package/tsconfig/README/LICENSE 及 CJK 回归测试，共 292 个文件；第一次引入时已逐一核对该 commit 的 Git blob ID。输入归档及逐文件 SHA256 在 [source-manifest.json](source-manifest.json)。源码解压到临时目录，构建结束即清理。

打包复用上游 esbuild 选项（ES2022、ESM、minify、UTF-8、拆分共享 chunk），仅选择 core 和三类图入口。类型生成使用上游 tsconfig，额外加入 `DOM.Iterable`，使现有 TypeScript 5.9.3 能正确识别 `FontFaceSet.size`。完整声明保留上游引用关系，运行时代码只有所选入口及依赖闭包。

输出：

- `pele-1.6.0-pocket.44da152.tgz`：122,498 bytes；SHA256 `7ff5ebf787b1533119af42144582d90c67d99ad0c90d211c9ebcf03d322ccbaf`。
- [package-manifest.json](package-manifest.json)：来源、工具版本、SRI、包尺寸与各运行时文件尺寸。
- 包内 `PROVENANCE.json`、完整 MIT、Pocket 说明和原始上游 README。

两次独立临时目录构建得到相同包 SHA256。最终包解压后，core 注册三类图、中文长标签断行、未注册其它图类型的检查通过。渲染和安全实验保留于 `.local/qa/mermaid-2026-10-19/evaluation/`；这些检查不等同于所有 Mermaid 语法、真机性能或完整安全审计通过。

以后升级需重新核对上游版本、中文断行差异和范围；包内容改变时同步更换本地版本与锁文件，不能覆盖同版本却保留旧 integrity。
