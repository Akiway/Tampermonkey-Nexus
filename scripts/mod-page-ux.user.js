// ==UserScript==
// @name         Nexus Mods Enhancer - Mod Page
// @namespace    https://github.com/Akiway
// @author       Akiway
// @version      1.1.0
// @description  Adds a new chart on the Stats tab for unique downloads total and per month, add follower/endorser counters and list in Logs tab.
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
  const TRACK_SUMMARY_ID = "tm-tracked-users-summary";
  const TRACK_RECOUNT_ID = "tm-tracked-users-recount";
  const USER_LIST_MODAL_BG_ID = "tm-user-list-modal-bg";
  const USER_LIST_MODAL_WRAP_ID = "tm-user-list-modal-wrap";
  const USER_LIST_POPUP_ID = "tm-user-list-popup";
  const NOTICE_ID = "tm-modpage-notice";
  const MAX_INIT_ATTEMPTS = 50;
  const RETRY_DELAY_MS = 350;
  const TRACK_SCOPE = "users";
  const TRACK_LOAD_TIMEOUT_MS = 7000;
  const TRACK_MAX_LOAD_CYCLES = 400;
  const DEFAULT_GRAPH_WIDTH = 1260;
  const GRAPH_SECTION_PADDING = 40;
  const MIN_GRAPH_WIDTH = 320;

  let initAttempts = 0;
  let retryTimer = 0;
  let resizeTimer = 0;
  let isInitInProgress = false;
  let isTrackCountInProgress = false;
  let chartInstance = null;
  let rootResizeObserver = null;
  let activePopupKeyHandler = null;
  const latestUserLists = {
    tracked: [],
    endorsed: [],
  };

  function isStatsTab() {
    const queryTab = new URL(window.location.href).searchParams.get("tab");
    return queryTab === "stats";
  }

  function isLogsTab() {
    const queryTab = new URL(window.location.href).searchParams.get("tab");
    return queryTab === "logs";
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

      #${TRACK_SUMMARY_ID} {
        margin: 10px 0 18px;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid var(--primary-subdued, #c87b28);
        background: rgba(14, 14, 14, 0.45);
        color: #e6e6e6;
        font-size: 13px;
        line-height: 1.4;
      }

      #${TRACK_SUMMARY_ID} .tm-track-disclaimer {
        margin-bottom: 8px;
        opacity: 0.85;
        font-size: 12px;
      }

      #${TRACK_SUMMARY_ID} .tm-track-stats {
        margin: 0;
        padding: 0;
        width: 100%;
        list-style: none;
        display: flex;
        flex-wrap: wrap;
        gap: 14px 18px;
      }

      #${TRACK_SUMMARY_ID} .tm-track-stat {
        min-width: 220px;
        flex: 1 1 260px;
        display: flex;
        align-items: center;
        gap: 10px;
      }

      #${TRACK_SUMMARY_ID} .tm-track-stat .statitem {
        min-width: 0;
      }

      #${TRACK_SUMMARY_ID} .tm-track-stat .titlestat {
        margin: 0;
        opacity: 0.85;
        font-size: 13px;
      }

      #${TRACK_SUMMARY_ID} .tm-track-stat .stat {
        margin: 0;
        color: #ffffff;
      }

      #${TRACK_SUMMARY_ID} .tm-track-value {
        font-size: 24px;
        line-height: 1;
        font-weight: 700;
      }

      #${TRACK_SUMMARY_ID} .tm-track-stat-link {
        border: 0;
        background: transparent;
        color: var(--primary-moderate, #d98f40);
        padding: 0;
        margin: 0;
        font: inherit;
        cursor: pointer;
        transition: color 225ms ease;
      }

      #${TRACK_SUMMARY_ID} .tm-track-stat-link:hover {
        color: var(--primary-strong, #e0a362);
      }

      #${TRACK_SUMMARY_ID} .tm-track-stat-link:disabled {
        color: #ffffff;
        cursor: default;
      }

      #${TRACK_SUMMARY_ID} .tm-track-meta {
        margin-top: 8px;
        opacity: 0.85;
        font-size: 12px;
        pointer-events: none;
      }

      #${TRACK_SUMMARY_ID} .tm-track-actions {
        margin-top: 8px;
      }

      #${TRACK_SUMMARY_ID} .tm-track-recount {
        border: 1px solid var(--primary-moderate, #d98f40);
        border-radius: 5px;
        background: #1f1f1f;
        color: #f1f1f1;
        padding: 4px 10px;
        font-size: 12px;
        cursor: pointer;
        transition: filter 225ms ease;
      }

      #${TRACK_SUMMARY_ID} .tm-track-recount:hover {
        border-color: var(--primary-strong, #e0a362);
        filter: brightness(120%);
      }

      #${TRACK_SUMMARY_ID} .tm-track-recount:disabled {
        opacity: 0.5;
        cursor: default;
        filter: none;
      }

      #${TRACK_SUMMARY_ID} .tm-track-nav-icon {
        display: inline-flex;
        width: 26px;
        height: 26px;
        min-width: 26px;
        min-height: 26px;
        align-items: center;
        justify-content: center;
        font-size: 26px;
        transform: scale(1.5);
      }

      #${TRACK_SUMMARY_ID} .tm-track-endorse-icon {
        display: inline-flex;
        width: 26px;
        height: 26px;
        min-width: 26px;
        min-height: 26px;
        align-items: center;
        justify-content: center;
        transform: scale(1.5);
      }

      #${TRACK_SUMMARY_ID} .tm-track-endorse-icon svg {
        width: 100%;
        height: 100%;
        display: block;
      }

      #${USER_LIST_MODAL_BG_ID} {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        z-index: 2147483645;
      }

      #${USER_LIST_MODAL_WRAP_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }

      #${USER_LIST_POPUP_ID} {
        width: min(620px, calc(100vw - 40px));
        max-height: calc(100vh - 40px);
        overflow: visible;
      }

      #${USER_LIST_POPUP_ID} .tm-popup-inner {
        padding: 14px 16px 16px;
      }

      #${USER_LIST_POPUP_ID} h2 {
        margin: 0 0 10px;
        font-size: 20px;
      }

      #${USER_LIST_POPUP_ID} .user-list {
        overflow-y: auto;
        max-height: min(65vh, 520px);
        margin: 0;
      }

      #${USER_LIST_POPUP_ID} .user-list li {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      #${USER_LIST_POPUP_ID} .user-list img {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        object-fit: cover;
      }

      #${USER_LIST_POPUP_ID} .tm-popup-empty {
        margin: 0;
        opacity: 0.8;
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

  function removeTrackedUsersSummary() {
    const existing = document.getElementById(TRACK_SUMMARY_ID);
    if (existing) {
      existing.remove();
    }
    closeUserListPopup();
  }

  function upsertTrackedUsersSummary() {
    const heading = document.querySelector(".tab-actionlog h2[data-game-id][data-mod-id]");
    if (!heading) {
      return null;
    }

    let summary = document.getElementById(TRACK_SUMMARY_ID);
    if (!summary) {
      summary = document.createElement("div");
      summary.id = TRACK_SUMMARY_ID;
      summary.innerHTML = `
        <div class="tm-track-disclaimer">Disclaimer: Data estimated from logs available</div>
        <ul class="stats clearfix tm-track-stats">
          <li class="tm-track-stat">
            <i class="nav-icon nav-icon-tracking tm-track-nav-icon" aria-hidden="true"></i>
            <div class="statitem">
              <div class="titlestat">Mod followers</div>
              <div class="stat">
                <button type="button" class="tm-track-stat-link" data-role="view-tracked" disabled>
                  <span class="tm-track-value" data-role="current">-</span>
                </button>
              </div>
            </div>
          </li>
          <li class="tm-track-stat">
            <span class="tm-track-endorse-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" role="presentation" class="shrink-0" style="width: 1rem; height: 1rem;"><path d="M23,10C23,8.89 22.1,8 21,8H14.68L15.64,3.43C15.66,3.33 15.67,3.22 15.67,3.11C15.67,2.7 15.5,2.32 15.23,2.05L14.17,1L7.59,7.58C7.22,7.95 7,8.45 7,9V19A2,2 0 0,0 9,21H18C18.83,21 19.54,20.5 19.84,19.78L22.86,12.73C22.95,12.5 23,12.26 23,12V10M1,21H5V9H1V21Z" style="fill: currentcolor;"></path></svg>
            </span>
            <div class="statitem">
              <div class="titlestat">Mod endorsers</div>
              <div class="stat">
                <button type="button" class="tm-track-stat-link" data-role="view-endorsed" disabled>
                  <span class="tm-track-value" data-role="endorsed">-</span>
                </button>
              </div>
            </div>
          </li>
          <li class="tm-track-stat">
            <i class="nav-icon nav-icon-tracking tm-track-nav-icon" aria-hidden="true"></i>
            <div class="statitem">
              <div class="titlestat">Tracked at least once</div>
              <div class="stat">
                <span class="tm-track-value" data-role="ever">-</span>
              </div>
            </div>
          </li>
        </ul>
        <div class="tm-track-meta" data-role="meta">Click "Caculate" to load all pages and count tracked and endorsed users.<br>This may take a few moments depending on mod popularity.</div>
        <div class="tm-track-actions">
          <button type="button" id="${TRACK_RECOUNT_ID}" class="tm-track-recount">Caculate</button>
        </div>
      `;
      heading.insertAdjacentElement("afterend", summary);
    }

    const recountButton = summary.querySelector(`#${TRACK_RECOUNT_ID}`);
    if (recountButton && recountButton.dataset.tmBound !== "1") {
      recountButton.dataset.tmBound = "1";
      recountButton.addEventListener("click", () => {
        void updateTrackedUsersSummary({ forceReload: true });
      });
    }

    const trackedViewButton = summary.querySelector('[data-role="view-tracked"]');
    if (trackedViewButton && trackedViewButton.dataset.tmBound !== "1") {
      trackedViewButton.dataset.tmBound = "1";
      trackedViewButton.addEventListener("click", () => {
        openUserListPopup("tracked");
      });
    }

    const endorsedViewButton = summary.querySelector('[data-role="view-endorsed"]');
    if (endorsedViewButton && endorsedViewButton.dataset.tmBound !== "1") {
      endorsedViewButton.dataset.tmBound = "1";
      endorsedViewButton.addEventListener("click", () => {
        openUserListPopup("endorsed");
      });
    }

    return summary;
  }

  function setTrackedUsersSummary(summary, values) {
    if (!summary) {
      return;
    }

    const trackedCurrent = values?.trackedCurrent ?? "-";
    const trackedEver = values?.trackedEver ?? "-";
    const endorsedCurrent = values?.endorsedCurrent ?? "-";
    const metaText = values?.metaText ?? "";
    const trackedUsers = Array.isArray(values?.trackedUsers) ? values.trackedUsers : null;
    const endorsedUsers = Array.isArray(values?.endorsedUsers) ? values.endorsedUsers : null;
    const listsLoaded = values?.listsLoaded === true;

    const currentValue = summary.querySelector('[data-role="current"]');
    const everValue = summary.querySelector('[data-role="ever"]');
    const endorsedValue = summary.querySelector('[data-role="endorsed"]');
    const metaValue = summary.querySelector('[data-role="meta"]');
    const trackedViewButton = summary.querySelector('[data-role="view-tracked"]');
    const endorsedViewButton = summary.querySelector('[data-role="view-endorsed"]');

    if (currentValue) {
      currentValue.textContent = String(trackedCurrent);
    }
    if (everValue) {
      everValue.textContent = String(trackedEver);
    }
    if (endorsedValue) {
      endorsedValue.textContent = String(endorsedCurrent);
    }
    if (metaValue) {
      metaValue.textContent = metaText;
    }

    if (trackedUsers) {
      latestUserLists.tracked = trackedUsers;
    }
    if (endorsedUsers) {
      latestUserLists.endorsed = endorsedUsers;
    }

    if (trackedViewButton) {
      trackedViewButton.disabled = !listsLoaded;
    }
    if (endorsedViewButton) {
      endorsedViewButton.disabled = !listsLoaded;
    }
  }

  function closeUserListPopup() {
    const popupBg = document.getElementById(USER_LIST_MODAL_BG_ID);
    const popupWrap = document.getElementById(USER_LIST_MODAL_WRAP_ID);
    if (popupBg) {
      popupBg.remove();
    }
    if (popupWrap) {
      popupWrap.remove();
    }

    if (activePopupKeyHandler) {
      document.removeEventListener("keydown", activePopupKeyHandler, true);
      activePopupKeyHandler = null;
    }
  }

  function normalizeDisplayName(name, fallback) {
    const value = String(name ?? "").replace(/\s+/g, " ").trim();
    if (value) {
      return value;
    }
    return String(fallback ?? "Unknown user");
  }

  function createUserListItem(user) {
    const li = document.createElement("li");
    li.className = "clearfix";

    const img = document.createElement("img");
    img.src = String(user.avatarUrl ?? "").trim() || "https://www.nexusmods.com/assets/images/default-no-profile-picture.svg";
    img.alt = "";
    li.appendChild(img);

    const details = document.createElement("div");
    details.className = "user-list-details";

    const link = document.createElement("a");
    link.className = "user-list-name";
    link.href = String(user.profileHref ?? "").trim() || "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = normalizeDisplayName(user.userName, user.userId);
    details.appendChild(link);

    li.appendChild(details);
    return li;
  }

  function openUserListPopup(type) {
    closeUserListPopup();

    const users = type === "endorsed" ? latestUserLists.endorsed : latestUserLists.tracked;
    const baseTitle = type === "endorsed" ? "Mod endorsers" : "Mod followers";
    const title = `${baseTitle} (${users.length})`;

    const bg = document.createElement("div");
    bg.id = USER_LIST_MODAL_BG_ID;
    bg.addEventListener("click", closeUserListPopup);

    const wrap = document.createElement("div");
    wrap.id = USER_LIST_MODAL_WRAP_ID;
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) {
        closeUserListPopup();
      }
    });

    const popup = document.createElement("div");
    popup.id = USER_LIST_POPUP_ID;
    popup.className = "popup-bugreport popup mfp-with-anim col-1-1";
    popup.innerHTML = `
      <div class="col-1-1 tm-popup-inner">
        <h2>${title}</h2>
        <div class="clearfix">
          <ul class="user-list"></ul>
          <p class="tm-popup-empty" style="display:none;">No users to display.</p>
        </div>
      </div>
      <button title="Close (Esc)" type="button" class="mfp-close">×</button>
    `;

    const list = popup.querySelector(".user-list");
    const empty = popup.querySelector(".tm-popup-empty");
    if (list) {
      if (users.length) {
        for (const user of users) {
          list.appendChild(createUserListItem(user));
        }
      } else if (empty) {
        empty.style.display = "";
      }
    }

    const closeButton = popup.querySelector(".mfp-close");
    closeButton?.addEventListener("click", closeUserListPopup);

    wrap.appendChild(popup);
    document.body.appendChild(bg);
    document.body.appendChild(wrap);

    activePopupKeyHandler = (event) => {
      if (event.key === "Escape") {
        closeUserListPopup();
      }
    };
    document.addEventListener("keydown", activePopupKeyHandler, true);
  }

  function getLogsRouteIds() {
    const heading = document.querySelector(".tab-actionlog h2[data-game-id][data-mod-id]");
    const gameId = Number.parseInt(String(heading?.getAttribute("data-game-id") ?? ""), 10);
    const modId = Number.parseInt(String(heading?.getAttribute("data-mod-id") ?? ""), 10);

    if (!Number.isInteger(modId) || !Number.isInteger(gameId)) {
      return null;
    }

    return { modId, gameId };
  }

  function getUsersLoadButton() {
    return document.getElementById("ModActionLogExpanderLoadButtonusers");
  }

  function getUsersLogContainer() {
    const loadButtonContainer = getUsersLoadButton()?.closest("dd.act-log-container");
    if (loadButtonContainer) {
      return loadButtonContainer;
    }

    const scripts = Array.from(document.querySelectorAll(".tab-actionlog dd.act-log-container script"));
    for (const script of scripts) {
      const text = String(script.textContent ?? "");
      if (!text.includes("actionLogOffset['users']") && !text.includes('actionLogOffset["users"]')) {
        continue;
      }

      const scriptContainer = script.closest("dd.act-log-container");
      if (scriptContainer) {
        return scriptContainer;
      }
    }

    const dtElements = Array.from(document.querySelectorAll(".tab-actionlog dl.accordion > dt"));
    for (const dt of dtElements) {
      const label = String(dt.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!label.includes("mod page activity")) {
        continue;
      }

      if (dt.nextElementSibling?.tagName === "DD") {
        return dt.nextElementSibling;
      }
    }

    return null;
  }

  function getUsersActionItems(container = getUsersLogContainer()) {
    if (!container) {
      return [];
    }

    return Array.from(container.querySelectorAll("ul.action-log > li"));
  }

  function getUserInfoFromItem(item) {
    const userLink = item?.querySelector('.log-modified a[href*="/users/"]');
    const href = String(userLink?.getAttribute("href") ?? "");
    const hrefMatch = href.match(/\/users\/(\d+)(?:[/?#]|$)/);
    const userName = String(userLink?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const normalizedName = userName.toLowerCase();

    const userId = hrefMatch?.[1] ? Number.parseInt(hrefMatch[1], 10) : null;
    const profileHref = (() => {
      if (!href) {
        return "";
      }
      if (/^https?:\/\//i.test(href)) {
        return href;
      }
      if (href.startsWith("/")) {
        return `${window.location.origin}${href}`;
      }
      return `${window.location.origin}/${href}`;
    })();

    if (!Number.isInteger(userId) && !normalizedName) {
      return null;
    }

    return {
      idKey: Number.isInteger(userId) ? `u:${userId}` : `n:${normalizedName}`,
      userId: Number.isInteger(userId) ? userId : null,
      userName,
      profileHref,
      avatarUrl: Number.isInteger(userId) ? `https://avatars.nexusmods.com/${userId}/100` : "",
    };
  }

  function getActionTypeFromItem(item) {
    const actionTitle = String(item?.querySelector(".log-change h4")?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!actionTitle) {
      return "";
    }

    if (actionTitle.includes("untracked")) {
      return "untracked";
    }
    if (actionTitle.includes("tracked")) {
      return "tracked";
    }
    if (actionTitle.includes("unendors")) {
      return "unendorsed";
    }
    if (actionTitle.includes("endorsed")) {
      return "endorsed";
    }

    return "";
  }

  function collectUserActionEvents(container = getUsersLogContainer()) {
    const events = [];
    for (const item of getUsersActionItems(container)) {
      const action = getActionTypeFromItem(item);
      if (!action) {
        continue;
      }

      const user = getUserInfoFromItem(item);
      if (!user?.idKey) {
        continue;
      }

      events.push({ user, action });
    }

    return events;
  }

  function computeUserActionStats(events) {
    const everTrackedUsers = new Set();
    const latestTrackStateByUser = new Map();
    const latestEndorseStateByUser = new Map();

    // The log list is newest-first, so first action seen per user is the current state.
    for (const event of events) {
      const userKey = event.user.idKey;

      if (event.action === "tracked") {
        everTrackedUsers.add(userKey);
      }

      if (
        (event.action === "tracked" || event.action === "untracked") &&
        !latestTrackStateByUser.has(userKey)
      ) {
        latestTrackStateByUser.set(userKey, {
          active: event.action === "tracked",
          user: event.user,
        });
      }

      if (
        (event.action === "endorsed" || event.action === "unendorsed") &&
        !latestEndorseStateByUser.has(userKey)
      ) {
        latestEndorseStateByUser.set(userKey, {
          active: event.action === "endorsed",
          user: event.user,
        });
      }
    }

    const currentTrackedUsers = [];
    for (const state of latestTrackStateByUser.values()) {
      if (state.active) {
        currentTrackedUsers.push(state.user);
      }
    }

    const currentEndorsedUsers = [];
    for (const state of latestEndorseStateByUser.values()) {
      if (state.active) {
        currentEndorsedUsers.push(state.user);
      }
    }

    return {
      currentTrackedUsers,
      everTrackedUsers: everTrackedUsers.size,
      currentEndorsedUsers,
    };
  }

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function waitForCondition(check, timeoutMs, stepMs) {
    const startAt = Date.now();
    while (Date.now() - startAt < timeoutMs) {
      if (check()) {
        return true;
      }
      await delay(stepMs);
    }
    return false;
  }

  function getUsersOffsetToken() {
    try {
      return String(window.actionLogOffset?.[TRACK_SCOPE] ?? "");
    } catch (_) {
      return "";
    }
  }

  async function loadAllUsersLogPages(modId, gameId, { onProgress } = {}) {
    if (typeof window.LoadMoreModActionLogItems !== "function") {
      return { loadedPages: 0, usedNativeLoader: false };
    }

    let loadedPages = 0;
    let cycles = 0;
    const seenOffsets = new Set();
    const initialOffset = getUsersOffsetToken();
    if (initialOffset) {
      seenOffsets.add(initialOffset);
    }
    if (typeof onProgress === "function") {
      onProgress(loadedPages);
    }

    while (cycles < TRACK_MAX_LOAD_CYCLES) {
      cycles += 1;
      const loadButton = getUsersLoadButton();
      if (!loadButton) {
        break;
      }

      const beforeCount = getUsersActionItems().length;
      const beforeOffset = getUsersOffsetToken();

      window.LoadMoreModActionLogItems(modId, gameId, TRACK_SCOPE);

      const completed = await waitForCondition(() => {
        const afterOffset = getUsersOffsetToken();
        const hasButton = Boolean(getUsersLoadButton());
        return !hasButton || (afterOffset !== "" && afterOffset !== beforeOffset);
      }, TRACK_LOAD_TIMEOUT_MS, 120);

      if (!completed) {
        break;
      }

      const hasButton = Boolean(getUsersLoadButton());
      const afterOffset = getUsersOffsetToken();
      if (hasButton && afterOffset === beforeOffset) {
        break;
      }

      if (afterOffset && seenOffsets.has(afterOffset)) {
        break;
      }
      if (afterOffset) {
        seenOffsets.add(afterOffset);
      }

      const afterCount = getUsersActionItems().length;
      if (afterCount > beforeCount) {
        loadedPages += 1;
        if (typeof onProgress === "function") {
          onProgress(loadedPages);
        }
      }

      await delay(140);
    }

    return { loadedPages, usedNativeLoader: true };
  }

  async function updateTrackedUsersSummary({ forceReload = false } = {}) {
    if (isTrackCountInProgress) {
      return;
    }

    const summary = upsertTrackedUsersSummary();
    if (!summary) {
      scheduleRetry();
      return;
    }

    if (!forceReload && summary.dataset.tmTrackReady === "1") {
      return;
    }

    const recountButton = summary.querySelector(`#${TRACK_RECOUNT_ID}`);
    if (recountButton) {
      recountButton.disabled = true;
    }

    isTrackCountInProgress = true;
    try {
      const ids = getLogsRouteIds();
      if (!ids) {
        setTrackedUsersSummary(summary, {
          trackedCurrent: "-",
          trackedEver: "-",
          endorsedCurrent: "-",
          metaText: "Unable to resolve mod/game ids.",
          trackedUsers: [],
          endorsedUsers: [],
          listsLoaded: false,
        });
        return;
      }

      const usersContainer = getUsersLogContainer();
      if (!usersContainer) {
        setTrackedUsersSummary(summary, {
          trackedCurrent: "...",
          trackedEver: "...",
          endorsedCurrent: "...",
          metaText: "Waiting for activity log data...",
          listsLoaded: false,
        });
        return;
      }

      setTrackedUsersSummary(summary, {
        trackedCurrent: "...",
        trackedEver: "...",
        endorsedCurrent: "...",
        metaText: "Loading all log pages... 0 extra page(s) loaded.",
        listsLoaded: false,
      });
      const loadResult = await loadAllUsersLogPages(ids.modId, ids.gameId, {
        onProgress(loadedPages) {
          setTrackedUsersSummary(summary, {
            trackedCurrent: "...",
            trackedEver: "...",
            endorsedCurrent: "...",
            metaText: `Loading all log pages... ${loadedPages} extra page(s) loaded.`,
            listsLoaded: false,
          });
        },
      });

      const entriesCount = getUsersActionItems(usersContainer).length;
      if (!entriesCount) {
        setTrackedUsersSummary(summary, {
          trackedCurrent: "...",
          trackedEver: "...",
          endorsedCurrent: "...",
          metaText: "Waiting for activity log entries...",
          listsLoaded: false,
        });
        return;
      }

      const events = collectUserActionEvents(usersContainer);
      if (!events.length) {
        setTrackedUsersSummary(summary, {
          trackedCurrent: 0,
          trackedEver: 0,
          endorsedCurrent: 0,
          metaText: `Analyzed ${entriesCount} log entries. No tracked/endorsed events found.`,
          trackedUsers: [],
          endorsedUsers: [],
          listsLoaded: true,
        });
        summary.dataset.tmTrackReady = "1";
        return;
      }

      const stats = computeUserActionStats(events);
      setTrackedUsersSummary(summary, {
        trackedCurrent: stats.currentTrackedUsers.length,
        trackedEver: stats.everTrackedUsers,
        endorsedCurrent: stats.currentEndorsedUsers.length,
        metaText: `Analyzed ${entriesCount} log entries. Loaded ${loadResult.loadedPages} extra page(s).`,
        trackedUsers: stats.currentTrackedUsers,
        endorsedUsers: stats.currentEndorsedUsers,
        listsLoaded: true,
      });
      summary.dataset.tmTrackReady = "1";
    } catch (error) {
      setTrackedUsersSummary(summary, {
        trackedCurrent: "-",
        trackedEver: "-",
        endorsedCurrent: "-",
        metaText: "Failed to compute tracked users.",
        listsLoaded: false,
      });
      console.error("[TM Mod Page] Track counter error", error);
    } finally {
      isTrackCountInProgress = false;
      if (recountButton) {
        recountButton.disabled = false;
      }
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

    const onStatsTab = isStatsTab();
    const onLogsTab = isLogsTab();

    if (!onStatsTab && !onLogsTab) {
      removeEnhancementNotice();
      removeTrackedUsersSummary();
      return;
    }

    isInitInProgress = true;
    try {
      ensureStyle();
      upsertEnhancementNotice();

      if (onLogsTab) {
        upsertTrackedUsersSummary();
        return;
      }

      removeTrackedUsersSummary();

      if (!window.Highcharts || typeof window.Highcharts.stockChart !== "function") {
        scheduleRetry();
        return;
      }

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
      const needsStatsEnhancement = isStatsTab() && !document.getElementById(SECTION_ID);
      const needsLogsEnhancement = isLogsTab() && !document.getElementById(TRACK_SUMMARY_ID);
      if (needsStatsEnhancement || needsLogsEnhancement) {
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
