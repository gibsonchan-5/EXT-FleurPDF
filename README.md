# EXT-FleurPDF

FleurPDF 的**移动端手写批注测试仓库**。存在的唯一目的：让你能在真机（iPad / Android 平板）上通过 BRAT 装上还没进社区市场的手写批注功能，验证手感后再决定是否毕业合并。

| 项目 | 值 |
|---|---|
| 插件 id | `fleur-pdf-mobile` |
| 显示名 | `FleurPDF Mobile` |
| 版本线 | 独立，从 `0.1.0` 起 |
| 安装方式 | 只能通过 BRAT，**不提交社区市场** |
| 插件目录 | `.obsidian/plugins/fleur-pdf-mobile/` |
| 批注数据目录 | `.obsidian/plugins/fleur-pdf/data/`（与社区版共用，见下文） |

## 为什么要单独一个仓库

社区版 `FleurPDF 1.5.15` 已发布且已被用户安装，它的 `main.js` 里**完全没有手写批注模块** —— 社区版产物 117,527 B、`lasso` 零命中；含移动端的构建是 225,655 B、`lasso` 84 命中。手写功能要在真机上反复验手感，走社区市场发版太重。单独开一个仓库用 BRAT 迭代，既不污染主仓库的 Release 列表，也不影响主仓库的社区审核流程。

## 用 BRAT 安装（移动端）

1. Obsidian 移动端 → 设置 → 第三方插件 → 关闭「受限模式」；
2. 设置 → 第三方插件 → 浏览 → 搜索 `BRAT`（Obsidian42 - BRAT）→ 安装并启用；
3. BRAT 设置 → `Add Beta plugin` → 填入 `gibsonchan-5/EXT-FleurPDF` → `Add Plugin`；
4. 回到第三方插件列表，启用 `FleurPDF Mobile`；
5. **若同一个 vault 里还启用了社区版 `FleurPDF`，请把它禁掉** —— 两者共用同一套 CSS 类名（`.fleur-pdf-*`），同时启用会互相干扰样式。

安装或更新后需完全退出 Obsidian（iOS 上从多任务里划掉）再重新打开，插件才会重新加载。

## 与社区版的关系

**批注数据共用，设置各自独立。**

- **批注数据**：测试版把数据目录写死指向 `plugins/fleur-pdf/data/`（见 `src/store.ts` 里的 `SHARED_DATA_PLUGIN_ID`）。这样真机上打开已有的 PDF 能直接看到社区版积累的批注，才能验证「手写批注与已有批注共存」这个核心场景 —— 否则新 id 会推导出一个空目录，打开什么都是空的，测不出真实体验。
- **插件设置**：`data.json` 各自独立，iPad 上首次安装需要重新配置一次。API Key 若用「系统钥匙串」模式存储，密钥 id 是全局的（`fleur-pdf-api-key`），可能不需要重填。
- **版本号**：独立成线（`0.1.x`），与社区版 `1.5.x` 没有对应关系。

## 开发与发版

```sh
npm install
npm run build          # tsc 类型检查 + esbuild production 打包
```

发版走 GitHub Actions，推 tag 即触发：

```sh
# 先把 manifest.json 与 package.json 的 version 改成同一个版本号
git commit -am "0.1.1"
git push
git tag 0.1.1 && git push origin 0.1.1
```

工作流会先校验「tag 名 == manifest 版本号」，不一致直接失败，避免出现 BRAT 拉到的版本与 tag 对不上的经典故障。版本号不带 `v` 前缀。

## 毕业合并回主仓库

测试满意后，把代码搬回 `gibsonchan-5/fleur-pdf`：

1. 用本仓库的 `src/`、`styles.css` 全量覆盖主仓库同名内容；
2. `manifest.json` 的 `id` 改回 `fleur-pdf`，`name` 改回 `FleurPDF`；
3. 删掉 `src/store.ts` 里的 `SHARED_DATA_PLUGIN_ID` 常量与那行三元判断 —— id 一旦改回 `fleur-pdf`，该分支自动退化为原始行为，常量可一并移除；
4. 把主仓库版本号 bump 到测试版的最终版本；
5. 按主仓库的发布流程走：隐私扫描 → bump → 构建部署 → commit → tag → push → Release。

## 与主仓库的关系

本仓库是主仓库的**超集**：功能代码完全包含主仓库的内容，额外多了 `src/mobile/`（手写批注引擎与 UI，4061 行）与 `src/platform.ts`。完整功能文档见主仓库 [gibsonchan-5/fleur-pdf](https://github.com/gibsonchan-5/fleur-pdf)。

## 许可

MIT，与主仓库一致。
