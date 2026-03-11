// ==UserScript==
// @name         Nexus Mods Enhancer - Mod Page
// @namespace    https://github.com/Akiway
// @author       Akiway
// @version      1.0.0
// @description  Adds a new chart on the Stats tab to show monthly unique-download totals and month-over-month evolution.
// @match        https://www.nexusmods.com/cyberpunk2077/mods/*
// @updateURL    https://github.com/Akiway/Tampermonkey-Nexus/raw/refs/heads/main/scripts/mod-page-ux.user.js
// @downloadURL  https://github.com/Akiway/Tampermonkey-Nexus/raw/refs/heads/main/scripts/mod-page-ux.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const STYLE_ID = "tm-unique-dl-evolution-style";
  const SECTION_ID = "tm-unique-dl-evolution-section";
  const CONTAINER_ID = "tm-unique-dl-evolution-chart";
  const NOTICE_ID = "tm-modpage-notice";
  const MAX_INIT_ATTEMPTS = 50;
  const RETRY_DELAY_MS = 350;
  const DEFAULT_GRAPH_WIDTH = 1260;
  const GRAPH_SECTION_PADDING = 40;
  const MIN_GRAPH_WIDTH = 320;

  let initAttempts = 0;
  let retryTimer = 0;
  let resizeTimer = 0;
  let isInitInProgress = false;
  let chartInstance = null;
  let rootResizeObserver = null;

  function isStatsTab() {
    const queryTab = new URL(window.location.href).searchParams.get("tab");
    return queryTab === "stats";
  }

  function decodeJsString(value) {
    return String(value ?? "")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\\//g, "/")
      .replace(/\\\\/g, "\\");
  }

  function getStatsUrlFromInlineScript() {
    const scriptNodes = Array.from(document.querySelectorAll("script"));
    for (const script of scriptNodes) {
      const text = script.textContent || "";
      if (!text.includes("mod_monthly_stats")) {
        continue;
      }

      const explicitMatch = text.match(/var\s+statsUrl\s*=\s*["']([^"']+)["']/);
      if (explicitMatch?.[1]) {
        return decodeJsString(explicitMatch[1]);
      }

      const fallbackMatch = text.match(/["'](https?:\\\/\\\/staticstats\.nexusmods\.com\\\/mod_monthly_stats\\\/[^"']+)["']/);
      if (fallbackMatch?.[1]) {
        return decodeJsString(fallbackMatch[1]);
      }
    }

    return "";
  }

  function getStatsUrlFromHeading() {
    const heading = document.querySelector(".tab-stats h2[data-game-id][data-mod-id]");
    const gameId = heading?.getAttribute("data-game-id");
    const modId = heading?.getAttribute("data-mod-id");

    if (!/^\d+$/.test(String(gameId ?? "")) || !/^\d+$/.test(String(modId ?? ""))) {
      return "";
    }

    return `https://staticstats.nexusmods.com/mod_monthly_stats/${gameId}/${modId}.json`;
  }

  function toMonthTimestamp(dateKey) {
    const match = String(dateKey ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return null;
    }

    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return null;
    }

    return Date.UTC(year, month - 1, 1);
  }

  function buildSeriesData(payload) {
    const monthlyUnique = payload?.mod_monthly_unique_downloads;
    if (!monthlyUnique || typeof monthlyUnique !== "object") {
      return null;
    }

    const totals = Object.entries(monthlyUnique)
      .map(([dateKey, value]) => {
        const timestamp = toMonthTimestamp(dateKey);
        const total = Number(value);
        if (timestamp === null || !Number.isFinite(total)) {
          return null;
        }

        return [timestamp, total];
      })
      .filter(Boolean)
      .sort((a, b) => a[0] - b[0]);

    if (!totals.length) {
      return null;
    }

    const monthlyEvolution = totals.map((point, index) => {
      if (index === 0) {
        return [point[0], point[1]];
      }
      return [point[0], point[1] - totals[index - 1][1]];
    });

    return { totals, monthlyEvolution };
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${SECTION_ID} {
        clear: both;
      }

      #${CONTAINER_ID} {
        min-height: 380px;
      }

      #${SECTION_ID} .highcharts-tooltip text,
      #${SECTION_ID} .highcharts-tooltip tspan {
        fill: #ffffff !important;
      }

      #${NOTICE_ID} {
        position: fixed;
        top: 74px;
        right: 14px;
        z-index: 2147483647;
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid var(--primary-subdued, #c87b28);
        background: rgba(14, 14, 14, 0.50);
        color: #e6e6e6;
        font-size: 12px;
        line-height: 1.35;
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.35);
      }

      #${NOTICE_ID} .tm-notice-line {
        white-space: nowrap;
      }

      #${NOTICE_ID} .tm-notice-author-link {
        text-decoration: none;
        color: var(--primary-strong, #e0a362);
        transition: filter 225ms ease;
      }

      #${NOTICE_ID} .tm-notice-author-link:hover {
        filter: brightness(120%);
      }

      #${NOTICE_ID} .tm-notice-inline-icon {
        width: 13px;
        height: 13px;
        display: inline-block;
        vertical-align: -2px;
        margin-right: 5px;
        border-radius: 50%;
      }

      #${NOTICE_ID} .tm-notice-inline-icon img {
        width: 100%;
        height: 100%;
        display: block;
        border-radius: 50%;
      }

      #${NOTICE_ID} .tm-notice-buttons {
        margin-top: 7px;
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }

      #${NOTICE_ID} .tm-notice-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        border-radius: 5px;
        border: 1px solid var(--primary-moderate, #d98f40);
        background: #1f1f1f;
        color: #f1f1f1;
        text-decoration: none;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.1px;
        transition: filter 225ms ease;
      }

      #${NOTICE_ID} .tm-notice-btn:hover {
        background: #2a2a2a;
        border-color: var(--primary-strong, #e0a362);
        color: #ffffff;
        filter: brightness(120%);
      }

      #${NOTICE_ID} .tm-notice-btn-icon {
        width: 13px;
        height: 13px;
        display: inline-block;
      }

      #${NOTICE_ID} .tm-notice-btn-icon svg {
        width: 100%;
        height: 100%;
        fill: currentColor;
      }

      #${NOTICE_ID} .tm-notice-btn-icon img {
        width: 100%;
        height: 100%;
        display: block;
      }
    `;

    document.head.appendChild(style);
  }

  function ensureMountPoint() {
    const groupingBar = document.querySelector(".tab-stats .sortbar.data-grouping-btns");
    if (!groupingBar) {
      return null;
    }

    const groupingContainer = groupingBar.closest("div");
    if (!groupingContainer) {
      return null;
    }

    const insertionAnchor = groupingContainer.parentElement || groupingContainer;

    let section = document.getElementById(SECTION_ID);
    if (!section) {
      section = document.createElement("section");
      section.id = SECTION_ID;
      section.innerHTML = `<div id="${CONTAINER_ID}"></div>`;
      insertionAnchor.insertAdjacentElement("afterend", section);
    }

    const title = section.querySelector(".tm-unique-dl-title");
    if (title) {
      title.remove();
    }

    const subtitle = section.querySelector(".tm-unique-dl-subtitle");
    if (subtitle) {
      subtitle.remove();
    }

    if (!section.querySelector(`#${CONTAINER_ID}`)) {
      const chartContainer = document.createElement("div");
      chartContainer.id = CONTAINER_ID;
      section.appendChild(chartContainer);
    }

    return section.querySelector(`#${CONTAINER_ID}`);
  }

  function getDesiredChartWidth(container) {
    if (!container) {
      return DEFAULT_GRAPH_WIDTH;
    }

    const widthAnchor =
      document.querySelector("#section") ||
      document.querySelector(".modpage") ||
      container.closest("#section") ||
      container.closest(".modpage") ||
      container.closest(`#${SECTION_ID}`);
    const anchorWidth = widthAnchor?.clientWidth ?? 0;
    if (!Number.isFinite(anchorWidth) || anchorWidth <= 0) {
      return DEFAULT_GRAPH_WIDTH;
    }

    const rawWidth = Math.floor(anchorWidth - GRAPH_SECTION_PADDING);
    return Math.max(MIN_GRAPH_WIDTH, rawWidth);
  }

  function applyContainerWidth(container) {
    const desiredWidth = getDesiredChartWidth(container);
    container.style.width = `${desiredWidth}px`;
    return desiredWidth;
  }

  function renderChart(container, seriesData) {
    if (!window.Highcharts || typeof window.Highcharts.stockChart !== "function") {
      return;
    }

    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }

    const highcharts = window.Highcharts;
    const chartWidth = applyContainerWidth(container);
    chartInstance = highcharts.stockChart(container, {
      chart: {
        backgroundColor: "transparent",
        height: 430,
        zoomType: "x",
        width: Number.isFinite(chartWidth) ? chartWidth : null,
      },
      title: {
        text: "Unique Downloads Progress",
      },
      credits: {
        enabled: false,
      },
      rangeSelector: {
        enabled: false,
      },
      navigator: {
        enabled: false,
      },
      scrollbar: {
        enabled: false,
      },
      legend: {
        enabled: true,
        align: "center",
        borderWidth: 2,
        layout: "horizontal",
        verticalAlign: "top",
      },
      xAxis: {
        type: "datetime",
      },
      yAxis: [
        {
          title: {
            text: "Total Unique Downloads",
          },
          opposite: false,
          labels: {
            formatter() {
              return highcharts.numberFormat(this.value, 0);
            },
          },
        },
        {
          title: {
            text: "Monthly Evolution",
          },
          opposite: true,
          labels: {
            formatter() {
              const value = Number(this.value) || 0;
              const sign = value > 0 ? "+" : "";
              return `${sign}${highcharts.numberFormat(value, 0)}`;
            },
          },
        },
      ],
      tooltip: {
        shared: true,
        useHTML: true,
        style: {
          color: "#ffffff",
        },
        formatter() {
          const points = Array.isArray(this.points)
            ? this.points
            : this.point
              ? [this.point]
              : [];
          const firstX = Number.isFinite(this.x)
            ? this.x
            : Number.isFinite(points[0]?.x)
              ? points[0].x
              : null;

          let content = "";
          if (Number.isFinite(firstX)) {
            content += `<span style="color:#ffffff"><b>${highcharts.dateFormat("%b %Y", firstX)}</b></span><br/>`;
          }

          for (const point of points) {
            const value = Number(point.y);
            if (!Number.isFinite(value)) {
              continue;
            }

            const isEvolution = point.series?.name === "Monthly Evolution";
            const sign = isEvolution && value > 0 ? "+" : "";
            content += `<span style="color:${point.color}">\u25CF</span> <span style="color:#ffffff">${point.series.name}: <b>${sign}${highcharts.numberFormat(value, 0)}</b></span><br/>`;
          }

          return content || false;
        },
      },
      plotOptions: {
        series: {
          dataGrouping: {
            enabled: false,
          },
        },
      },
      series: [
        {
          name: "Unique Downloads Total",
          type: "areaspline",
          yAxis: 0,
          data: seriesData.totals,
          color: "#3aa9ff",
          lineColor: "#3aa9ff",
          lineWidth: 2,
          marker: {
            enabled: false,
          },
          fillColor: {
            linearGradient: [0, 0, 0, 320],
            stops: [
              [0, "rgba(58, 169, 255, 0.70)"],
              [1, "rgba(58, 169, 255, 0.12)"],
            ],
          },
          tooltip: {
            valueDecimals: 0,
          },
        },
        {
          name: "Monthly Evolution",
          type: "spline",
          yAxis: 1,
          data: seriesData.monthlyEvolution,
          color: "#57d168",
          lineWidth: 2,
          marker: {
            enabled: false,
          },
          tooltip: {
            valueDecimals: 0,
          },
        },
      ],
    });
  }

  function resizeChartToTargetWidth() {
    if (!chartInstance) {
      return;
    }

    const container = document.getElementById(CONTAINER_ID);
    if (!container) {
      return;
    }

    const desiredWidth = applyContainerWidth(container);
    if (!Number.isFinite(desiredWidth)) {
      return;
    }

    if (Math.abs(chartInstance.chartWidth - desiredWidth) > 1) {
      chartInstance.setSize(desiredWidth, null, false);
    }
  }

  function scheduleChartResize() {
    if (resizeTimer) {
      window.clearTimeout(resizeTimer);
    }

    resizeTimer = window.setTimeout(() => {
      resizeTimer = 0;
      resizeChartToTargetWidth();
    }, 120);
  }

  function removeEnhancementNotice() {
    const existing = document.getElementById(NOTICE_ID);
    if (existing) {
      existing.remove();
    }
  }

  function createNoticeButton(label, href, iconType) {
    const button = document.createElement("a");
    button.className = "tm-notice-btn";
    button.href = href;
    button.target = "_blank";
    button.rel = "noopener noreferrer";

    const iconWrap = document.createElement("span");
    iconWrap.className = "tm-notice-btn-icon";

    if (iconType === "nexus") {
      const icon = document.createElement("img");
      icon.src = "https://www.nexusmods.com/favicon.ico";
      icon.alt = "";
      iconWrap.appendChild(icon);
    } else {
      const iconWrapSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      iconWrapSvg.setAttribute("viewBox", "0 0 16 16");
      iconWrapSvg.setAttribute("aria-hidden", "true");
      const iconPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      iconPath.setAttribute(
        "d",
        "M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38" +
          " 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13" +
          "-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66" +
          ".07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15" +
          "-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04" +
          " 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87" +
          " 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46" +
          ".55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z",
      );
      iconWrapSvg.appendChild(iconPath);
      iconWrap.appendChild(iconWrapSvg);
    }

    const text = document.createElement("span");
    text.textContent = label;

    button.appendChild(iconWrap);
    button.appendChild(text);
    return button;
  }

  function upsertEnhancementNotice() {
    if (document.getElementById(NOTICE_ID)) {
      return;
    }

    const notice = document.createElement("div");
    notice.id = NOTICE_ID;

    const line = document.createElement("div");
    line.className = "tm-notice-line";
    line.appendChild(document.createTextNode("This page is enhanced by "));

    const authorLink = document.createElement("a");
    authorLink.className = "tm-notice-author-link";
    authorLink.href = "https://www.nexusmods.com/profile/Akiway";
    authorLink.target = "_blank";
    authorLink.rel = "noopener noreferrer";

    const authorIconWrap = document.createElement("span");
    authorIconWrap.className = "tm-notice-inline-icon";
    const authorIcon = document.createElement("img");
    authorIcon.src = "https://avatars.nexusmods.com/6318603/100";
    authorIcon.alt = "";
    authorIconWrap.appendChild(authorIcon);
    authorLink.appendChild(authorIconWrap);

    const author = document.createElement("strong");
    author.textContent = "Akiway";
    authorLink.appendChild(author);
    line.appendChild(authorLink);

    const buttons = document.createElement("div");
    buttons.className = "tm-notice-buttons";
    buttons.appendChild(
      createNoticeButton("Nexus Mods", "https://www.nexusmods.com/profile/Akiway", "nexus"),
    );
    buttons.appendChild(
      createNoticeButton("GitHub", "https://github.com/Akiway/Tampermonkey-Nexus", "github"),
    );

    notice.appendChild(line);
    notice.appendChild(buttons);

    if (document.body) {
      document.body.appendChild(notice);
    } else {
      document.documentElement.appendChild(notice);
    }
  }

  function bindRootWidthObserver() {
    if (typeof window.ResizeObserver !== "function") {
      return;
    }

    const rootSection = document.querySelector("#section") || document.querySelector(".modpage");
    if (!rootSection) {
      return;
    }

    if (rootResizeObserver) {
      rootResizeObserver.disconnect();
    }

    rootResizeObserver = new window.ResizeObserver(() => {
      scheduleChartResize();
    });
    rootResizeObserver.observe(rootSection);
  }

  function showError(container, message) {
    if (!container) {
      return;
    }

    container.textContent = message;
  }

  function scheduleRetry() {
    if (retryTimer || initAttempts >= MAX_INIT_ATTEMPTS) {
      return;
    }

    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      initAttempts += 1;
      void init();
    }, RETRY_DELAY_MS);
  }

  async function init() {
    if (isInitInProgress) {
      return;
    }

    if (!isStatsTab()) {
      removeEnhancementNotice();
      return;
    }

    isInitInProgress = true;
    try {
      if (!window.Highcharts || typeof window.Highcharts.stockChart !== "function") {
        scheduleRetry();
        return;
      }

      ensureStyle();
      upsertEnhancementNotice();
      const container = ensureMountPoint();
      if (!container) {
        scheduleRetry();
        return;
      }

      bindRootWidthObserver();

      if (container.dataset.tmUniqueDlReady === "1") {
        return;
      }

      const statsUrl = getStatsUrlFromInlineScript() || getStatsUrlFromHeading();
      if (!statsUrl) {
        showError(container, "Unable to resolve stats JSON URL.");
        return;
      }

      const response = await window.fetch(statsUrl, { credentials: "omit" });
      if (!response.ok) {
        showError(container, `Failed to load stats JSON (${response.status}).`);
        return;
      }

      const payload = await response.json();
      const seriesData = buildSeriesData(payload);
      if (!seriesData) {
        showError(container, "No monthly unique-download data found.");
        return;
      }

      renderChart(container, seriesData);
      scheduleChartResize();
      container.dataset.tmUniqueDlReady = "1";
    } catch (error) {
      const container = document.getElementById(CONTAINER_ID);
      showError(container, "Unable to build the unique-download chart.");
      console.error("[TM Unique DL Evolution]", error);
    } finally {
      isInitInProgress = false;
    }
  }

  function start() {
    void init();

    const observer = new MutationObserver(() => {
      if (!document.getElementById(SECTION_ID)) {
        void init();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", () => {
      void init();
    });
    window.addEventListener("hashchange", () => {
      void init();
    });
    window.addEventListener("resize", () => {
      scheduleChartResize();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
