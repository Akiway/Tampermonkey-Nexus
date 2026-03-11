// ==UserScript==
// @name         Nexus ModRewards UX Enhancer
// @namespace    https://github.com/Akiway
// @author       Akiway
// @version      1.1.1
// @description  Adds sortable columns, mod links, extra fields, totals on reports, and wallet enhancements.
// @match        https://www.nexusmods.com/modrewards*
// @updateURL    https://github.com/Akiway/Tampermonkey-Nexus/blob/main/scripts/modrewards-ux.user.js
// @downloadURL	 https://github.com/Akiway/Tampermonkey-Nexus/blob/main/scripts/modrewards-ux.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const GAME_SLUG = "cyberpunk2077";
  const MOD_ENTRIES_URL_FRAGMENT = "/Core/Libs/Common/Managers/ModRewards?GetEntries";
  const MOD_SUMMARY_URL_FRAGMENT = "/Core/Libs/Common/Managers/ModRewards?GetSummary";
  const CUTOFF_YEAR = 2024;
  const CUTOFF_MONTH = 5;
  const STYLE_ID = "tm-modrewards-ux-style";
  const NOTICE_ID = "tm-modrewards-notice";
  const LINK_CLASS = "tm-mod-link";
  const TOTAL_ROW_ATTR = "data-tm-total-row";
  const WALLET_SEPARATOR_ATTR = "data-tm-wallet-separator";
  const WALLET_SEPARATOR_TEXT = "Beginning of the new Donation Point System.";
  const EXTRA_COLUMNS = [
    { key: "modCount", label: "Unique DLs", format: "int" },
    { key: "modValue", label: "Mod's DP", format: "int" },
    { key: "value", label: "Your DP", format: "int" },
    { key: "status", label: "Status", format: "int" },
  ];

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const numberFormatter = new Intl.NumberFormat("en-US");
  const percentFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const modIdByName = new Map();
  const modIdByNameAndGame = new Map();
  const entryDataByNameAndGame = new Map();
  const summaryDataByYearAndMonth = new Map();
  const sortState = { index: -1, direction: "asc" };

  let isSorting = false;
  let isApplyingEnhancements = false;
  let enhancementScheduled = false;
  let lastFallbackFetchKey = "";
  let hasSummaryFallbackFetchSucceeded = false;
  let isSummaryFallbackFetchInFlight = false;
  let reportObserver = null;
  let observerRoot = null;
  let observerPauseDepth = 0;

  function pauseObserver() {
    observerPauseDepth += 1;
    if (observerPauseDepth === 1 && reportObserver) {
      reportObserver.disconnect();
    }
  }

  function resumeObserver() {
    if (observerPauseDepth > 0) {
      observerPauseDepth -= 1;
    }

    if (observerPauseDepth === 0 && reportObserver && observerRoot) {
      reportObserver.observe(observerRoot, { childList: true, subtree: true });
    }
  }

  function isReportsRoute() {
    return window.location.hash.includes("/reports/");
  }

  function isWalletRoute() {
    return window.location.hash.includes("/wallet");
  }

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function toIntegerOrNull(value) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isInteger(parsed) ? parsed : null;
  }

  function makeNameAndGameKey(modName, gameName) {
    const normalizedModName = normalizeText(modName);
    if (!normalizedModName) {
      return "";
    }

    return `${normalizedModName}|${normalizeText(gameName)}`;
  }

  function makeYearAndMonthKey(year, month) {
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      return "";
    }

    return `${year}-${month}`;
  }

  function isEnhancementEligible() {
    if (!window.location.hash.includes("/reports/")) {
      return false;
    }

    const parsed = parseYearAndMonthFromHash();
    if (!parsed) {
      return false;
    }

    if (parsed.year > CUTOFF_YEAR) {
      return true;
    }

    return parsed.year === CUTOFF_YEAR && parsed.month > CUTOFF_MONTH;
  }

  function getStoreList() {
    return document.querySelector("ul.store-items");
  }

  function getEntryRows() {
    const list = getStoreList();
    if (!list) {
      return [];
    }

    return Array.from(list.children).filter(
      (child) => child.querySelector(".report_entry") && child.getAttribute(TOTAL_ROW_ATTR) !== "1",
    );
  }

  function getHeaderCells() {
    const header = document.querySelector("ul.store-items .report_entry_head");
    if (!header) {
      return [];
    }

    return Array.from(header.children).filter(
      (child) => child.classList && child.classList.contains("report_entry_head--title"),
    );
  }

  function getEntryCells(rowElement) {
    const entry = rowElement.querySelector(".report_entry");
    if (!entry) {
      return [];
    }

    return Array.from(entry.children).filter((child) => child.tagName === "SPAN");
  }

  function getCellText(rowElement, columnIndex) {
    const cells = getEntryCells(rowElement);
    const cell = cells[columnIndex];
    if (!cell) {
      return "";
    }

    const rawValue = cell.dataset.tmRawValue;
    if (rawValue !== undefined && rawValue !== "") {
      return rawValue;
    }

    return String(cell.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  function parseNumericValue(value) {
    let cleaned = String(value ?? "")
      .replace(/[%$]/g, "")
      .replace(/[\u00A0\u202F\s]/g, "")
      .trim();

    if (!cleaned || cleaned === "-") {
      return NaN;
    }

    if (/^-?\d{1,3}(\.\d{3})+$/.test(cleaned)) {
      cleaned = cleaned.replace(/\./g, "");
    } else if (/^-?\d{1,3}(,\d{3})+$/.test(cleaned)) {
      cleaned = cleaned.replace(/,/g, "");
    } else {
      cleaned = cleaned.replace(/,/g, ".");
    }

    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function isNumericColumn(values) {
    if (!values.length) {
      return false;
    }

    return values.every((value) => {
      const normalized = String(value ?? "").trim();
      return (
        !normalized ||
        normalized === "-" ||
        Number.isFinite(parseNumericValue(normalized))
      );
    });
  }

  function getDataColumnsTemplate() {
    const valueIndex = EXTRA_COLUMNS.findIndex((column) => column.key === "value");
    const beforeValueColumns =
      valueIndex >= 0 ? EXTRA_COLUMNS.slice(0, valueIndex) : EXTRA_COLUMNS.slice();
    const valueColumn = valueIndex >= 0 ? EXTRA_COLUMNS[valueIndex] : null;
    const afterValueColumns = valueIndex >= 0 ? EXTRA_COLUMNS.slice(valueIndex + 1) : [];

    const trackForColumn = (column) => {
      if (column.key === "status") {
        return "70px";
      }

      if (column.key === "modCount") {
        return "120px";
      }

      if (column.key === "modValue" || column.key === "value") {
        return "100px";
      }

      return "minmax(85px, 0.9fr)";
    };

    const tracks = [
      ...beforeValueColumns.map(trackForColumn),
      "minmax(85px, 0.9fr)",
      ...(valueColumn ? [trackForColumn(valueColumn)] : []),
      ...afterValueColumns.map(trackForColumn),
    ];

    return tracks.join("\n          ");
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      ul.store-items .report_entry_head .report_entry_head--title[data-tm-sortable="true"] {
        cursor: pointer;
        user-select: none;
        position: relative;
        padding-right: 14px;
      }

      ul.store-items .report_entry_head .report_entry_head--title[data-tm-sort-dir="asc"]::after {
        content: "\\25B2";
        position: absolute;
        right: 0;
        top: 50%;
        transform: translateY(-50%);
        font-size: 10px;
        opacity: 0.8;
      }

      ul.store-items .report_entry_head .report_entry_head--title[data-tm-sort-dir="desc"]::after {
        content: "\\25BC";
        position: absolute;
        right: 0;
        top: 50%;
        transform: translateY(-50%);
        font-size: 10px;
        opacity: 0.8;
      }

      a.${LINK_CLASS} {
        color: inherit;
        text-decoration: none !important;
      }

      a.${LINK_CLASS}:hover {
        color: #f9a93a;
        text-decoration: none !important;
      }

      ul.store-items {
        overflow-x: auto;
      }

      ul.store-items .report_entry[data-tm-has-extra="1"],
      ul.store-items .report_entry_head[data-tm-has-extra="1"] {
        display: grid !important;
        grid-template-columns:
          minmax(240px, 2.4fr)
          minmax(140px, 1.4fr)
          ${getDataColumnsTemplate()};
        column-gap: 10px;
        align-items: center;
      }

      ul.store-items .report_entry[data-tm-has-extra="1"] > span,
      ul.store-items .report_entry_head[data-tm-has-extra="1"] > .report_entry_head--title {
        width: auto !important;
        min-width: 0;
      }

      ul.store-items .report_entry_head[data-tm-has-extra="1"] > .report_entry_head--title {
        text-align: center;
        font-weight: 700;
      }

      ul.store-items .report_entry[data-tm-has-extra="1"] > span[data-tm-extra-col],
      ul.store-items .report_entry_head[data-tm-has-extra="1"] > .report_entry_head--title[data-tm-extra-col] {
        font-variant-numeric: tabular-nums;
        color: #e1e1e1;
      }

      ul.store-items .report_entry_head[data-tm-has-extra="1"] > .report_entry_head--title:nth-child(2),
      ul.store-items .report_entry[data-tm-has-extra="1"] > span:nth-child(2),
      ul.store-items .report_entry_head[data-tm-has-extra="1"] > .report_entry_head--title:nth-child(2) *,
      ul.store-items .report_entry[data-tm-has-extra="1"] > span:nth-child(2) *,
      ul.store-items .report_entry[data-tm-has-extra="1"] > span[data-tm-extra-col="status"],
      ul.store-items .report_entry_head[data-tm-has-extra="1"] > .report_entry_head--title[data-tm-extra-col="status"],
      ul.store-items .report_entry[data-tm-has-extra="1"] > span[data-tm-extra-col="status"] *,
      ul.store-items .report_entry_head[data-tm-has-extra="1"] > .report_entry_head--title[data-tm-extra-col="status"] * {
        color: #9a9a9a !important;
      }

      ul.store-items .report_entry[data-tm-has-extra="1"] > span[data-tm-extra-col] {
        text-align: right;
      }

      ul.store-items .report_entry[data-tm-has-extra="1"] > span[data-tm-extra-col="status"],
      ul.store-items .report_entry_head[data-tm-has-extra="1"] > .report_entry_head--title[data-tm-extra-col="status"] {
        text-align: center;
      }

      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry {
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px solid rgba(255, 255, 255, 0.2);
        font-weight: 700;
      }

      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry > span {
        color: #e1e1e1 !important;
      }

      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry > span * {
        color: #e1e1e1 !important;
      }

      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry > span[data-tm-total-game="1"],
      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry > span[data-tm-total-ratio="1"] {
        text-align: center;
      }

      #store-items ul.store-items li[${WALLET_SEPARATOR_ATTR}="1"] .con-vs-alert,
      #store-items ul.store-items li[${WALLET_SEPARATOR_ATTR}="1"] .vs-alert {
        box-shadow: none !important;
      }

      #store-items ul.store-items li[${WALLET_SEPARATOR_ATTR}="1"] .vs-alert {
        font-size: 14px !important;
        line-height: 18.2px !important;
      }

      #store-items ul.store-items li[${WALLET_SEPARATOR_ATTR}="1"] .vs-alert .vs-icon {
        font-size: 14px !important;
        line-height: 18.2px !important;
      }

      #${NOTICE_ID} {
        position: fixed;
        top: 74px;
        right: 14px;
        z-index: 2147483647;
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid rgba(249, 169, 58, 0.55);
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
      }

      #${NOTICE_ID} .tm-notice-author-link:hover {
        color: #f9a93a;
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
        border: 1px solid rgba(249, 169, 58, 0.75);
        background: #1f1f1f;
        color: #f1f1f1;
        text-decoration: none;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.1px;
      }

      #${NOTICE_ID} .tm-notice-btn:hover {
        background: #2a2a2a;
        border-color: #f9a93a;
        color: #ffffff;
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

    if (document.head) {
      document.head.appendChild(style);
      return;
    }

    document.documentElement.appendChild(style);
  }

  function updateSortIndicators() {
    const cells = getHeaderCells();
    for (const [index, cell] of cells.entries()) {
      if (index === sortState.index) {
        cell.dataset.tmSortDir = sortState.direction;
      } else {
        cell.removeAttribute("data-tm-sort-dir");
      }
    }
  }

  function sortRowsInPlace() {
    if (sortState.index < 0) {
      return;
    }

    const list = getStoreList();
    if (!list) {
      return;
    }

    const totalRow = list.querySelector(`li[${TOTAL_ROW_ATTR}="1"]`);

    const rows = getEntryRows();
    if (rows.length < 2) {
      if (totalRow && list.lastElementChild !== totalRow) {
        pauseObserver();
        try {
          list.appendChild(totalRow);
        } finally {
          resumeObserver();
        }
      }
      return;
    }

    const values = rows.map((row) => getCellText(row, sortState.index));
    const numericColumn = isNumericColumn(values);
    const items = rows.map((row, index) => ({
      row,
      index,
      textValue: values[index],
      numericValue: parseNumericValue(values[index]),
    }));

    items.sort((left, right) => {
      let comparison = 0;

      if (numericColumn) {
        const leftValue = Number.isFinite(left.numericValue) ? left.numericValue : -Infinity;
        const rightValue = Number.isFinite(right.numericValue) ? right.numericValue : -Infinity;
        comparison = leftValue - rightValue;
      } else {
        comparison = collator.compare(left.textValue, right.textValue);
      }

      if (comparison !== 0) {
        return sortState.direction === "asc" ? comparison : -comparison;
      }

      // Keep equal values stable in both ASC and DESC to avoid oscillation.
      return left.index - right.index;
    });

    const isSameOrder = items.every((item, index) => item.row === rows[index]);
    if (isSameOrder) {
      if (totalRow && list.lastElementChild !== totalRow) {
        pauseObserver();
        try {
          list.appendChild(totalRow);
        } finally {
          resumeObserver();
        }
      }
      return;
    }

    pauseObserver();
    isSorting = true;
    try {
      for (const item of items) {
        list.appendChild(item.row);
      }

      if (totalRow) {
        list.appendChild(totalRow);
      }
    } finally {
      isSorting = false;
      resumeObserver();
    }
  }

  function onHeaderClick(event) {
    if (!isEnhancementEligible()) {
      return;
    }

    const cell = event.currentTarget;
    const columnIndex = Number.parseInt(cell.dataset.tmSortIndex ?? "", 10);
    if (!Number.isInteger(columnIndex)) {
      return;
    }

    if (sortState.index === columnIndex) {
      sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
    } else {
      sortState.index = columnIndex;
      sortState.direction = "desc";
    }

    updateSortIndicators();
    sortRowsInPlace();
  }

  function bindHeaderSorting() {
    const cells = getHeaderCells();
    if (!cells.length) {
      return;
    }

    for (const [index, cell] of cells.entries()) {
      cell.dataset.tmSortable = "true";
      cell.dataset.tmSortIndex = String(index);

      if (cell.dataset.tmSortBound !== "1") {
        cell.dataset.tmSortBound = "1";
        cell.addEventListener("click", onHeaderClick, true);
      }
    }

    updateSortIndicators();
  }

  function resolveModId(modName, gameName) {
    const modKey = normalizeText(modName);
    if (!modKey) {
      return null;
    }

    const gameKey = normalizeText(gameName);
    if (gameKey) {
      const gameSpecificKey = `${modKey}|${gameKey}`;
      if (modIdByNameAndGame.has(gameSpecificKey)) {
        return modIdByNameAndGame.get(gameSpecificKey);
      }
    }

    return modIdByName.get(modKey) ?? null;
  }

  function resolveEntryData(modName, gameName) {
    const key = makeNameAndGameKey(modName, gameName);
    if (!key) {
      return null;
    }

    return entryDataByNameAndGame.get(key) ?? null;
  }

  function formatExtraColumnValue(value, format) {
    if (value === null || value === undefined || value === "") {
      return "-";
    }

    if (format === "int") {
      const parsed = Number.parseInt(String(value), 10);
      if (Number.isInteger(parsed)) {
        return numberFormatter.format(parsed);
      }
    }

    return String(value);
  }

  function formatRatioPercent(value) {
    if (!Number.isFinite(value)) {
      return "-";
    }

    return `${percentFormatter.format(value)}%`;
  }

  function removeTotalRow() {
    const list = getStoreList();
    if (!list) {
      return;
    }

    const totalRow = list.querySelector(`li[${TOTAL_ROW_ATTR}="1"]`);
    if (totalRow) {
      totalRow.remove();
    }
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

  function createTotalCell(text, extraKey, rawValue) {
    const cell = document.createElement("span");
    if (extraKey) {
      cell.dataset.tmExtraCol = extraKey;
    }

    if (Number.isFinite(rawValue)) {
      cell.dataset.tmRawValue = String(rawValue);
    }

    cell.textContent = text;
    return cell;
  }

  function upsertTotalRow(hasRows, totalsByKey) {
    const list = getStoreList();
    if (!list) {
      return;
    }

    let totalRow = list.querySelector(`li[${TOTAL_ROW_ATTR}="1"]`);
    if (!hasRows) {
      if (totalRow) {
        totalRow.remove();
      }
      return;
    }

    if (!totalRow) {
      totalRow = document.createElement("li");
      totalRow.setAttribute(TOTAL_ROW_ATTR, "1");
      const totalEntry = document.createElement("div");
      totalEntry.className = "report_entry";
      totalRow.appendChild(totalEntry);
      list.appendChild(totalRow);
    }

    const totalEntry = totalRow.querySelector(".report_entry");
    if (!totalEntry) {
      return;
    }

    totalEntry.dataset.tmHasExtra = "1";
    totalEntry.textContent = "";

    totalEntry.appendChild(createTotalCell("Total"));
    const totalGameCell = createTotalCell("-");
    totalGameCell.dataset.tmTotalGame = "1";
    totalEntry.appendChild(totalGameCell);

    const valueIndex = EXTRA_COLUMNS.findIndex((column) => column.key === "value");
    const beforeValueColumns =
      valueIndex >= 0 ? EXTRA_COLUMNS.slice(0, valueIndex) : EXTRA_COLUMNS.slice();
    const valueColumn = valueIndex >= 0 ? EXTRA_COLUMNS[valueIndex] : null;
    const afterValueColumns = valueIndex >= 0 ? EXTRA_COLUMNS.slice(valueIndex + 1) : [];

    const appendTotalForColumn = (column) => {
      const totalValue = totalsByKey[column.key];
      const isStatus = column.key === "status";
      const displayValue = isStatus ? "-" : formatExtraColumnValue(totalValue, column.format);
      totalEntry.appendChild(createTotalCell(displayValue, column.key, isStatus ? NaN : totalValue));
    };

    for (const column of beforeValueColumns) {
      appendTotalForColumn(column);
    }

    const totalModValue = Number(totalsByKey.modValue ?? 0);
    const totalValue = Number(totalsByKey.value ?? 0);
    const totalRatioPercent =
      Number.isFinite(totalModValue) && totalModValue > 0 && Number.isFinite(totalValue)
        ? (totalValue / totalModValue) * 100
        : NaN;

    const totalRatioCell = createTotalCell(
      formatRatioPercent(totalRatioPercent),
      undefined,
      totalRatioPercent,
    );
    totalRatioCell.dataset.tmTotalRatio = "1";
    totalEntry.appendChild(totalRatioCell);

    if (valueColumn) {
      appendTotalForColumn(valueColumn);
    }

    for (const column of afterValueColumns) {
      appendTotalForColumn(column);
    }

    if (list.lastElementChild !== totalRow) {
      list.appendChild(totalRow);
    }
  }

  function cleanupEnhancements() {
    removeTotalRow();
    removeEnhancementNotice();
    removeWalletReportSeparators();

    const header = document.querySelector("ul.store-items .report_entry_head");
    if (header) {
      header.removeAttribute("data-tm-has-extra");
      const extraHeaders = header.querySelectorAll(".report_entry_head--title[data-tm-extra-col]");
      for (const node of extraHeaders) {
        node.remove();
      }

      const allHeaders = header.querySelectorAll(".report_entry_head--title");
      for (const cell of allHeaders) {
        cell.removeAttribute("data-tm-sort-dir");
      }
    }

    const entries = document.querySelectorAll("ul.store-items .report_entry");
    for (const entry of entries) {
      entry.removeAttribute("data-tm-has-extra");
      const extraCells = entry.querySelectorAll("span[data-tm-extra-col]");
      for (const node of extraCells) {
        node.remove();
      }
    }

    const links = document.querySelectorAll(`a.${LINK_CLASS}`);
    for (const link of links) {
      const text = document.createTextNode(link.textContent ?? "");
      link.replaceWith(text);
    }

    sortState.index = -1;
    sortState.direction = "asc";
  }

  function removeWalletReportSeparators() {
    const separatorRows = document.querySelectorAll(
      `#store-items ul.store-items li[${WALLET_SEPARATOR_ATTR}="1"]`,
    );
    for (const row of separatorRows) {
      row.remove();
    }
  }

  function createWalletReportSeparatorRow() {
    const row = document.createElement("li");
    row.setAttribute(WALLET_SEPARATOR_ATTR, "1");

    const alertWrap = document.createElement("div");
    alertWrap.className = "con-vs-alert con-vs-alert-warning con-icon";
    alertWrap.style.height = "38px";

    const alertBody = document.createElement("div");
    alertBody.className = "vs-alert con-icon";

    const icon = document.createElement("i");
    icon.className = "vs-icon notranslate icon-scale icon-alert material-icons null";
    icon.textContent = "info";

    alertBody.appendChild(icon);
    alertBody.appendChild(document.createTextNode(` ${WALLET_SEPARATOR_TEXT}`));
    alertWrap.appendChild(alertBody);
    row.appendChild(alertWrap);

    return row;
  }

  function applyExtraColumns() {
    const header = document.querySelector("ul.store-items .report_entry_head");
    if (!header) {
      return;
    }

    header.dataset.tmHasExtra = "1";

    for (const column of EXTRA_COLUMNS) {
      let headerCell = header.querySelector(
        `.report_entry_head--title[data-tm-extra-col="${column.key}"]`,
      );

      if (!headerCell) {
        headerCell = document.createElement("span");
        headerCell.className = "report_entry_head--title";
        headerCell.dataset.tmExtraCol = column.key;
        header.appendChild(headerCell);
      }

      headerCell.textContent = column.label;
    }

    const rows = getEntryRows();
    if (!rows.length) {
      upsertTotalRow(false, {});
      return;
    }

    const totalsByKey = {};
    for (const column of EXTRA_COLUMNS) {
      totalsByKey[column.key] = 0;
    }

    for (const row of rows) {
      const cells = getEntryCells(row);
      if (cells.length < 2) {
        continue;
      }

      const rowEntry = row.querySelector(".report_entry");
      if (!rowEntry) {
        continue;
      }

      rowEntry.dataset.tmHasExtra = "1";

      const modName = String(cells[0].textContent ?? "").replace(/\s+/g, " ").trim();
      const gameName = String(cells[1].textContent ?? "").replace(/\s+/g, " ").trim();
      const entryData = resolveEntryData(modName, gameName);

      for (const column of EXTRA_COLUMNS) {
        let extraCell = rowEntry.querySelector(`span[data-tm-extra-col="${column.key}"]`);

        if (!extraCell) {
          extraCell = document.createElement("span");
          extraCell.dataset.tmExtraCol = column.key;
          rowEntry.appendChild(extraCell);
        }

        const rawValue = entryData?.[column.key];
        if (column.key !== "status" && Number.isFinite(rawValue)) {
          totalsByKey[column.key] += rawValue;
        }

        if (column.format === "int" && Number.isInteger(rawValue)) {
          extraCell.dataset.tmRawValue = String(rawValue);
        } else {
          delete extraCell.dataset.tmRawValue;
        }

        extraCell.textContent = formatExtraColumnValue(rawValue, column.format);
      }
    }

    const headerBaseCells = Array.from(header.children).filter(
      (child) =>
        child.classList &&
        child.classList.contains("report_entry_head--title") &&
        !child.dataset.tmExtraCol,
    );
    const ratioHeaderCell = headerBaseCells[2];
    const valueHeaderCell = header.querySelector('.report_entry_head--title[data-tm-extra-col="value"]');
    if (ratioHeaderCell && valueHeaderCell) {
      header.insertBefore(ratioHeaderCell, valueHeaderCell);
    }

    for (const row of rows) {
      const rowEntry = row.querySelector(".report_entry");
      if (!rowEntry) {
        continue;
      }

      const rowBaseCells = Array.from(rowEntry.children).filter(
        (child) => child.tagName === "SPAN" && !child.dataset.tmExtraCol,
      );
      const ratioCell = rowBaseCells[2];
      const valueCell = rowEntry.querySelector('span[data-tm-extra-col="value"]');
      if (ratioCell) {
        const ratioRawValue = parseNumericValue(ratioCell.textContent);
        if (Number.isFinite(ratioRawValue)) {
          ratioCell.dataset.tmRawValue = String(ratioRawValue);
        } else {
          delete ratioCell.dataset.tmRawValue;
        }
      }
      if (ratioCell && valueCell) {
        rowEntry.insertBefore(ratioCell, valueCell);
      }
    }

    upsertTotalRow(true, totalsByKey);
  }

  function applyModLinks() {
    const rows = getEntryRows();
    if (!rows.length) {
      return;
    }

    for (const row of rows) {
      const cells = getEntryCells(row);
      if (!cells.length) {
        continue;
      }

      const modCell = cells[0];
      const gameCell = cells[1];
      const modName = String(modCell.textContent ?? "").replace(/\s+/g, " ").trim();
      const gameName = String(gameCell?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!modName) {
        continue;
      }

      const modId = resolveModId(modName, gameName);
      if (!modId) {
        continue;
      }

      const url = `https://www.nexusmods.com/${GAME_SLUG}/mods/${modId}`;
      const existingLink = modCell.querySelector(`a.${LINK_CLASS}`);
      if (existingLink) {
        existingLink.href = url;
        existingLink.target = "_blank";
        existingLink.rel = "noopener noreferrer";
        continue;
      }

      const link = document.createElement("a");
      link.className = LINK_CLASS;
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = modName;

      modCell.textContent = "";
      modCell.appendChild(link);
    }
  }

  function rememberEntriesFromPayload(payload) {
    const entries = payload?.message?.data?.userMonthlyReport?.entries;
    if (!Array.isArray(entries) || !entries.length) {
      return;
    }

    let hasUpdates = false;

    for (const entry of entries) {
      const modName = entry?.mod?.name;
      const gameName = entry?.game?.name;
      const modId = Number(entry?.modId);
      const entryKey = makeNameAndGameKey(modName, gameName);

      if (!modName || !Number.isInteger(modId)) {
        continue;
      }

      const modKey = normalizeText(modName);
      if (!modKey) {
        continue;
      }

      if (!modIdByName.has(modKey)) {
        modIdByName.set(modKey, modId);
        hasUpdates = true;
      }

      const gameKey = normalizeText(gameName);
      if (gameKey) {
        const gameSpecificKey = `${modKey}|${gameKey}`;
        if (!modIdByNameAndGame.has(gameSpecificKey)) {
          modIdByNameAndGame.set(gameSpecificKey, modId);
          hasUpdates = true;
        }
      }

      if (entryKey) {
        const nextEntryData = {
          modId: toIntegerOrNull(entry?.modId),
          gameId: toIntegerOrNull(entry?.gameId),
          modCount: toIntegerOrNull(entry?.modCount),
          modValue: toIntegerOrNull(entry?.modValue),
          value: toIntegerOrNull(entry?.value),
          reportId: toIntegerOrNull(entry?.reportId),
          status: toIntegerOrNull(entry?.status),
          month: toIntegerOrNull(entry?.month),
          year: toIntegerOrNull(entry?.year),
        };

        const currentEntryData = entryDataByNameAndGame.get(entryKey);
        const hasEntryChanged = EXTRA_COLUMNS.some(
          (column) => currentEntryData?.[column.key] !== nextEntryData[column.key],
        );

        if (!currentEntryData || hasEntryChanged) {
          entryDataByNameAndGame.set(entryKey, nextEntryData);
          hasUpdates = true;
        }
      }
    }

    if (hasUpdates && isEnhancementEligible()) {
      scheduleEnhancement();
    }
  }

  function isModEntriesUrl(url) {
    return typeof url === "string" && url.includes(MOD_ENTRIES_URL_FRAGMENT);
  }

  function isModSummaryUrl(url) {
    return typeof url === "string" && url.includes(MOD_SUMMARY_URL_FRAGMENT);
  }

  function rememberSummaryFromPayload(payload) {
    const entries = payload?.message?.entries;
    if (!Array.isArray(entries) || !entries.length) {
      return;
    }

    let hasUpdates = false;

    for (const entry of entries) {
      const year = toIntegerOrNull(entry?.year);
      const month = toIntegerOrNull(entry?.month);
      const key = makeYearAndMonthKey(year, month);
      if (!key) {
        continue;
      }

      const nextSummaryData = {
        reportType: String(entry?.report_type ?? entry?.reportType ?? "").trim(),
        modCount: toIntegerOrNull(entry?.mod_count ?? entry?.modCount),
        modValue: toIntegerOrNull(entry?.mod_value ?? entry?.modValue),
        value: toIntegerOrNull(entry?.value),
        reportId: toIntegerOrNull(entry?.report_id ?? entry?.reportId),
      };

      const currentSummaryData = summaryDataByYearAndMonth.get(key);
      const hasChanged =
        !currentSummaryData ||
        currentSummaryData.reportType !== nextSummaryData.reportType ||
        currentSummaryData.modCount !== nextSummaryData.modCount ||
        currentSummaryData.modValue !== nextSummaryData.modValue ||
        currentSummaryData.value !== nextSummaryData.value ||
        currentSummaryData.reportId !== nextSummaryData.reportId;

      if (hasChanged) {
        summaryDataByYearAndMonth.set(key, nextSummaryData);
        hasUpdates = true;
      }
    }

    if (hasUpdates && isWalletRoute()) {
      scheduleEnhancement();
    }
  }

  function patchFetch() {
    if (typeof window.fetch !== "function" || window.fetch.__tmModRewardsWrapped) {
      return;
    }

    const nativeFetch = window.fetch.bind(window);

    const wrappedFetch = (...args) =>
      nativeFetch(...args).then((response) => {
        try {
          const request = args[0];
          const url =
            typeof request === "string"
              ? request
              : request && typeof request.url === "string"
                ? request.url
                : "";

          let handler = null;
          if (isModEntriesUrl(url)) {
            handler = rememberEntriesFromPayload;
          } else if (isModSummaryUrl(url)) {
            handler = rememberSummaryFromPayload;
          }

          if (handler) {
            response
              .clone()
              .json()
              .then((payload) => {
                handler(payload);
              })
              .catch(() => {});
          }
        } catch (_) {
          // Ignore response parsing errors.
        }

        return response;
      });

    wrappedFetch.__tmModRewardsWrapped = true;
    window.fetch = wrappedFetch;
  }

  function patchXMLHttpRequest() {
    const proto = XMLHttpRequest.prototype;
    if (proto.open.__tmModRewardsWrapped) {
      return;
    }

    const nativeOpen = proto.open;
    const nativeSend = proto.send;

    proto.open = function patchedOpen(method, url, ...rest) {
      this.__tmModRewardsUrl = typeof url === "string" ? url : "";
      return nativeOpen.call(this, method, url, ...rest);
    };

    proto.send = function patchedSend(...args) {
      let handler = null;
      if (isModEntriesUrl(this.__tmModRewardsUrl)) {
        handler = rememberEntriesFromPayload;
      } else if (isModSummaryUrl(this.__tmModRewardsUrl)) {
        handler = rememberSummaryFromPayload;
      }

      if (handler) {
        this.addEventListener("load", () => {
          if (typeof this.responseText !== "string") {
            return;
          }

          try {
            const payload = JSON.parse(this.responseText);
            handler(payload);
          } catch (_) {
            // Ignore response parsing errors.
          }
        });
      }

      return nativeSend.apply(this, args);
    };

    proto.open.__tmModRewardsWrapped = true;
  }

  function parseYearAndMonthFromReportHref(href) {
    const match = String(href ?? "").match(/#\/reports\/(\d{4})\/(\d{1,2})(?:\/\d+)?$/);
    if (!match) {
      return null;
    }

    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return null;
    }

    return { year, month };
  }

  function parseYearAndMonthFromHash() {
    const match = window.location.hash.match(/^#\/reports\/(\d{4})\/(\d{1,2})(?:\/\d+)?$/);
    if (!match) {
      return null;
    }

    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return null;
    }

    return { year, month };
  }

  async function fetchEntriesForCurrentRoute() {
    if (!isEnhancementEligible()) {
      return;
    }

    const parsed = parseYearAndMonthFromHash();
    if (!parsed) {
      return;
    }

    const key = `${parsed.year}-${parsed.month}`;
    if (key === lastFallbackFetchKey) {
      return;
    }
    lastFallbackFetchKey = key;

    const url = `/Core/Libs/Common/Managers/ModRewards?GetEntries&year=${parsed.year}&month=${parsed.month}`;

    try {
      const response = await window.fetch(url, { credentials: "include" });
      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      rememberEntriesFromPayload(payload);
    } catch (_) {
      // Ignore network errors in fallback fetch.
    }
  }

  async function fetchSummaryForCurrentRoute() {
    if (!isWalletRoute() || hasSummaryFallbackFetchSucceeded || isSummaryFallbackFetchInFlight) {
      return;
    }

    isSummaryFallbackFetchInFlight = true;
    try {
      const response = await window.fetch(MOD_SUMMARY_URL_FRAGMENT, { credentials: "include" });
      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      rememberSummaryFromPayload(payload);
      hasSummaryFallbackFetchSucceeded = true;
    } catch (_) {
      // Ignore network errors in fallback fetch.
    } finally {
      isSummaryFallbackFetchInFlight = false;
    }
  }

  function applyWalletModCountFix() {
    if (!isWalletRoute()) {
      return;
    }

    const list = document.querySelector("#store-items ul.store-items");
    if (!list) {
      return;
    }

    removeWalletReportSeparators();

    const rows = Array.from(list.children).filter((child) => child.tagName === "LI");
    if (!rows.length) {
      return;
    }

    let previousReportType = "";

    for (const row of rows) {
      const rowEntry = row.querySelector(".report_entry");
      if (!rowEntry) {
        continue;
      }

      const cells = Array.from(rowEntry.children).filter((child) => child.tagName === "SPAN");
      if (cells.length < 2) {
        continue;
      }

      const monthAnchor = cells[0].querySelector('a[href*="/reports/"]');
      if (!monthAnchor) {
        continue;
      }

      const parsed = parseYearAndMonthFromReportHref(monthAnchor.getAttribute("href"));
      if (!parsed) {
        continue;
      }

      const summaryData = summaryDataByYearAndMonth.get(makeYearAndMonthKey(parsed.year, parsed.month));
      const reportType = summaryData?.reportType ?? "";
      if (previousReportType && reportType && reportType !== previousReportType) {
        list.insertBefore(createWalletReportSeparatorRow(), row);
      }
      if (reportType) {
        previousReportType = reportType;
      }

      if (!summaryData || reportType !== "i20_game_pools") {
        continue;
      }

      if (!Number.isInteger(summaryData.modCount)) {
        continue;
      }

      const modCountCell = cells[1];
      modCountCell.dataset.tmRawValue = String(summaryData.modCount);
      modCountCell.textContent = numberFormatter.format(summaryData.modCount);
    }
  }

  function enhancePage() {
    if (!isReportsRoute() && !isWalletRoute()) {
      cleanupEnhancements();
      removeEnhancementNotice();
      return;
    }

    pauseObserver();
    isApplyingEnhancements = true;
    try {
      ensureStyle();

      if (isReportsRoute()) {
        if (!isEnhancementEligible()) {
          cleanupEnhancements();
          removeEnhancementNotice();
          return;
        }

        upsertEnhancementNotice();
        applyExtraColumns();
        bindHeaderSorting();
        applyModLinks();
        sortRowsInPlace();
      } else {
        cleanupEnhancements();
        upsertEnhancementNotice();
        applyWalletModCountFix();
      }
    } finally {
      isApplyingEnhancements = false;
      resumeObserver();
    }
  }

  function scheduleEnhancement() {
    if (enhancementScheduled) {
      return;
    }

    enhancementScheduled = true;
    window.requestAnimationFrame(() => {
      enhancementScheduled = false;
      enhancePage();
    });
  }

  function startObserver() {
    const connect = () => {
      if (!document.body) {
        window.requestAnimationFrame(connect);
        return;
      }

      observerRoot = document.body;
      reportObserver = new MutationObserver(() => {
        if (!isSorting && !isApplyingEnhancements && observerPauseDepth === 0) {
          scheduleEnhancement();
        }
      });

      reportObserver.observe(observerRoot, { childList: true, subtree: true });
      scheduleEnhancement();
    };

    connect();
  }

  patchFetch();
  patchXMLHttpRequest();

  window.addEventListener("hashchange", () => {
    scheduleEnhancement();
    fetchEntriesForCurrentRoute();
    fetchSummaryForCurrentRoute();
  });

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        scheduleEnhancement();
        fetchEntriesForCurrentRoute();
        fetchSummaryForCurrentRoute();
      },
      { once: true },
    );
  } else {
    scheduleEnhancement();
    fetchEntriesForCurrentRoute();
    fetchSummaryForCurrentRoute();
  }

  window.setTimeout(fetchEntriesForCurrentRoute, 1250);
  window.setTimeout(fetchSummaryForCurrentRoute, 1250);
  startObserver();
})();
