# Safecafe Responsive UI Implementation Plan

> This is a completed implementation plan retained as engineering history. Prefer current source code and `TESTING.md` for product behavior.

**Goal:** 修复 Safecafe 在 320–1181px 范围内的 Agent、验证者列表和持仓布局问题，并让 UI Sweep 持续覆盖断点边界与大屏。

**Architecture:** 保留现有 React 组件与页面信息架构。组件状态使用与 CSS 相同的 820px 移动边界；验证者列表使用 Container Query 按实际面板宽度切换表格/卡片；UI Sweep 在现有完整流程后运行一次独立响应式矩阵。

**Tech Stack:** React 19、TypeScript、CSS Container Queries、Playwright、现有 `createWebTestDriver`/`createMockChain`。

## Global Constraints

- 不隐藏移动端核心数据或交易功能。
- 移动端交互目标不小于 `44×44px`。
- 保留 1440px 以上现有最大内容宽度。
- 不新增依赖，不修改链上业务逻辑，不自动 commit。
- 所有 shell 命令使用 `pnpm` 并由 `rtk` 前缀执行。

---

### Task 1: 建立多分辨率失败回归

**Files:**
- Modify: `scripts/e2e-ui-sweep.mjs`

**Interfaces:**
- Consumes: `createMockChain`, `createWebTestDriver`, `screenshot`, `recordFinding`
- Produces: `responsiveViewports`, `runResponsiveMatrix(browser)`, `collectResponsiveIssues(page, viewport, route)`

- [ ] **Step 1: 添加响应式 viewport 矩阵**

在完整交互轮次结束后只运行一次：

```js
const responsiveViewports = [
  { name: "phone-320x568", width: 320, height: 568 },
  { name: "phone-360x800", width: 360, height: 800 },
  { name: "tablet-768x1024", width: 768, height: 1024 },
  { name: "edge-820x1180", width: 820, height: 1180 },
  { name: "edge-821x1180", width: 821, height: 1180 },
  { name: "landscape-900x700", width: 900, height: 700 },
  { name: "tablet-1024x768", width: 1024, height: 768 },
  { name: "edge-1180x820", width: 1180, height: 820 },
  { name: "edge-1181x820", width: 1181, height: 820 },
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "desktop-1920x1080", width: 1920, height: 1080 },
  { name: "desktop-2560x1440", width: 2560, height: 1440 },
]
```

每个 viewport 依次加载 `/`、`/validators`、`/settings`，再打开 Agent；截图文件使用 `responsive-<viewport>-<route>.png`。

- [ ] **Step 2: 添加可判定的响应式断言**

`collectResponsiveIssues` 必须检测并记录：

```js
{
  documentOverflow,
  clippedInteractiveElements,
  dialogViewportOverflow,
  launcherInteractiveOverlaps,
}
```

仅忽略位于显式横向滚动容器内的元素；Agent 弹窗任意一边越界均为 blocker。

- [ ] **Step 3: 运行测试确认当前实现失败**

Run: `rtk env UI_SWEEP_ROUNDS=1 pnpm test:e2e:ui-sweep`

Expected: FAIL，至少包含 768/820 Agent 弹窗越界和 821–1181 验证者操作裁切。

---

### Task 2: 统一 Agent 响应式边界并实现贴边标签

**Files:**
- Modify: `src/app/AgentLauncher.tsx`
- Modify: `src/styles.css`
- Test: `scripts/e2e-ui-sweep.mjs`
- Test: `scripts/e2e-test.mjs`

**Interfaces:**
- Consumes: `AgentChatDialog` 的 `anchor: { x: number; y: number } | null`
- Produces: `mobileAgentMediaQuery = "(max-width: 820px)"`

- [ ] **Step 1: 用 matchMedia 替代 720px 判断**

```ts
const mobileAgentMediaQuery = "(max-width: 820px)"

function readMobileAgentLayout() {
  return typeof window !== "undefined" && window.matchMedia(mobileAgentMediaQuery).matches
}
```

初始化 `isMobile` 使用该函数；effect 监听 `MediaQueryList` 的 `change`，并继续在 resize/orientationchange 时 clamp launcher 位置。

- [ ] **Step 2: 保证移动范围不传桌面 anchor**

保持现有接口：

```tsx
anchor={isMobile ? null : position}
```

768px 和 820px 因 `isMobile === true` 使用 CSS 底部 Sheet，不再获得 `dialogPosition()` 的 inline left/top。

- [ ] **Step 3: 将 1180px 及以下浮球改为贴边标签**

在 `@media (max-width: 1180px)` 中设置贴边标签，并在 `@media (max-width: 820px)` 中增加页面底部安全留白：
组件同时使用 `matchMedia("(max-width: 1180px)")` 将可拖拽入口切换为 compact/fixed 模式，避免配置开启时绕过该样式。

```css
.agent-launcher.fixed {
  right: max(0px, env(safe-area-inset-right));
  bottom: max(16px, env(safe-area-inset-bottom));
  width: 44px;
  height: 44px;
  border-radius: 14px 0 0 14px;
  opacity: 0.88;
}

@media (max-width: 820px) {
.page {
  padding-bottom: max(96px, calc(72px + env(safe-area-inset-bottom)));
}
}
```

图标和现有 `aria-label` 保持不变，不增加可见长文案。

- [ ] **Step 4: 运行 Agent 响应式回归**

Run: `rtk env UI_SWEEP_ROUNDS=1 pnpm test:e2e:ui-sweep`

Expected: 768px、820px 的 `dialogViewportOverflow` 消失；其他验证者相关失败仍保留。

---

### Task 3: 让验证者列表按容器宽度切换布局

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/styles.css`
- Test: `scripts/e2e-ui-sweep.mjs`

**Interfaces:**
- Produces: named container `validators-panel`

- [ ] **Step 1: 声明验证者容器**

确保 Validators 页面的 `FullPanel` 传入 `className="validators-panel"`，再声明容器：

```css
.validators-panel {
  container-name: validators-panel;
  container-type: inline-size;
}
```

- [ ] **Step 2: 抽取中等宽度卡片布局**

新增：

```css
@container validators-panel (max-width: 1040px) {
  .validator-header { display: none; }
  .validator-list { overflow: visible; }
  .validator-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "identity status"
      "commission participation"
      "total your"
      "actions actions";
    min-width: 0;
  }
}
```

将现有 `@media (max-width: 820px)` 中相同的 row area、stat area、actions area 规则迁入该 container query，避免重复定义。

- [ ] **Step 3: 验证 821–1181px 操作完整可见**

Run: `rtk env UI_SWEEP_ROUNDS=1 pnpm test:e2e:ui-sweep`

Expected: 821、900、1024、1180、1181 的 `clippedInteractiveElements` 为 0。

---

### Task 4: 修复 320–360px 单列信息重叠

**Files:**
- Modify: `src/styles.css`
- Test: `scripts/e2e-ui-sweep.mjs`

**Interfaces:**
- Consumes: Task 3 的 validator card grid areas

- [ ] **Step 1: 添加窄屏 validator 单列规则**

在 `@media (max-width: 420px)` 中设置：

```css
.validator-row {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas:
    "identity"
    "status"
    "participation"
    "commission"
    "total"
    "your"
    "actions";
}

.validator-row .status-badge {
  width: fit-content;
  justify-self: start;
}

.validator-row-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 44px;
}
```

- [ ] **Step 2: 重排 Dashboard 持仓行**

```css
.position-row {
  grid-template-columns: auto minmax(0, 1fr);
}

.position-amount {
  grid-column: 2;
  justify-items: start;
}
```

进度条继续使用现有 `grid-column: 1 / -1`。

- [ ] **Step 3: 运行窄屏回归**

Run: `rtk env UI_SWEEP_ROUNDS=1 pnpm test:e2e:ui-sweep`

Expected: 320px、360px 无元素越界、交互遮挡或字段重叠 finding。

---

### Task 5: 完整验证与截图审查

**Files:**
- Verify: `scripts/e2e-ui-sweep.mjs`
- Verify: `src/app/AgentLauncher.tsx`
- Verify: `src/styles.css`

- [ ] **Step 1: 静态检查**

Run: `rtk pnpm check`

Expected: exit 0，locale、TypeScript、Biome 全部通过。

- [ ] **Step 2: 完整 UI Sweep**

Run: `rtk pnpm test:e2e:ui-sweep`

Expected: 3 轮完整流程和一次响应式矩阵均完成，`0 blocker / 0 warning`。

- [ ] **Step 3: 运行受影响 E2E**

Run: `rtk pnpm test:e2e`

Run: `rtk pnpm test:agent`

Expected: 两条命令均 exit 0。

- [ ] **Step 4: 人工审查最新截图**

按 Dashboard、Validators、Settings、Agent 分组检查 320、360、768、820、821、900、1024、1180、1181、1440、1920、2560px；确认无文字覆盖、被裁切操作或弹窗越界。

- [ ] **Step 5: 清理临时资源**

停止本次启动的 Vite/Wrangler/Chromium 进程，删除 `/tmp` 联系图；保留 `output/playwright/` 原始测试截图。不创建 commit。
