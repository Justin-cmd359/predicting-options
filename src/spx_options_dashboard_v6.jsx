/**
 * SPX / ES Options Analytics Dashboard
 * Version 5 — Conservative edits applied:
 *   - Removed Overview Session Summary panel
 *   - Replaced datetime-local time slice with start/end data-day + time picker
 *   - Removed Microstructure Ask / Bid Distribution panel
 *   - Precomputed Spread rows to reduce Spread toggle lag
 *   - Date filter and Time Slice now reset each other to avoid conflicts
 *
 * Data source : Cloudflare R2 (20250414_full_agg.parquet)
 * Sessions    : 2025-04-14 09:21–16:00 ET  |  2025-04-15 09:23–11:21 ET
 * Coverage    : 99.26 % second-level (231 intraday seconds absent)
 *
 * Gonzaga University — Spring 2026 Academic Research Project
 */

// ─────────────────────────────────────────────────────────────────────────────
// External dependencies
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useMemo } from "react";
import { parquetReadObjects } from "hyparquet";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ScatterChart, Scatter, Cell,
  ReferenceLine, ReferenceArea, Area, AreaChart, ComposedChart,
} from "recharts";


// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PARQUET_URL =
  "https://pub-73edacec404b41a29ac6cf15672e387f.r2.dev/20250414_full_agg_v2.parquet";

const DS = { line: 600, bar: 400, scatter: 800, bookPair: 500 };

const TICK_MAX_DELTA_S = 300;
const TICK_SUBHOUR_THRESHOLD_S = 3600;


// ─────────────────────────────────────────────────────────────────────────────
// Colour palette
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  bg:      "#07080f",
  panel:   "#0e1019",
  border:  "#1c1f2e",
  grid:    "#14172200",
  accent1: "#00e5ff",
  accent2: "#ff6b35",
  accent3: "#a78bfa",
  accent4: "#34d399",
  accent5: "#f59e0b",
  muted:   "#4b5263",
  text:    "#c8cfe0",
  textDim: "#5a6070",
  ask:     "#f87171",
  bid:     "#34d399",
  daySep:  "#2a2f45",
};


// ─────────────────────────────────────────────────────────────────────────────
// Greek tooltip definitions
// ─────────────────────────────────────────────────────────────────────────────

const GREEK_DEFINITIONS = {
  delta: "Change in option premium per $1 move in the underlying. Calls range 0 to 1, Puts -1 to 0. Approaches +/-0.5 at-the-money.",
  gamma: "Rate of change of delta per $1 move in the underlying. Highest at-the-money; falls as the option moves further in or out of the money.",
  theta: "Daily option value decay as expiration approaches. Almost always negative for long options; accelerates near expiry.",
  vega:  "Change in option premium per 1% move in implied volatility. Rising IV increases both call and put values, and vice versa.",
  rho:   "Change in option price per 1% move in the risk-free rate. Calls have positive rho, puts negative. Least impactful for short-dated options.",
  vanna: "Rate of change of delta w.r.t. IV — equivalently, rate of change of vega w.r.t. underlying price.",
  charm: "Rate of change of delta over time (delta decay). Measures how delta shifts as expiration approaches.",
  vomma: "Rate of change of vega w.r.t. IV. High vomma means vega accelerates as volatility rises (vega convexity).",
};


// ─────────────────────────────────────────────────────────────────────────────
// Pure utility functions
// ─────────────────────────────────────────────────────────────────────────────

function downsample(data, maxPts) {
  if (!data || data.length <= maxPts) return data;
  var result = new Array(maxPts);
  var last = data.length - 1;
  result[0] = data[0];
  result[maxPts - 1] = data[last];
  var step = last / (maxPts - 1);
  for (var i = 1; i < maxPts - 1; i++) {
    result[i] = data[Math.round(i * step)];
  }
  return result;
}

const GREEK_KEYS = [
  "callDelta","callGamma","callVega","callTheta",
  "callVanna","callCharm","callVomma","callRho",
  "putDelta","putGamma","putVega","putTheta",
  "putVanna","putCharm","putVomma","putRho",
];

const MBO_LEVEL_KEYS = Array.from({ length: 20 }, (_, i) => "mbo" + (i + 1));

const MBO_LINE_COLORS = [
  C.accent1, C.accent2, C.accent3, C.accent4, C.accent5,
  C.ask, C.bid, "#ec4899", "#818cf8", "#22d3ee",
  "#fb7185", "#fbbf24", "#2dd4bf", "#c084fc", "#60a5fa",
  "#f97316", "#84cc16", "#e879f9", "#38bdf8", "#f43f5e",
];

/**
 * Build Ask − Bid spread data once from the full cleaned dataset.
 * This prevents the expensive merge/normalize operation from happening every
 * time the user clicks the Spread button.
 */
function buildSpreadData(data) {
  var byTs = {};

  data.forEach(function(row) {
    var ts = row.timestamp;
    if (!byTs[ts]) byTs[ts] = {};
    byTs[ts][row.side] = row;
  });

  return Object.keys(byTs).sort().map(function(ts) {
    var ask = byTs[ts].Ask || {};
    var bid = byTs[ts].Bid || {};
    var base = ask.esPrice != null ? ask : bid;

    var row = {
      timestamp: ts,
      side: "Spread",
      esPrice: base.esPrice,
      spxPrice: base.spxPrice,
      t: base.t,
    };

    GREEK_KEYS.concat(["mbo_ps"]).concat(MBO_LEVEL_KEYS).forEach(function(k) {
      row[k] = (ask[k] != null && bid[k] != null) ? ask[k] - bid[k] : null;
    });

    return row;
  });
}

function formatTimeTick(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (isNaN(dt.getTime())) return String(value);
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  const ss = String(dt.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatHourTick(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (isNaN(dt.getTime())) return String(value);
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatDayHourTick(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (isNaN(dt.getTime())) return String(value);
  const mo = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${mo}/${dd} ${hh}:${mm}`;
}

function isoToDate(ts) {
  return ts ? ts.slice(0, 10) : "";
}

function isoToLocalInputValue(iso) {
  if (!iso) return "";
  var dt = new Date(iso);
  if (isNaN(dt.getTime())) return "";
  var yyyy = dt.getFullYear();
  var mm = String(dt.getMonth() + 1).padStart(2, "0");
  var dd = String(dt.getDate()).padStart(2, "0");
  var hh = String(dt.getHours()).padStart(2, "0");
  var mi = String(dt.getMinutes()).padStart(2, "0");
  var ss = String(dt.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

function isoToLocalTimeInputValue(iso) {
  if (!iso) return "";
  var dt = new Date(iso);
  if (isNaN(dt.getTime())) return "";

  var hh = String(dt.getHours()).padStart(2, "0");
  var mi = String(dt.getMinutes()).padStart(2, "0");
  var ss = String(dt.getSeconds()).padStart(2, "0");

  return `${hh}:${mi}:${ss}`;
}

function localDateAndTimeToIso(date, time) {
  if (!date || !time) return null;

  var parts = time.split(":");
  var hh = parts[0] || "00";
  var mi = parts[1] || "00";
  var ss = parts[2] || "00";

  var dt = new Date(`${date}T${hh}:${mi}:${ss}`);
  if (isNaN(dt.getTime())) return null;

  return dt.toISOString();
}

function formatDateTimeShort(iso) {
  if (!iso) return "—";
  var dt = new Date(iso);
  if (isNaN(dt.getTime())) return "—";
  var yyyy = dt.getFullYear();
  var mm = String(dt.getMonth() + 1).padStart(2, "0");
  var dd = String(dt.getDate()).padStart(2, "0");
  var hh = String(dt.getHours()).padStart(2, "0");
  var mi = String(dt.getMinutes()).padStart(2, "0");
  var ss = String(dt.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function getRangeForDate(data, date) {
  var rows = data.filter(d => isoToDate(d.timestamp) === date);
  if (!rows.length) return null;
  return [rows[0].timestamp, rows[rows.length - 1].timestamp];
}

function getNiceTicksFromRenderedData(data) {
  if (!data || data.length < 2) return [];

  var tsArray = data
    .map(d => ({
      timestamp: d.timestamp,
      ms: new Date(d.timestamp).getTime(),
    }))
    .filter(d => Number.isFinite(d.ms));

  if (tsArray.length < 2) return [];

  var first = tsArray[0].ms;
  var last = tsArray[tsArray.length - 1].ms;
  var spanSecs = (last - first) / 1000;

  var targetTicks;
  if (spanSecs <= 10 * 60) {
    targetTicks = 4;
  } else if (spanSecs <= 30 * 60) {
    targetTicks = 5;
  } else if (spanSecs <= 2 * 60 * 60) {
    targetTicks = 6;
  } else {
    targetTicks = 7;
  }

  var ticks = [];
  var lastPickedIndex = -1;

  for (var i = 0; i < targetTicks; i++) {
    var rawIndex = Math.round((i * (tsArray.length - 1)) / (targetTicks - 1));

    if (rawIndex !== lastPickedIndex && tsArray[rawIndex]) {
      ticks.push(tsArray[rawIndex].timestamp);
      lastPickedIndex = rawIndex;
    }
  }

  return ticks;
}

function formatDateTimeTooltip(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (isNaN(dt.getTime())) return String(value);

  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  const year = dt.getFullYear();

  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  const ss = String(dt.getSeconds()).padStart(2, "0");

  return `${month}/${day}/${year} ${hh}:${mm}:${ss}`;
}

function getDaySeparators(data) {
  if (!data || !data.length) return [];
  var separators = [];
  var seenDate = isoToDate(data[0].timestamp);
  for (var i = 1; i < data.length; i++) {
    var d = isoToDate(data[i].timestamp);
    if (d !== seenDate) {
      var dt  = new Date(data[i].timestamp);
      var lbl = dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      separators.push({ timestamp: data[i].timestamp, label: lbl });
      seenDate = d;
    }
  }
  return separators;
}


// ─────────────────────────────────────────────────────────────────────────────
// Reusable UI components
// ─────────────────────────────────────────────────────────────────────────────

function GreekLabel({ name, label }) {
  const [show, setShow] = useState(false);
  const def = GREEK_DEFINITIONS[name.toLowerCase()];
  return (
    <span
      style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 5, cursor: "help" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span>{label}</span>
      <span style={{
        fontSize: 9, color: C.accent1, border: "1px solid " + C.accent1,
        borderRadius: "50%", width: 13, height: 13,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        lineHeight: 1, flexShrink: 0, fontWeight: 700,
      }}>?</span>
      {show && def && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 9999,
          background: "#13151f", border: "1px solid " + C.accent1, borderRadius: 8,
          padding: "10px 14px", width: 250, fontSize: 11,
          fontFamily: "'DM Mono', monospace", color: C.text, lineHeight: 1.7,
          pointerEvents: "none", boxShadow: "0 4px 24px rgba(0,229,255,0.1)",
        }}>
          <div style={{ color: C.accent1, fontWeight: 700, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.1em", fontSize: 10 }}>{label}</div>
          {def}
        </div>
      )}
    </span>
  );
}

function Panel({ title, subtitle, children, span }) {
  return (
    <div style={{
      background: C.panel,
      border: "1px solid " + C.border,
      borderRadius: 8,
      padding: "16px 18px",
      gridColumn: "span " + (span || 1),
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div>
        <div style={{
          fontSize: 10, letterSpacing: "0.1em", color: C.accent1,
          textTransform: "uppercase", fontFamily: "'DM Mono', monospace", marginBottom: 1,
        }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 10, color: C.textDim, fontFamily: "'DM Mono', monospace" }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function StatBadge({ label, value, color, greek }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{
        fontSize: 10, color: C.textDim, textTransform: "uppercase",
        letterSpacing: "0.1em", fontFamily: "'DM Mono', monospace",
      }}>
        {greek ? <GreekLabel name={greek} label={label} /> : label}
      </span>
      <span style={{
        fontSize: 22, fontWeight: 700, color: color || C.text,
        fontFamily: "'DM Mono', monospace", letterSpacing: "-0.02em",
      }}>{value}</span>
    </div>
  );
}

function FilterPill({ label, active, onClick, color }) {
  return (
    <button onClick={onClick} style={{
      background: active ? (color || C.accent1) : "transparent",
      color:  active ? C.bg : C.textDim,
      border: "1px solid " + (active ? (color || C.accent1) : C.border),
      borderRadius: 20, padding: "3px 12px", fontSize: 10,
      fontFamily: "'DM Mono', monospace", cursor: "pointer",
      letterSpacing: "0.08em", fontWeight: active ? 700 : 400, transition: "all 0.15s",
    }}>
      {label}
    </button>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  var displayLabel = (typeof label === "string" && label.includes("T"))
    ? formatDateTimeTooltip(label)
    : label;
  return (
    <div style={{
      background: "#13151f", border: "1px solid " + C.border,
      borderRadius: 6, padding: "8px 12px",
      fontSize: 11, fontFamily: "'DM Mono', monospace", color: C.text,
    }}>
      <div style={{ color: C.accent1, marginBottom: 5 }}>{displayLabel}</div>
      {payload.map(function(p, i) {
        return (
          <div key={i} style={{ color: p.color, marginBottom: 2 }}>
            {p.name}:{" "}
            <span style={{ color: C.text }}>
              {typeof p.value === "number" ? p.value.toFixed(4) : p.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Shared chart configuration helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildTimeAxisProps(ticks, tickFormatter) {
  return {
    dataKey: "timestamp",
    ticks: ticks,
    tickFormatter: tickFormatter || formatHourTick,
    interval: 0,
    minTickGap: 60,
    tickMargin: 8,
    tick: {
      fill: C.textDim,
      fontSize: 9,
      angle: -30,
      textAnchor: "end",
    },
    height: 44,
    axisLine: { stroke: C.border },
    tickLine: { stroke: C.border },
  };
}

function buildYAxisProps(width) {
  return {
    tick:      { fill: C.textDim, fontSize: 9 },
    tickCount: 4,
    width:     width || 50,
    axisLine:  { stroke: C.border },
    tickLine:  false,
  };
}

const GRID_PROPS = {
  strokeDasharray: "",
  stroke: "rgba(255,255,255,0.04)",
  vertical: true,
  horizontal: true,
};

const LEGEND_PROPS = {
  wrapperStyle: { fontSize: 10, color: C.textDim },
};

function renderDaySeparators(separators, yAxisId) {
  return separators.map(function(s) {
    var props = {
      key: s.timestamp,
      x: s.timestamp,
      stroke: C.accent3,
      strokeDasharray: "4 3",
      strokeOpacity: 0.5,
      strokeWidth: 1,
      label: {
        value: s.label,
        position: "insideTopRight",
        fill: C.accent3,
        fontSize: 9,
        fontFamily: "'DM Mono', monospace",
        opacity: 0.8,
      },
    };
    if (yAxisId !== undefined) props.yAxisId = yAxisId;
    return <ReferenceLine {...props} />;
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// Main Dashboard component
// ─────────────────────────────────────────────────────────────────────────────

export default function Dashboard() {

  // ── UI state ───────────────────────────────────────────────────────────────
  const [activeTab,     setActiveTab]     = useState("overview");
  const [selectedSide,  setSelectedSide]  = useState("Ask");
  const [selectedDate,  setSelectedDate]  = useState("all");

  // Custom data-aware time-slice picker.
  // Date and Time Slice are intentionally mutually exclusive:
  // applying a time slice forces selectedDate = "all";
  // choosing a date clears the time slice.
  const [sliceStartDate, setSliceStartDate] = useState("");
  const [sliceEndDate, setSliceEndDate] = useState("");
  const [sliceStartTime, setSliceStartTime] = useState("");
  const [sliceEndTime, setSliceEndTime] = useState("");
  const [timeRange,      setTimeRange]      = useState(null);
  const [timeFilterError, setTimeFilterError] = useState("");

  // ── Data state ─────────────────────────────────────────────────────────────
  const [ALL_DATA, setAllData] = useState([]);
  const [error,    setError]   = useState(null);

  // ── Zoom state ─────────────────────────────────────────────────────────────
  const [zoomRange,   setZoomRange]   = useState(null);
  const [dragStart,   setDragStart]   = useState(null);
  const [dragCurrent, setDragCurrent] = useState(null);
  const isDragging = dragStart !== null;


  // ── Parquet loader ─────────────────────────────────────────────────────────
  useEffect(() => {
    var cancelled = false;

    async function loadParquet() {
      setAllData([]);
      setError(null);
      try {
        var resp = await fetch(PARQUET_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        var arrayBuffer = await resp.arrayBuffer();
        if (cancelled) return;

        var file = {
          byteLength: arrayBuffer.byteLength,
          slice: (start, end) => Promise.resolve(arrayBuffer.slice(start, end)),
        };

        var rawRows = await parquetReadObjects({ file });
        if (cancelled) return;

        var cleaned = rawRows
          .filter(row => row.timestamp)
          .map(row => ({
            timestamp:    row.timestamp instanceof Date
                            ? row.timestamp.toISOString()
                            : String(row.timestamp || ""),
            side:         row.Side,

            esPrice:      row.current_es_price,
            spxPrice:     row.spx_price,
            spxStrike:    row.spx_strike,
            futureStrike: row.future_strike,
            t:            row.t,

            mbo_ps:       row.MBO_pulling_stacking,

            callDelta: row.call_delta,  callGamma: row.call_gamma,
            callVega:  row.call_vega,   callTheta: row.call_theta,
            callVanna: row.call_vanna,  callCharm: row.call_charm,
            callVomma: row.call_vomma,  callRho:   row.call_rho,

            putDelta:  row.put_delta,   putGamma:  row.put_gamma,
            putVega:   row.put_vega,    putTheta:  row.put_theta,
            putVanna:  row.put_vanna,   putCharm:  row.put_charm,
            putVomma:  row.put_vomma,   putRho:    row.put_rho,

            mbo1:  row.MBO_1,  mbo2:  row.MBO_2,  mbo3:  row.MBO_3,  mbo4:  row.MBO_4,
            mbo5:  row.MBO_5,  mbo6:  row.MBO_6,  mbo7:  row.MBO_7,  mbo8:  row.MBO_8,
            mbo9:  row.MBO_9,  mbo10: row.MBO_10, mbo11: row.MBO_11, mbo12: row.MBO_12,
            mbo13: row.MBO_13, mbo14: row.MBO_14, mbo15: row.MBO_15, mbo16: row.MBO_16,
            mbo17: row.MBO_17, mbo18: row.MBO_18, mbo19: row.MBO_19, mbo20: row.MBO_20,
          }))
          .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

        if (!cancelled) setAllData(cleaned);
      } catch (err) {
        if (!cancelled) setError(err?.message || "Failed to load data.");
      }
    }

    loadParquet();
    return () => { cancelled = true; };
  }, []);


  // ── Derived filter options ─────────────────────────────────────────────────

  const SPREAD_DATA = useMemo(() => {
    if (!ALL_DATA.length) return [];
    return buildSpreadData(ALL_DATA);
  }, [ALL_DATA]);

  /**
   * Data filtered only by side.
   * This layer deliberately ignores selectedDate so the custom time-slice picker
   * can work independently and then force selectedDate back to "all".
   */
  const SIDE_DATA = useMemo(() => {
    var source = selectedSide === "Spread" ? SPREAD_DATA : ALL_DATA;
    if (selectedSide === "Spread") return source;
    return source.filter(d => d.side === selectedSide);
  }, [ALL_DATA, SPREAD_DATA, selectedSide]);

  const allDates = useMemo(() => {
    var seen = {};
    SIDE_DATA.forEach(d => { var dt = isoToDate(d.timestamp); if (dt) seen[dt] = true; });
    return Object.keys(seen).sort();
  }, [SIDE_DATA]);


  // ── Filtered data layers ───────────────────────────────────────────────────

  const BASE_DATA = useMemo(() => {
    return SIDE_DATA.filter(d => {
      return selectedDate === "all" || isoToDate(d.timestamp) === selectedDate;
    });
  }, [SIDE_DATA, selectedDate]);

  const DATA = useMemo(() => {
    if (!timeRange) return BASE_DATA;
    var lo = timeRange[0] < timeRange[1] ? timeRange[0] : timeRange[1];
    var hi = timeRange[0] < timeRange[1] ? timeRange[1] : timeRange[0];

    // Time slice intentionally operates on SIDE_DATA, not BASE_DATA, because
    // applying a time slice resets the date filter to All.
    return SIDE_DATA.filter(d => d.timestamp >= lo && d.timestamp <= hi);
  }, [BASE_DATA, SIDE_DATA, timeRange]);

  const availableRange = useMemo(() => {
    if (!SIDE_DATA.length) return null;
    return [SIDE_DATA[0].timestamp, SIDE_DATA[SIDE_DATA.length - 1].timestamp];
  }, [SIDE_DATA]);

  const VIEWED_DATA = useMemo(() => {
    if (!zoomRange) return DATA;
    var lo = zoomRange[0] < zoomRange[1] ? zoomRange[0] : zoomRange[1];
    var hi = zoomRange[0] < zoomRange[1] ? zoomRange[1] : zoomRange[0];
    return DATA.filter(d => d.timestamp >= lo && d.timestamp <= hi);
  }, [DATA, zoomRange]);

  const displayData = VIEWED_DATA;

  // Keep the custom time-slice picker initialized to the visible data range.
  // Unlike Date Select, this picker can span multiple data days.
  useEffect(() => {
    if (!availableRange || !allDates.length || timeRange) return;

    var startDate = selectedDate === "all" ? isoToDate(availableRange[0]) : selectedDate;
    if (!allDates.includes(startDate)) startDate = allDates[0];

    var startRange = getRangeForDate(SIDE_DATA, startDate);
    var endRange = selectedDate === "all"
      ? getRangeForDate(SIDE_DATA, isoToDate(availableRange[1]))
      : startRange;

    if (!startRange || !endRange) return;

    setSliceStartDate(startDate);
    setSliceEndDate(isoToDate(endRange[1]));
    setSliceStartTime(isoToLocalTimeInputValue(startRange[0]));
    setSliceEndTime(isoToLocalTimeInputValue(endRange[1]));
    setTimeFilterError("");
  }, [availableRange, allDates, selectedDate, SIDE_DATA, timeRange]);


  // ── Tab-gated, downsampled chart data ─────────────────────────────────────

  const overviewChartData = useMemo(() => {
    if (activeTab !== "overview" || !displayData.length) return null;
    return {
      price:  downsample(displayData, DS.line),
      delta:  downsample(displayData, DS.line),
      mboBar: downsample(displayData, DS.bar),
    };
  }, [displayData, activeTab]);

  const greeksChartData = useMemo(() => {
    if (activeTab !== "greeks" || !displayData.length) return null;
    return downsample(displayData, DS.line);
  }, [displayData, activeTab]);

  const microChartData = useMemo(() => {
    if (activeTab !== "microstructure" || !displayData.length) return null;
    return {
      mboBar:  downsample(displayData, DS.bar),
      scatter: downsample(displayData, DS.scatter),
    };
  }, [displayData, activeTab]);

  const orderBookChartData = useMemo(() => {
    if (activeTab !== "order book" || !displayData.length) return null;
    return downsample(displayData, DS.bookPair);
  }, [displayData, activeTab]);


  // ── Always-on derived values ───────────────────────────────────────────────

  const latestDisplayRow = displayData.length
    ? displayData[displayData.length - 1]
    : (ALL_DATA.length ? ALL_DATA[ALL_DATA.length - 1] : null);

  // ── Early returns for loading / error ─────────────────────────────────────
  if (error)           return <div style={{ color: C.ask, padding: 40, fontFamily: "monospace", background: C.bg, minHeight: "100vh" }}>Failed to load data: {error}</div>;
  if (!ALL_DATA.length) return <div style={{ color: C.accent1, padding: 40, fontFamily: "monospace", background: C.bg, minHeight: "100vh" }}>Loading data…</div>;
  if (!latestDisplayRow) return null;


  // ── Shared x-axis config ───────────────────────────────────────────────────
  var activeSlice = (
    activeTab === "overview"       ? (overviewChartData?.price) :
    activeTab === "greeks"         ? greeksChartData :
    activeTab === "microstructure" ? (microChartData?.mboBar) :
    activeTab === "order book"     ? orderBookChartData :
    null
  ) || displayData;

  var timeTicks = getNiceTicksFromRenderedData(activeSlice);
  var activeSpanMs = activeSlice && activeSlice.length >= 2
    ? new Date(activeSlice[activeSlice.length - 1].timestamp).getTime()
      - new Date(activeSlice[0].timestamp).getTime()
    : 0;
  var tickFmt = activeSpanMs > 86400000 ? formatDayHourTick : formatHourTick;
  var timeAxisProps = buildTimeAxisProps(timeTicks, tickFmt);
  var daySeparators = getDaySeparators(VIEWED_DATA);


  // ── Zoom event handlers ────────────────────────────────────────────────────
  function handleZoomMouseDown(e) {
    if (e?.activeLabel) {
      setDragStart(e.activeLabel);
      setDragCurrent(e.activeLabel);
    }
  }

  function handleZoomMouseMove(e) {
    if (isDragging && e?.activeLabel) setDragCurrent(e.activeLabel);
  }

  function handleZoomMouseUp() {
    if (isDragging && dragStart && dragCurrent && dragStart !== dragCurrent) {
      var lo = dragStart < dragCurrent ? dragStart : dragCurrent;
      var hi = dragStart < dragCurrent ? dragCurrent : dragStart;
      setZoomRange([lo, hi]);
    }
    setDragStart(null);
    setDragCurrent(null);
  }

  function resetZoom() {
    setZoomRange(null);
    setDragStart(null);
    setDragCurrent(null);
  }

  function setSliceStartDateFromInput(date) {
    var range = getRangeForDate(SIDE_DATA, date);
    if (!range) return;

    setSliceStartDate(date);
    setSliceStartTime(isoToLocalTimeInputValue(range[0]));

    // Keep the range valid. If the previous end date is before the new start,
    // move the end date to the same day and use that day's close.
    if (!sliceEndDate || sliceEndDate < date) {
      setSliceEndDate(date);
      setSliceEndTime(isoToLocalTimeInputValue(range[1]));
    }

    setTimeFilterError("");
  }

  function setSliceEndDateFromInput(date) {
    var range = getRangeForDate(SIDE_DATA, date);
    if (!range) return;

    setSliceEndDate(date);
    setSliceEndTime(isoToLocalTimeInputValue(range[1]));

    // Keep the range valid. If the previous start date is after the new end,
    // move the start date to the same day and use that day's open.
    if (!sliceStartDate || sliceStartDate > date) {
      setSliceStartDate(date);
      setSliceStartTime(isoToLocalTimeInputValue(range[0]));
    }

    setTimeFilterError("");
  }

  function clearTimeFilter() {
    setTimeRange(null);
    setTimeFilterError("");
    resetZoom();

    var startDate = selectedDate === "all" ? isoToDate(availableRange?.[0]) : selectedDate;
    if (!startDate || !allDates.includes(startDate)) startDate = allDates[0];

    var startRange = getRangeForDate(SIDE_DATA, startDate);
    var endRange = selectedDate === "all" && availableRange
      ? getRangeForDate(SIDE_DATA, isoToDate(availableRange[1]))
      : startRange;

    if (startRange && endRange) {
      setSliceStartDate(startDate);
      setSliceEndDate(isoToDate(endRange[1]));
      setSliceStartTime(isoToLocalTimeInputValue(startRange[0]));
      setSliceEndTime(isoToLocalTimeInputValue(endRange[1]));
    }
  }

  function fillFullAvailableTimeRange() {
    if (!availableRange) return;

    setSliceStartDate(isoToDate(availableRange[0]));
    setSliceEndDate(isoToDate(availableRange[1]));
    setSliceStartTime(isoToLocalTimeInputValue(availableRange[0]));
    setSliceEndTime(isoToLocalTimeInputValue(availableRange[1]));
    setTimeFilterError("");
  }

  function applyTimeFilter() {
    setTimeFilterError("");

    if (!availableRange) {
      setTimeFilterError("No data is available for the current side filter.");
      return;
    }

    var startIso = localDateAndTimeToIso(sliceStartDate, sliceStartTime);
    var endIso = localDateAndTimeToIso(sliceEndDate, sliceEndTime);

    if (!startIso || !endIso) {
      setTimeFilterError("Pick a start day/time and end day/time.");
      return;
    }

    var lo = startIso < endIso ? startIso : endIso;
    var hi = startIso < endIso ? endIso : startIso;

    if (lo === hi) {
      setTimeFilterError("Start and end time cannot be the same.");
      return;
    }

    if (lo < availableRange[0] || hi > availableRange[1]) {
      setTimeFilterError(
        "Time slice is outside the available data: " +
        formatDateTimeShort(availableRange[0]) + " → " +
        formatDateTimeShort(availableRange[1])
      );
      return;
    }

    var rowsInRange = SIDE_DATA.filter(d => d.timestamp >= lo && d.timestamp <= hi);
    if (!rowsInRange.length) {
      setTimeFilterError("No rows exist in that window. It may fall inside a session gap.");
      return;
    }

    // Time slice and date filter are mutually exclusive.
    setSelectedDate("all");
    setTimeRange([lo, hi]);
    resetZoom();
  }

  function handleDateChange(date) {
    // Date filter and time slice are mutually exclusive.
    setSelectedDate(date);
    setTimeRange(null);
    setTimeFilterError("");
    resetZoom();

    var range = date === "all"
      ? (availableRange ? availableRange : null)
      : getRangeForDate(SIDE_DATA, date);

    if (range) {
      setSliceStartDate(isoToDate(range[0]));
      setSliceEndDate(isoToDate(range[1]));
      setSliceStartTime(isoToLocalTimeInputValue(range[0]));
      setSliceEndTime(isoToLocalTimeInputValue(range[1]));
    }
  }

  function handleSideChange(side) {
    setSelectedSide(side);
    setTimeRange(null);
    setTimeFilterError("");
    resetZoom();
  }

  function getZoomChartProps() {
    return {
      onMouseDown: handleZoomMouseDown,
      onMouseMove: handleZoomMouseMove,
      onMouseUp: handleZoomMouseUp,
      style: { cursor: isDragging ? "col-resize" : "crosshair", userSelect: "none" },
    };
  }

  var dragLo = (dragStart && dragCurrent)
    ? (dragStart < dragCurrent ? dragStart : dragCurrent) : null;
  var dragHi = (dragStart && dragCurrent)
    ? (dragStart < dragCurrent ? dragCurrent : dragStart) : null;

  function renderZoomSelection(yAxisId) {
    if (!isDragging || !dragLo || !dragHi) return null;
    var props = {
      x1: dragLo,
      x2: dragHi,
      fill: C.accent5,
      fillOpacity: 0.12,
      stroke: C.accent5,
      strokeOpacity: 0.5,
      strokeWidth: 1,
    };
    if (yAxisId !== undefined) props.yAxisId = yAxisId;
    return <ReferenceArea {...props} />;
  }

  function zoomDurationLabel() {
    if (!zoomRange || !displayData.length) return "";
    var secs = Math.round(
      (new Date(displayData[displayData.length - 1].timestamp) -
       new Date(displayData[0].timestamp)) / 1000
    );
    if (secs < 60)   return secs + "s window";
    if (secs < 3600) return Math.round(secs / 60) + "m window";
    return (secs / 3600).toFixed(1) + "h window";
  }


  // ── Render helpers ─────────────────────────────────────────────────────────
  var isZoomed    = !!zoomRange;
  var tabs        = ["overview", "greeks", "microstructure", "order book"];
  var viewedRows  = VIEWED_DATA.length.toLocaleString();
  var downsampled = VIEWED_DATA.length > DS.line;


  // ── JSX ────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh", background: C.bg, color: C.text,
      fontFamily: "'DM Mono', 'Courier New', monospace",
      padding: "24px 28px", boxSizing: "border-box",
    }}>

      {/* HEADER */}
      <div style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        marginBottom: 14, flexWrap: "wrap", gap: 16,
      }}>
        <div>
          <div style={{ fontSize: 9, letterSpacing: "0.25em", color: C.accent1, textTransform: "uppercase", marginBottom: 3 }}>
            SPX / ES Options Analytics
          </div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: "#fff", letterSpacing: "-0.03em" }}>
            S&amp;P 500 Derivative
          </h1>
          <div style={{ fontSize: 10, color: C.textDim, marginTop: 3, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>{formatTimeTick(latestDisplayRow?.timestamp)}</span>
            <span style={{ color: C.border }}>·</span>
            <span>T = {latestDisplayRow?.t != null ? latestDisplayRow.t.toFixed(5) : "—"}</span>
            <span style={{ color: C.border }}>·</span>
            <span>{viewedRows} rows</span>
            {downsampled && (
              <span style={{ color: C.muted }}>· charts show {DS.line} pts (downsampled)</span>
            )}
            {timeRange && (
              <span style={{ color: C.accent3 }}>· time slice active · date set to All</span>
            )}
            {isZoomed && (
              <span style={{ color: C.accent5 }}>· {zoomDurationLabel()}</span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
          <StatBadge label="ES Price"   value={latestDisplayRow?.esPrice   != null ? latestDisplayRow.esPrice.toFixed(1)   : "—"} color={C.accent1} />
          <StatBadge label="SPX Price"  value={latestDisplayRow?.spxPrice  != null ? latestDisplayRow.spxPrice.toFixed(1)  : "—"} color={C.accent4} />
          <StatBadge label="Call Delta" value={latestDisplayRow?.callDelta != null ? latestDisplayRow.callDelta.toFixed(3) : "—"} color={C.accent3} greek="delta" />
          <StatBadge label="Call Gamma" value={latestDisplayRow?.callGamma != null ? latestDisplayRow.callGamma.toFixed(5) : "—"} color={C.accent5} greek="gamma" />
        </div>
      </div>

      {/* FILTER BAR */}
      <div style={{ display: "flex", gap: 16, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>

        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase" }}>Date</span>
          <FilterPill label="All" active={selectedDate === "all"} onClick={() => handleDateChange("all")} color={C.accent1} />
          {allDates.map(d => {
            var dt    = new Date(d + "T12:00:00Z");
            var label = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
            return (
              <FilterPill key={d} label={label} active={selectedDate === d} onClick={() => handleDateChange(d)} color={C.accent3} />
            );
          })}
        </div>

        <div style={{ width: 1, height: 16, background: C.border }} />

        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase" }}>View</span>
          {["Ask", "Bid", "Spread"].map(s => (
            <FilterPill
              key={s} label={s} active={selectedSide === s}
              onClick={() => handleSideChange(s)}
              color={s === "Ask" ? C.ask : s === "Bid" ? C.bid : C.accent3}
            />
          ))}
        </div>

        <div style={{ width: 1, height: 16, background: C.border }} />

        {/* Custom data-aware time-slice range picker */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase" }}>Time Slice</span>

          <span style={{ fontSize: 9, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase" }}>From</span>
          <select
            value={sliceStartDate}
            onChange={e => setSliceStartDateFromInput(e.target.value)}
            style={{
              background: "#0b0d15",
              color: C.text,
              border: "1px solid " + C.border,
              borderRadius: 6,
              padding: "4px 7px",
              fontSize: 10,
              fontFamily: "'DM Mono', monospace",
              colorScheme: "dark",
            }}
          >
            {allDates.map(d => {
              var dt = new Date(d + "T12:00:00Z");
              var label = dt.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              });
              return <option key={d} value={d}>{label}</option>;
            })}
          </select>

          <input
            type="time"
            step="1"
            value={sliceStartTime}
            onChange={e => setSliceStartTime(e.target.value)}
            style={{
              background: "#0b0d15",
              color: C.text,
              border: "1px solid " + C.border,
              borderRadius: 6,
              padding: "4px 7px",
              fontSize: 10,
              fontFamily: "'DM Mono', monospace",
              colorScheme: "dark",
            }}
          />

          <span style={{ color: C.textDim, fontSize: 10 }}>→</span>

          <span style={{ fontSize: 9, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase" }}>To</span>
          <select
            value={sliceEndDate}
            onChange={e => setSliceEndDateFromInput(e.target.value)}
            style={{
              background: "#0b0d15",
              color: C.text,
              border: "1px solid " + C.border,
              borderRadius: 6,
              padding: "4px 7px",
              fontSize: 10,
              fontFamily: "'DM Mono', monospace",
              colorScheme: "dark",
            }}
          >
            {allDates.map(d => {
              var dt = new Date(d + "T12:00:00Z");
              var label = dt.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              });
              return <option key={d} value={d}>{label}</option>;
            })}
          </select>

          <input
            type="time"
            step="1"
            value={sliceEndTime}
            onChange={e => setSliceEndTime(e.target.value)}
            style={{
              background: "#0b0d15",
              color: C.text,
              border: "1px solid " + C.border,
              borderRadius: 6,
              padding: "4px 7px",
              fontSize: 10,
              fontFamily: "'DM Mono', monospace",
              colorScheme: "dark",
            }}
          />

          <button
            onClick={applyTimeFilter}
            style={{
              background: timeRange ? C.accent3 : "transparent",
              color: timeRange ? C.bg : C.accent3,
              border: "1px solid " + C.accent3, borderRadius: 20,
              padding: "3px 12px", fontSize: 10,
              fontFamily: "'DM Mono', monospace", cursor: "pointer",
              letterSpacing: "0.08em", fontWeight: 700,
            }}
          >
            Apply
          </button>

          <button
            onClick={fillFullAvailableTimeRange}
            style={{
              background: "transparent", color: C.textDim,
              border: "1px solid " + C.border, borderRadius: 20,
              padding: "3px 10px", fontSize: 10,
              fontFamily: "'DM Mono', monospace", cursor: "pointer",
              letterSpacing: "0.08em",
            }}
          >
            Fill Range
          </button>

          {(timeRange || timeFilterError) && (
            <button
              onClick={clearTimeFilter}
              style={{
                background: "transparent", color: C.textDim,
                border: "1px solid " + C.border, borderRadius: 20,
                padding: "3px 10px", fontSize: 10,
                fontFamily: "'DM Mono', monospace", cursor: "pointer",
                letterSpacing: "0.08em",
              }}
            >
              Clear
            </button>
          )}

          {availableRange && !timeFilterError && (
            <span style={{ fontSize: 9, color: C.muted }}>
              available {formatDateTimeShort(availableRange[0])} → {formatDateTimeShort(availableRange[1])}
            </span>
          )}

          {timeFilterError && (
            <span style={{ fontSize: 9, color: C.ask, maxWidth: 520 }}>
              {timeFilterError}
            </span>
          )}
        </div>

        {isZoomed && (
          <>
            <div style={{ width: 1, height: 16, background: C.border }} />
            <button
              onClick={resetZoom}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                background: "rgba(245,158,11,0.12)", color: C.accent5,
                border: "1px solid " + C.accent5, borderRadius: 20,
                padding: "3px 12px", fontSize: 10,
                fontFamily: "'DM Mono', monospace", cursor: "pointer",
                letterSpacing: "0.08em", fontWeight: 700,
              }}
            >
              ✕ Reset Zoom
            </button>
          </>
        )}
      </div>

      {/* TAB BAR */}
      <div style={{ display: "flex", gap: 2, marginBottom: 18, borderBottom: "1px solid " + C.border }}>
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            style={{
              background: activeTab === t ? C.accent1 : "transparent",
              color:      activeTab === t ? C.bg : C.textDim,
              border: "none", borderRadius: "6px 6px 0 0",
              padding: "6px 16px", fontSize: 10,
              letterSpacing: "0.1em", textTransform: "uppercase",
              cursor: "pointer", fontFamily: "'DM Mono', monospace",
              fontWeight: activeTab === t ? 700 : 400,
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {!VIEWED_DATA.length && (
        <div style={{ color: C.textDim, padding: "40px 0", textAlign: "center", fontSize: 13 }}>
          No data matches the current filters.
        </div>
      )}

      {/* OVERVIEW TAB */}
      {activeTab === "overview" && overviewChartData && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>

          <Panel
            title="Underlying Price"
            subtitle={isZoomed ? "ES vs SPX · zoomed" : "ES vs SPX · drag any time-series chart to zoom"}
            span={2}
          >
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart
                data={overviewChartData.price}
                {...getZoomChartProps()}
              >
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(62)} domain={["auto", "auto"]} />
                <Tooltip content={<CustomTooltip />} />
                <Legend {...LEGEND_PROPS} />
                <Line type="monotone" dataKey="esPrice"  stroke={C.accent1} dot={false} strokeWidth={1.5} name="ES Price" />
                <Line type="monotone" dataKey="spxPrice" stroke={C.accent4} dot={false} strokeWidth={1}   strokeDasharray="4 2" name="SPX Price" />
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </ComposedChart>
            </ResponsiveContainer>
            {!isZoomed && (
              <div style={{ fontSize: 9, color: C.muted, letterSpacing: "0.06em" }}>
                CLICK &amp; DRAG ANY TIME-SERIES CHART TO ZOOM — APPLIES TO ALL CHARTS
              </div>
            )}
          </Panel>

          <Panel title={<GreekLabel name="delta" label="Delta Evolution" />} subtitle="Call & Put delta vs time">
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={overviewChartData.delta} {...getZoomChartProps()}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(38)} domain={[-1, 1]} />
                <Tooltip content={<CustomTooltip />} />
                <Legend {...LEGEND_PROPS} />
                <ReferenceLine y={0} stroke={C.muted} strokeWidth={1} />
                <Area type="monotone" dataKey="callDelta" stroke={C.accent1} fill={C.accent1} fillOpacity={0.06} dot={false} strokeWidth={1.5} name="Call Δ" />
                <Area type="monotone" dataKey="putDelta"  stroke={C.accent2} fill={C.accent2} fillOpacity={0.06} dot={false} strokeWidth={1.5} name="Put Δ" />
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title="MBO Net Flow" subtitle="Stacking / pulling net signal per second" span={3}>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={overviewChartData.mboBar} {...getZoomChartProps()}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(55)} />
                <ReferenceLine y={0} stroke={C.muted} strokeWidth={1} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="mbo_ps" name="Net MBO Flow">
                  {overviewChartData.mboBar.map((d, i) => (
                    <Cell key={i} fill={d.mbo_ps > 0 ? C.bid : C.ask} />
                  ))}
                </Bar>
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </BarChart>
            </ResponsiveContainer>
          </Panel>

        </div>
      )}

      {/* GREEKS TAB */}
      {activeTab === "greeks" && greeksChartData && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>

          <Panel title={<GreekLabel name="gamma" label="Gamma" />} subtitle="Call & Put — rate of change of delta">
            <ResponsiveContainer width="100%" height={175}>
              <LineChart data={greeksChartData} {...getZoomChartProps()}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(65)} />
                <Tooltip content={<CustomTooltip />} />
                <Legend {...LEGEND_PROPS} />
                <Line type="monotone" dataKey="callGamma" stroke={C.accent1} dot={false} strokeWidth={1.5} name="Call Γ" />
                <Line type="monotone" dataKey="putGamma"  stroke={C.accent2} dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="Put Γ" />
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </LineChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="vega" label="Vega" />} subtitle="Call & Put — sensitivity to IV">
            <ResponsiveContainer width="100%" height={175}>
              <LineChart data={greeksChartData} {...getZoomChartProps()}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(55)} />
                <Tooltip content={<CustomTooltip />} />
                <Legend {...LEGEND_PROPS} />
                <Line type="monotone" dataKey="callVega" stroke={C.accent3} dot={false} strokeWidth={1.5} name="Call ν" />
                <Line type="monotone" dataKey="putVega"  stroke={C.accent5} dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="Put ν" />
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </LineChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="theta" label="Theta" />} subtitle="Call & Put — time decay">
            <ResponsiveContainer width="100%" height={175}>
              <LineChart data={greeksChartData} {...getZoomChartProps()}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(55)} />
                <Tooltip content={<CustomTooltip />} />
                <Legend {...LEGEND_PROPS} />
                <Line type="monotone" dataKey="callTheta" stroke={C.ask}    dot={false} strokeWidth={1.5} name="Call Θ" />
                <Line type="monotone" dataKey="putTheta"  stroke={C.accent5} dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="Put Θ" />
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </LineChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="vanna" label="Vanna" />} subtitle="Call & Put — delta sensitivity to IV">
            <ResponsiveContainer width="100%" height={175}>
              <AreaChart data={greeksChartData} {...getZoomChartProps()}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(55)} />
                <ReferenceLine y={0} stroke={C.muted} strokeWidth={1} />
                <Tooltip content={<CustomTooltip />} />
                <Legend {...LEGEND_PROPS} />
                <Area type="monotone" dataKey="callVanna" stroke={C.accent5} fill={C.accent5} fillOpacity={0.08} dot={false} strokeWidth={1.5} name="Call Vanna" />
                <Area type="monotone" dataKey="putVanna"  stroke={C.accent3} fill={C.accent3} fillOpacity={0.08} dot={false} strokeWidth={1.5} name="Put Vanna" />
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="charm" label="Charm" />} subtitle="Call & Put — delta decay over time">
            <ResponsiveContainer width="100%" height={175}>
              <AreaChart data={greeksChartData} {...getZoomChartProps()}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(55)} />
                <ReferenceLine y={0} stroke={C.muted} strokeWidth={1} />
                <Tooltip content={<CustomTooltip />} />
                <Legend {...LEGEND_PROPS} />
                <Area type="monotone" dataKey="callCharm" stroke="#ec4899" fill="#ec4899" fillOpacity={0.08} dot={false} strokeWidth={1.5} name="Call Charm" />
                <Area type="monotone" dataKey="putCharm"  stroke="#818cf8" fill="#818cf8" fillOpacity={0.08} dot={false} strokeWidth={1.5} name="Put Charm" />
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="vomma" label="Vomma" />} subtitle="Call & Put — vega convexity">
            <ResponsiveContainer width="100%" height={175}>
              <LineChart data={greeksChartData} {...getZoomChartProps()}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(55)} />
                <ReferenceLine y={0} stroke={C.muted} strokeWidth={1} />
                <Tooltip content={<CustomTooltip />} />
                <Legend {...LEGEND_PROPS} />
                <Line type="monotone" dataKey="callVomma" stroke={C.accent4} dot={false} strokeWidth={1.5} name="Call Vomma" />
                <Line type="monotone" dataKey="putVomma"  stroke={C.accent2} dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="Put Vomma" />
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </LineChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="rho" label="Rho" />} subtitle="Call & Put — interest rate sensitivity" span={2}>
            <ResponsiveContainer width="100%" height={175}>
              <LineChart data={greeksChartData} {...getZoomChartProps()}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(55)} />
                <ReferenceLine y={0} stroke={C.muted} strokeWidth={1} />
                <Tooltip content={<CustomTooltip />} />
                <Legend {...LEGEND_PROPS} />
                <Line type="monotone" dataKey="callRho" stroke={C.accent1} dot={false} strokeWidth={1.5} name="Call ρ" />
                <Line type="monotone" dataKey="putRho"  stroke={C.accent2} dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="Put ρ" />
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </LineChart>
            </ResponsiveContainer>
          </Panel>

        </div>
      )}

      {/* MICROSTRUCTURE TAB */}
      {activeTab === "microstructure" && microChartData && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>

          <Panel title="MBO Net Flow" subtitle="Stacking / pulling net signal per second" span={3}>
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={microChartData.mboBar} {...getZoomChartProps()}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(55)} />
                <ReferenceLine y={0} stroke={C.muted} strokeWidth={1} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="mbo_ps" name="Net MBO">
                  {microChartData.mboBar.map((d, i) => (
                    <Cell key={i} fill={d.mbo_ps > 0 ? C.bid : C.ask} />
                  ))}
                </Bar>
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="delta" label="Delta vs MBO Signal" />} subtitle="Call delta coloured by net flow direction" span={3}>
            <ResponsiveContainer width="100%" height={200}>
              <ScatterChart>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  type="number" dataKey="esPrice" name="ES Price"
                  tick={{ fill: C.textDim, fontSize: 9 }} tickCount={5} minTickGap={28}
                  domain={["dataMin", "dataMax"]}
                  label={{ value: "ES Price", fill: C.textDim, fontSize: 9, position: "insideBottom", offset: -4 }}
                  axisLine={{ stroke: C.border }} tickLine={false}
                />
                <YAxis
                  dataKey="callDelta" name="Call Delta"
                  tick={{ fill: C.textDim, fontSize: 9 }} tickCount={4} width={45}
                  axisLine={{ stroke: C.border }} tickLine={false}
                />
                <Tooltip cursor={{ stroke: C.muted }} content={<CustomTooltip />} />
                <Scatter data={microChartData.scatter} name="Observations">
                  {microChartData.scatter.map((d, i) => (
                    <Cell key={i} fill={d.mbo_ps > 0 ? C.bid : C.ask} opacity={0.7} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 16, fontSize: 10, color: C.textDim }}>
              <span style={{ color: C.bid }}>● Net Stacking</span>
              <span style={{ color: C.ask }}>● Net Pulling</span>
            </div>
          </Panel>

        </div>
      )}

      {/* ORDER BOOK TAB */}
      {activeTab === "order book" && orderBookChartData && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>

          <Panel title="All MBO Levels" subtitle="L1–L20 net order flow across the selected timeframe" span={2}>
            <ResponsiveContainer width="100%" height={330}>
              <LineChart data={orderBookChartData} {...getZoomChartProps()}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis {...timeAxisProps} />
                <YAxis {...buildYAxisProps(58)} />
                <ReferenceLine y={0} stroke={C.muted} strokeWidth={1} />
                <Tooltip content={<CustomTooltip />} />
                <Legend {...LEGEND_PROPS} />
                {MBO_LEVEL_KEYS.map((key, idx) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stroke={MBO_LINE_COLORS[idx % MBO_LINE_COLORS.length]}
                    dot={false}
                    strokeWidth={1}
                    opacity={0.82}
                    name={"L" + (idx + 1)}
                    connectNulls
                  />
                ))}
                {renderZoomSelection()}
                {renderDaySeparators(daySeparators)}
              </LineChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 9, color: C.muted, letterSpacing: "0.06em" }}>
              SHOWS EVERY MBO LEVEL IN THE CURRENT DATE / TIME SLICE / ZOOM WINDOW
            </div>
          </Panel>

          {[
            ["mbo1","mbo2"],["mbo3","mbo4"],["mbo5","mbo6"],["mbo7","mbo8"],["mbo9","mbo10"],
            ["mbo11","mbo12"],["mbo13","mbo14"],["mbo15","mbo16"],["mbo17","mbo18"],["mbo19","mbo20"],
          ].map((pair, idx) => {
            var a = pair[0], b = pair[1];
            var labelA = a.replace("mbo", "L");
            var labelB = b.replace("mbo", "L");
            return (
              <Panel key={idx} title={"Book Levels " + labelA + " & " + labelB} subtitle="Net order flow over time">
                <ResponsiveContainer width="100%" height={170}>
                  <LineChart data={orderBookChartData} {...getZoomChartProps()}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis {...timeAxisProps} />
                    <YAxis {...buildYAxisProps(50)} />
                    <ReferenceLine y={0} stroke={C.muted} strokeWidth={1} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend {...LEGEND_PROPS} />
                    <Line type="monotone" dataKey={a} stroke={C.accent1} dot={false} strokeWidth={1.2} name={labelA} />
                    <Line type="monotone" dataKey={b} stroke={C.accent2} dot={false} strokeWidth={1.2} name={labelB} />
                    {renderZoomSelection()}
                    {renderDaySeparators(daySeparators)}
                  </LineChart>
                </ResponsiveContainer>
              </Panel>
            );
          })}

        </div>
      )}

      <div style={{ marginTop: 20, fontSize: 9, color: C.textDim, textAlign: "right", letterSpacing: "0.08em" }}>
        SPX OPTIONS ANALYTICS · DATA PROVIDED BY DR. MOREHEAD
      </div>

    </div>
  );
}
