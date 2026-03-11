// ==UserScript==
// @name         Nexus ModRewards UX Enhancer
// @namespace    https://github.com/Akiway
// @author       Akiway
// @version      1.3.0
// @description  Adds sortable columns, mod links, extra fields, totals on reports, and wallet enhancements.
// @match        https://www.nexusmods.com/modrewards*
// @match        https://www.nexusmods.com/*/modrewards*
// @updateURL    https://github.com/Akiway/Tampermonkey-Nexus/raw/refs/heads/main/scripts/modrewards-ux.user.js
// @downloadURL	 https://github.com/Akiway/Tampermonkey-Nexus/raw/refs/heads/main/scripts/modrewards-ux.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const DEFAULT_GAME_SLUG = "cyberpunk2077";
  const MOD_ENTRIES_URL_FRAGMENT = "/Core/Libs/Common/Managers/ModRewards?GetEntries";
  const MOD_SUMMARY_URL_FRAGMENT = "/Core/Libs/Common/Managers/ModRewards?GetSummary";
  const MOD_USER_MODS_URL_FRAGMENT = "/Core/Libs/Common/Managers/ModRewards?GetUserMods";
  const STYLE_ID = "tm-modrewards-ux-style";
  const NOTICE_ID = "tm-modrewards-notice";
  const LINK_CLASS = "tm-mod-link";
  const TOTAL_ROW_ATTR = "data-tm-total-row";
  const REPORT_MODE_ATTR = "data-tm-report-mode";
  const REPORT_MODE_I20 = "i20";
  const REPORT_MODE_UNIQUE = "unique";
  const UNIQUE_RATIO_ATTR = "data-tm-unique-has-ratio";
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
  const reportTypeByYearAndMonth = new Map();
  const summaryDataByYearAndMonth = new Map();
  const userModDataById = new Map();
  const sortState = { index: -1, direction: "asc" };
  const modsSortState = { key: "", direction: "asc" };

  let isSorting = false;
  let isApplyingEnhancements = false;
  let enhancementScheduled = false;
  let lastFallbackFetchKey = "";
  let lastUserModsFetchKey = "";
  let hasSummaryFallbackFetchSucceeded = false;
  let isSummaryFallbackFetchInFlight = false;
  let isUserModsFallbackFetchInFlight = false;
  let isUserModsAllFetchInFlight = false;
  let lastUserModsAllFetchKey = "";
  let modsTotalPagesHint = 1;
  const modsPaginationState = { pageSize: 20, currentPage: 1 };
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

  function isModsRoute() {
    return /^#\/mods(?:\/|$)/.test(window.location.hash);
  }

  function getCurrentGameSlug() {
    const match = window.location.pathname.match(/^\/([^/]+)\/modrewards(?:\/|$)/i);
    return match?.[1] || DEFAULT_GAME_SLUG;
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

    return Boolean(parseYearAndMonthFromHash());
  }

  function getStoreList() {
    return document.querySelector("ul.store-items");
  }

  function getModsList() {
    return document.querySelector("ul.mod-items");
  }

  function getModsHeaderRow(list = getModsList()) {
    if (!list) {
      return null;
    }

    return (
      Array.from(list.children).find(
        (child) =>
          child.tagName === "LI" &&
          child.querySelector(".mod-col-12-head") &&
          child.querySelector(".mod-name-col") &&
          !child.querySelector(".mod-item-label"),
      ) ?? null
    );
  }

  function getModsRows(list = getModsList()) {
    if (!list) {
      return [];
    }

    return Array.from(list.children).filter(
      (child) =>
        child.tagName === "LI" &&
        !child.querySelector(".mod-col-12-head") &&
        child.querySelector(".mod-name-col") &&
        child.querySelector(".mod-percentage-col"),
    );
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

  function getBaseHeaderCells(header) {
    return Array.from(header.children).filter(
      (child) =>
        child.classList &&
        child.classList.contains("report_entry_head--title") &&
        !child.dataset.tmExtraCol,
    );
  }

  function detectReportModeFromHeader() {
    const header = document.querySelector("ul.store-items .report_entry_head");
    if (!header) {
      return REPORT_MODE_I20;
    }

    const headerNames = getBaseHeaderCells(header).map((cell) => normalizeText(cell.textContent));
    const hasRatioColumn = headerNames.some((text) => text.includes("ratio"));
    if (hasRatioColumn) {
      return REPORT_MODE_I20;
    }

    const hasUniqueColumn = headerNames.some(
      (text) => (text.includes("unique") && text.includes("download")) || text.includes("unique dl"),
    );
    const hasModRewardsColumn = headerNames.some(
      (text) =>
        (text.includes("mod") && text.includes("reward")) ||
        (text.includes("mod") && text.includes("dp")),
    );
    const hasYourRewardColumn = headerNames.some(
      (text) =>
        (text.includes("your") && text.includes("reward")) ||
        (text.includes("your") && text.includes("dp")),
    );

    if (hasUniqueColumn && hasModRewardsColumn && hasYourRewardColumn) {
      return REPORT_MODE_UNIQUE;
    }

    return REPORT_MODE_I20;
  }

  function getCurrentReportMode() {
    const parsed = parseYearAndMonthFromHash();
    if (parsed) {
      const reportType = reportTypeByYearAndMonth.get(makeYearAndMonthKey(parsed.year, parsed.month));
      if (reportType === "UNIQUE_DOWNLOADS") {
        return REPORT_MODE_UNIQUE;
      }
      if (reportType === "I20_GAME_POOLS") {
        return REPORT_MODE_I20;
      }
    }

    return detectReportModeFromHeader();
  }

  function findUniqueColumnIndexes(header) {
    const indexes = {
      modCount: -1,
      modValue: -1,
      value: -1,
      ratio: -1,
    };

    const headerCells = getBaseHeaderCells(header);
    for (const [index, cell] of headerCells.entries()) {
      const label = normalizeText(cell.textContent);
      if (
        indexes.modCount < 0 &&
        ((label.includes("unique") && label.includes("download")) || label.includes("unique dl"))
      ) {
        indexes.modCount = index;
        continue;
      }

      if (
        indexes.modValue < 0 &&
        ((label.includes("mod") && label.includes("reward")) ||
          (label.includes("mod") && label.includes("dp")))
      ) {
        indexes.modValue = index;
        continue;
      }

      if (
        indexes.value < 0 &&
        ((label.includes("your") && label.includes("reward")) ||
          (label.includes("your") && label.includes("dp")))
      ) {
        indexes.value = index;
        continue;
      }

      if (indexes.ratio < 0 && label.includes("ratio")) {
        indexes.ratio = index;
      }
    }

    return indexes;
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

  function parseModIdFromHref(href) {
    const match = String(href ?? "").match(/\/mods\/(\d+)(?:[/?#]|$)/);
    if (!match) {
      return null;
    }

    const parsed = Number.parseInt(match[1], 10);
    return Number.isInteger(parsed) ? parsed : null;
  }

  function splitModNameAndGameFromLabel(labelText) {
    const text = String(labelText ?? "").replace(/\s+/g, " ").trim();
    const match = text.match(/^(.*)\s+for\s+(.+)$/i);
    if (!match) {
      return { modName: text, gameName: "" };
    }

    return {
      modName: String(match[1] ?? "").trim(),
      gameName: String(match[2] ?? "").trim(),
    };
  }

  function buildAbsoluteModUrl(modUrl, modId, domainName) {
    const normalized = String(modUrl ?? "").trim();
    if (/^https?:\/\//i.test(normalized)) {
      return normalized;
    }

    if (normalized.startsWith("/")) {
      return `${window.location.origin}${normalized}`;
    }

    if (Number.isInteger(modId)) {
      const slug = String(domainName || getCurrentGameSlug() || DEFAULT_GAME_SLUG).trim();
      return `https://www.nexusmods.com/${slug}/mods/${modId}`;
    }

    return "";
  }

  function getModsTotalPagesFromDom() {
    const pagers = document.querySelectorAll("ul.mod-items .wallet-labels");
    let maxPage = 0;
    for (const pager of pagers) {
      const text = String(pager.textContent ?? "").replace(/\s+/g, " ").trim();
      const match = text.match(/(\d+)\s+of\s+(\d+)/i);
      if (!match) {
        continue;
      }

      const totalPages = Number.parseInt(match[2], 10);
      if (Number.isInteger(totalPages) && totalPages > maxPage) {
        maxPage = totalPages;
      }
    }

    return maxPage;
  }

  function removeModsPaginationControls(list) {
    const pagerNodes = Array.from(list.children).filter(
      (child) => child.tagName === "DIV" && child.querySelector(".wallet-labels"),
    );
    for (const pager of pagerNodes) {
      pager.remove();
    }
  }

  function getModsSortValueFromRow(row, key) {
    if (!row) {
      return "";
    }

    if (key === "status") {
      return row.querySelector(".tm-mod-status-col .mod-item-select") ? "1" : "0";
    }

    if (key === "name") {
      const linkText = row.querySelector(`.mod-name-col .mod-description a.${LINK_CLASS}`)?.textContent;
      if (linkText) {
        return String(linkText).replace(/\s+/g, " ").trim();
      }

      const fallbackText = row.querySelector(".mod-name-col .mod-description")?.textContent;
      return String(fallbackText ?? "").replace(/\s+/g, " ").trim();
    }

    if (key === "game") {
      return String(row.querySelector(".tm-mod-game-col")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
    }

    if (key === "percentage") {
      const ratioText = row.querySelector(".mod-percentage-col .author-ratio")?.textContent;
      return String(ratioText ?? "").trim();
    }

    if (key === "unique") {
      const downloadsText = row.querySelector('.mod-col-8[data-tm-mod-col="downloads"]')?.textContent;
      return String(downloadsText ?? "").trim();
    }

    if (key === "actions") {
      const actionsText = row.querySelector('.mod-col-8[data-tm-mod-col="actions"]')?.textContent;
      return String(actionsText ?? "").replace(/\s+/g, " ").trim();
    }

    return "";
  }

  function getModsSearchActionsWrap() {
    const searchInput = document.querySelector('.mods-bulk-actions input.styled-input[placeholder*="mod"]');
    return searchInput?.closest(".mods-bulk-actions") ?? null;
  }

  function removeModsSortFieldSelector() {
    const actionRows = Array.from(document.querySelectorAll(".mods-bulk-actions"));
    for (const row of actionRows) {
      const hasSearchInput = Boolean(row.querySelector("input.styled-input"));
      if (hasSearchInput) {
        continue;
      }

      const sortSelect = row.querySelector(
        'select.styled-select:not([data-tm-mods-page-size])',
      );
      if (sortSelect) {
        row.remove();
        return;
      }
    }
  }

  function getModsTotalPagesForPageSize(rowCount) {
    const safeRowCount = Number.isInteger(rowCount) ? rowCount : getModsRows().length;
    const safeSize = Number.isInteger(modsPaginationState.pageSize) ? modsPaginationState.pageSize : 20;
    return Math.max(1, Math.ceil(safeRowCount / Math.max(1, safeSize)));
  }

  function setModsHashPage(page) {
    const nextPage = Number.isInteger(page) && page > 0 ? page : 1;
    const currentHash = window.location.hash || "";
    const nextHash = /^#\/mods\/\d+(?:\/\d+)?$/i.test(currentHash)
      ? currentHash.replace(/^#\/mods\/\d+/i, `#/mods/${nextPage}`)
      : `#/mods/${nextPage}`;

    if (nextHash === currentHash) {
      return;
    }

    const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
    window.history.replaceState(null, "", nextUrl);
  }

  function normalizeModsCurrentPage(totalPages) {
    const parsed = parseModsPageFromHash();
    const requestedPage = Number.isInteger(parsed?.page) ? parsed.page : modsPaginationState.currentPage;
    const clamped = Math.min(Math.max(1, requestedPage || 1), Math.max(1, totalPages));
    modsPaginationState.currentPage = clamped;
    return clamped;
  }

  function applyModsPagination(list = getModsList()) {
    if (!list) {
      return;
    }

    const rows = getModsRows(list);
    const totalPages = getModsTotalPagesForPageSize(rows.length);
    const currentPage = normalizeModsCurrentPage(totalPages);
    const startIndex = (currentPage - 1) * modsPaginationState.pageSize;
    const endIndex = startIndex + modsPaginationState.pageSize;

    for (const [index, row] of rows.entries()) {
      row.style.display = index >= startIndex && index < endIndex ? "" : "none";
    }

    const pagerInfo = document.querySelector("[data-tm-mods-page-info='1']");
    if (pagerInfo) {
      pagerInfo.textContent = `${currentPage} of ${totalPages}`;
    }

    const prevButton = document.querySelector("[data-tm-mods-page-prev='1']");
    if (prevButton) {
      prevButton.disabled = currentPage <= 1;
    }
    const nextButton = document.querySelector("[data-tm-mods-page-next='1']");
    if (nextButton) {
      nextButton.disabled = currentPage >= totalPages;
    }
  }

  function moveToModsPage(page) {
    const rows = getModsRows();
    const totalPages = getModsTotalPagesForPageSize(rows.length);
    const clamped = Math.min(Math.max(1, page), totalPages);
    modsPaginationState.currentPage = clamped;
    setModsHashPage(clamped);
    applyModsPagination();
  }

  function onModsPageSizeChange(event) {
    const nextSize = Number.parseInt(String(event?.currentTarget?.value ?? ""), 10);
    if (![20, 50, 100].includes(nextSize)) {
      return;
    }

    modsPaginationState.pageSize = nextSize;
    moveToModsPage(1);
  }

  function onModsPrevPageClick() {
    moveToModsPage(modsPaginationState.currentPage - 1);
  }

  function onModsNextPageClick() {
    moveToModsPage(modsPaginationState.currentPage + 1);
  }

  function upsertModsPageSizeControl() {
    const wrap = getModsSearchActionsWrap();
    if (!wrap) {
      return;
    }

    let control = wrap.querySelector("[data-tm-mods-page-size-wrap='1']");
    if (!control) {
      control = document.createElement("div");
      control.dataset.tmModsPageSizeWrap = "1";
      control.className = "tm-mods-page-size-wrap";

      const label = document.createElement("label");
      label.className = "tm-mods-page-size-label";
      label.textContent = "Show";

      const select = document.createElement("select");
      select.className = "styled-select tm-mods-page-size-select";
      select.dataset.tmModsPageSize = "1";
      for (const size of [20, 50, 100]) {
        const option = document.createElement("option");
        option.value = String(size);
        option.textContent = String(size);
        select.appendChild(option);
      }

      const suffix = document.createElement("span");
      suffix.className = "tm-mods-page-size-suffix";
      suffix.textContent = "per page";

      control.appendChild(label);
      control.appendChild(select);
      control.appendChild(suffix);
      const clearBlock = wrap.querySelector(".clear");
      if (clearBlock) {
        wrap.insertBefore(control, clearBlock);
      } else {
        wrap.appendChild(control);
      }
    }

    const select = control.querySelector("[data-tm-mods-page-size='1']");
    if (select) {
      select.value = String(modsPaginationState.pageSize);
      if (select.dataset.tmBound !== "1") {
        select.dataset.tmBound = "1";
        select.addEventListener("change", onModsPageSizeChange, true);
      }
    }
  }

  function upsertModsPager(list = getModsList()) {
    if (!list) {
      return;
    }

    let pager = list.querySelector("li[data-tm-mods-pager='1']");
    if (!pager) {
      pager = document.createElement("li");
      pager.dataset.tmModsPager = "1";
      pager.className = "tm-mods-pager";
      pager.innerHTML =
        '<button type="button" data-tm-mods-page-prev="1">Prev</button>' +
        '<span data-tm-mods-page-info="1">1 of 1</span>' +
        '<button type="button" data-tm-mods-page-next="1">Next</button>';
      list.appendChild(pager);
    }

    const prevButton = pager.querySelector("[data-tm-mods-page-prev='1']");
    if (prevButton && prevButton.dataset.tmBound !== "1") {
      prevButton.dataset.tmBound = "1";
      prevButton.addEventListener("click", onModsPrevPageClick, true);
    }
    const nextButton = pager.querySelector("[data-tm-mods-page-next='1']");
    if (nextButton && nextButton.dataset.tmBound !== "1") {
      nextButton.dataset.tmBound = "1";
      nextButton.addEventListener("click", onModsNextPageClick, true);
    }
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

      return "125px";
    };

    const tracks = [
      ...beforeValueColumns.map(trackForColumn),
      "125px",
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

      ul.store-items .report_entry[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_I20}"],
      ul.store-items .report_entry_head[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_I20}"] {
        display: grid !important;
        grid-template-columns:
          minmax(240px, 1.4fr)
          minmax(140px, 0.8fr)
          ${getDataColumnsTemplate()};
        column-gap: 10px;
        align-items: center;
      }

      ul.store-items .report_entry[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_I20}"] > span,
      ul.store-items .report_entry_head[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_I20}"] > .report_entry_head--title {
        width: auto !important;
        min-width: 0;
      }

      ul.store-items .report_entry[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"],
      ul.store-items .report_entry_head[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] {
        display: grid !important;
        column-gap: 10px;
        align-items: center;
      }

      ul.store-items .report_entry[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"][${UNIQUE_RATIO_ATTR}="1"],
      ul.store-items .report_entry_head[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"][${UNIQUE_RATIO_ATTR}="1"] {
        grid-template-columns:
          minmax(240px, 1.4fr)
          minmax(140px, 0.8fr)
          120px
          100px
          125px
          100px
          70px;
      }

      ul.store-items .report_entry[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"][${UNIQUE_RATIO_ATTR}="0"],
      ul.store-items .report_entry_head[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"][${UNIQUE_RATIO_ATTR}="0"] {
        grid-template-columns:
          minmax(240px, 1.4fr)
          minmax(140px, 0.8fr)
          120px
          100px
          100px
          70px;
      }

      ul.store-items .report_entry[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span,
      ul.store-items .report_entry_head[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > .report_entry_head--title {
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

      ul.store-items .report_entry[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span[data-tm-unique-base-col="modCount"],
      ul.store-items .report_entry[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span[data-tm-unique-base-col="modValue"],
      ul.store-items .report_entry[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span[data-tm-unique-base-col="value"] {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      ul.store-items .report_entry[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span[data-tm-extra-col="status"],
      ul.store-items .report_entry_head[data-tm-has-extra="1"][${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > .report_entry_head--title[data-tm-extra-col="status"] {
        text-align: center !important;
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

      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry[${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] {
        margin-top: 0;
        padding-top: 0;
        border-top: 0;
      }

      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry[${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span {
        border-top: 1px solid rgba(255, 255, 255, 0.2);
        padding-top: 6px;
      }

      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry[${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span:nth-child(1) {
        text-align: left;
      }

      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry[${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span[data-tm-extra-col="modCount"],
      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry[${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span[data-tm-extra-col="modValue"],
      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry[${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span[data-tm-extra-col="value"] {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry[${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span[data-tm-total-ratio="1"],
      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry[${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span:nth-child(2),
      ul.store-items li[${TOTAL_ROW_ATTR}="1"] .report_entry[${REPORT_MODE_ATTR}="${REPORT_MODE_UNIQUE}"] > span[data-tm-extra-col="status"] {
        text-align: center !important;
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

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div,
      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div:not(.clear) {
        box-sizing: border-box;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div[data-tm-mods-sortable="1"] {
        cursor: pointer;
        user-select: none;
        position: relative;
        padding-right: 18px !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div[data-tm-mods-sort-dir="asc"]::after {
        content: "\\25B2";
        position: absolute;
        right: 5px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 10px;
        opacity: 0.8;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div[data-tm-mods-sort-dir="desc"]::after {
        content: "\\25BC";
        position: absolute;
        right: 5px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 10px;
        opacity: 0.8;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div.tm-mod-game-head,
      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.tm-mod-status-col,
      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.tm-mod-game-col {
        display: inline-block;
        float: left;
        overflow: hidden;
        padding: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div.tm-mod-game-head {
        background-color: #222222;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div.mod-col-12-head,
      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.tm-mod-status-col {
        width: 9% !important;
        text-align: center;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div.mod-name-col,
      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.mod-name-col {
        width: 27.5% !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div.tm-mod-game-head,
      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.tm-mod-game-col {
        width: 16% !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div.mod-percentage-col,
      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.mod-percentage-col {
        width: 24% !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div.mod-col-8-head[data-tm-mod-col="downloads"],
      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.mod-col-8[data-tm-mod-col="downloads"] {
        width: 11% !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div.mod-col-8-head[data-tm-mod-col="actions"],
      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.mod-col-8[data-tm-mod-col="actions"] {
        width: 12.5% !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.tm-mod-status-col .mod-item-select {
        width: 24px;
        display: block;
        margin: 0 auto !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div {
        text-align: center !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.mod-col-8[data-tm-mod-col="downloads"] {
        text-align: right !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.tm-mod-game-col {
        text-align: center !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-header="1"] > div.tm-mod-game-head,
      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.tm-mod-game-col,
      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.tm-mod-game-col * {
        color: #9a9a9a !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.mod-name-col .mod-description {
        flex: 1 1 auto;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.mod-name-col .mod-item-label {
        display: none !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.mod-name-col .mod-description > a[href*="/mods/"]:not(.${LINK_CLASS}) {
        display: none !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] > li[data-tm-mods-row="1"] > div > div.mod-col-8[data-tm-mod-col="actions"] {
        text-align: right !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] .mod-item-author-badge.small,
      ul.mod-items[data-tm-mods-enhanced="1"] .mod-item-author-badge.small span,
      ul.mod-items[data-tm-mods-enhanced="1"] .mod-item-author-badge.small img {
        width: 40px !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] .mod-item-author-badge.small .author-avatar {
        width: 40px !important;
        height: 40px !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] .mod-item-author-badge.small .author-info {
        width: 40px !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] .mod-item-author-badge {
        margin-bottom: 0 !important;
      }

      ul.mod-items[data-tm-mods-enhanced="1"] .clear {
        height: 0;
      }

      .tm-mods-page-size-wrap {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: 12px;
        float: left;
      }

      .tm-mods-page-size-wrap .tm-mods-page-size-label,
      .tm-mods-page-size-wrap .tm-mods-page-size-suffix {
        color: #e1e1e1;
        font-size: 13px;
      }

      .tm-mods-page-size-wrap .tm-mods-page-size-select {
        width: 84px;
        margin-left: 0 !important;
        padding-right: 24px;
        background-image: url(/assets/images/wallet/select-down-arrow.png);
      }

      ul.mod-items li.tm-mods-pager[data-tm-mods-pager="1"] {
        list-style: none;
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 10px;
        margin-top: 8px;
        color: #e1e1e1;
      }

      ul.mod-items li.tm-mods-pager[data-tm-mods-pager="1"] button {
        border: 1px solid #3f3f3f;
        background: #202020;
        color: #e1e1e1;
        padding: 4px 10px;
        cursor: pointer;
      }

      ul.mod-items li.tm-mods-pager[data-tm-mods-pager="1"] button:disabled {
        opacity: 0.45;
        cursor: default;
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
    totalEntry.setAttribute(REPORT_MODE_ATTR, REPORT_MODE_I20);
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

  function upsertTotalRowForUnique(hasRows, totalsByKey, hasRatioColumn, totalRatioPercent) {
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
    totalEntry.setAttribute(REPORT_MODE_ATTR, REPORT_MODE_UNIQUE);
    totalEntry.setAttribute(UNIQUE_RATIO_ATTR, hasRatioColumn ? "1" : "0");
    totalEntry.textContent = "";

    totalEntry.appendChild(createTotalCell("Total"));
    const totalGameCell = createTotalCell("-");
    totalGameCell.dataset.tmTotalGame = "1";
    totalEntry.appendChild(totalGameCell);

    totalEntry.appendChild(
      createTotalCell(formatExtraColumnValue(totalsByKey.modCount, "int"), "modCount", totalsByKey.modCount),
    );
    totalEntry.appendChild(
      createTotalCell(formatExtraColumnValue(totalsByKey.modValue, "int"), "modValue", totalsByKey.modValue),
    );
    if (hasRatioColumn) {
      const ratioCell = createTotalCell(formatRatioPercent(totalRatioPercent), undefined, totalRatioPercent);
      ratioCell.dataset.tmTotalRatio = "1";
      totalEntry.appendChild(ratioCell);
    }

    totalEntry.appendChild(
      createTotalCell(formatExtraColumnValue(totalsByKey.value, "int"), "value", totalsByKey.value),
    );
    totalEntry.appendChild(createTotalCell("-", "status", NaN));

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
      header.removeAttribute(REPORT_MODE_ATTR);
      header.removeAttribute(UNIQUE_RATIO_ATTR);
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
      entry.removeAttribute(REPORT_MODE_ATTR);
      entry.removeAttribute(UNIQUE_RATIO_ATTR);
      const allCells = entry.querySelectorAll("span");
      for (const cell of allCells) {
        delete cell.dataset.tmRawValue;
        delete cell.dataset.tmUniqueBaseCol;
      }
      const extraCells = entry.querySelectorAll("span[data-tm-extra-col]");
      for (const node of extraCells) {
        node.remove();
      }
    }

    const links = document.querySelectorAll(`ul.store-items a.${LINK_CLASS}`);
    for (const link of links) {
      const text = document.createTextNode(link.textContent ?? "");
      link.replaceWith(text);
    }

    sortState.index = -1;
    sortState.direction = "asc";
  }

  function cleanupModsEnhancements() {
    const list = getModsList();
    if (list) {
      delete list.dataset.tmModsEnhanced;
      delete list.dataset.tmModsExpandedCount;
      const pager = list.querySelector("li[data-tm-mods-pager='1']");
      if (pager) {
        pager.remove();
      }
      const header = getModsHeaderRow(list);
      if (header) {
        delete header.dataset.tmModsHeader;
        const sortableHeaders = header.querySelectorAll("div[data-tm-mods-sort-dir]");
        for (const cell of sortableHeaders) {
          cell.removeAttribute("data-tm-mods-sort-dir");
        }
      }
    }

    const pageSizeWrap = document.querySelector("[data-tm-mods-page-size-wrap='1']");
    if (pageSizeWrap) {
      pageSizeWrap.remove();
    }

    modsSortState.key = "";
    modsSortState.direction = "asc";
    modsPaginationState.pageSize = 20;
    modsPaginationState.currentPage = 1;
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
    header.setAttribute(REPORT_MODE_ATTR, REPORT_MODE_I20);

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
      rowEntry.setAttribute(REPORT_MODE_ATTR, REPORT_MODE_I20);

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

  function applyUniqueDownloadsEnhancements() {
    const header = document.querySelector("ul.store-items .report_entry_head");
    if (!header) {
      return;
    }

    header.dataset.tmHasExtra = "1";
    header.setAttribute(REPORT_MODE_ATTR, REPORT_MODE_UNIQUE);
    header.setAttribute(UNIQUE_RATIO_ATTR, "0");

    const nonStatusHeaders = header.querySelectorAll(
      '.report_entry_head--title[data-tm-extra-col]:not([data-tm-extra-col="status"])',
    );
    for (const node of nonStatusHeaders) {
      node.remove();
    }

    const statusColumn = EXTRA_COLUMNS.find((column) => column.key === "status");
    if (statusColumn) {
      let statusHeader = header.querySelector('.report_entry_head--title[data-tm-extra-col="status"]');
      if (!statusHeader) {
        statusHeader = document.createElement("span");
        statusHeader.className = "report_entry_head--title";
        statusHeader.dataset.tmExtraCol = "status";
        header.appendChild(statusHeader);
      }
      statusHeader.textContent = statusColumn.label;
    }

    const rows = getEntryRows();
    if (!rows.length) {
      upsertTotalRowForUnique(false, {}, false, NaN);
      return;
    }

    const uniqueColumnIndexes = findUniqueColumnIndexes(header);
    const hasRatioColumn = Number.isInteger(uniqueColumnIndexes.ratio) && uniqueColumnIndexes.ratio >= 0;
    header.setAttribute(UNIQUE_RATIO_ATTR, hasRatioColumn ? "1" : "0");
    const baseHeaderCells = getBaseHeaderCells(header);
    if (
      Number.isInteger(uniqueColumnIndexes.modCount) &&
      uniqueColumnIndexes.modCount >= 0 &&
      uniqueColumnIndexes.modCount < baseHeaderCells.length
    ) {
      baseHeaderCells[uniqueColumnIndexes.modCount].textContent = "Unique DLs";
    }
    if (
      Number.isInteger(uniqueColumnIndexes.modValue) &&
      uniqueColumnIndexes.modValue >= 0 &&
      uniqueColumnIndexes.modValue < baseHeaderCells.length
    ) {
      baseHeaderCells[uniqueColumnIndexes.modValue].textContent = "Mod's DP";
    }
    if (
      Number.isInteger(uniqueColumnIndexes.value) &&
      uniqueColumnIndexes.value >= 0 &&
      uniqueColumnIndexes.value < baseHeaderCells.length
    ) {
      baseHeaderCells[uniqueColumnIndexes.value].textContent = "Your DP";
    }
    const totalsByKey = {
      modCount: 0,
      modValue: 0,
      value: 0,
    };

    const addToTotal = (key, entryData, fallbackText) => {
      const valueFromEntry = entryData?.[key];
      if (Number.isFinite(valueFromEntry)) {
        totalsByKey[key] += valueFromEntry;
        return valueFromEntry;
      }

      const parsed = parseNumericValue(fallbackText ?? "");
      if (Number.isFinite(parsed)) {
        totalsByKey[key] += parsed;
        return parsed;
      }

      return NaN;
    };

    for (const row of rows) {
      const cells = getEntryCells(row);
      if (cells.length < 2) {
        continue;
      }

      for (const cell of cells) {
        delete cell.dataset.tmUniqueBaseCol;
      }

      const rowEntry = row.querySelector(".report_entry");
      if (!rowEntry) {
        continue;
      }

      const nonStatusExtraCells = rowEntry.querySelectorAll(
        'span[data-tm-extra-col]:not([data-tm-extra-col="status"])',
      );
      for (const node of nonStatusExtraCells) {
        node.remove();
      }

      rowEntry.dataset.tmHasExtra = "1";
      rowEntry.setAttribute(REPORT_MODE_ATTR, REPORT_MODE_UNIQUE);
      rowEntry.setAttribute(UNIQUE_RATIO_ATTR, hasRatioColumn ? "1" : "0");

      const modName = String(cells[0].textContent ?? "").replace(/\s+/g, " ").trim();
      const gameName = String(cells[1].textContent ?? "").replace(/\s+/g, " ").trim();
      const entryData = resolveEntryData(modName, gameName);

      const setRawForBaseCell = (key, index) => {
        if (!Number.isInteger(index) || index < 0 || index >= cells.length) {
          if (Number.isFinite(entryData?.[key])) {
            totalsByKey[key] += entryData[key];
          }
          return;
        }

        const cell = cells[index];
        cell.dataset.tmUniqueBaseCol = key;
        const numericRaw = addToTotal(key, entryData, cell.textContent);
        if (Number.isFinite(numericRaw)) {
          cell.dataset.tmRawValue = String(numericRaw);
        } else {
          delete cell.dataset.tmRawValue;
        }
      };

      setRawForBaseCell("modCount", uniqueColumnIndexes.modCount);
      setRawForBaseCell("modValue", uniqueColumnIndexes.modValue);
      setRawForBaseCell("value", uniqueColumnIndexes.value);

      if (
        hasRatioColumn &&
        uniqueColumnIndexes.ratio >= 0 &&
        uniqueColumnIndexes.ratio < cells.length
      ) {
        cells[uniqueColumnIndexes.ratio].dataset.tmUniqueBaseCol = "ratio";
      }

      let statusCell = rowEntry.querySelector('span[data-tm-extra-col="status"]');
      if (!statusCell) {
        statusCell = document.createElement("span");
        statusCell.dataset.tmExtraCol = "status";
        rowEntry.appendChild(statusCell);
      }

      const rawStatus = entryData?.status;
      if (Number.isInteger(rawStatus)) {
        statusCell.dataset.tmRawValue = String(rawStatus);
      } else {
        delete statusCell.dataset.tmRawValue;
      }
      statusCell.textContent = formatExtraColumnValue(rawStatus, "int");
    }

    const totalRatioPercent =
      Number.isFinite(totalsByKey.modValue) &&
      totalsByKey.modValue > 0 &&
      Number.isFinite(totalsByKey.value)
        ? (totalsByKey.value / totalsByKey.modValue) * 100
        : NaN;

    upsertTotalRowForUnique(true, totalsByKey, hasRatioColumn, totalRatioPercent);
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

      const url = `https://www.nexusmods.com/${getCurrentGameSlug()}/mods/${modId}`;
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

  function parseModsPageFromHash() {
    const match = window.location.hash.match(/^#\/mods\/(\d+)(?:\/\d+)?$/);
    if (!match) {
      return null;
    }

    const page = Number.parseInt(match[1], 10);
    if (!Number.isInteger(page) || page < 1) {
      return null;
    }

    return { page };
  }

  function rememberUserModsFromPayload(payload) {
    const mods = payload?.message?.mods;
    if (!Array.isArray(mods) || !mods.length) {
      return;
    }

    let hasUpdates = false;

    for (const mod of mods) {
      const modId = toIntegerOrNull(mod?.mod_id ?? mod?.modId);
      if (!Number.isInteger(modId)) {
        continue;
      }

      const modName = String(mod?.name ?? "").trim();
      const gameName = String(mod?.game_name ?? mod?.gameName ?? "").trim();
      const domainName = String(mod?.domain_name ?? mod?.domainName ?? "").trim();
      const modUrl = String(mod?.mod_url ?? mod?.modUrl ?? "").trim();
      const downloads = toIntegerOrNull(mod?.downloads);
      const optedIn = Boolean(mod?.opted_in ?? mod?.optedIn);
      const authorRatio = Number(mod?.authors?.[0]?.ratio);
      const authorAvatar = String(mod?.authors?.[0]?.avatar ?? "").trim();
      const ratioPercent = Number.isFinite(authorRatio) ? authorRatio * 100 : NaN;

      const nextModData = {
        modId,
        modName,
        gameName,
        domainName,
        modUrl,
        downloads,
        optedIn,
        authorAvatar,
        ratioPercent,
      };

      const currentModData = userModDataById.get(modId);
      const hasChanged =
        !currentModData ||
        currentModData.modName !== nextModData.modName ||
        currentModData.gameName !== nextModData.gameName ||
        currentModData.domainName !== nextModData.domainName ||
        currentModData.modUrl !== nextModData.modUrl ||
        currentModData.downloads !== nextModData.downloads ||
        currentModData.optedIn !== nextModData.optedIn ||
        currentModData.authorAvatar !== nextModData.authorAvatar ||
        currentModData.ratioPercent !== nextModData.ratioPercent;

      if (hasChanged) {
        userModDataById.set(modId, nextModData);
        hasUpdates = true;
      }
    }

    if (hasUpdates && isModsRoute()) {
      scheduleEnhancement();
    }
  }

  function updateModsSortIndicators(headerRow) {
    const sortableCells = headerRow?.querySelectorAll("div[data-tm-mods-sort-key]");
    if (!sortableCells) {
      return;
    }

    for (const cell of sortableCells) {
      if (cell.dataset.tmModsSortKey === modsSortState.key) {
        cell.dataset.tmModsSortDir = modsSortState.direction;
      } else {
        cell.removeAttribute("data-tm-mods-sort-dir");
      }
    }
  }

  function sortModsRowsInPlace() {
    if (!isModsRoute() || !modsSortState.key) {
      applyModsPagination();
      return;
    }

    const list = getModsList();
    if (!list) {
      return;
    }

    const rows = getModsRows(list);
    if (rows.length < 2) {
      applyModsPagination(list);
      return;
    }

    const insertionRef = rows[rows.length - 1].nextSibling;
    const isNumeric =
      modsSortState.key === "status" ||
      modsSortState.key === "percentage" ||
      modsSortState.key === "unique";
    const items = rows.map((row, index) => ({
      row,
      index,
      raw: getModsSortValueFromRow(row, modsSortState.key),
    }));

    items.sort((left, right) => {
      let comparison = 0;
      if (isNumeric) {
        const leftValue = parseNumericValue(left.raw);
        const rightValue = parseNumericValue(right.raw);
        const safeLeft = Number.isFinite(leftValue) ? leftValue : -Infinity;
        const safeRight = Number.isFinite(rightValue) ? rightValue : -Infinity;
        comparison = safeLeft - safeRight;
      } else {
        comparison = collator.compare(String(left.raw), String(right.raw));
      }

      if (comparison !== 0) {
        return modsSortState.direction === "asc" ? comparison : -comparison;
      }

      return left.index - right.index;
    });

    pauseObserver();
    isSorting = true;
    try {
      for (const item of items) {
        list.insertBefore(item.row, insertionRef);
      }
    } finally {
      isSorting = false;
      resumeObserver();
    }

    applyModsPagination(list);
  }

  function onModsHeaderClick(event) {
    if (!isModsRoute()) {
      return;
    }

    const key = String(event.currentTarget?.dataset?.tmModsSortKey ?? "").trim();
    if (!key) {
      return;
    }

    if (modsSortState.key === key) {
      modsSortState.direction = modsSortState.direction === "asc" ? "desc" : "asc";
    } else {
      modsSortState.key = key;
      modsSortState.direction = "desc";
    }

    modsPaginationState.currentPage = 1;
    setModsHashPage(1);

    const headerRow = getModsHeaderRow();
    updateModsSortIndicators(headerRow);
    sortModsRowsInPlace();
  }

  function bindModsHeaderSorting(headerRow) {
    const sortableCells = headerRow?.querySelectorAll("div[data-tm-mods-sort-key]");
    if (!sortableCells) {
      return;
    }

    for (const cell of sortableCells) {
      cell.dataset.tmModsSortable = "1";
      if (cell.dataset.tmModsSortBound !== "1") {
        cell.dataset.tmModsSortBound = "1";
        cell.addEventListener("click", onModsHeaderClick, true);
      }
    }

    updateModsSortIndicators(headerRow);
  }

  function rebuildModsRowsFromUserData(list) {
    const rows = getModsRows(list);
    if (!rows.length || !userModDataById.size) {
      return false;
    }

    const totalPagesFromDom = getModsTotalPagesFromDom();
    if (totalPagesFromDom > 0) {
      modsTotalPagesHint = totalPagesFromDom;
    }

    const shouldExpand = userModDataById.size > rows.length;
    if (!shouldExpand) {
      return false;
    }

    if (
      list.dataset.tmModsExpandedCount === String(userModDataById.size) &&
      rows.length === userModDataById.size
    ) {
      removeModsPaginationControls(list);
      return false;
    }

    const templateRow = rows[0].cloneNode(true);
    const rowWithStatusIcon =
      rows.find(
        (row) =>
          row.querySelector(".tm-mod-status-col .mod-item-select") ||
          row.querySelector(".mod-name-col .mod-item-select"),
      ) || rows[0];
    const statusTemplateHtml =
      rowWithStatusIcon.querySelector(".tm-mod-status-col .mod-item-select")?.outerHTML ||
      rowWithStatusIcon.querySelector(".mod-name-col .mod-item-select")?.outerHTML ||
      "";
    const actionsTemplateText = String(
      templateRow.querySelector('.mod-col-8[data-tm-mod-col="actions"]')?.textContent ?? "",
    )
      .replace(/\s+/g, " ")
      .trim();

    const allMods = Array.from(userModDataById.values()).sort((left, right) =>
      collator.compare(left.modName || "", right.modName || ""),
    );

    pauseObserver();
    try {
      for (const row of rows) {
        row.remove();
      }
      removeModsPaginationControls(list);

      for (const modData of allMods) {
        const row = templateRow.cloneNode(true);
        row.dataset.tmModsRow = "1";
        row.dataset.tmModId = Number.isInteger(modData.modId) ? String(modData.modId) : "";

        const statusCol = row.querySelector(".tm-mod-status-col");
        if (statusCol) {
          statusCol.textContent = "";
          if (modData.optedIn) {
            if (statusTemplateHtml) {
              statusCol.innerHTML = statusTemplateHtml;
            } else {
              statusCol.textContent = "1";
            }
          } else {
            statusCol.textContent = "-";
          }
        }

        const modDescription = row.querySelector(".mod-name-col .mod-description");
        if (modDescription) {
          const modName = String(modData.modName ?? "").trim() || "-";
          const modUrl = buildAbsoluteModUrl(modData.modUrl, modData.modId, modData.domainName);
          modDescription.textContent = "";
          if (modUrl) {
            const link = document.createElement("a");
            link.className = LINK_CLASS;
            link.href = modUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = modName;
            modDescription.appendChild(link);
          } else {
            modDescription.textContent = modName;
          }
        }

        const gameCol = row.querySelector(".tm-mod-game-col");
        if (gameCol) {
          gameCol.textContent = String(modData.gameName ?? "").trim() || "-";
        }

        const ratioElement = row.querySelector(".mod-percentage-col .author-ratio");
        if (ratioElement) {
          ratioElement.textContent = Number.isFinite(modData.ratioPercent)
            ? `${percentFormatter.format(modData.ratioPercent)}%`
            : "-";
        }

        const avatarElement = row.querySelector(".mod-percentage-col .author-avatar");
        if (avatarElement && modData.authorAvatar) {
          avatarElement.style.backgroundImage = `url("${modData.authorAvatar}")`;
        }

        const uniqueCol = row.querySelector('.mod-col-8[data-tm-mod-col="downloads"]');
        if (uniqueCol) {
          if (Number.isFinite(modData.downloads)) {
            uniqueCol.textContent = numberFormatter.format(modData.downloads);
            uniqueCol.dataset.tmRawValue = String(modData.downloads);
          } else {
            uniqueCol.textContent = "-";
            delete uniqueCol.dataset.tmRawValue;
          }
        }

        const actionsCol = row.querySelector('.mod-col-8[data-tm-mod-col="actions"]');
        if (actionsCol && !String(actionsCol.textContent ?? "").trim() && actionsTemplateText) {
          actionsCol.textContent = actionsTemplateText;
        }

        row.dataset.tmModsSortStatus = modData.optedIn ? "1" : "0";
        row.dataset.tmModsSortName = String(modData.modName ?? "").trim();
        row.dataset.tmModsSortGame = String(modData.gameName ?? "").trim();
        row.dataset.tmModsSortPercentage = Number.isFinite(modData.ratioPercent)
          ? String(modData.ratioPercent)
          : "";
        row.dataset.tmModsSortUnique = Number.isFinite(modData.downloads) ? String(modData.downloads) : "";
        row.dataset.tmModsSortActions = String(actionsCol?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();

        list.appendChild(row);
      }

      list.dataset.tmModsExpandedCount = String(allMods.length);
      return true;
    } finally {
      resumeObserver();
    }
  }

  function applyModsEnhancements() {
    const list = getModsList();
    if (!list) {
      return;
    }

    removeModsSortFieldSelector();

    const headerRow = getModsHeaderRow(list);
    if (!headerRow) {
      return;
    }

    list.dataset.tmModsEnhanced = "1";
    headerRow.dataset.tmModsHeader = "1";

    const headerStatusCell = headerRow.querySelector(".mod-col-12-head");
    const headerNameCell = headerRow.querySelector(".mod-name-col");
    const headerPercentageCell = headerRow.querySelector(".mod-percentage-col");
    const headerCol8 = Array.from(headerRow.querySelectorAll(".mod-col-8-head"));
    const headerUniqueCell =
      headerCol8.find((cell) => !cell.classList.contains("text-right")) || headerCol8[0] || null;
    const headerActionsCell =
      headerCol8.find((cell) => cell.classList.contains("text-right")) || headerCol8[1] || null;

    if (!headerStatusCell || !headerNameCell || !headerPercentageCell || !headerUniqueCell || !headerActionsCell) {
      return;
    }

    headerStatusCell.textContent = "Opted In";
    headerUniqueCell.dataset.tmModCol = "downloads";
    headerActionsCell.dataset.tmModCol = "actions";

    let headerGameCell = headerRow.querySelector(".tm-mod-game-head");
    if (!headerGameCell) {
      headerGameCell = document.createElement("div");
      headerGameCell.className = "tm-mod-game-head";
      headerRow.insertBefore(headerGameCell, headerPercentageCell);
    }
    headerGameCell.textContent = "Game";

    const sortableConfig = [
      { node: headerStatusCell, key: "status" },
      { node: headerNameCell, key: "name" },
      { node: headerGameCell, key: "game" },
      { node: headerPercentageCell, key: "percentage" },
      { node: headerUniqueCell, key: "unique" },
    ];

    for (const item of sortableConfig) {
      item.node.dataset.tmModsSortKey = item.key;
    }
    headerActionsCell.removeEventListener("click", onModsHeaderClick, true);
    headerActionsCell.removeAttribute("data-tm-mods-sort-key");
    headerActionsCell.removeAttribute("data-tm-mods-sortable");
    headerActionsCell.removeAttribute("data-tm-mods-sort-dir");
    headerActionsCell.removeAttribute("data-tm-mods-sort-bound");
    bindModsHeaderSorting(headerRow);

    const rows = getModsRows(list);
    for (const row of rows) {
      row.dataset.tmModsRow = "1";

      const rowContainer = Array.from(row.children).find((child) => child.tagName === "DIV");
      if (!rowContainer) {
        continue;
      }

      const nameCol = rowContainer.querySelector(".mod-name-col");
      const percentageCol = rowContainer.querySelector(".mod-percentage-col");
      const col8Cells = Array.from(rowContainer.querySelectorAll(".mod-col-8"));
      const uniqueCol = col8Cells[0] || null;
      const actionsCol = col8Cells[1] || null;
      if (!nameCol || !percentageCol || !uniqueCol || !actionsCol) {
        continue;
      }

      uniqueCol.dataset.tmModCol = "downloads";
      actionsCol.dataset.tmModCol = "actions";

      let statusCol = rowContainer.querySelector(".tm-mod-status-col");
      if (!statusCol) {
        statusCol = document.createElement("div");
        statusCol.className = "tm-mod-status-col";
        rowContainer.insertBefore(statusCol, nameCol);
      }

      const statusIcon = nameCol.querySelector(".mod-item-select");
      if (statusIcon) {
        statusCol.textContent = "";
        statusCol.appendChild(statusIcon);
      }

      const modDescription = nameCol.querySelector(".mod-description");
      const label = modDescription?.querySelector(".mod-item-label");
      const existingModLink = modDescription?.querySelector('a[href*="/mods/"]');
      const existingHref = existingModLink?.getAttribute("href") ?? "";
      const parsedModId = parseModIdFromHref(existingHref);
      const modData = Number.isInteger(parsedModId) ? userModDataById.get(parsedModId) : null;

      const labelParts = splitModNameAndGameFromLabel(label?.textContent);
      const modName =
        modData?.modName ||
        labelParts.modName ||
        String(modDescription?.querySelector(`a.${LINK_CLASS}`)?.textContent ?? "").trim() ||
        String(label?.textContent ?? "").trim();
      const gameName =
        modData?.gameName ||
        labelParts.gameName ||
        String(rowContainer.querySelector(".tm-mod-game-col")?.textContent ?? "").trim();
      const modUrl = buildAbsoluteModUrl(modData?.modUrl || existingHref, parsedModId, modData?.domainName);

      let gameCol = rowContainer.querySelector(".tm-mod-game-col");
      if (!gameCol) {
        gameCol = document.createElement("div");
        gameCol.className = "tm-mod-game-col";
        rowContainer.insertBefore(gameCol, percentageCol);
      }
      gameCol.textContent = gameName || "-";

      if (modDescription) {
        if (modUrl) {
          let link = modDescription.querySelector(`a.${LINK_CLASS}`);
          if (!link) {
            link = document.createElement("a");
            link.className = LINK_CLASS;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
          }

          link.href = modUrl;
          link.textContent = modName || "-";
          modDescription.textContent = "";
          modDescription.appendChild(link);
        } else {
          modDescription.textContent = modName || "-";
        }
      }

      const statusSortValue = modData ? (modData.optedIn ? 1 : 0) : statusCol.querySelector(".mod-item-select") ? 1 : 0;
      const percentageText = percentageCol.querySelector(".author-ratio")?.textContent ?? percentageCol.textContent;
      const percentageValue = parseNumericValue(percentageText);
      const uniqueValueFromPayload = Number(modData?.downloads);
      const uniqueValueFromCell = parseNumericValue(uniqueCol.textContent);
      const uniqueValue = Number.isFinite(uniqueValueFromPayload)
        ? uniqueValueFromPayload
        : Number.isFinite(uniqueValueFromCell)
          ? uniqueValueFromCell
          : NaN;
      if (Number.isFinite(uniqueValue)) {
        uniqueCol.textContent = numberFormatter.format(Math.trunc(uniqueValue));
      }

      row.dataset.tmModsSortStatus = String(statusSortValue);
      row.dataset.tmModsSortName = modName || "";
      row.dataset.tmModsSortGame = gameName || "";
      row.dataset.tmModsSortPercentage = Number.isFinite(percentageValue) ? String(percentageValue) : "";
      row.dataset.tmModsSortUnique = Number.isFinite(uniqueValue) ? String(uniqueValue) : "";
      row.dataset.tmModsSortActions = String(actionsCol.textContent ?? "").replace(/\s+/g, " ").trim();
    }

    rebuildModsRowsFromUserData(list);
    removeModsPaginationControls(list);
    upsertModsPageSizeControl();
    upsertModsPager(list);
    sortModsRowsInPlace();
  }

  function rememberEntriesFromPayload(payload) {
    const reportType = String(payload?.message?.data?.userMonthlyReport?.reportType ?? "")
      .trim()
      .toUpperCase();
    const parsedRoute = parseYearAndMonthFromHash();
    if (reportType && parsedRoute) {
      reportTypeByYearAndMonth.set(makeYearAndMonthKey(parsedRoute.year, parsedRoute.month), reportType);
    }

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

      const entryYear = toIntegerOrNull(entry?.year);
      const entryMonth = toIntegerOrNull(entry?.month);
      const reportTypeKey = makeYearAndMonthKey(entryYear, entryMonth);
      if (reportType && reportTypeKey) {
        reportTypeByYearAndMonth.set(reportTypeKey, reportType);
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

  function isUserModsUrl(url) {
    return typeof url === "string" && url.includes(MOD_USER_MODS_URL_FRAGMENT);
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
          } else if (isUserModsUrl(url)) {
            handler = rememberUserModsFromPayload;
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
      } else if (isUserModsUrl(this.__tmModRewardsUrl)) {
        handler = rememberUserModsFromPayload;
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

  async function fetchUserModsForCurrentRoute() {
    if (!isModsRoute() || isUserModsFallbackFetchInFlight) {
      return;
    }

    const totalPagesFromDom = getModsTotalPagesFromDom();
    if (totalPagesFromDom > 0) {
      modsTotalPagesHint = totalPagesFromDom;
    }

    const parsed = parseModsPageFromHash();
    if (!parsed) {
      return;
    }

    const key = `${window.location.pathname}|${parsed.page}`;
    if (key === lastUserModsFetchKey) {
      return;
    }

    isUserModsFallbackFetchInFlight = true;
    try {
      const response = await window.fetch(
        `${MOD_USER_MODS_URL_FRAGMENT}&page=${parsed.page}`,
        { credentials: "include" },
      );
      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      rememberUserModsFromPayload(payload);
      lastUserModsFetchKey = key;
    } catch (_) {
      // Ignore network errors in fallback fetch.
    } finally {
      isUserModsFallbackFetchInFlight = false;
    }
  }

  async function fetchAllUserModsForCurrentRoute() {
    if (!isModsRoute() || isUserModsAllFetchInFlight) {
      return;
    }

    const totalPagesFromDom = getModsTotalPagesFromDom();
    if (totalPagesFromDom > 0) {
      modsTotalPagesHint = totalPagesFromDom;
    }

    const totalPages = Math.max(1, modsTotalPagesHint);
    if (totalPages <= 1) {
      return;
    }

    const key = `${window.location.pathname}|all|${totalPages}`;
    if (key === lastUserModsAllFetchKey) {
      return;
    }

    isUserModsAllFetchInFlight = true;
    let loadedPages = 0;
    try {
      for (let page = 1; page <= totalPages; page += 1) {
        const response = await window.fetch(`${MOD_USER_MODS_URL_FRAGMENT}&page=${page}`, {
          credentials: "include",
        });
        if (!response.ok) {
          break;
        }

        const payload = await response.json();
        rememberUserModsFromPayload(payload);
        loadedPages += 1;
      }

      if (loadedPages === totalPages) {
        lastUserModsAllFetchKey = key;
      }
    } catch (_) {
      // Ignore network errors in fallback fetch.
    } finally {
      isUserModsAllFetchInFlight = false;
      if (loadedPages > 0) {
        scheduleEnhancement();
      }
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
    if (!isReportsRoute() && !isWalletRoute() && !isModsRoute()) {
      cleanupEnhancements();
      cleanupModsEnhancements();
      removeEnhancementNotice();
      return;
    }

    pauseObserver();
    isApplyingEnhancements = true;
    try {
      ensureStyle();

      if (isReportsRoute()) {
        cleanupModsEnhancements();
        if (!isEnhancementEligible()) {
          cleanupEnhancements();
          removeEnhancementNotice();
          return;
        }

        upsertEnhancementNotice();
        const reportMode = getCurrentReportMode();
        if (reportMode === REPORT_MODE_UNIQUE) {
          applyUniqueDownloadsEnhancements();
        } else {
          applyExtraColumns();
        }
        bindHeaderSorting();
        applyModLinks();
        sortRowsInPlace();
      } else if (isWalletRoute()) {
        cleanupModsEnhancements();
        cleanupEnhancements();
        upsertEnhancementNotice();
        applyWalletModCountFix();
      } else if (isModsRoute()) {
        upsertEnhancementNotice();
        fetchAllUserModsForCurrentRoute();
        applyModsEnhancements();
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
    fetchUserModsForCurrentRoute();
    fetchAllUserModsForCurrentRoute();
  });

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        scheduleEnhancement();
        fetchEntriesForCurrentRoute();
        fetchSummaryForCurrentRoute();
        fetchUserModsForCurrentRoute();
        fetchAllUserModsForCurrentRoute();
      },
      { once: true },
    );
  } else {
    scheduleEnhancement();
    fetchEntriesForCurrentRoute();
    fetchSummaryForCurrentRoute();
    fetchUserModsForCurrentRoute();
    fetchAllUserModsForCurrentRoute();
  }

  window.setTimeout(fetchEntriesForCurrentRoute, 1250);
  window.setTimeout(fetchSummaryForCurrentRoute, 1250);
  window.setTimeout(fetchUserModsForCurrentRoute, 1250);
  window.setTimeout(fetchAllUserModsForCurrentRoute, 1250);
  startObserver();
})();
