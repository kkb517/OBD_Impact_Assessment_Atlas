    const MAPBOX_ACCESS_TOKEN = "pk.eyJ1Ijoia2h1c2hidWtiIiwiYSI6ImNtYW9zcjQxaTBhcXcyaXB2ZXc0YTVrNmYifQ.uujp1Y7b8fCTgt9nvddvzA";
    const MAPBOX_STYLE = "mapbox://styles/mapbox/streets-v12";
    window.__UWBE_SCRIPT_STARTED__ = true;

    const MASTER_WELL_FILE = "OBD_Continuous_Parks_Data.csv";
    const BOREWELL_FILE = "UW-Phase_II-Combined_BW_Measurements.csv";
    const DONOR_COLOR_PALETTE = [
      "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b",
      "#e377c2", "#7f7f7f", "#bcbd22", "#17becf", "#ef4444", "#14b8a6",
      "#eab308", "#0ea5e9", "#f97316", "#84cc16", "#a855f7", "#22c55e"
    ];
    const ANALYTICS_START_MONTH = "2023-01";
    const LAG_ANALYTICS_START_MONTH = "2024-11";
    const CONT_MON_START_MONTH = "2025-08";
    const CONT_MON_END_MONTH = "2026-01";
    const CONT_MON_MIN_MONTHS = 3;
    const BOREWELL_TREND_START_MONTH = "2025-10";
    const BOREWELL_TREND_END_MONTH = "2026-01";

    // Defensive cleanup in case stale/raw text lands in map container.
    const mapEl = document.getElementById("map");
    if (mapEl) mapEl.textContent = "";

    function showFatalError(msg) {
      const errBox = document.getElementById("err");
      if (!errBox) return;
      const pageName = window.location.pathname.split("/").pop() || "index.html";
      errBox.style.display = "block";
      errBox.innerHTML = `${String(msg)}<br><span class="hint">Open via <code>http://localhost:8000/${escapeHtml(pageName)}</code> and hard refresh with <code>Ctrl+Shift+R</code>.</span>`;
    }
    if (window.location.protocol === "file:") {
      showFatalError("This map cannot load CSV files from file:// paths.");
      throw new Error("file_protocol_not_supported");
    }
    if (typeof mapboxgl === "undefined") {
      showFatalError("Mapbox library failed to load. Check internet and reload.");
      throw new Error("mapbox_library_missing");
    }

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;
    const map = new mapboxgl.Map({
      container: "map",
      style: MAPBOX_STYLE,
      center: [77.60, 12.97],
      zoom: 11
    });
    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    const emptyFeatureCollection = { type: "FeatureCollection", features: [] };
    let parkHoverPopup = null;
    let wellPopup = null;
    let borewellPopup = null;
    let trendChart = null;
    let mapReady = false;
    let visibleWellHistoryByKey = new Map();
    let layerMode = "BOTH";

    let selectedParkKey = null;
    let activeMonth = "ALL";
    let activeParkFilterKey = "ALL";
    let activeDonor = "ALL";
    let activeValley = "ALL";
    let compareEnabled = false;
    let compareMonthA = null;
    let compareMonthB = null;

    const state = {
      wells: [],
      borewells: [],
      parks: new Map(),
      monthKeys: [],
      rainfallByMonth: new Map(),
      donorsAll: new Set(),
      donorDisplayByNorm: new Map(),
      donorColorByNorm: new Map(),
      borewellMonthKeys: []
    };
    function isPercolationLayerVisible() {
      return layerMode === "BOTH" || layerMode === "PERC_ONLY";
    }
    function isBorewellLayerVisible() {
      return layerMode === "BOTH" || layerMode === "BORE_ONLY";
    }

    function normalizeWellId(id) {
      return String(id || "").trim().toUpperCase();
    }
    function normalizeText(v) {
      return String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
    }
    function valleyKeyFromText(v) {
      const s = normalizeText(v);
      if (!s) return "OTHER";
      if (s.includes("koramangala") || s.includes("challaghatta") || s === "kc" || s === "kc valley") return "KC";
      if (s.includes("hebbal")) return "HEBBAL";
      if (s.includes("bommanahalli")) return "KC";
      if (s.includes("vrishabhavathi") || s === "v valley" || s === "v") return "V";
      return "OTHER";
    }
    function valleyLabelFromKey(v) {
      if (v === "KC") return "KC Valley";
      if (v === "HEBBAL") return "Hebbal Valley";
      if (v === "V") return "V Valley";
      return "Other Valley";
    }
    function valleyMatchesKey(valleyKey) {
      return activeValley === "ALL" || valleyKey === activeValley;
    }

    function parseCsvLine(line) {
      const cells = [];
      let cell = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "\"") {
          if (inQuotes && line[i + 1] === "\"") {
            cell += "\"";
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (c === "," && !inQuotes) {
          cells.push(cell);
          cell = "";
        } else {
          cell += c;
        }
      }
      cells.push(cell);
      return cells;
    }

    function parseCsv(text) {
      const rows = text.replace(/\r/g, "").split("\n").filter(Boolean);
      if (!rows.length) return [];
      const headers = parseCsvLine(rows[0]).map(h => h.trim());
      return rows.slice(1).map(line => {
        const vals = parseCsvLine(line);
        const row = {};
        headers.forEach((h, i) => row[h] = (vals[i] || "").trim());
        return row;
      });
    }
    function parseCsvRows(text) {
      return text.replace(/\r/g, "").split("\n").filter(Boolean).map(parseCsvLine);
    }
    function parseReportCsvByHeader(text, requiredHeaders) {
      const rows = parseCsvRows(text);
      if (!rows.length) return [];
      let headerIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        const rowNorm = rows[i].map(c => String(c || "").trim().toLowerCase());
        const allFound = requiredHeaders.every(h => rowNorm.includes(String(h).trim().toLowerCase()));
        if (allFound) {
          headerIdx = i;
          break;
        }
      }
      if (headerIdx < 0) return [];
      const headers = rows[headerIdx].map(h => String(h || "").trim());
      const out = [];
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const vals = rows[i];
        if (!vals.some(v => String(v || "").trim())) continue;
        const row = {};
        headers.forEach((h, j) => row[h] = String(vals[j] || "").trim());
        out.push(row);
      }
      return out;
    }

    function toNum(x) {
      const s = String(x ?? "").trim();
      if (!s || s.toLowerCase() === "na" || s.toLowerCase() === "null" || s === "-") return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }

    function monthKeyFromDate(d) {
      if (!d) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d.slice(0, 7);
      if (/^\d{2}-\d{2}-\d{4}$/.test(d)) {
        const [dd, mm, yyyy] = d.split("-");
        return `${yyyy}-${mm}`;
      }
      return null;
    }
    function parseBorewellDate(dateStr) {
      const raw = String(dateStr || "").trim();
      if (!raw) return null;
      const normalized = raw
        .replace(/\./g, ":")
        .replace(/(\d)(AM|PM)$/i, "$1 $2")
        .replace(/\s+/g, " ")
        .replace(/\s+,/g, ",")
        .trim();
      const candidates = [
        normalized,
        normalized.replace(/,\s*/g, " "),
        normalized.replace(/(\d{1,2}\s+[A-Za-z]{3}\s+\d{4}),\s*(\d{1,2}:\d{2}\s*[AP]M)/i, "$1 $2")
      ];
      for (const c of candidates) {
        const d = new Date(c);
        if (Number.isFinite(d.getTime())) return d;
      }
      return null;
    }
    function monthKeyFromBorewellDate(dateStr) {
      const d = parseBorewellDate(dateStr);
      if (!d) return null;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }

    function monthLabel(key) {
      if (!/^\d{4}-\d{2}$/.test(String(key || ""))) return String(key || "NA");
      const [y, m] = key.split("-").map(Number);
      return new Date(y, m - 1, 1).toLocaleString("en-IN", { month: "short", year: "numeric" });
    }
    function monthLabelShort(key) {
      if (!/^\d{4}-\d{2}$/.test(String(key || ""))) return String(key || "NA");
      const [y, m] = key.split("-").map(Number);
      const mon = new Date(y, m - 1, 1).toLocaleString("en-IN", { month: "short" });
      return `${mon} ${String(y).slice(2)}`;
    }
    function monthOnOrAfter(monthKey, startKey = ANALYTICS_START_MONTH) {
      const m = String(monthKey || "");
      const s = String(startKey || "");
      if (!/^\d{4}-\d{2}$/.test(m) || !/^\d{4}-\d{2}$/.test(s)) return false;
      return m >= s;
    }
    function monthInRange(monthKey, startKey, endKey) {
      const m = String(monthKey || "");
      const s = String(startKey || "");
      const e = String(endKey || "");
      if (!/^\d{4}-\d{2}$/.test(m) || !/^\d{4}-\d{2}$/.test(s) || !/^\d{4}-\d{2}$/.test(e)) return false;
      return m >= s && m <= e;
    }
    function parseFlexibleDate(dateStr) {
      const s = String(dateStr || "").trim();
      if (!s) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const d = new Date(`${s}T00:00:00`);
        return Number.isFinite(d.getTime()) ? d : null;
      }
      if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
        const [dd, mm, yyyy] = s.split("-");
        const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
        return Number.isFinite(d.getTime()) ? d : null;
      }
      return null;
    }
    function getWaterLevelBand(ft) {
      const n = Number(ft);
      if (!Number.isFinite(n)) return { key: "na", label: "NA", color: "#94a3b8" };
      if (n === 0) return { key: "zero", label: "0 ft", color: "#9ca3af" };
      if (n > 0 && n <= 2) return { key: "b0_2", label: "0-2 ft", color: "#dc2626" };
      if (n > 2 && n <= 4) return { key: "b2_4", label: "2-4 ft", color: "#f59e0b" };
      return { key: "b4_plus", label: "4+ ft", color: "#60a5fa" };
    }
    function getBorewellDepthBand(ft) {
      const n = Number(ft);
      if (!Number.isFinite(n)) return { key: "na", label: "NA", color: "#94a3b8" };
      if (n <= 30) return { key: "d0_30", label: "0-30 ft", color: "#16a34a" };
      if (n <= 80) return { key: "d30_80", label: "30-80 ft", color: "#f59e0b" };
      return { key: "d80_plus", label: "80+ ft", color: "#dc2626" };
    }
    function escapeHtml(s) {
      return String(s || "").replace(/[&<>"']/g, (ch) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[ch]));
    }
    function csvEscape(v) {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
    }
    function fmtNum(v, digits) {
      const n = Number(v);
      if (!Number.isFinite(n)) return "NA";
      return n.toFixed(digits);
    }
    function fmtIntIN(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return "NA";
      return Math.round(n).toLocaleString("en-IN");
    }
    function donorColorByNorm(donorNorm) {
      if (!donorNorm) return "#64748b";
      return state.donorColorByNorm.get(donorNorm) || "#64748b";
    }
    function donorNameByNorm(donorNorm) {
      if (!donorNorm) return "NA";
      return state.donorDisplayByNorm.get(donorNorm) || donorNorm;
    }
    function initDonorColorScale() {
      state.donorColorByNorm.clear();
      const donors = Array.from(state.donorsAll).sort((a, b) => donorNameByNorm(a).localeCompare(donorNameByNorm(b)));
      donors.forEach((d, i) => {
        state.donorColorByNorm.set(d, DONOR_COLOR_PALETTE[i % DONOR_COLOR_PALETTE.length]);
      });
    }
    function dominantDonorNorm(wells) {
      const counts = new Map();
      for (const w of wells) {
        const dn = normalizeText(w.donor);
        if (!dn) continue;
        counts.set(dn, (counts.get(dn) || 0) + 1);
      }
      if (!counts.size) return null;
      return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
    }
    function dominantDonorNormForPark(park) {
      const wellsPool = park.wells.filter(w => {
        const monthOk = activeMonth === "ALL" || w.monthKey === activeMonth;
        return monthOk;
      });
      return dominantDonorNorm(wellsPool.length ? wellsPool : park.wells);
    }
    function distanceKm(lat1, lon1, lat2, lon2) {
      const p = Math.PI / 180;
      const a = 0.5 - Math.cos((lat2 - lat1) * p) / 2 +
        Math.cos(lat1 * p) * Math.cos(lat2 * p) *
        (1 - Math.cos((lon2 - lon1) * p)) / 2;
      return 12742 * Math.asin(Math.sqrt(Math.max(0, a)));
    }

    async function loadText(path) {
      const url = new URL(path, window.location.href).href;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load ${path}`);
      return res.text();
    }

    function recordDonorName(donorRaw) {
      const donor = String(donorRaw || "").trim();
      const donorNorm = normalizeText(donor);
      if (!donorNorm) return donorNorm;
      state.donorsAll.add(donorNorm);
      if (!state.donorDisplayByNorm.has(donorNorm)) state.donorDisplayByNorm.set(donorNorm, donor);
      return donorNorm;
    }
    function pickRainNum(row, keys) {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
        const n = toNum(row[key]);
        if (n !== null) return n;
      }
      return null;
    }
    function normalizeDateKey(dateStr) {
      const s = String(dateStr || "").trim();
      if (!s) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
        const [dd, mm, yyyy] = s.split("-");
        return `${yyyy}-${mm}-${dd}`;
      }
      return null;
    }
    function rebuildRainfallFromWellRows() {
      state.rainfallByMonth.clear();
      const byMonth = new Map();
      for (const w of state.wells) {
        if (!w.monthKey || !monthOnOrAfter(w.monthKey)) continue;
        if (!byMonth.has(w.monthKey)) {
          byMonth.set(w.monthKey, { monthlyVals: [], dailyByDate: new Map() });
        }
        const rec = byMonth.get(w.monthKey);
        if (w.rainMonthlyMm !== null) rec.monthlyVals.push(w.rainMonthlyMm);
        const dKey = normalizeDateKey(w.date);
        if (dKey && w.rainDailyMm !== null && !rec.dailyByDate.has(dKey)) rec.dailyByDate.set(dKey, w.rainDailyMm);
      }
      for (const [monthKey, rec] of byMonth.entries()) {
        const monthlyFromFile = calcAvg(rec.monthlyVals);
        const dailyValues = Array.from(rec.dailyByDate.values());
        const dailyTotal = dailyValues.reduce((sum, v) => sum + v, 0);
        const totalMm = monthlyFromFile !== null ? monthlyFromFile : (dailyValues.length ? dailyTotal : null);
        const avgMmPerDay = dailyValues.length ? (dailyTotal / dailyValues.length) : null;
        state.rainfallByMonth.set(monthKey, { totalMm, avgMmPerDay });
      }
    }

    function addWellRecord(row, sourceFile) {
      const parkName = row.park_name || "Unknown Park";
      const parkId = row.park_id || parkName;
      const donor = String(row.donor || "").trim();
      recordDonorName(donor);
      const parkLat = toNum(row.park_lat);
      const parkLon = toNum(row.park_lon);
      const wellLat = toNum(row.well_lat);
      const wellLon = toNum(row.well_lon);
      const monthKey = monthKeyFromDate(row.date);
      const valley = String(row.valley || "").trim();
      const valleyKey = valleyKeyFromText(valley);
      const valleyLabel = valley || valleyLabelFromKey(valleyKey);
      const parkKey = `${normalizeText(parkName)}::${valleyKey}`;

      if (parkLat === null || parkLon === null) return;

      const well = {
        wellId: row.well_id || "",
        parkId,
        parkKey,
        parkName,
        valley,
        valleyKey,
        valleyLabel,
        donor,
        date: row.date || "",
        monthKey,
        waterLevelFt: toNum(row.water_level_ft),
        rainDailyMm: pickRainNum(row, ["rainfall_day_mm", "daily_rainfall_mm", "imd_daily_rainfall_mm", "rainfall_daily_mm"]),
        rainMonthlyMm: pickRainNum(row, ["monthly_rainfall_mm", "rainfall_monthly_mm", "imd_monthly_rainfall_mm", "rainfall_total_mm"]),
        notes: row.notes || "",
        parkLat,
        parkLon,
        wellLat,
        wellLon,
        sourceFile
      };
      state.wells.push(well);
      if (!state.parks.has(parkKey)) {
        state.parks.set(parkKey, {
          parkId,
          parkIds: new Set([parkId]),
          parkName,
          parkLat,
          parkLon,
          valley: well.valleyLabel,
          valleyKey: well.valleyKey,
          wells: []
        });
      } else {
        state.parks.get(parkKey).parkIds.add(parkId);
        if (!state.parks.get(parkKey).valley) state.parks.get(parkKey).valley = well.valleyLabel;
        if (!state.parks.get(parkKey).valleyKey) state.parks.get(parkKey).valleyKey = well.valleyKey;
      }
      state.parks.get(parkKey).wells.push(well);
      if (monthKey && !state.monthKeys.includes(monthKey)) state.monthKeys.push(monthKey);
    }
    function normalizeBorewellId(id) {
      return String(id || "").trim().toUpperCase();
    }
    function addBorewellRecord(row, sourceFile) {
      const wellId = normalizeBorewellId(row["Well ID"]);
      const zone = String(row["Zone/Valley"] || "").trim();
      const valleyKey = valleyKeyFromText(zone);
      const status = String(row["Borewell Monitoring Status"] || "").trim();
      const remark = String(row["Remark"] || "").trim();
      const dateRaw = String(row["Date and Time of Measurement"] || "").trim();
      const monthKey = monthKeyFromBorewellDate(dateRaw);
      const lat = toNum(row["Latitude"]);
      const lon = toNum(row["Longitude"]);
      const depthFt = toNum(row["Water Level from Ground Level (ft)"]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      if (!wellId && !monthKey) return;
      const rec = {
        wellId: wellId || `NO_ID_${lat.toFixed(5)}_${lon.toFixed(5)}`,
        zone,
        valleyKey,
        status,
        remark,
        date: dateRaw,
        monthKey,
        lat,
        lon,
        depthFt,
        sourceFile
      };
      state.borewells.push(rec);
      if (monthKey && !state.borewellMonthKeys.includes(monthKey)) state.borewellMonthKeys.push(monthKey);
      if (monthKey && !state.monthKeys.includes(monthKey)) state.monthKeys.push(monthKey);
    }
    function standardizeBorewellLocations() {
      const byWell = new Map();
      for (const b of state.borewells) {
        const key = normalizeBorewellId(b.wellId);
        if (!byWell.has(key)) byWell.set(key, []);
        byWell.get(key).push(b);
      }
      for (const recs of byWell.values()) {
        const pairCounts = new Map();
        recs.forEach(r => {
          if (!Number.isFinite(Number(r.lat)) || !Number.isFinite(Number(r.lon))) return;
          const pairKey = `${Number(r.lat).toFixed(6)},${Number(r.lon).toFixed(6)}`;
          pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
        });
        if (!pairCounts.size) continue;
        const bestPair = Array.from(pairCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
        const [latStr, lonStr] = bestPair.split(",");
        recs.forEach(r => {
          r.lat = Number(latStr);
          r.lon = Number(lonStr);
        });
      }
    }

    async function loadWells() {
      const text = await loadText(MASTER_WELL_FILE);
      const rows = parseCsv(text);
      if (!rows.length) throw new Error(`No rows found in ${MASTER_WELL_FILE}`);
      rows.forEach(r => addWellRecord(r, MASTER_WELL_FILE));
      standardizeWellLocations();
      standardizeParkLocations();
      initDonorColorScale();
      state.monthKeys.sort();
      rebuildRainfallFromWellRows();
    }
    async function loadBorewells() {
      const text = await loadText(BOREWELL_FILE);
      const rows = parseReportCsvByHeader(text, ["Well ID", "Date and Time of Measurement", "Latitude", "Longitude", "Zone/Valley"]);
      if (!rows.length) throw new Error(`No parsable rows found in ${BOREWELL_FILE}`);
      rows.forEach(r => addBorewellRecord(r, BOREWELL_FILE));
      standardizeBorewellLocations();
      state.borewellMonthKeys.sort();
      state.monthKeys.sort();
    }

    function standardizeWellLocations() {
      const byWellId = new Map();
      for (const w of state.wells) {
        const normWellId = normalizeWellId(w.wellId);
        const latKey = Number.isFinite(Number(w.wellLat)) ? Number(w.wellLat).toFixed(6) : "NA";
        const lonKey = Number.isFinite(Number(w.wellLon)) ? Number(w.wellLon).toFixed(6) : "NA";
        const key = normWellId ? `${w.parkKey}::${normWellId}` : `${w.parkKey}::NO_ID::${latKey},${lonKey}`;
        if (!byWellId.has(key)) byWellId.set(key, []);
        byWellId.get(key).push(w);
      }

      for (const records of byWellId.values()) {
        if (!records.length) continue;

        const pairCounts = new Map();
        records.forEach(r => {
          const lat = Number(r.wellLat);
          const lon = Number(r.wellLon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
          const pairKey = `${lat.toFixed(6)},${lon.toFixed(6)}`;
          pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
        });

        let canonicalLat = null;
        let canonicalLon = null;

        if (pairCounts.size > 0) {
          const bestPair = Array.from(pairCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
          const [latStr, lonStr] = bestPair.split(",");
          canonicalLat = Number(latStr);
          canonicalLon = Number(lonStr);
        } else {
          const valid = records.filter(r => Number.isFinite(Number(r.wellLat)) && Number.isFinite(Number(r.wellLon)));
          if (!valid.length) continue;
          canonicalLat = valid.reduce((s, r) => s + Number(r.wellLat), 0) / valid.length;
          canonicalLon = valid.reduce((s, r) => s + Number(r.wellLon), 0) / valid.length;
        }

        records.forEach(r => {
          r.wellLat = canonicalLat;
          r.wellLon = canonicalLon;
        });
      }
    }

    function standardizeParkLocations() {
      for (const park of state.parks.values()) {
        const pairCounts = new Map();
        park.wells.forEach(w => {
          const lat = Number(w.parkLat);
          const lon = Number(w.parkLon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
          if (lat === 0 && lon === 0) return;
          const pairKey = `${lat.toFixed(6)},${lon.toFixed(6)}`;
          pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
        });
        if (pairCounts.size) {
          const bestPair = Array.from(pairCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
          const [latStr, lonStr] = bestPair.split(",");
          park.parkLat = Number(latStr);
          park.parkLon = Number(lonStr);
        }
      }
    }

    function filteredWellsForPark(park) {
      return park.wells.filter(w => {
        const monthOk = activeMonth === "ALL" || w.monthKey === activeMonth;
        const donorOk = activeDonor === "ALL" || normalizeText(w.donor) === activeDonor;
        const valleyOk = valleyMatchesKey(w.valleyKey || park.valleyKey);
        return monthOk && donorOk && valleyOk;
      });
    }
    function filteredWellsForParkByMonth(park, monthKey) {
      return park.wells.filter(w => {
        const monthOk = monthKey === "ALL" || w.monthKey === monthKey;
        const donorOk = activeDonor === "ALL" || normalizeText(w.donor) === activeDonor;
        const valleyOk = valleyMatchesKey(w.valleyKey || park.valleyKey);
        return monthOk && donorOk && valleyOk;
      });
    }
    function getVisibleParks() {
      const out = [];
      for (const park of state.parks.values()) {
        if (!parkMatchesFilters(park)) continue;
        const wells = filteredWellsForPark(park);
        if (!wells.length) continue;
        out.push(park);
      }
      return out;
    }
    function getParkSparklineSvg(park) {
      const keys = state.monthKeys.slice();
      if (!keys.length) return "";
      const vals = keys.map(k => {
        const wells = filteredWellsForParkByMonth(park, k);
        return calcAvg(wells.map(w => w.waterLevelFt));
      });
      const valid = vals.filter(v => v !== null);
      if (!valid.length) return "";
      const min = Math.min(...valid);
      const max = Math.max(...valid);
      const w = 120;
      const h = 30;
      const pad = 2;
      const xStep = keys.length > 1 ? (w - pad * 2) / (keys.length - 1) : 0;
      const yFor = (v) => {
        if (v === null) return null;
        if (max === min) return h / 2;
        return pad + (h - pad * 2) * (1 - ((v - min) / (max - min)));
      };
      const points = vals.map((v, i) => {
        const y = yFor(v);
        if (y === null) return null;
        const x = pad + i * xStep;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).filter(Boolean);
      if (!points.length) return "";
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="display:block;margin-top:4px"><polyline fill="none" stroke="#d97706" stroke-width="2" points="${points.join(" ")}"/></svg>`;
    }
    function getWellGroups(wells) {
      const mapById = new Map();
      wells.forEach(w => {
        const idKey = getWellGroupKey(w);
        if (!mapById.has(idKey)) mapById.set(idKey, []);
        mapById.get(idKey).push(w);
      });
      return mapById;
    }
    function getWellGroupKey(w) {
      const normWellId = normalizeWellId(w.wellId);
      const latKey = Number.isFinite(Number(w.wellLat)) ? Number(w.wellLat).toFixed(6) : "NA";
      const lonKey = Number.isFinite(Number(w.wellLon)) ? Number(w.wellLon).toFixed(6) : "NA";
      return normWellId ? `${w.parkKey}::${normWellId}` : `${w.parkKey}::NO_ID::${latKey},${lonKey}`;
    }
    function countContinuouslyMonitoredWells(wells) {
      const byWell = new Map();
      for (const w of wells) {
        if (!w || !w.monthKey || !monthInRange(w.monthKey, CONT_MON_START_MONTH, CONT_MON_END_MONTH)) continue;
        const key = getWellGroupKey(w);
        if (!byWell.has(key)) byWell.set(key, new Set());
        byWell.get(key).add(w.monthKey);
      }
      let count = 0;
      for (const months of byWell.values()) {
        if (months.size >= CONT_MON_MIN_MONTHS) count += 1;
      }
      return count;
    }
    function getLatestRecord(records) {
      if (!records || !records.length) return null;
      return records.slice().sort((a, b) => {
        const da = parseFlexibleDate(a.date);
        const db = parseFlexibleDate(b.date);
        const ta = da ? da.getTime() : -Infinity;
        const tb = db ? db.getTime() : -Infinity;
        return tb - ta;
      })[0];
    }
    function fmtWaterLevel(ft) {
      return ft === null || !Number.isFinite(Number(ft)) ? "NA" : Number(ft).toFixed(1);
    }
    function buildWellHistoryPoints(records) {
      const byMonth = new Map();
      for (const r of records) {
        if (!r.monthKey) continue;
        const prev = byMonth.get(r.monthKey);
        if (!prev) {
          byMonth.set(r.monthKey, r);
          continue;
        }
        const dPrev = parseFlexibleDate(prev.date);
        const dNow = parseFlexibleDate(r.date);
        const tPrev = dPrev ? dPrev.getTime() : -Infinity;
        const tNow = dNow ? dNow.getTime() : -Infinity;
        if (tNow > tPrev) byMonth.set(r.monthKey, r);
      }
      return state.monthKeys.map(k => {
        const rec = byMonth.get(k);
        return {
          monthKey: k,
          monthLabel: monthLabelShort(k),
          waterLevelFt: rec ? rec.waterLevelFt : null,
          date: rec ? (rec.date || "NA") : "NA"
        };
      });
    }
    function getWellHistorySparkSvg(points) {
      const values = points.map(p => p.waterLevelFt);
      const valid = values.filter(v => v !== null && Number.isFinite(Number(v))).map(Number);
      if (!valid.length) return "";
      const min = Math.min(...valid);
      const max = Math.max(...valid);
      const w = 150;
      const h = 34;
      const pad = 3;
      const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
      const yFor = (v) => {
        if (v === null || !Number.isFinite(Number(v))) return null;
        if (max === min) return h / 2;
        return pad + (h - pad * 2) * (1 - ((Number(v) - min) / (max - min)));
      };
      const pts = points.map((p, i) => {
        const y = yFor(p.waterLevelFt);
        if (y === null) return null;
        const x = pad + i * step;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).filter(Boolean);
      if (!pts.length) return "";
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="display:block;margin:6px 0 2px"><polyline fill="none" stroke="#d97706" stroke-width="2" points="${pts.join(" ")}"/></svg>`;
    }
    function buildWellPopupHtml(historyObj) {
      const latest = historyObj.latestRecord;
      const rows = historyObj.points.map(p => {
        const isActive = activeMonth !== "ALL" && p.monthKey === activeMonth;
        return `<tr${isActive ? ' style="background:#fff7ed"' : ""}>
          <td style="padding:4px 6px;border-bottom:1px solid #f1f5f9;">${escapeHtml(p.monthLabel)}</td>
          <td style="padding:4px 6px;border-bottom:1px solid #f1f5f9;text-align:right;">${escapeHtml(fmtWaterLevel(p.waterLevelFt))}</td>
          <td style="padding:4px 6px;border-bottom:1px solid #f1f5f9;">${escapeHtml(p.date)}</td>
        </tr>`;
      }).join("");
      const activeMonthNote = activeMonth === "ALL" ? "" : `<div class="uwbe-popup-foot">Highlighted month: ${escapeHtml(monthLabel(activeMonth))}</div>`;
      return `<div class="uwbe-popup-card">
        <div class="uwbe-popup-title">Well: ${escapeHtml(historyObj.wellId || "NA")}</div>
        <div><b>Park:</b> ${escapeHtml(historyObj.parkName || "NA")}</div>
        <div><b>Latest:</b> ${escapeHtml(fmtWaterLevel(latest ? latest.waterLevelFt : null))} ft on ${escapeHtml(latest ? (latest.date || "NA") : "NA")}</div>
        ${activeMonthNote}
        ${getWellHistorySparkSvg(historyObj.points)}
        <div class="uwbe-popup-sep"></div>
        <div style="max-height:210px;overflow:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr>
                <th style="text-align:left;padding:4px 6px;border-bottom:1px solid #e5e7eb;">Month</th>
                <th style="text-align:right;padding:4px 6px;border-bottom:1px solid #e5e7eb;">Water level (ft)</th>
                <th style="text-align:left;padding:4px 6px;border-bottom:1px solid #e5e7eb;">Date</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
    }
    function getRepresentativeWellRecords(wells) {
      const groups = getWellGroups(wells);
      const reps = [];
      for (const records of groups.values()) {
        const sorted = records.slice().sort((a, b) => {
          const da = parseFlexibleDate(a.date);
          const db = parseFlexibleDate(b.date);
          const ta = da ? da.getTime() : -Infinity;
          const tb = db ? db.getTime() : -Infinity;
          return tb - ta;
        });
        reps.push(sorted[0]);
      }
      return reps;
    }
    function isFiniteWellCoord(w) {
      return Number.isFinite(Number(w.wellLat)) && Number.isFinite(Number(w.wellLon));
    }
    function getDrawableRepresentativeWells(wells) {
      return getRepresentativeWellRecords(wells).filter(isFiniteWellCoord);
    }
    function selectedParkObject(overridePark) {
      if (overridePark) return overridePark;
      if (!selectedParkKey) return null;
      return state.parks.get(selectedParkKey) || null;
    }
    function isNearPark(borewell, park, radiusKm = 2.0) {
      if (!park) return true;
      if (!Number.isFinite(Number(borewell.lat)) || !Number.isFinite(Number(borewell.lon))) return false;
      if (!Number.isFinite(Number(park.parkLat)) || !Number.isFinite(Number(park.parkLon))) return false;
      return distanceKm(Number(borewell.lat), Number(borewell.lon), Number(park.parkLat), Number(park.parkLon)) <= radiusKm;
    }
    function getBorewellScopeRecords(overridePark = null, ignoreMonth = false) {
      const park = selectedParkObject(overridePark);
      return state.borewells.filter(b => {
        const valleyOk = valleyMatchesKey(b.valleyKey);
        const monthOk = ignoreMonth ? true : (activeMonth === "ALL" || b.monthKey === activeMonth);
        const parkOk = isNearPark(b, park);
        return valleyOk && monthOk && parkOk;
      });
    }
    function getLatestBorewellRecord(records) {
      if (!records || !records.length) return null;
      return records.slice().sort((a, b) => {
        const ta = parseBorewellDate(a.date);
        const tb = parseBorewellDate(b.date);
        const va = ta ? ta.getTime() : -Infinity;
        const vb = tb ? tb.getTime() : -Infinity;
        return vb - va;
      })[0];
    }
    function getDrawableBorewells(overridePark = null) {
      const base = getBorewellScopeRecords(overridePark, true);
      if (activeMonth !== "ALL") {
        return base.filter(b => b.monthKey === activeMonth);
      }
      const byWell = new Map();
      base.forEach(b => {
        const key = normalizeBorewellId(b.wellId);
        if (!byWell.has(key)) byWell.set(key, []);
        byWell.get(key).push(b);
      });
      const latest = [];
      for (const recs of byWell.values()) {
        const one = getLatestBorewellRecord(recs);
        if (one) latest.push(one);
      }
      return latest;
    }
    function renderBorewellImpact(scopeLabel, overridePark = null) {
      const el = document.getElementById("borewellImpactWriteup");
      if (!el) return;
      const shown = getDrawableBorewells(overridePark);
      const measuredShown = shown.filter(r => Number.isFinite(Number(r.depthFt)));
      const avgShown = calcAvg(measuredShown.map(r => Number(r.depthFt)));
      const allForTrend = getBorewellScopeRecords(overridePark, true).filter(r =>
        r.monthKey &&
        monthInRange(r.monthKey, BOREWELL_TREND_START_MONTH, BOREWELL_TREND_END_MONTH) &&
        Number.isFinite(Number(r.depthFt))
      );
      const byWell = new Map();
      allForTrend.forEach(r => {
        const key = normalizeBorewellId(r.wellId);
        if (!byWell.has(key)) byWell.set(key, []);
        byWell.get(key).push(r);
      });
      const deltas = [];
      for (const recs of byWell.values()) {
        const sorted = recs.slice().sort((a, b) => {
          const ta = parseBorewellDate(a.date);
          const tb = parseBorewellDate(b.date);
          const va = ta ? ta.getTime() : -Infinity;
          const vb = tb ? tb.getTime() : -Infinity;
          return va - vb;
        });
        const monthSet = new Set(sorted.map(r => r.monthKey).filter(Boolean));
        if (monthSet.size < 2) continue;
        const delta = Number(sorted[sorted.length - 1].depthFt) - Number(sorted[0].depthFt);
        if (Number.isFinite(delta)) deltas.push(delta);
      }
      const improved = deltas.filter(d => d < -0.5).length;
      const worsened = deltas.filter(d => d > 0.5).length;
      const stable = deltas.filter(d => d >= -0.5 && d <= 0.5).length;
      const medianDelta = deltas.length ? deltas.slice().sort((a, b) => a - b)[Math.floor(deltas.length / 2)] : null;
      const story = !deltas.length
        ? "Not enough repeated borewell measurements yet to infer trend."
        : (improved > worsened
          ? "More borewells show improvement (shallower depth), indicating local groundwater recovery."
          : (worsened > improved
            ? "More borewells show deeper water levels, indicating seasonal stress despite recharge interventions."
            : "Borewell trend is mixed; improvements and declines are balanced."));
      el.innerHTML =
        `<div><b>Scope:</b> ${escapeHtml(scopeLabel || "Selected scope")}</div>` +
        `<div><b>Borewells shown:</b> ${fmtIntIN(shown.length)}${avgShown !== null ? `, avg depth ${avgShown.toFixed(1)} ft` : ""}</div>` +
        `<div><b>Trend window:</b> Oct 2025 to Jan 2026 (${deltas.length} borewells with repeated measurements)</div>` +
        `<div style="margin-top:6px;"><b>Story:</b> ${escapeHtml(story)}</div>` +
        `<div><b>Change split:</b> Improved ${improved}, Stable ${stable}, Worsened ${worsened}${medianDelta !== null ? ` (median change ${medianDelta.toFixed(1)} ft)` : ""}</div>` +
        `<div class="small-note" style="margin-top:6px;">For borewells, lower depth from ground level means better groundwater availability.</div>` +
        (activeDonor !== "ALL" ? `<div class="small-note">Borewell dataset is not donor-tagged; donor filter does not alter borewell records.</div>` : "");
    }
    function drawBorewells(overridePark = null) {
      if (!mapReady) return;
      if (!isBorewellLayerVisible()) {
        setSourceData("borewells", emptyFeatureCollection);
        return;
      }
      const recs = getDrawableBorewells(overridePark);
      const features = recs
        .filter(r => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)))
        .map(r => {
          const band = getBorewellDepthBand(r.depthFt);
          return {
            type: "Feature",
            geometry: { type: "Point", coordinates: [Number(r.lon), Number(r.lat)] },
            properties: {
              wellId: r.wellId || "NA",
              zone: r.zone || "NA",
              date: r.date || "NA",
              depthFt: r.depthFt !== null && Number.isFinite(Number(r.depthFt)) ? Number(r.depthFt).toFixed(1) : "NA",
              status: r.status || "NA",
              remark: r.remark || "NA",
              borewellColor: band.color,
              borewellBand: band.label
            }
          };
        });
      setSourceData("borewells", { type: "FeatureCollection", features });
    }
    function clearBorewells() {
      if (!mapReady) return;
      setSourceData("borewells", emptyFeatureCollection);
      if (borewellPopup) {
        borewellPopup.remove();
        borewellPopup = null;
      }
    }

    function parkMatchesFilters(park) {
      const parkOk = activeParkFilterKey === "ALL" || park.parkKey === activeParkFilterKey;
      const valleyOk = valleyMatchesKey(park.valleyKey);
      return parkOk && valleyOk;
    }

    function closeTrendPanel() {
      const panel = document.getElementById("trendPanel");
      if (panel) panel.classList.remove("open");
    }

    function applyFilters() {
      drawParks();
      if (selectedParkKey && state.parks.has(selectedParkKey)) {
        const park = state.parks.get(selectedParkKey);
        if (parkMatchesFilters(park)) {
          if (isPercolationLayerVisible()) drawWellsForPark(park);
          else clearWells();
          if (isBorewellLayerVisible()) drawBorewells(park);
          else clearBorewells();
          renderParkSummary(park);
          renderDepthVsRainTable(park);
          renderTrendPanel(park);
        } else {
          selectedParkKey = null;
          clearWells();
          drawBorewells(null);
          resetSelectionPanel();
          if (activeDonor !== "ALL" || activeMonth !== "ALL" || activeValley !== "ALL") renderScopeTrendPanel();
          else closeTrendPanel();
        }
      } else {
        clearWells();
        if (isBorewellLayerVisible()) drawBorewells(null);
        else clearBorewells();
        resetSelectionPanel();
        if (activeDonor !== "ALL" || activeMonth !== "ALL" || activeValley !== "ALL") renderScopeTrendPanel();
        else closeTrendPanel();
      }
      updateTopStats();
      renderCompareStats();
    }
    function validBorewellCoords(rec) {
      return Number.isFinite(Number(rec?.lat)) && Number.isFinite(Number(rec?.lon));
    }
    function uniqueCoords(coords) {
      const seen = new Set();
      const out = [];
      coords.forEach(c => {
        const key = `${Number(c[0]).toFixed(6)},${Number(c[1]).toFixed(6)}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(c);
      });
      return out;
    }
    function fitMapToCoords(coords, options = {}) {
      if (!coords.length) return false;
      const padding = options.padding ?? 60;
      const duration = options.duration ?? 700;
      const maxZoom = options.maxZoom ?? 16;
      if (coords.length === 1) {
        const [x, y] = coords[0];
        const dLon = 0.01;
        const dLat = 0.01 * Math.cos(y * Math.PI / 180);
        map.fitBounds([[x - dLon, y - dLat], [x + dLon, y + dLat]], { padding, duration, maxZoom });
        return true;
      }
      const bounds = coords.reduce(
        (acc, cur) => acc.extend(cur),
        new mapboxgl.LngLatBounds(coords[0], coords[0])
      );
      map.fitBounds(bounds, { padding, duration, maxZoom });
      return true;
    }
    function filterCoordsNearPark(park, coords, radiusKm = 3.0) {
      const parkLat = Number(park?.parkLat);
      const parkLon = Number(park?.parkLon);
      if (!Number.isFinite(parkLat) || !Number.isFinite(parkLon)) return coords;
      const near = coords.filter(c => distanceKm(parkLat, parkLon, Number(c[1]), Number(c[0])) <= radiusKm);
      if (near.length) return near;
      const ranked = coords
        .map(c => ({ coord: c, dist: distanceKm(parkLat, parkLon, Number(c[1]), Number(c[0])) }))
        .sort((a, b) => a.dist - b.dist);
      if (!ranked.length || ranked[0].dist > 8) return [];
      return ranked.slice(0, Math.min(8, ranked.length)).map(x => x.coord);
    }
    function zoomToParkSelection(park) {
      let coords = [];
      if (isPercolationLayerVisible()) {
        const repWells = getDrawableRepresentativeWells(filteredWellsForPark(park));
        coords = coords.concat(repWells.map(w => [Number(w.wellLon), Number(w.wellLat)]));
      }
      if (isBorewellLayerVisible()) {
        const boreCoords = getDrawableBorewells(park)
          .filter(validBorewellCoords)
          .map(b => [Number(b.lon), Number(b.lat)]);
        coords = coords.concat(boreCoords);
      }
      coords = uniqueCoords(coords.filter(c => Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1]))));
      const nearCoords = filterCoordsNearPark(park, coords, 3.0);
      if (fitMapToCoords(nearCoords, { maxZoom: 16 })) return;

      const x = Number(park.parkLon);
      const y = Number(park.parkLat);
      const dLon = 0.01;
      const dLat = 0.01 * Math.cos(y * Math.PI / 180);
      map.fitBounds([[x - dLon, y - dLat], [x + dLon, y + dLat]], { padding: 60, duration: 600, maxZoom: 15 });
    }
    function clearAllFilters() {
      activeMonth = "ALL";
      activeDonor = "ALL";
      activeValley = "ALL";
      activeParkFilterKey = "ALL";
      selectedParkKey = null;
      layerMode = "BOTH";
      compareEnabled = false;
      compareMonthA = state.monthKeys[0] || null;
      compareMonthB = state.monthKeys[state.monthKeys.length - 1] || null;

      const parkSelect = document.getElementById("parkFilter");
      const donorSelect = document.getElementById("donorFilter");
      const valleySelect = document.getElementById("valleyFilter");
      const monthSelect = document.getElementById("monthFilter");
      const layerModeSelect = document.getElementById("layerModeFilter");
      const compareToggle = document.getElementById("compareToggle");
      const compareCard = document.getElementById("compareCard");
      const monthASelect = document.getElementById("monthAFilter");
      const monthBSelect = document.getElementById("monthBFilter");

      if (parkSelect) parkSelect.value = "ALL";
      if (donorSelect) donorSelect.value = "ALL";
      if (valleySelect) valleySelect.value = "ALL";
      if (monthSelect) monthSelect.value = "ALL";
      if (layerModeSelect) layerModeSelect.value = "BOTH";
      if (compareToggle) compareToggle.checked = false;
      if (compareCard) compareCard.classList.remove("open");
      if (monthASelect && compareMonthA) monthASelect.value = compareMonthA;
      if (monthBSelect && compareMonthB) monthBSelect.value = compareMonthB;

      closeTrendPanel();
      clearWells();
      resetSelectionPanel();
      applyFilters();
    }

    function calcAvg(nums) {
      const valid = nums.filter(n => n !== null && Number.isFinite(n));
      if (!valid.length) return null;
      return valid.reduce((a, b) => a + b, 0) / valid.length;
    }
    function nextMonthKey(monthKey) {
      const m = String(monthKey || "");
      if (!/^\d{4}-\d{2}$/.test(m)) return null;
      const [yy, mm] = m.split("-").map(Number);
      const d = new Date(yy, mm - 1, 1);
      d.setMonth(d.getMonth() + 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    function pearsonCorr(xs, ys) {
      const n = Math.min(xs.length, ys.length);
      if (n < 2) return null;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0;
      let dx2 = 0;
      let dy2 = 0;
      for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx;
        const dy = ys[i] - my;
        num += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
      }
      if (dx2 <= 0 || dy2 <= 0) return null;
      return num / Math.sqrt(dx2 * dy2);
    }
    function linearSlope(xs, ys) {
      const n = Math.min(xs.length, ys.length);
      if (n < 2) return null;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx;
        num += dx * (ys[i] - my);
        den += dx * dx;
      }
      if (den <= 0) return null;
      return num / den;
    }
    function corrStrengthLabel(r) {
      if (r === null || !Number.isFinite(r)) return "NA";
      const a = Math.abs(r);
      if (a < 0.2) return "very weak";
      if (a < 0.4) return "weak";
      if (a < 0.6) return "moderate";
      if (a < 0.8) return "strong";
      return "very strong";
    }
    function lagSignalStory(r) {
      if (r === null || !Number.isFinite(r)) return "Lag relation cannot be estimated for this scope.";
      if (r >= 0.8) return "Very strong delayed recharge signal after rainfall.";
      if (r >= 0.6) return "Strong delayed recharge signal after rainfall.";
      if (r >= 0.4) return "Moderate delayed recharge signal after rainfall.";
      if (r >= 0.2) return "Weak delayed recharge signal after rainfall.";
      if (r > -0.2) return "Very weak delayed recharge signal in current data.";
      if (r > -0.4) return "Weak inverse relation in current data.";
      if (r > -0.6) return "Moderate inverse relation in current data.";
      return "Strong inverse relation in current data.";
    }
    function buildLagMetricsFromWells(wells) {
      const byMonth = new Map();
      for (const w of wells) {
        if (!w || !w.monthKey || !monthOnOrAfter(w.monthKey, LAG_ANALYTICS_START_MONTH)) continue;
        if (!byMonth.has(w.monthKey)) byMonth.set(w.monthKey, { waterVals: [], rainVals: [] });
        const rec = byMonth.get(w.monthKey);
        const wf = Number(w.waterLevelFt);
        if (Number.isFinite(wf)) rec.waterVals.push(wf);
        const rf = Number(w.rainMonthlyMm);
        if (Number.isFinite(rf)) rec.rainVals.push(rf);
      }

      const monthStats = new Map();
      for (const [monthKey, rec] of byMonth.entries()) {
        const avgWater = calcAvg(rec.waterVals);
        const avgRainFromRows = calcAvg(rec.rainVals);
        const avgRain = avgRainFromRows !== null ? avgRainFromRows : (state.rainfallByMonth.get(monthKey)?.totalMm ?? null);
        monthStats.set(monthKey, { avgWater, avgRain });
      }

      const rains = [];
      const waters = [];
      const pairs = [];
      const keys = Array.from(monthStats.keys()).sort();
      for (const k of keys) {
        const nk = nextMonthKey(k);
        if (!nk || !monthStats.has(nk)) continue;
        const curr = monthStats.get(k);
        const next = monthStats.get(nk);
        if (curr.avgRain === null || next.avgWater === null) continue;
        rains.push(curr.avgRain);
        waters.push(next.avgWater);
        pairs.push({
          rainMonthKey: k,
          waterMonthKey: nk,
          rainMm: curr.avgRain,
          waterFt: next.avgWater
        });
      }
      return {
        nPairs: pairs.length,
        pairs,
        r: pearsonCorr(rains, waters),
        slopeFtPerMm: linearSlope(rains, waters)
      };
    }
    function renderLagInsight(wells, scopeLabel) {
      const el = document.getElementById("impactWriteup");
      if (!el) return;
      const inc = buildLagMetricsFromWells(wells);

      if (!wells || !wells.length) {
        el.textContent = "No records available for rainfall-recharge relation in this scope.";
        return;
      }
      if (inc.nPairs < 2) {
        el.innerHTML =
          `Need at least 2 lag month-pairs to compute correlation.` +
          `<br><span class="small-note">Formula: corr(Rain<sub>t</sub>, Water<sub>t+1</sub>).</span>`;
        return;
      }

      const rInc = inc.r !== null ? inc.r.toFixed(3) : "NA";
      const slope100IncRaw = inc.slopeFtPerMm !== null ? Number((inc.slopeFtPerMm * 100).toFixed(2)) : null;
      const slope100Inc = slope100IncRaw === null ? "NA" : `${slope100IncRaw >= 0 ? "+" : ""}${slope100IncRaw.toFixed(2)}`;
      const slopeAbs = slope100IncRaw === null ? null : Math.abs(slope100IncRaw).toFixed(2);
      const firstPair = inc.pairs[0];
      const lastPair = inc.pairs[inc.pairs.length - 1];
      const periodLabel = firstPair && lastPair
        ? `${monthLabel(firstPair.rainMonthKey)} -> ${monthLabel(lastPair.waterMonthKey)}`
        : "NA";
      const storyLine = lagSignalStory(inc.r);
      const impactLine = slopeAbs === null
        ? "Response estimate is not available for this scope."
        : (slope100IncRaw >= 0
            ? `In simple terms: +100 mm rainfall is associated with about +${slopeAbs} ft higher water level in the next month.`
            : `In simple terms: +100 mm rainfall is associated with about -${slopeAbs} ft lower water level in the next month.`);
      el.innerHTML =
        `<div><b>Scope:</b> ${escapeHtml(scopeLabel || "Selected scope")}</div>` +
        `<div><b>Window:</b> ${escapeHtml(periodLabel)} (${inc.nPairs} lag pairs)</div>` +
        `<div style="margin-top:6px;"><b>Story:</b> ${escapeHtml(storyLine)}</div>` +
        `<div>${escapeHtml(impactLine)}</div>` +
        `<div style="margin-top:6px;"><b>Lag correlation:</b> r = ${rInc} (${corrStrengthLabel(inc.r)})</div>` +
        `<div><b>Response:</b> ${slope100Inc} ft per +100 mm rainfall</div>` +
        `<div class="small-note" style="margin-top:6px;">Rainfall in month t is compared with average water level in month t+1 to reflect delayed recharge in percolation wells.</div>` +
        `<div class="small-note">Formula: r = corr(Rain<sub>t</sub>, Water<sub>t+1</sub>), slope = Cov/Var.</div>`;
    }

    function ensureMapLayers() {
      if (mapReady) return;
      map.addSource("parks", { type: "geojson", data: emptyFeatureCollection });
      map.addSource("wells", { type: "geojson", data: emptyFeatureCollection });
      map.addSource("borewells", { type: "geojson", data: emptyFeatureCollection });

      map.addLayer({
        id: "parks-circle",
        type: "circle",
        source: "parks",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            9, ["*", 0.7, ["coalesce", ["get", "radius"], 8]],
            12, ["coalesce", ["get", "radius"], 8],
            14, ["*", 1.2, ["coalesce", ["get", "radius"], 8]]
          ],
          "circle-color": ["coalesce", ["get", "parkColor"], "#64748b"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.2,
          "circle-opacity": 0.92
        }
      });

      map.addLayer({
        id: "wells-circle",
        type: "circle",
        source: "wells",
        paint: {
          "circle-radius": 5,
          "circle-color": ["coalesce", ["get", "wellColor"], "#ff7f11"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 0.8,
          "circle-opacity": 0.92
        }
      });
      map.addLayer({
        id: "borewells-symbol",
        type: "symbol",
        source: "borewells",
        layout: {
          "text-field": "◆",
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            9, 14,
            11, 18,
            13, 22
          ],
          "text-allow-overlap": true
        },
        paint: {
          "text-color": ["coalesce", ["get", "borewellColor"], "#8b5cf6"],
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2
        }
      });

      map.on("click", "parks-circle", (e) => {
        const parkKey = e.features && e.features[0] && e.features[0].properties ? e.features[0].properties.parkKey : null;
        if (parkKey) selectPark(parkKey);
      });

      map.on("mouseenter", "parks-circle", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const feat = e.features && e.features[0];
        if (!feat) return;
        const props = feat.properties || {};
        if (parkHoverPopup) parkHoverPopup.remove();
        const parkKey = props.parkKey || "";
        const park = state.parks.get(parkKey);
        const sparkSvg = park ? getParkSparklineSvg(park) : "";
        parkHoverPopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: "uwbe-popup" })
          .setLngLat(feat.geometry.coordinates)
          .setHTML(
            `<div class="uwbe-popup-card">` +
            `<div class="uwbe-popup-title">${escapeHtml(props.parkName || "Park")}</div>` +
            `<div><b>Donor:</b> ${escapeHtml(props.donorName || "NA")}</div>` +
            `<div><b>Wells:</b> ${escapeHtml(props.wellsCount || "0")}</div>` +
            `<div><b>Avg water level:</b> ${escapeHtml(props.avgWaterLevel || "NA")} ft</div>` +
            ((props.wellsCount || "0") === "0" ? `<div class="uwbe-popup-sep"></div><div class="uwbe-popup-foot">Geotagging under progress</div>` : "") +
            (sparkSvg ? `<div class="uwbe-popup-sep"></div>${sparkSvg}` : "") +
            `</div>`
          )
          .addTo(map);
      });

      map.on("mouseleave", "parks-circle", () => {
        map.getCanvas().style.cursor = "";
        if (parkHoverPopup) {
          parkHoverPopup.remove();
          parkHoverPopup = null;
        }
      });

      map.on("click", "wells-circle", (e) => {
        const feat = e.features && e.features[0];
        if (!feat) return;
        const p = feat.properties || {};
        const historyKey = p.wellHistoryKey || "";
        const historyObj = visibleWellHistoryByKey.get(historyKey);
        if (wellPopup) wellPopup.remove();
        wellPopup = new mapboxgl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "340px", className: "uwbe-popup" })
          .setLngLat(feat.geometry.coordinates)
          .setHTML(historyObj ? buildWellPopupHtml(historyObj) : (
            `<div class="uwbe-popup-card">` +
            `<div class="uwbe-popup-title">Well: ${escapeHtml(p.wellId || "NA")}</div>` +
            `<div><b>Park:</b> ${escapeHtml(p.parkName || "NA")}</div>` +
            `<div><b>Date:</b> ${escapeHtml(p.date || "NA")}</div>` +
            `<div><b>Water level:</b> ${escapeHtml(p.waterLevelFt || "NA")} ft</div>` +
            `<div><b>Band:</b> ${escapeHtml(p.waterBand || "NA")}</div>` +
            `</div>`
          ))
          .addTo(map);
      });
      map.on("mouseenter", "borewells-symbol", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "borewells-symbol", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("click", "borewells-symbol", (e) => {
        const feat = e.features && e.features[0];
        if (!feat) return;
        const p = feat.properties || {};
        if (borewellPopup) borewellPopup.remove();
        borewellPopup = new mapboxgl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "340px", className: "uwbe-popup" })
          .setLngLat(feat.geometry.coordinates)
          .setHTML(
            `<div class="uwbe-popup-card">` +
            `<div class="uwbe-popup-title">Borewell: ${escapeHtml(p.wellId || "NA")}</div>` +
            `<div><b>Zone/Valley:</b> ${escapeHtml(p.zone || "NA")}</div>` +
            `<div><b>Depth from ground:</b> ${escapeHtml(p.depthFt || "NA")} ft (${escapeHtml(p.borewellBand || "NA")})</div>` +
            `<div><b>Date:</b> ${escapeHtml(p.date || "NA")}</div>` +
            `<div><b>Status:</b> ${escapeHtml(p.status || "NA")}</div>` +
            `<div><b>Remark:</b> ${escapeHtml(p.remark || "NA")}</div>` +
            `</div>`
          )
          .addTo(map);
      });

      mapReady = true;
    }

    function setSourceData(sourceId, data) {
      const src = map.getSource(sourceId);
      if (src) src.setData(data);
    }

    function drawParks() {
      if (!mapReady) return;
      const features = [];
      const bounds = [];
      for (const [parkKey, park] of state.parks) {
        if (selectedParkKey && parkKey === selectedParkKey) {
          const selectedPercolation = isPercolationLayerVisible()
            ? getDrawableRepresentativeWells(filteredWellsForPark(park)).length
            : 0;
          const selectedBore = isBorewellLayerVisible()
            ? getDrawableBorewells(park).filter(validBorewellCoords).length
            : 0;
          if (selectedPercolation > 0 || selectedBore > 0) continue;
        }
        if (!parkMatchesFilters(park)) continue;
        const wells = filteredWellsForPark(park);
        if (!wells.length) continue;

        const uniqueWellRecords = getDrawableRepresentativeWells(wells);
        const avgWaterLevel = calcAvg(wells.map(w => w.waterLevelFt));
        const domDonorNorm = dominantDonorNorm(wells);
        const parkColor = donorColorByNorm(domDonorNorm);
        const radius = Math.max(6, Math.min(16, 6 + uniqueWellRecords.length * 0.45));
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [park.parkLon, park.parkLat] },
          properties: {
            parkKey,
            parkName: park.parkName,
            wellsCount: String(uniqueWellRecords.length),
            avgWaterLevel: avgWaterLevel !== null ? avgWaterLevel.toFixed(1) : "NA",
            donorName: donorNameByNorm(domDonorNorm),
            parkColor,
            radius
          }
        });
        bounds.push([park.parkLon, park.parkLat]);
      }

      setSourceData("parks", { type: "FeatureCollection", features });

      if (!selectedParkKey && bounds.length) {
        if (bounds.length === 1) {
          const [x, y] = bounds[0];
          const dLon = 0.02;
          const dLat = 0.02 * Math.cos(y * Math.PI / 180);
          map.fitBounds([[x - dLon, y - dLat], [x + dLon, y + dLat]], { padding: 70, duration: 600, maxZoom: 12.6 });
        } else {
          const mapBounds = bounds.reduce(
            (acc, cur) => acc.extend(cur),
            new mapboxgl.LngLatBounds(bounds[0], bounds[0])
          );
          map.fitBounds(mapBounds, { padding: 60, duration: 700, maxZoom: 12.6 });
        }
      }
    }

    function clearWells() {
      if (!mapReady) return;
      setSourceData("wells", emptyFeatureCollection);
      if (wellPopup) {
        wellPopup.remove();
        wellPopup = null;
      }
    }

    function drawWellsForPark(park) {
      if (!mapReady) return;
      const wellsVisible = filteredWellsForPark(park);
      const wellsAllMonths = filteredWellsForParkByMonth(park, "ALL");
      const groupsVisible = getWellGroups(wellsVisible);
      const groupsAllMonths = getWellGroups(wellsAllMonths);
      visibleWellHistoryByKey = new Map();

      const features = [];
      for (const [groupKey, groupVisible] of groupsVisible.entries()) {
        const rep = getLatestRecord(groupVisible);
        if (!rep || !isFiniteWellCoord(rep)) continue;
        const allForGroup = groupsAllMonths.get(groupKey) || groupVisible;
        const points = buildWellHistoryPoints(allForGroup);
        const latestAll = getLatestRecord(allForGroup);
        const band = getWaterLevelBand(rep.waterLevelFt);
        visibleWellHistoryByKey.set(groupKey, {
          wellId: rep.wellId || "NA",
          parkName: rep.parkName || "NA",
          latestRecord: latestAll,
          points
        });
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [rep.wellLon, rep.wellLat] },
          properties: {
            wellHistoryKey: groupKey,
            wellId: rep.wellId || "NA",
            parkName: rep.parkName || "NA",
            date: rep.date || "NA",
            waterLevelFt: rep.waterLevelFt !== null ? rep.waterLevelFt.toFixed(1) : "NA",
            waterBand: band.label,
            wellColor: band.color
          }
        });
      }
      setSourceData("wells", { type: "FeatureCollection", features });
    }

    function resetSelectionPanel() {
      renderScopeSummary();
      renderScopeDepthVsRainTable();
    }

    function renderParkSummary(park) {
      const wells = filteredWellsForPark(park);
      const wellsAllMonths = filteredWellsForParkByMonth(park, "ALL");
      const wellsSelectedMonth = activeMonth === "ALL" ? [] : filteredWellsForParkByMonth(park, activeMonth);
      const selectedMonthWellCount = activeMonth === "ALL" ? null : getRepresentativeWellRecords(wellsSelectedMonth).length;
      const continuousWellCount = countContinuouslyMonitoredWells(wellsAllMonths);
      const avgWaterLevel = calcAvg(wells.map(w => w.waterLevelFt));

      document.getElementById("parkSummary").innerHTML =
        `<div class="row"><span class="label">Park ID</span><span class="value">${Array.from(park.parkIds || [park.parkId]).join(", ")}</span></div>
         <div class="row"><span class="label">Wells (selected month)</span><span class="value">${selectedMonthWellCount === null ? "Select month" : selectedMonthWellCount}</span></div>
         <div class="row"><span class="label">Continuously monitored wells (>=3 months, Aug 2025-Jan 2026)</span><span class="value">${continuousWellCount}</span></div>
         <div class="row"><span class="label">Avg water level</span><span class="value">${avgWaterLevel !== null ? avgWaterLevel.toFixed(2) : "NA"} ft</span></div>`;
      renderLagInsight(wellsAllMonths, `Park: ${park.parkName}`);
      renderBorewellImpact(`Park: ${park.parkName}`, park);
    }
    function getVisibleStats() {
      let parksVisible = 0;
      let wellsVisible = 0;
      for (const park of state.parks.values()) {
        if (!parkMatchesFilters(park)) continue;
        const wells = filteredWellsForPark(park);
        if (!wells.length) continue;
        const uniqueWellCount = getRepresentativeWellRecords(wells).length;
        parksVisible += 1;
        wellsVisible += uniqueWellCount;
      }
      return { parksVisible, wellsVisible };
    }
    function getScopeWells(ignoreMonth) {
      return state.wells.filter(w => {
        const donorOk = activeDonor === "ALL" || normalizeText(w.donor) === activeDonor;
        const monthOk = ignoreMonth ? true : (activeMonth === "ALL" || w.monthKey === activeMonth);
        const valleyOk = valleyMatchesKey(w.valleyKey);
        return donorOk && monthOk && valleyOk;
      });
    }
    function renderScopeSummary() {
      const el = document.getElementById("parkSummary");
      if (!el) return;
      const wells = getScopeWells(false);
      const wellsForLag = getScopeWells(true);
      const wellsSelectedMonth = activeMonth === "ALL" ? [] : getScopeWells(false);
      const selectedMonthWellCount = activeMonth === "ALL" ? null : getRepresentativeWellRecords(wellsSelectedMonth).length;
      const continuousWellCount = countContinuouslyMonitoredWells(wellsForLag);
      const parks = new Set(wells.map(w => w.parkKey));
      const uniqueWells = getRepresentativeWellRecords(wells).length;
      const avgWaterLevel = calcAvg(wells.map(w => w.waterLevelFt));
      const scopeLabel =
        [
          activeValley !== "ALL" ? `Valley: ${valleyLabelFromKey(activeValley)}` : null,
          activeDonor !== "ALL" ? `Donor: ${donorNameByNorm(activeDonor)}` : null,
          activeMonth !== "ALL" ? `Month: ${monthLabel(activeMonth)}` : null
        ].filter(Boolean).join(" | ") || "All parks";
      el.innerHTML =
        `<div class="row"><span class="label">Scope</span><span class="value">${escapeHtml(scopeLabel)}</span></div>` +
        `<div class="row"><span class="label">Locations</span><span class="value">${fmtIntIN(parks.size)}</span></div>` +
        `<div class="row"><span class="label">Wells (selected month)</span><span class="value">${selectedMonthWellCount === null ? "Select month" : fmtIntIN(selectedMonthWellCount)}</span></div>` +
        `<div class="row"><span class="label">Continuously monitored wells (>=3 months, Aug 2025-Jan 2026)</span><span class="value">${fmtIntIN(continuousWellCount)}</span></div>` +
        `<div class="row"><span class="label">Wells (filtered)</span><span class="value">${fmtIntIN(uniqueWells)}</span></div>` +
        `<div class="row"><span class="label">Avg water level</span><span class="value">${avgWaterLevel !== null ? avgWaterLevel.toFixed(2) : "NA"} ft</span></div>`;
      renderLagInsight(wellsForLag, scopeLabel);
      renderBorewellImpact(scopeLabel, null);
    }
    function buildMonthlyScopeStats(wells) {
      const byMonth = new Map();
      for (const w of wells) {
        if (!w.monthKey || !monthOnOrAfter(w.monthKey)) continue;
        if (!byMonth.has(w.monthKey)) byMonth.set(w.monthKey, []);
        byMonth.get(w.monthKey).push(w);
      }
      const keys = Array.from(byMonth.keys()).sort();
      return keys.map(k => ({
        monthKey: k,
        avgWaterLevel: calcAvg(byMonth.get(k).map(w => w.waterLevelFt)),
        rain: state.rainfallByMonth.get(k) || null
      }));
    }
    function renderScopeDepthVsRainTable() {
      const wellsForSeries = getScopeWells(true);
      const rows = buildMonthlyScopeStats(wellsForSeries);
      const holder = document.getElementById("depthRainTable");
      if (!holder) return;
      if (!rows.length) {
        holder.textContent = "No monthly records for selected filter.";
        return;
      }
      let html = "<table><thead><tr><th>Month</th><th>Avg water level (ft)</th><th>Rainfall total (mm)</th></tr></thead><tbody>";
      rows.forEach(r => {
        const highlight = activeMonth !== "ALL" && r.monthKey === activeMonth ? ' style="background:#fff7ed"' : "";
        html += `<tr${highlight}>
          <td>${monthLabel(r.monthKey)}</td>
          <td>${r.avgWaterLevel !== null ? r.avgWaterLevel.toFixed(2) : "NA"}</td>
          <td>${r.rain ? fmtNum(r.rain.totalMm, 1) : "NA"}</td>
        </tr>`;
      });
      html += "</tbody></table>";
      holder.innerHTML = html;
    }
    function renderScopeTrendPanel() {
      const wellsForSeries = getScopeWells(true);
      const rows = buildMonthlyScopeStats(wellsForSeries);
      if (!rows.length) {
        closeTrendPanel();
        return;
      }
      const panel = document.getElementById("trendPanel");
      if (!panel) return;

      const scopeTitle =
        activeDonor !== "ALL" ? `${donorNameByNorm(activeDonor)} Summary` :
        activeValley !== "ALL" ? `${valleyLabelFromKey(activeValley)} Summary` :
        activeMonth !== "ALL" ? "Monthly Summary" :
        "All Parks Summary";
      const scopeSubtitle =
        activeDonor !== "ALL" ? "Across all parks for selected donor" :
        activeValley !== "ALL" ? "Across selected valley" :
        "Across all parks and donors";
      const avgWaterLevelFt = calcAvg(wellsForSeries.map(w => w.waterLevelFt));

      document.getElementById("trendParkName").textContent = scopeTitle;
      document.getElementById("trendValley").textContent = scopeSubtitle;
      document.getElementById("trendBasinPill").textContent = activeValley === "ALL" ? (activeMonth === "ALL" ? "All months" : monthLabel(activeMonth)) : valleyLabelFromKey(activeValley);
      document.getElementById("trendDonorPill").textContent =
        activeDonor === "ALL"
          ? (activeMonth === "ALL" ? "Donor: All" : `Month: ${monthLabel(activeMonth)}`)
          : `Donor: ${donorNameByNorm(activeDonor)}`;
      document.getElementById("trendAvgPill").textContent = avgWaterLevelFt !== null ? `Avg: ${avgWaterLevelFt.toFixed(2)} ft` : "Avg: NA";

      const empty = document.getElementById("trendEmpty");
      const canvasWrap = document.getElementById("trendCanvasWrap");
      const canvas = document.getElementById("trendChart");
      if (typeof Chart === "undefined") {
        if (trendChart) { trendChart.destroy(); trendChart = null; }
        canvasWrap.style.display = "none";
        empty.style.display = "block";
        empty.textContent = "Chart library failed to load. Reload page.";
        panel.classList.add("open");
        return;
      }

      const labels = rows.map(r => monthLabelShort(r.monthKey));
      const waterLevelData = rows.map(r => r.avgWaterLevel !== null ? Number(r.avgWaterLevel.toFixed(2)) : null);
      const rainData = rows.map(r => (r.rain && Number.isFinite(Number(r.rain.totalMm))) ? Number(Number(r.rain.totalMm).toFixed(1)) : null);
      const maxWaterLevel = waterLevelData.filter(v => v !== null).reduce((m, v) => Math.max(m, v), 0);
      const maxRain = rainData.filter(v => v !== null).reduce((m, v) => Math.max(m, v), 0);

      if (trendChart) trendChart.destroy();
      trendChart = new Chart(canvas, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              type: "line",
              label: "Avg Water Level (ft)",
              data: waterLevelData,
              yAxisID: "yWaterLevel",
              borderColor: "#d97706",
              backgroundColor: "#d97706",
              tension: 0.3,
              pointRadius: 4,
              pointHoverRadius: 5,
              spanGaps: true
            },
            {
              type: "bar",
              label: "Rainfall (mm)",
              data: rainData,
              yAxisID: "yRain",
              borderColor: "#93c5fd",
              backgroundColor: "rgba(147,197,253,0.45)",
              borderWidth: 1.5,
              borderRadius: 4,
              barPercentage: 0.8,
              categoryPercentage: 0.86
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true,
              position: "top",
              labels: { boxWidth: 12, usePointStyle: false, color: "#475569" }
            },
            tooltip: { mode: "index", intersect: false }
          },
          interaction: { mode: "index", intersect: false },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: "#64748b", maxRotation: 0, autoSkip: true }
            },
            yWaterLevel: {
              position: "left",
              title: { display: true, text: "Water level (ft)", color: "#475569", font: { size: 12, weight: "600" } },
              min: 0,
              max: Math.max(6, Math.ceil(maxWaterLevel + 1)),
              ticks: { color: "#64748b" },
              grid: { color: "rgba(148,163,184,0.25)" }
            },
            yRain: {
              position: "right",
              title: { display: true, text: "Rainfall (mm)", color: "#60a5fa", font: { size: 12, weight: "600" } },
              min: 0,
              max: Math.max(100, Math.ceil(maxRain / 50) * 50),
              ticks: { color: "#60a5fa" },
              grid: { drawOnChartArea: false }
            }
          }
        }
      });
      canvasWrap.style.display = "block";
      empty.style.display = "none";
      panel.classList.add("open");
    }

    function renderDepthVsRainTable(park) {
      const byMonth = new Map();
      for (const w of park.wells) {
        if (!w.monthKey || !monthOnOrAfter(w.monthKey)) continue;
        if (!byMonth.has(w.monthKey)) byMonth.set(w.monthKey, []);
        byMonth.get(w.monthKey).push(w);
      }
      const keys = Array.from(byMonth.keys()).sort();
      if (!keys.length) {
        document.getElementById("depthRainTable").textContent = "No monthly records for selected filter.";
        return;
      }
      let html = "<table><thead><tr><th>Month</th><th>Avg water level (ft)</th><th>Rainfall total (mm)</th></tr></thead><tbody>";
      keys.forEach(k => {
        const avgWaterLevel = calcAvg(byMonth.get(k).map(w => w.waterLevelFt));
        const rain = state.rainfallByMonth.get(k);
        const highlight = activeMonth !== "ALL" && k === activeMonth ? ' style="background:#fff7ed"' : "";
        html += `<tr${highlight}>
          <td>${monthLabel(k)}</td>
          <td>${avgWaterLevel !== null ? avgWaterLevel.toFixed(2) : "NA"}</td>
          <td>${rain ? fmtNum(rain.totalMm, 1) : "NA"}</td>
        </tr>`;
      });
      html += "</tbody></table>";
      document.getElementById("depthRainTable").innerHTML = html;
    }

    function renderTrendPanel(park) {
      const panel = document.getElementById("trendPanel");
      if (!panel) return;

      const donorCounts = new Map();
      park.wells.forEach(w => {
        const donorNorm = normalizeText(w.donor);
        if (!donorNorm) return;
        donorCounts.set(donorNorm, (donorCounts.get(donorNorm) || 0) + 1);
      });
      const donorLabel = donorCounts.size
        ? `Donor: ${state.donorDisplayByNorm.get(Array.from(donorCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]) || "NA"}`
        : "Donor: NA";
      const avgWaterLevelFt = calcAvg(park.wells.map(w => w.waterLevelFt));

      document.getElementById("trendParkName").textContent = park.parkName || "Park";
      document.getElementById("trendValley").textContent = park.valley || "Valley: NA";
      document.getElementById("trendBasinPill").textContent = park.valley || "Valley";
      document.getElementById("trendDonorPill").textContent = donorLabel;
      document.getElementById("trendAvgPill").textContent = avgWaterLevelFt !== null ? `Avg: ${avgWaterLevelFt.toFixed(2)} ft` : "Avg: NA";

      const byMonth = new Map();
      park.wells.forEach(w => {
        if (!w.monthKey || !monthOnOrAfter(w.monthKey)) return;
        if (!byMonth.has(w.monthKey)) byMonth.set(w.monthKey, []);
        byMonth.get(w.monthKey).push(w);
      });
      const keys = Array.from(byMonth.keys()).sort();

      const empty = document.getElementById("trendEmpty");
      const canvasWrap = document.getElementById("trendCanvasWrap");
      const canvas = document.getElementById("trendChart");
      if (!keys.length) {
        if (trendChart) { trendChart.destroy(); trendChart = null; }
        canvasWrap.style.display = "none";
        empty.style.display = "block";
        panel.classList.add("open");
        return;
      }

      if (typeof Chart === "undefined") {
        if (trendChart) { trendChart.destroy(); trendChart = null; }
        canvasWrap.style.display = "none";
        empty.style.display = "block";
        empty.textContent = "Chart library failed to load. Reload page.";
        panel.classList.add("open");
        return;
      }

      const labels = keys.map(monthLabelShort);
      const waterLevelData = keys.map(k => {
        const avgFt = calcAvg(byMonth.get(k).map(w => w.waterLevelFt));
        return avgFt !== null ? Number(avgFt.toFixed(2)) : null;
      });
      const rainData = keys.map(k => {
        const r = state.rainfallByMonth.get(k);
        return (r && Number.isFinite(Number(r.totalMm))) ? Number(Number(r.totalMm).toFixed(1)) : null;
      });

      const maxWaterLevel = waterLevelData.filter(v => v !== null).reduce((m, v) => Math.max(m, v), 0);
      const maxRain = rainData.filter(v => v !== null).reduce((m, v) => Math.max(m, v), 0);

      if (trendChart) trendChart.destroy();
      trendChart = new Chart(canvas, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              type: "line",
              label: "Avg Water Level (ft)",
              data: waterLevelData,
              yAxisID: "yWaterLevel",
              borderColor: "#d97706",
              backgroundColor: "#d97706",
              tension: 0.3,
              pointRadius: 4,
              pointHoverRadius: 5,
              spanGaps: true
            },
            {
              type: "bar",
              label: "Rainfall (mm)",
              data: rainData,
              yAxisID: "yRain",
              borderColor: "#93c5fd",
              backgroundColor: "rgba(147,197,253,0.45)",
              borderWidth: 1.5,
              borderRadius: 4,
              barPercentage: 0.8,
              categoryPercentage: 0.86
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true,
              position: "top",
              labels: { boxWidth: 12, usePointStyle: false, color: "#475569" }
            },
            tooltip: { mode: "index", intersect: false }
          },
          interaction: { mode: "index", intersect: false },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: "#64748b", maxRotation: 0, autoSkip: true }
            },
            yWaterLevel: {
              position: "left",
              title: { display: true, text: "Water level (ft)", color: "#475569", font: { size: 12, weight: "600" } },
              min: 0,
              max: Math.max(6, Math.ceil(maxWaterLevel + 1)),
              ticks: { color: "#64748b" },
              grid: { color: "rgba(148,163,184,0.25)" }
            },
            yRain: {
              position: "right",
              title: { display: true, text: "Rainfall (mm)", color: "#60a5fa", font: { size: 12, weight: "600" } },
              min: 0,
              max: Math.max(100, Math.ceil(maxRain / 50) * 50),
              ticks: { color: "#60a5fa" },
              grid: { drawOnChartArea: false }
            }
          }
        }
      });
      canvasWrap.style.display = "block";
      empty.style.display = "none";
      panel.classList.add("open");
    }
    function renderCompareStats() {
      const el = document.getElementById("compareStats");
      if (!el) return;
      if (!compareEnabled) {
        el.textContent = "Compare mode is off.";
        return;
      }
      if (!selectedParkKey || !state.parks.has(selectedParkKey)) {
        el.textContent = "Select a park to view compare stats.";
        return;
      }
      const park = state.parks.get(selectedParkKey);
      const a = compareMonthA || (state.monthKeys[0] || "ALL");
      const b = compareMonthB || (state.monthKeys[state.monthKeys.length - 1] || "ALL");
      const wa = filteredWellsForParkByMonth(park, a);
      const wb = filteredWellsForParkByMonth(park, b);
      const avgA = calcAvg(wa.map(w => w.waterLevelFt));
      const avgB = calcAvg(wb.map(w => w.waterLevelFt));
      const rainA = state.rainfallByMonth.get(a);
      const rainB = state.rainfallByMonth.get(b);
      const delta = (avgA !== null && avgB !== null) ? (avgB - avgA) : null;
      el.innerHTML =
        `<div><strong>${monthLabel(a)}</strong>: ${avgA !== null ? avgA.toFixed(2) : "NA"} ft, Rain ${rainA ? fmtNum(rainA.totalMm, 1) : "NA"} mm</div>` +
        `<div><strong>${monthLabel(b)}</strong>: ${avgB !== null ? avgB.toFixed(2) : "NA"} ft, Rain ${rainB ? fmtNum(rainB.totalMm, 1) : "NA"} mm</div>` +
        `<div><strong>Delta (B - A):</strong> ${delta !== null ? delta.toFixed(2) : "NA"} ft</div>`;
    }
    function downloadFilteredCsv() {
      const rows = [];
      for (const park of getVisibleParks()) {
        const wells = filteredWellsForPark(park);
        wells.forEach(w => rows.push(w));
      }
      const header = ["park_name","park_id","well_id","date","month","water_level_ft","donor","valley","park_lat","park_lon","well_lat","well_lon"];
      const csv = [
        header.join(","),
        ...rows.map(r => [
          csvEscape(r.parkName),
          csvEscape(r.parkId),
          csvEscape(r.wellId),
          csvEscape(r.date),
          csvEscape(r.monthKey || ""),
          csvEscape(r.waterLevelFt ?? ""),
          csvEscape(r.donor || ""),
          csvEscape(r.valley || ""),
          csvEscape(r.parkLat ?? ""),
          csvEscape(r.parkLon ?? ""),
          csvEscape(r.wellLat ?? ""),
          csvEscape(r.wellLon ?? "")
        ].join(","))
      ].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `filtered_wells_${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
    function selectPark(parkKey) {
      selectedParkKey = parkKey;
      const park = state.parks.get(parkKey);
      if (!park) return;
      drawParks();
      if (isPercolationLayerVisible()) drawWellsForPark(park);
      else clearWells();
      if (isBorewellLayerVisible()) drawBorewells(park);
      else clearBorewells();
      renderParkSummary(park);
      renderDepthVsRainTable(park);
      renderTrendPanel(park);
      zoomToParkSelection(park);
      updateTopStats();
      renderCompareStats();
    }

    function initFilters() {
      const monthSelect = document.getElementById("monthFilter");
      state.monthKeys.forEach(k => {
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = monthLabel(k);
        monthSelect.appendChild(opt);
      });

      const monthASelect = document.getElementById("monthAFilter");
      const monthBSelect = document.getElementById("monthBFilter");
      state.monthKeys.forEach(k => {
        const a = document.createElement("option");
        a.value = k;
        a.textContent = monthLabel(k);
        monthASelect.appendChild(a);
        const b = document.createElement("option");
        b.value = k;
        b.textContent = monthLabel(k);
        monthBSelect.appendChild(b);
      });
      compareMonthA = state.monthKeys[0] || null;
      compareMonthB = state.monthKeys[state.monthKeys.length - 1] || null;
      if (compareMonthA) monthASelect.value = compareMonthA;
      if (compareMonthB) monthBSelect.value = compareMonthB;

      const parkSelect = document.getElementById("parkFilter");
      const parkOptions = Array.from(state.parks.entries())
        .sort((a, b) => a[1].parkName.localeCompare(b[1].parkName));
      parkOptions.forEach(([parkKey, park]) => {
        const opt = document.createElement("option");
        opt.value = parkKey;
        opt.textContent = park.parkName;
        parkSelect.appendChild(opt);
      });

      const donorSelect = document.getElementById("donorFilter");
      const donors = Array.from(state.donorsAll).sort((a, b) => {
        const aName = state.donorDisplayByNorm.get(a) || a;
        const bName = state.donorDisplayByNorm.get(b) || b;
        return aName.localeCompare(bName);
      });
      donors.forEach(d => {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = state.donorDisplayByNorm.get(d) || d;
        donorSelect.appendChild(opt);
      });
      const valleySelect = document.getElementById("valleyFilter");
      const layerModeSelect = document.getElementById("layerModeFilter");

      parkSelect.addEventListener("change", (e) => {
        activeParkFilterKey = e.target.value;
        if (activeParkFilterKey !== "ALL") {
          const park = state.parks.get(activeParkFilterKey);
          const domDonor = park ? dominantDonorNormForPark(park) : null;
          if (domDonor) {
            activeDonor = domDonor;
            donorSelect.value = domDonor;
          }
          if (park && park.valleyKey) {
            activeValley = park.valleyKey;
            if (valleySelect) valleySelect.value = park.valleyKey;
          }
          selectPark(activeParkFilterKey);
        } else {
          selectedParkKey = null;
          clearWells();
          resetSelectionPanel();
          closeTrendPanel();
          applyFilters();
        }
      });
      donorSelect.addEventListener("change", (e) => {
        activeDonor = e.target.value;
        applyFilters();
      });
      if (valleySelect) {
        valleySelect.addEventListener("change", (e) => {
          activeValley = e.target.value;
          if (selectedParkKey) {
            const selectedPark = state.parks.get(selectedParkKey);
            if (selectedPark && !valleyMatchesKey(selectedPark.valleyKey)) {
              selectedParkKey = null;
              const parkSelectEl = document.getElementById("parkFilter");
              if (parkSelectEl) parkSelectEl.value = "ALL";
              activeParkFilterKey = "ALL";
            }
          }
          applyFilters();
        });
      }

      monthSelect.addEventListener("change", (e) => {
        activeMonth = e.target.value;
        applyFilters();
      });
      if (layerModeSelect) {
        layerModeSelect.value = layerMode;
        layerModeSelect.addEventListener("change", (e) => {
          const nextMode = String(e.target.value || "BOTH");
          layerMode = (nextMode === "PERC_ONLY" || nextMode === "BORE_ONLY" || nextMode === "BOTH") ? nextMode : "BOTH";
          applyFilters();
        });
      }

      const compareToggle = document.getElementById("compareToggle");
      const compareCard = document.getElementById("compareCard");
      compareToggle.addEventListener("change", (e) => {
        compareEnabled = e.target.checked;
        compareCard.classList.toggle("open", compareEnabled);
        renderCompareStats();
      });
      monthASelect.addEventListener("change", (e) => {
        compareMonthA = e.target.value;
        renderCompareStats();
      });
      monthBSelect.addEventListener("change", (e) => {
        compareMonthB = e.target.value;
        renderCompareStats();
      });

      const downloadBtn = document.getElementById("downloadCsvBtn");
      if (downloadBtn) downloadBtn.addEventListener("click", downloadFilteredCsv);
      const clearBtn = document.getElementById("clearFiltersBtn");
      if (clearBtn) clearBtn.addEventListener("click", clearAllFilters);

      resetSelectionPanel();
      renderCompareStats();
    }

    function updateTopStats() {
      const { parksVisible, wellsVisible } = getVisibleStats();
      document.getElementById("parkCount").textContent = `${parksVisible}`;
      document.getElementById("wellCount").textContent = `${wellsVisible}`;
    }

    async function boot() {
      try {
        if (!MAPBOX_ACCESS_TOKEN || MAPBOX_ACCESS_TOKEN === "YOUR_MAPBOX_ACCESS_TOKEN_HERE") {
          throw new Error("Set your Mapbox token in MAPBOX_ACCESS_TOKEN before loading this page.");
        }
        await loadWells();
        await loadBorewells();
        const initAfterMapReady = () => {
          ensureMapLayers();
          initFilters();
          applyFilters();
          window.__UWBE_APP_READY__ = true;
        };
        if (map.loaded()) {
          initAfterMapReady();
        } else {
          map.once("load", initAfterMapReady);
        }
        const closeBtn = document.getElementById("trendCloseBtn");
        if (closeBtn) {
          closeBtn.addEventListener("click", () => {
            closeTrendPanel();
          });
        }
      } catch (err) {
        const errBox = document.getElementById("err");
        if (errBox) {
          const pageName = window.location.pathname.split("/").pop() || "index.html";
          errBox.style.display = "block";
          errBox.innerHTML = `${String(err.message || err)}<br><span class="hint">Run a local server in this folder, e.g. <code>python -m http.server 8000</code>, and open <code>http://localhost:8000/${escapeHtml(pageName)}</code>.</span>`;
        }
      }
    }

    boot();
  
