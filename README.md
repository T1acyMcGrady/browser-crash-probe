# browser-crash-probe

Browser-side crash and memory probe for troubleshooting page crashes, memory growth, and last-user-action trails.

这是一个浏览器侧排查脚本，用来记录：

- `performance.memory` 的增长轨迹
- 最近的点击、提交、关键按键
- 最近的 `fetch` / `XMLHttpRequest`
- 最近的 `window error` / `unhandledrejection`
- 上一次疑似异常退出前的最后动作、最后请求、最后错误

每一条用户操作日志现在都会附带：

- 当时的 `usedJSHeapSize`
- 当时的 `totalJSHeapSize`
- 相对本次会话起点的增长值
- 相对上一次采样点的增长值
- 当时的堆占比和 DOM 节点数

它不依赖服务端，数据默认保存在当前站点的 `localStorage`。

## 文件

- `cloud-service-crash-probe.js`

## 适用场景

- 客户反馈页面切换一段时间后崩溃
- 需要判断崩溃前内存是否快速上涨
- 需要知道崩溃前最后一次操作、最后一次请求、最后一次前端异常

## 安装方式

### 方式 1：Tampermonkey

1. 安装 Tampermonkey
2. 新建脚本
3. 把 `cloud-service-crash-probe.js` 全部内容粘进去
4. 如有需要，把顶部的 `@match` 改成目标域名，例如：

```js
// @match https://www.baidu.com/*
```

5. 保存并刷新页面

### 方式 2：Chrome DevTools Snippets

1. 打开 Chrome DevTools
2. 进入 `Sources` -> `Snippets`
3. 新建一个 snippet
4. 把 `cloud-service-crash-probe.js` 内容粘进去
5. 打开目标页面后手动运行一次

这种方式适合临时复现，不适合长期跟客户环境跑，因为页面刷新后需要重新执行。

## 使用方式

脚本加载后，页面右下角会出现 `Crash Probe` 面板。

面板会展示：

- 当前会话 ID
- 当前内存 / 峰值内存
- 相对本次会话起点的内存增长量
- 当前 `usedJSHeapSize / totalJSHeapSize` 占比
- 当前 `usedJSHeapSize / jsHeapSizeLimit` 占比
- 最近 24 个采样点的简易趋势条
- 最近 10 次操作列表，以及每次操作后的内存、累计增长、本次增量
- 上次疑似异常退出摘要

最近操作列表会自动做颜色告警：

- 绿色：稳定或回落
- 蓝色：轻微增长
- 黄色：预警，默认单次操作后增长超过 `10MB`
- 红色：高风险，默认单次操作后增长超过 `30MB`

当出现红色高风险操作时，面板会自动展开、顶部显示 `HIGH RISK`，并对该条操作自动打星标和闪烁提醒。

如果浏览器支持 `performance.memory`，这些值会每秒刷新一次，可以边操作边看页面内存是否持续抬升。

按钮功能：

- `导出 JSON`：下载完整诊断数据
- `清空记录`：清掉本地缓存
- `控制台打印`：把当前报告打印到控制台

## 崩溃后怎么查

如果页面是异常退出或崩溃，通常不会触发正常的 `beforeunload/pagehide`。脚本会把这种情况当成一次“疑似异常退出”。

下次重新打开同域页面并再次加载脚本后，面板里会显示：

- 上次异常退出时间
- 上次异常退出前最后动作
- 上次异常退出前最后请求
- 上次异常退出前最后错误
- 上次会话内存峰值
- 上次异常退出前最近 `100` 次操作
- 上次异常退出前最近 `200` 个内存采样

也可以在控制台执行：

```js
CrashProbe.getStatus()
CrashProbe.printLastCrash()
CrashProbe.exportReport()
CrashProbe.downloadReport()
```

其中 `CrashProbe.getStatus()` 会直接返回当前实时内存指标，包括：

- `currentUsedJSHeapSize`
- `currentTotalJSHeapSize`
- `currentJsHeapSizeLimit`
- `currentPeakUsedJSHeapSize`
- `currentGrowthFromStart`
- `currentHeapUsageRate`
- `currentLimitUsageRate`

## 报告重点字段

导出的 JSON 里重点看：

- `state.lastCrash.memoryPeak`
- `state.lastCrash.lastAction`
- `state.lastCrash.lastRequest`
- `state.lastCrash.lastError`
- `state.lastCrash.recentActions`
- `state.lastCrash.recentMemorySamples`
- `state.lastCrash.recentRequests`
- `state.lastCrash.recentErrors`
- `state.current.memorySamples`
- `state.current.actions`
- `state.current.requests`
- `state.current.errors`

其中：

- `state.lastCrash.recentActions[*].memory` 是崩溃前窗口内每次操作对应的内存数据
- `state.lastCrash.recentMemorySamples` 可以直接用来判断哪一段开始持续上涨
- `state.current.actions[*].memory` 是当前活跃会话里每次操作对应的内存数据

## 限制

- `performance.memory` 主要在 Chromium 浏览器可用
- 如果客户没有重新打开同域页面，脚本拿不到“上次异常退出”的摘要展示
- 如果浏览器或系统在极端情况下来不及把最后一次事件写入 `localStorage`，最后一步操作可能会缺失，但最近一段轨迹通常还在
- 这个脚本是排查工具，不建议长期全量给所有用户开启
