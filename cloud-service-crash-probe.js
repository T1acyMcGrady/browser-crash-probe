// ==UserScript==
// @name         Cloud Service Crash Probe
// @namespace    local.debug
// @version      0.1.0
// @description  Records memory growth, user actions, requests, and crash clues for browser-side troubleshooting.
// @match        https://www.baidu.com/*
// @match        https://*.baidu.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  if (window.CrashProbe) {
    return;
  }

  var CONFIG = {
    version: "0.1.0",
    storageKey: "__cloud_service_crash_probe__:" + location.origin,
    heartbeatMs: 1000,
    staleAfterMs: 4000,
    maxSamples: 600,
    maxActions: 200,
    maxRequests: 200,
    maxErrors: 200,
    maxCrashes: 10,
    panelZIndex: 2147483647,
    startupAlert: true,
    warningGrowthBytes: 10 * 1024 * 1024,
    dangerGrowthBytes: 30 * 1024 * 1024,
    flashDurationMs: 3000
  };

  var state = loadState();
  var sessionId = createId();
  var panel = null;
  var lastUrl = location.href;
  var lastPatched = false;
  var dragState = null;
  var panelFlashTimeout = null;
  var lastDangerAlertKey = null;

  bootstrap();

  function bootstrap() {
    capturePreviousCrash();
    state.current = createSession();
    persist();
    installLifecycleHooks();
    installUserActionHooks();
    installNetworkHooks();
    installErrorHooks();
    installHistoryHooks();
    startHeartbeat();
    createPanel();
    logAction("probe_started", {
      href: location.href,
      title: document.title
    });
    announceStartup();
    console.info("[CrashProbe] ready", window.CrashProbe.getStatus());
  }

  function announceStartup() {
    var message = "[CrashProbe] userscript executed on " + location.href;
    console.info(message);
    if (!CONFIG.startupAlert) {
      return;
    }
    try {
      window.alert("Crash Probe loaded");
    } catch (error) {
      console.warn("[CrashProbe] startup alert failed", error);
    }
  }

  function createSession() {
    return {
      sessionId: sessionId,
      version: CONFIG.version,
      startedAt: now(),
      lastSeenAt: now(),
      cleanExit: false,
      userAgent: navigator.userAgent,
      href: location.href,
      title: document.title,
      memorySamples: [],
      actions: [],
      requests: [],
      errors: [],
      counters: {
        heartbeats: 0
      }
    };
  }

  function capturePreviousCrash() {
    if (!state.current || !state.current.sessionId) {
      return;
    }
    var previous = state.current;
    var stale = now() - (previous.lastSeenAt || 0) > CONFIG.staleAfterMs;
    if (previous.cleanExit === false && stale) {
      var summary = summarizeCrash(previous);
      pushRing(state.crashes, summary, CONFIG.maxCrashes);
      state.lastCrash = summary;
    }
  }

  function startHeartbeat() {
    sampleMemory("heartbeat");
    setInterval(function () {
      if (!state.current) {
        return;
      }
      state.current.lastSeenAt = now();
      state.current.href = location.href;
      state.current.title = document.title;
      state.current.cleanExit = false;
      state.current.counters.heartbeats += 1;
      if (location.href !== lastUrl) {
        logAction("location_changed", {
          from: lastUrl,
          to: location.href
        });
        lastUrl = location.href;
      }
      sampleMemory("heartbeat");
      persist();
      updatePanel();
    }, CONFIG.heartbeatMs);
  }

  function sampleMemory(reason) {
    if (!state.current) {
      return;
    }
    var sample = {
      ts: now(),
      reason: reason,
      href: location.href,
      domNodes: document.getElementsByTagName("*").length,
      usedJSHeapSize: null,
      totalJSHeapSize: null,
      jsHeapSizeLimit: null
    };
    if (performance && performance.memory) {
      sample.usedJSHeapSize = performance.memory.usedJSHeapSize;
      sample.totalJSHeapSize = performance.memory.totalJSHeapSize;
      sample.jsHeapSizeLimit = performance.memory.jsHeapSizeLimit;
    }
    pushRing(state.current.memorySamples, sample, CONFIG.maxSamples);
  }

  function installLifecycleHooks() {
    function markCleanExit(reason) {
      if (!state.current) {
        return;
      }
      state.current.lastSeenAt = now();
      state.current.cleanExit = true;
      logAction("page_exit", { reason: reason });
      persist();
    }

    window.addEventListener("beforeunload", function () {
      markCleanExit("beforeunload");
    });

    window.addEventListener("pagehide", function () {
      markCleanExit("pagehide");
    });

    document.addEventListener("visibilitychange", function () {
      logAction("visibility_change", {
        state: document.visibilityState
      });
      persist();
    });
  }

  function installUserActionHooks() {
    document.addEventListener(
      "click",
      function (event) {
        var target = event.target;
        logAction("click", describeElement(target));
        sampleMemory("click");
        persist();
      },
      true
    );

    document.addEventListener(
      "submit",
      function (event) {
        logAction("submit", describeElement(event.target));
        persist();
      },
      true
    );

    document.addEventListener(
      "keydown",
      function (event) {
        if (!shouldRecordKey(event)) {
          return;
        }
        logAction("keydown", {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          target: describeElement(event.target)
        });
        persist();
      },
      true
    );
  }

  function installNetworkHooks() {
    if (lastPatched) {
      return;
    }
    lastPatched = true;

    if (window.fetch) {
      var originalFetch = window.fetch;
      window.fetch = function () {
        var args = Array.prototype.slice.call(arguments);
        var requestId = createId();
        var url = getRequestUrl(args[0]);
        logRequest({
          ts: now(),
          id: requestId,
          type: "fetch",
          stage: "start",
          method: getFetchMethod(args[0], args[1]),
          url: url
        });
        persist();
        return originalFetch.apply(this, args).then(function (response) {
          logRequest({
            ts: now(),
            id: requestId,
            type: "fetch",
            stage: "end",
            method: getFetchMethod(args[0], args[1]),
            url: url,
            status: response.status,
            ok: response.ok
          });
          persist();
          return response;
        }).catch(function (error) {
          logRequest({
            ts: now(),
            id: requestId,
            type: "fetch",
            stage: "error",
            method: getFetchMethod(args[0], args[1]),
            url: url,
            error: stringifyError(error)
          });
          logError("fetch_error", { url: url, error: stringifyError(error) });
          persist();
          throw error;
        });
      };
    }

    var xhrOpen = XMLHttpRequest.prototype.open;
    var xhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__crashProbeMeta = {
        id: createId(),
        method: method,
        url: url
      };
      return xhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      var meta = xhr.__crashProbeMeta || {
        id: createId(),
        method: "GET",
        url: "unknown"
      };
      logRequest({
        ts: now(),
        id: meta.id,
        type: "xhr",
        stage: "start",
        method: meta.method,
        url: meta.url
      });
      xhr.addEventListener("loadend", function () {
        logRequest({
          ts: now(),
          id: meta.id,
          type: "xhr",
          stage: "end",
          method: meta.method,
          url: meta.url,
          status: xhr.status
        });
        persist();
      }, { once: true });
      return xhrSend.apply(this, arguments);
    };
  }

  function installErrorHooks() {
    window.addEventListener("error", function (event) {
      logError("window_error", {
        message: event.message,
        source: event.filename,
        line: event.lineno,
        column: event.colno
      });
      persist();
    });

    window.addEventListener("unhandledrejection", function (event) {
      logError("unhandledrejection", {
        reason: stringifyError(event.reason)
      });
      persist();
    });
  }

  function installHistoryHooks() {
    var originalPushState = history.pushState;
    var originalReplaceState = history.replaceState;

    history.pushState = function () {
      var result = originalPushState.apply(this, arguments);
      logAction("history_pushState", { href: location.href });
      persist();
      return result;
    };

    history.replaceState = function () {
      var result = originalReplaceState.apply(this, arguments);
      logAction("history_replaceState", { href: location.href });
      persist();
      return result;
    };

    window.addEventListener("popstate", function () {
      logAction("popstate", { href: location.href });
      persist();
    });

    window.addEventListener("hashchange", function () {
      logAction("hashchange", { href: location.href });
      persist();
    });
  }

  function logAction(type, details) {
    if (!state.current) {
      return;
    }
    var memorySnapshot = captureMemorySnapshot();
    var baseline = firstMemorySample(state.current.memorySamples);
    var previousSample = lastItem(state.current.memorySamples);
    pushRing(state.current.actions, {
      ts: now(),
      type: type,
      href: location.href,
      title: document.title,
      details: details || {},
      memory: memorySnapshot ? {
        usedJSHeapSize: memorySnapshot.usedJSHeapSize,
        totalJSHeapSize: memorySnapshot.totalJSHeapSize,
        jsHeapSizeLimit: memorySnapshot.jsHeapSizeLimit,
        domNodes: memorySnapshot.domNodes,
        growthFromStart: getMemoryGrowth(memorySnapshot, baseline),
        growthFromPreviousSample: getMemoryGrowth(memorySnapshot, previousSample),
        heapUsageRate: getHeapUsageRate(memorySnapshot),
        limitUsageRate: getLimitUsageRate(memorySnapshot)
      } : null
    }, CONFIG.maxActions);
  }

  function logRequest(entry) {
    if (!state.current) {
      return;
    }
    pushRing(state.current.requests, entry, CONFIG.maxRequests);
  }

  function logError(type, details) {
    if (!state.current) {
      return;
    }
    pushRing(state.current.errors, {
      ts: now(),
      type: type,
      href: location.href,
      details: details || {}
    }, CONFIG.maxErrors);
  }

  function summarizeCrash(session) {
    var lastAction = lastItem(session.actions);
    var lastRequest = lastItem(session.requests);
    var lastError = lastItem(session.errors);
    var peakSample = peakMemorySample(session.memorySamples);
    return {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      lastSeenAt: session.lastSeenAt,
      durationMs: (session.lastSeenAt || 0) - (session.startedAt || 0),
      href: session.href,
      title: session.title,
      memoryPeak: peakSample,
      memorySampleCount: session.memorySamples.length,
      lastAction: lastAction,
      lastRequest: lastRequest,
      lastError: lastError,
      cleanExit: session.cleanExit
    };
  }

  function peakMemorySample(samples) {
    var best = null;
    for (var i = 0; i < samples.length; i += 1) {
      var sample = samples[i];
      if (!best) {
        best = sample;
        continue;
      }
      if ((sample.usedJSHeapSize || 0) > (best.usedJSHeapSize || 0)) {
        best = sample;
      }
    }
    return best;
  }

  function captureMemorySnapshot() {
    var sample = {
      ts: now(),
      reason: "action_snapshot",
      href: location.href,
      domNodes: document.getElementsByTagName("*").length,
      usedJSHeapSize: null,
      totalJSHeapSize: null,
      jsHeapSizeLimit: null
    };
    if (performance && performance.memory) {
      sample.usedJSHeapSize = performance.memory.usedJSHeapSize;
      sample.totalJSHeapSize = performance.memory.totalJSHeapSize;
      sample.jsHeapSizeLimit = performance.memory.jsHeapSizeLimit;
    }
    return sample;
  }

  function describeElement(target) {
    if (!target || !target.tagName) {
      return null;
    }
    var text = "";
    if (typeof target.innerText === "string") {
      text = target.innerText.trim().replace(/\s+/g, " ").slice(0, 120);
    }
    return {
      tag: target.tagName,
      id: target.id || "",
      className: typeof target.className === "string" ? target.className.slice(0, 120) : "",
      role: target.getAttribute && target.getAttribute("role"),
      name: target.getAttribute && target.getAttribute("name"),
      type: target.getAttribute && target.getAttribute("type"),
      text: text,
      selector: shortSelector(target)
    };
  }

  function shortSelector(element) {
    if (!element || !element.tagName) {
      return "";
    }
    var selector = element.tagName.toLowerCase();
    if (element.id) {
      selector += "#" + sanitizeSelectorPart(element.id);
    }
    if (typeof element.className === "string" && element.className.trim()) {
      var classes = element.className.trim().split(/\s+/).slice(0, 3);
      if (classes.length) {
        selector += "." + classes.map(sanitizeSelectorPart).join(".");
      }
    }
    return selector;
  }

  function sanitizeSelectorPart(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function shouldRecordKey(event) {
    var keys = ["Enter", "Tab", "Escape", "F5"];
    if (keys.indexOf(event.key) >= 0) {
      return true;
    }
    return event.ctrlKey || event.metaKey;
  }

  function createPanel() {
    ensurePanelStyles();
    var root = document.createElement("div");
    root.id = "__crash_probe_panel__";
    root.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "width:320px",
      "background:#111827",
      "color:#f9fafb",
      "font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "border-radius:12px",
      "box-shadow:0 12px 40px rgba(0,0,0,.35)",
      "z-index:" + CONFIG.panelZIndex,
      "padding:12px"
    ].join(";");

    root.innerHTML = [
      '<div data-probe-drag-handle="1" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;cursor:move;user-select:none;gap:8px;">',
      '<div style="display:flex;align-items:center;gap:8px;">',
      '<strong>Crash Probe</strong>',
      '<span data-probe-alert="1" style="display:none;background:#b91c1c;color:#fff;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700;">HIGH RISK</span>',
      "</div>",
      '<button data-probe-action="toggle" style="background:#374151;color:#fff;border:0;border-radius:8px;padding:4px 8px;cursor:pointer;">收起</button>',
      "</div>",
      '<div data-probe-body="1">',
      '<div data-probe-status="1" style="white-space:pre-wrap;margin-bottom:8px;"></div>',
      '<div style="margin:8px 0 6px;font-weight:600;">最近操作</div>',
      '<div data-probe-actions="1" style="max-height:180px;overflow:auto;background:rgba(255,255,255,.04);border-radius:8px;padding:8px;margin-bottom:8px;"></div>',
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">',
      '<button data-probe-action="export" style="background:#2563eb;color:#fff;border:0;border-radius:8px;padding:6px 10px;cursor:pointer;">导出 JSON</button>',
      '<button data-probe-action="clear" style="background:#b91c1c;color:#fff;border:0;border-radius:8px;padding:6px 10px;cursor:pointer;">清空记录</button>',
      '<button data-probe-action="log" style="background:#4b5563;color:#fff;border:0;border-radius:8px;padding:6px 10px;cursor:pointer;">控制台打印</button>',
      "</div>",
      "</div>"
    ].join("");

    root.addEventListener("click", function (event) {
      var action = event.target && event.target.getAttribute("data-probe-action");
      if (!action) {
        return;
      }
      if (action === "export") {
        window.CrashProbe.downloadReport();
      } else if (action === "clear") {
        window.CrashProbe.clear();
      } else if (action === "toggle") {
        togglePanel();
      } else if (action === "log") {
        console.log("[CrashProbe] report", window.CrashProbe.exportReport());
      }
      event.stopPropagation();
    });

    document.documentElement.appendChild(root);
    panel = root;
    restorePanelPosition();
    installDrag(root);
    updatePanel();
    exposeApi();
  }

  function installDrag(root) {
    var handle = root.querySelector("[data-probe-drag-handle='1']");
    if (!handle) {
      return;
    }

    handle.addEventListener("mousedown", function (event) {
      if (event.target && event.target.getAttribute("data-probe-action")) {
        return;
      }
      startDrag(event.clientX, event.clientY);
      event.preventDefault();
    });

    document.addEventListener("mousemove", function (event) {
      if (!dragState || !panel) {
        return;
      }
      var nextLeft = dragState.startLeft + (event.clientX - dragState.startX);
      var nextTop = dragState.startTop + (event.clientY - dragState.startY);
      applyPanelPosition(nextLeft, nextTop);
    });

    document.addEventListener("mouseup", function () {
      stopDrag();
    });
  }

  function startDrag(clientX, clientY) {
    if (!panel) {
      return;
    }
    var rect = panel.getBoundingClientRect();
    panel.style.left = rect.left + "px";
    panel.style.top = rect.top + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    dragState = {
      startX: clientX,
      startY: clientY,
      startLeft: rect.left,
      startTop: rect.top
    };
  }

  function stopDrag() {
    if (!dragState || !panel) {
      return;
    }
    dragState = null;
    savePanelPosition();
  }

  function applyPanelPosition(left, top) {
    if (!panel) {
      return;
    }
    var width = panel.offsetWidth || 320;
    var height = panel.offsetHeight || 200;
    var maxLeft = Math.max(0, window.innerWidth - width);
    var maxTop = Math.max(0, window.innerHeight - height);
    var clampedLeft = clamp(left, 0, maxLeft);
    var clampedTop = clamp(top, 0, maxTop);
    panel.style.left = clampedLeft + "px";
    panel.style.top = clampedTop + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function savePanelPosition() {
    if (!panel) {
      return;
    }
    if (!state.panel) {
      state.panel = {};
    }
    state.panel.left = panel.style.left || null;
    state.panel.top = panel.style.top || null;
    state.panel.right = panel.style.right || null;
    state.panel.bottom = panel.style.bottom || null;
    persist();
  }

  function restorePanelPosition() {
    if (!panel || !state.panel) {
      return;
    }
    if (state.panel.left && state.panel.top) {
      panel.style.left = state.panel.left;
      panel.style.top = state.panel.top;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      return;
    }
    if (state.panel.right) {
      panel.style.right = state.panel.right;
    }
    if (state.panel.bottom) {
      panel.style.bottom = state.panel.bottom;
    }
  }

  function togglePanel() {
    if (!panel) {
      return;
    }
    var body = panel.querySelector("[data-probe-body='1']");
    var button = panel.querySelector("[data-probe-action='toggle']");
    var collapsed = body.style.display === "none";
    body.style.display = collapsed ? "block" : "none";
    button.textContent = collapsed ? "收起" : "展开";
  }

  function expandPanel() {
    if (!panel) {
      return;
    }
    var body = panel.querySelector("[data-probe-body='1']");
    var button = panel.querySelector("[data-probe-action='toggle']");
    if (!body || !button) {
      return;
    }
    body.style.display = "block";
    button.textContent = "收起";
  }

  function triggerPanelFlash() {
    if (!panel) {
      return;
    }
    panel.classList.remove("crash-probe-flash");
    void panel.offsetWidth;
    panel.classList.add("crash-probe-flash");
    if (panelFlashTimeout) {
      clearTimeout(panelFlashTimeout);
    }
    panelFlashTimeout = setTimeout(function () {
      if (!panel) {
        return;
      }
      panel.classList.remove("crash-probe-flash");
      panelFlashTimeout = null;
    }, CONFIG.flashDurationMs);
  }

  function updatePanel() {
    if (!panel || !state.current) {
      return;
    }
    var statusNode = panel.querySelector("[data-probe-status='1']");
    var actionsNode = panel.querySelector("[data-probe-actions='1']");
    var alertNode = panel.querySelector("[data-probe-alert='1']");
    var peak = peakMemorySample(state.current.memorySamples);
    var currentSample = lastItem(state.current.memorySamples);
    var baseline = firstMemorySample(state.current.memorySamples);
    var growth = getMemoryGrowth(currentSample, baseline);
    var heapUsage = getHeapUsageRate(currentSample);
    var limitUsage = getLimitUsageRate(currentSample);
    var growthLevel = getGrowthLevel(growth);
    var latestAction = lastItem(state.current.actions);
    var latestActionLevel = getGrowthLevel(
      latestAction && latestAction.memory ? latestAction.memory.growthFromPreviousSample : null
    );
    var lastCrash = state.lastCrash;
    var trend = renderTrend(state.current.memorySamples);
    var lines = [
      "会话: " + state.current.sessionId.slice(0, 8),
      "当前/峰值: " +
        formatBytes(currentSample && currentSample.usedJSHeapSize) +
        " / " +
        formatBytes(peak && peak.usedJSHeapSize),
      "增长: " + formatSignedBytes(growth),
      "堆占比: " + formatPercent(heapUsage) +
        " | 总堆 " +
        formatBytes(currentSample && currentSample.totalJSHeapSize),
      "进程上限占比: " + formatPercent(limitUsage) +
        " | 限制 " +
        formatBytes(currentSample && currentSample.jsHeapSizeLimit),
      "DOM 节点: " + formatNumber(currentSample && currentSample.domNodes) +
        " | 采样数: " + state.current.memorySamples.length,
      "风险等级: " + growthLevel.label,
      "趋势: " + trend,
      "最后动作: " + formatAction(lastItem(state.current.actions))
    ];
    if (lastCrash) {
      lines.push(
        "上次疑似异常退出: " +
          formatTime(lastCrash.lastSeenAt) +
          " | 最后动作 " +
          formatAction(lastCrash.lastAction)
      );
    } else {
      lines.push("上次疑似异常退出: 无");
    }
    statusNode.textContent = lines.join("\n");
    if (actionsNode) {
      actionsNode.innerHTML = renderActionList(state.current.actions);
    }
    if (alertNode) {
      alertNode.style.display = latestActionLevel.isDanger ? "inline-flex" : "none";
      var actionAlertKey = latestAction ? String(latestAction.ts) + ":" + String(latestAction.type) : null;
      if (latestActionLevel.isDanger && actionAlertKey && actionAlertKey !== lastDangerAlertKey) {
        lastDangerAlertKey = actionAlertKey;
        expandPanel();
        triggerPanelFlash();
      }
    }
  }

  function exposeApi() {
    window.CrashProbe = {
      exportReport: function () {
        return clone({
          meta: {
            version: CONFIG.version,
            generatedAt: now(),
            href: location.href
          },
          state: state
        });
      },
      downloadReport: function () {
        var payload = JSON.stringify(window.CrashProbe.exportReport(), null, 2);
        var blob = new Blob([payload], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var link = document.createElement("a");
        link.href = url;
        link.download = "crash-probe-" + Date.now() + ".json";
        link.click();
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 1000);
      },
      clear: function () {
        localStorage.removeItem(CONFIG.storageKey);
        lastDangerAlertKey = null;
        state = {
          crashes: [],
          lastCrash: null,
          current: createSession()
        };
        persist();
        updatePanel();
      },
      getStatus: function () {
        var peak = peakMemorySample(state.current.memorySamples);
        var current = lastItem(state.current.memorySamples);
        var baseline = firstMemorySample(state.current.memorySamples);
        return {
          currentSessionId: state.current.sessionId,
          currentUsedJSHeapSize: current && current.usedJSHeapSize,
          currentTotalJSHeapSize: current && current.totalJSHeapSize,
          currentJsHeapSizeLimit: current && current.jsHeapSizeLimit,
          currentPeakUsedJSHeapSize: peak && peak.usedJSHeapSize,
          currentGrowthFromStart: getMemoryGrowth(current, baseline),
          currentHeapUsageRate: getHeapUsageRate(current),
          currentLimitUsageRate: getLimitUsageRate(current),
          currentDomNodes: current && current.domNodes,
          lastCrash: state.lastCrash
        };
      },
      printLastCrash: function () {
        console.log("[CrashProbe] lastCrash", state.lastCrash);
      }
    };
  }

  function persist() {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(state));
    } catch (error) {
      console.warn("[CrashProbe] persist failed", error);
    }
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(CONFIG.storageKey);
      if (!raw) {
        return {
          crashes: [],
          lastCrash: null,
          current: null,
          panel: null
        };
      }
      var parsed = JSON.parse(raw);
      parsed.crashes = Array.isArray(parsed.crashes) ? parsed.crashes : [];
      parsed.lastCrash = parsed.lastCrash || null;
      parsed.current = parsed.current || null;
      parsed.panel = parsed.panel || null;
      return parsed;
    } catch (error) {
      console.warn("[CrashProbe] load failed, resetting", error);
      return {
        crashes: [],
        lastCrash: null,
        current: null,
        panel: null
      };
    }
  }

  function createId() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return "cp-" + Math.random().toString(16).slice(2) + "-" + now();
  }

  function getRequestUrl(input) {
    if (!input) {
      return "unknown";
    }
    if (typeof input === "string") {
      return input;
    }
    if (input.url) {
      return input.url;
    }
    return "unknown";
  }

  function getFetchMethod(input, init) {
    if (init && init.method) {
      return init.method;
    }
    if (input && input.method) {
      return input.method;
    }
    return "GET";
  }

  function pushRing(list, value, max) {
    list.push(value);
    if (list.length > max) {
      list.splice(0, list.length - max);
    }
  }

  function lastItem(list) {
    if (!list || !list.length) {
      return null;
    }
    return list[list.length - 1];
  }

  function stringifyError(error) {
    if (!error) {
      return "unknown";
    }
    if (typeof error === "string") {
      return error;
    }
    if (error.stack) {
      return String(error.stack).slice(0, 500);
    }
    if (error.message) {
      return error.message;
    }
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch (jsonError) {
      return String(error);
    }
  }

  function formatBytes(value) {
    if (!value && value !== 0) {
      return "n/a";
    }
    var units = ["B", "KB", "MB", "GB"];
    var size = value;
    var index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return size.toFixed(index === 0 ? 0 : 1) + " " + units[index];
  }

  function formatSignedBytes(value) {
    if (!value && value !== 0) {
      return "n/a";
    }
    if (value > 0) {
      return "+" + formatBytes(value);
    }
    if (value < 0) {
      return "-" + formatBytes(Math.abs(value));
    }
    return formatBytes(0);
  }

  function formatPercent(value) {
    if (!value && value !== 0) {
      return "n/a";
    }
    return (value * 100).toFixed(1) + "%";
  }

  function formatNumber(value) {
    if (!value && value !== 0) {
      return "n/a";
    }
    return Number(value).toLocaleString();
  }

  function firstMemorySample(samples) {
    if (!samples || !samples.length) {
      return null;
    }
    return samples[0];
  }

  function getMemoryGrowth(current, baseline) {
    if (!current || !baseline) {
      return null;
    }
    if (current.usedJSHeapSize == null || baseline.usedJSHeapSize == null) {
      return null;
    }
    return current.usedJSHeapSize - baseline.usedJSHeapSize;
  }

  function getHeapUsageRate(sample) {
    if (!sample || sample.usedJSHeapSize == null || sample.totalJSHeapSize == null || sample.totalJSHeapSize <= 0) {
      return null;
    }
    return sample.usedJSHeapSize / sample.totalJSHeapSize;
  }

  function getLimitUsageRate(sample) {
    if (!sample || sample.usedJSHeapSize == null || sample.jsHeapSizeLimit == null || sample.jsHeapSizeLimit <= 0) {
      return null;
    }
    return sample.usedJSHeapSize / sample.jsHeapSizeLimit;
  }

  function renderTrend(samples) {
    if (!samples || !samples.length) {
      return "n/a";
    }
    var chars = "▁▂▃▄▅▆▇█";
    var picked = samples.slice(-24);
    var min = null;
    var max = null;
    var values = [];
    for (var i = 0; i < picked.length; i += 1) {
      var value = picked[i].usedJSHeapSize || 0;
      values.push(value);
      if (min === null || value < min) {
        min = value;
      }
      if (max === null || value > max) {
        max = value;
      }
    }
    if (max === min) {
      return repeatChar(chars[0], values.length);
    }
    var output = "";
    for (var j = 0; j < values.length; j += 1) {
      var normalized = (values[j] - min) / (max - min);
      var index = Math.min(chars.length - 1, Math.floor(normalized * chars.length));
      output += chars[index];
    }
    return output;
  }

  function repeatChar(value, count) {
    var output = "";
    for (var i = 0; i < count; i += 1) {
      output += value;
    }
    return output;
  }

  function formatAction(action) {
    if (!action) {
      return "n/a";
    }
    var name = action.type || "unknown";
    if (action.details && action.details.target && action.details.target.text) {
      name += " [" + action.details.target.text + "]";
    } else if (action.details && action.details.text) {
      name += " [" + action.details.text + "]";
    } else if (action.details && action.details.selector) {
      name += " [" + action.details.selector + "]";
    }
    if (action.memory && action.memory.usedJSHeapSize != null) {
      name +=
        " | mem " +
        formatBytes(action.memory.usedJSHeapSize) +
        " | growth " +
        formatSignedBytes(action.memory.growthFromStart);
    }
    return name;
  }

  function renderActionList(actions) {
    if (!actions || !actions.length) {
      return '<div style="opacity:.7;">暂无操作记录</div>';
    }
    var recent = actions.slice(-10).reverse();
    var html = [];
    for (var i = 0; i < recent.length; i += 1) {
      var action = recent[i];
      var memory = action.memory || {};
      var growthFromStart = memory.growthFromStart;
      var growthFromPrevious = memory.growthFromPreviousSample;
      var level = getGrowthLevel(growthFromPrevious);
      var label = shortActionLabel(action);
      if (level.isDanger) {
        label = "★ " + label;
      }
      html.push(
        '<div style="padding:6px 8px;border-radius:8px;margin-bottom:6px;background:' +
          level.background +
          ';border:1px solid ' +
          level.border +
          ';border-bottom:' +
          (i === recent.length - 1 ? '0' : '1px solid rgba(255,255,255,.08)') +
          ';">' +
          '<div style="font-weight:600;">' + escapeHtml(label) + '</div>' +
          '<div style="opacity:.78;">' +
          escapeHtml(formatTime(action.ts)) +
          '</div>' +
          '<div style="opacity:.95;color:' + level.text + ';">' +
          '内存 ' + escapeHtml(formatBytes(memory.usedJSHeapSize)) +
          ' | 累计 ' + escapeHtml(formatSignedBytes(growthFromStart)) +
          ' | 本次 ' + escapeHtml(formatSignedBytes(growthFromPrevious)) +
          ' | ' + escapeHtml(level.label) +
          '</div>' +
          '</div>'
      );
    }
    return html.join("");
  }

  function shortActionLabel(action) {
    if (!action) {
      return "n/a";
    }
    var text = action.type || "unknown";
    if (action.details && action.details.target && action.details.target.text) {
      text += " [" + action.details.target.text + "]";
    } else if (action.details && action.details.text) {
      text += " [" + action.details.text + "]";
    } else if (action.details && action.details.selector) {
      text += " [" + action.details.selector + "]";
    }
    return text;
  }

  function getGrowthLevel(growthBytes) {
    if (growthBytes == null) {
      return {
        label: "未知",
        background: "rgba(107,114,128,.12)",
        border: "rgba(107,114,128,.35)",
        text: "#e5e7eb",
        isDanger: false
      };
    }
    if (growthBytes >= CONFIG.dangerGrowthBytes) {
      return {
        label: "高风险",
        background: "rgba(220,38,38,.18)",
        border: "rgba(248,113,113,.55)",
        text: "#fecaca",
        isDanger: true
      };
    }
    if (growthBytes >= CONFIG.warningGrowthBytes) {
      return {
        label: "预警",
        background: "rgba(217,119,6,.18)",
        border: "rgba(251,191,36,.55)",
        text: "#fde68a",
        isDanger: false
      };
    }
    if (growthBytes > 0) {
      return {
        label: "轻微增长",
        background: "rgba(37,99,235,.15)",
        border: "rgba(96,165,250,.4)",
        text: "#bfdbfe",
        isDanger: false
      };
    }
    return {
      label: "稳定/回落",
      background: "rgba(5,150,105,.16)",
      border: "rgba(52,211,153,.42)",
      text: "#a7f3d0",
      isDanger: false
    };
  }

  function formatTime(value) {
    if (!value) {
      return "n/a";
    }
    try {
      return new Date(value).toLocaleString();
    } catch (error) {
      return String(value);
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function now() {
    return Date.now();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function ensurePanelStyles() {
    if (document.getElementById("__crash_probe_styles__")) {
      return;
    }
    var style = document.createElement("style");
    style.id = "__crash_probe_styles__";
    style.textContent = [
      "@keyframes crashProbeBlink {",
      "  0% { box-shadow: 0 12px 40px rgba(0,0,0,.35); transform: scale(1); }",
      "  25% { box-shadow: 0 0 0 3px rgba(248,113,113,.95), 0 0 24px rgba(248,113,113,.6), 0 12px 40px rgba(0,0,0,.35); transform: scale(1.01); }",
      "  50% { box-shadow: 0 12px 40px rgba(0,0,0,.35); transform: scale(1); }",
      "  75% { box-shadow: 0 0 0 3px rgba(248,113,113,.95), 0 0 24px rgba(248,113,113,.6), 0 12px 40px rgba(0,0,0,.35); transform: scale(1.01); }",
      "  100% { box-shadow: 0 12px 40px rgba(0,0,0,.35); transform: scale(1); }",
      "}",
      "#__crash_probe_panel__.crash-probe-flash {",
      "  animation: crashProbeBlink 0.9s ease-in-out 3;",
      "}"
    ].join("\n");
    document.documentElement.appendChild(style);
  }
})();
