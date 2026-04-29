/**
 * SPX / ES Options Analytics Dashboard
 * Version 5 — Tufte-informed chart cleanup, hourly x-axis ticks,
 *              multi-day session separators, full code documentation.
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

/**
 * Remote Parquet file served from Cloudflare R2.
 * Contains 1-second aggregated SPX/ES options data for Apr 14–15 2025.
 */
const PARQUET_URL =
  "https://pub-73edacec404b41a29ac6cf15672e387f.r2.dev/20250414_full_agg_v2.parquet";

/**
 * Maximum number of data points sent to Recharts per chart type.
 * Recharts renders one SVG element per point; keeping these low prevents
 * browser jank on 60 k-row datasets while remaining visually lossless.
 *   line/area : 600 pts ≈ one tick every ~100 s on a full-day view
 *   bar       : 400 pts (bars merge below ~2 px anyway)
 *   scatter   : 800 pts (needs more density to preserve cloud shape)
 *   bookPair  : 500 pts × 10 panels = 5 k elements (vs 618 k unsampled)
 */
const DS = { line: 600, bar: 400, scatter: 800, bookPair: 500 };

/**
 * Maximum delta (in seconds) between a requested whole-hour boundary and the
 * nearest actual data timestamp for that hour to be included as an x-axis tick.
 * 300 s = 5 minutes. Hours far outside trading sessions (overnight gap) are
 * automatically excluded because no data point falls within this threshold.
 */
const TICK_MAX_DELTA_S = 300;

/**
 * When the visible time span (VIEWED_DATA) is shorter than this many seconds,
 * switch from hourly ticks to 10-minute ticks for better granularity.
 */
const TICK_SUBHOUR_THRESHOLD_S = 3600;


// ─────────────────────────────────────────────────────────────────────────────
// Colour palette
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All chart colours in one place. Dark theme optimised for screen readability.
 * Tufte note: accent colours are used sparingly — only to encode information,
 * never for decoration.
 */
const C = {
  bg:      "#07080f",   // page background
  panel:   "#0e1019",   // card background
  border:  "#1c1f2e",   // card / axis border
  grid:    "#14172200", // chart gridlines — very faint, non-zero opacity keeps
                        // structure without competing with data lines
  accent1: "#00e5ff",   // cyan  — ES price, call series primary
  accent2: "#ff6b35",   // orange — put series, negative MBO
  accent3: "#a78bfa",   // violet — date pill, secondary call
  accent4: "#34d399",   // green  — SPX price, bid, positive values
  accent5: "#f59e0b",   // amber  — zoom selection, gamma/vega highlights
  muted:   "#4b5263",   // mid-grey — zero reference lines, minor elements
  text:    "#c8cfe0",   // primary text
  textDim: "#5a6070",   // secondary text, axis labels
  ask:     "#f87171",   // red-ish — Ask side, theta, negative
  bid:     "#34d399",   // green  — Bid side, positive MBO
  daySep:  "#2a2f45",   // day-separator stripe fill
};


// ─────────────────────────────────────────────────────────────────────────────
// Greek tooltip definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Human-readable definitions shown when hovering the ? badge on any Greek
 * label. Kept in one object so they're easy to update or translate.
 */
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

/**
 * Reduce `data` to at most `maxPts` evenly-spaced rows, always keeping the
 * first and last row so time-axis edges remain accurate.
 *
 * Algorithm: uniform stride — pick index round(i * step) for i in [0, maxPts).
 * Time complexity: O(maxPts) after the length check. Safe inside useMemo.
 *
 * When data.length ≤ maxPts the original array is returned unchanged, which
 * means zoomed-in views (< 600 rows) automatically show full 1-second
 * resolution without any special-casing.
 *
 * @param {Array}  data    Sorted row array
 * @param {number} maxPts  Upper bound on output length
 * @returns {Array}
 */
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

// All camelCase Greek field names used in every merged row
const GREEK_KEYS = [
  'callDelta','callGamma','callVega','callTheta',
  'callVanna','callCharm','callVomma','callRho',
  'putDelta','putGamma','putVega','putTheta',
  'putVanna','putCharm','putVomma','putRho',
];
const MBO_LEVEL_KEYS = Array.from({ length: 20 }, (_, i) => 'mbo' + (i + 1));

/**
 * Merge Ask and Bid rows that share the same timestamp into single objects,
 * adding `ask_*`, `bid_*`, and `spread_*` (Ask − Bid) fields for every Greek,
 * mbo_ps, and all 20 MBO level columns.
 */
function mergeAskBid(data) {
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
    var merged = {
      timestamp: ts,
      esPrice:   base.esPrice,
      spxPrice:  base.spxPrice,
      t:         base.t,
    };
    GREEK_KEYS.concat(['mbo_ps']).concat(MBO_LEVEL_KEYS).forEach(function(k) {
      merged['ask_' + k] = ask[k] != null ? ask[k] : null;
      merged['bid_' + k] = bid[k] != null ? bid[k] : null;
      merged['spread_' + k] = (ask[k] != null && bid[k] != null) ? ask[k] - bid[k] : null;
    });
    return merged;
  });
}

/**
 * Remap the `spread_*` fields of a merged row array back onto the standard
 * field names (`callDelta`, `mbo_ps`, `mbo1`, …) so that all chart components
 * can render spread data without any conditional field-name logic.
 */
function normalizeSpreads(merged) {
  return merged.map(function(d) {
    var row = { timestamp: d.timestamp, esPrice: d.esPrice, spxPrice: d.spxPrice, t: d.t };
    GREEK_KEYS.concat(['mbo_ps']).concat(MBO_LEVEL_KEYS).forEach(function(k) {
      row[k] = d['spread_' + k];
    });
    return row;
  });
}

/**
 * Format a UTC ISO timestamp string (e.g. "2025-04-14T14:00:00.000Z") as a
 * local-time HH:MM:SS string using the browser's local timezone.
 *
 * This is intentional: timestamps are stored as UTC in the parquet file, but
 * users prefer to read chart axes in their own local time. The browser's
 * Date object handles DST automatically.
 *
 * Note: if local time is Pacific (UTC-7), 13:21 UTC → 06:21 local, which
 * correctly reflects when the market opened in that timezone.
 *
 * @param {string} value  ISO timestamp string
 * @returns {string}      "HH:MM:SS"
 */
function formatTimeTick(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (isNaN(dt.getTime())) return String(value);
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  const ss = String(dt.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Same as formatTimeTick but omits seconds — used for hour-boundary tick
 * labels so they read "10:00" instead of "10:00:00".
 *
 * @param {string} value  ISO timestamp string
 * @returns {string}      "HH:MM"
 */
function formatHourTick(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (isNaN(dt.getTime())) return String(value);
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Like formatHourTick but prepends "MM/DD " so labels are unambiguous when
 * the visible range spans multiple calendar days.
 */
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

/**
 * Extract the calendar date portion of an ISO string ("2025-04-14T…" → "2025-04-14").
 * Used for date-pill filtering and day-separator logic.
 *
 * @param {string} ts  ISO timestamp string
 * @returns {string}   "YYYY-MM-DD"
 */
function isoToDate(ts) {
  return ts ? ts.slice(0, 10) : "";
}

/**
 * Convert an ISO timestamp into a value accepted by <input type="datetime-local">.
 * The browser displays this in local time, matching the chart axis/tooltips.
 *
 * @param {string} iso  ISO timestamp string
 * @returns {string}    "YYYY-MM-DDTHH:MM:SS" or empty string
 */
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

/**
 * Parse a datetime-local input value back into an ISO timestamp.
 * Returns null for blank or invalid input so validation can fail gracefully.
 *
 * @param {string} value  datetime-local input value
 * @returns {string|null} ISO timestamp string or null
 */
function localInputValueToIso(value) {
  if (!value) return null;
  var dt = new Date(value);
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

/**
 * Format an ISO timestamp for compact helper text under the time filter.
 *
 * @param {string} iso  ISO timestamp string
 * @returns {string}    "YYYY-MM-DD HH:MM:SS" in local time
 */
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

/**
 * Build hourly (or 10-minute) x-axis tick timestamps suited to Tufte's
 * principle of consistent, meaningful axis labels.
 *
 * Strategy:
 *  1. Measure the span of the visible data in seconds.
 *  2. Choose a tick interval: 1 hour if span > TICK_SUBHOUR_THRESHOLD_S,
 *     else 10 minutes.
 *  3. Walk UTC boundaries at the chosen interval across the data range.
 *  4. For each boundary, find the nearest actual data-point timestamp.
 *  5. Exclude any boundary whose nearest point is > TICK_MAX_DELTA_S away —
 *     this automatically drops overnight hours where no data exists.
 *
 * Result: ticks land on clean clock times (10:00, 11:00 …) rather than
 * arbitrary array-index positions, and all charts share the same tick labels
 * because they all receive the same VIEWED_DATA.
 *
 * @param {Array}  data  Downsampled row array (each row has a `timestamp` field)
 * @returns {string[]}   Array of ISO timestamp strings to pass to Recharts ticks
 */
function getHourlyTicks(data) {
  if (!data || data.length < 2) return [];

  // Build a lookup: ISO string → index, for fast nearest-point search below
  var tsArray = data.map(function(d) { return new Date(d.timestamp).getTime(); });
  var first = tsArray[0];
  var last  = tsArray[tsArray.length - 1];
  var spanSecs = (last - first) / 1000;

  // Choose interval based on span — wider views use coarser ticks to avoid crowding
  var DAY_S = 86400;
  var intervalMs =
    spanSecs > 5 * DAY_S ? 4 * 60 * 60 * 1000 :   // > 5 days  → 4-hour ticks
    spanSecs > 2 * DAY_S ? 2 * 60 * 60 * 1000 :   // > 2 days  → 2-hour ticks
    spanSecs > TICK_SUBHOUR_THRESHOLD_S ? 60 * 60 * 1000 :  // > 1 hour → hourly
    10 * 60 * 1000;                                 // ≤ 1 hour  → 10-min

  // Find first boundary at or after `first`
  var startBoundary = Math.ceil(first / intervalMs) * intervalMs;

  var ticks = [];
  var boundary = startBoundary;

  while (boundary <= last) {
    // Binary-search for nearest data timestamp to this boundary
    var lo = 0, hi = tsArray.length - 1, best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tsArray[mid] < boundary) { lo = mid + 1; }
      else                          { hi = mid - 1; }
      if (Math.abs(tsArray[mid] - boundary) < Math.abs(tsArray[best] - boundary)) {
        best = mid;
      }
    }

    var deltaSecs = Math.abs(tsArray[best] - boundary) / 1000;
    if (deltaSecs <= TICK_MAX_DELTA_S) {
      ticks.push(data[best].timestamp);
    }

    boundary += intervalMs;
  }

  return ticks;
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

  // Pick a reasonable tick count based on zoom window.
  // This avoids overcrowding while still showing labels initially.
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

    // Avoid duplicates when zoomed very tightly.
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
/**
 * Find the timestamp of the first data row belonging to each calendar date
 * beyond the first. These are used as `x` values for day-separator
 * ReferenceLines when the view spans multiple sessions.
 *
 * @param {Array}  data  Row array with `timestamp` fields (sorted ascending)
 * @returns {Array}      Objects { timestamp, label } for each session boundary
 */
function getDaySeparators(data) {
  if (!data || !data.length) return [];
  var separators = [];
  var seenDate = isoToDate(data[0].timestamp);
  for (var i = 1; i < data.length; i++) {
    var d = isoToDate(data[i].timestamp);
    if (d !== seenDate) {
      // Format the label as "Apr 15" using UTC to avoid timezone-shift of the
      // date string (the timestamp is at the top of a UTC day)
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

/**
 * Inline Greek name label with a hoverable ? badge that shows the definition.
 * Used in Panel titles and StatBadge labels throughout the dashboard.
 *
 * Props:
 *   name  {string}  Key into GREEK_DEFINITIONS (case-insensitive)
 *   label {string}  Display text shown next to the badge
 */
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
      {/* Small circular badge — intentionally minimal (Tufte: no chartjunk) */}
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

/**
 * Consistent chart card container. All charts live inside a Panel.
 * The `span` prop controls CSS grid column-span (default 1).
 * Tufte: panels use minimal borders — just enough to separate regions.
 *
 * Props:
 *   title    {ReactNode}  Card heading (may contain a GreekLabel)
 *   subtitle {string}     Smaller descriptive line beneath the title
 *   span     {number}     CSS grid column span (1–3)
 *   children {ReactNode}  Chart content
 */
function Panel({ title, subtitle, children, span }) {
  return (
    <div style={{
      background: C.panel,
      border: "1px solid " + C.border,
      borderRadius: 8,                          // reduced from 12 — less decoration
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

/**
 * Numeric stat with an optional GreekLabel above it.
 * Used in the header and Session Summary panel.
 *
 * Props:
 *   label {string}  Short description
 *   value {string}  Formatted number string
 *   color {string}  CSS colour for the value
 *   greek {string}  If set, wraps label in a GreekLabel component
 */
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

/**
 * Toggleable pill button used for Date and Side filters.
 * Active state fills with the accent colour; inactive is ghost-style.
 *
 * Props:
 *   label  {string}   Button text
 *   active {boolean}  Whether this option is currently selected
 *   onClick {fn}      Click handler
 *   color  {string}   Accent colour when active
 */
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

/**
 * Custom Recharts tooltip shown on hover.
 * Displays the formatted timestamp and all series values.
 * Tufte: tooltip appears only on interaction — no persistent annotation noise.
 *
 * Recharts props (injected automatically):
 *   active  {boolean}  Whether the cursor is over the chart
 *   payload {Array}    Series data for the hovered point
 *   label   {string}   The x-axis value (timestamp ISO string)
 */
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  // Detect ISO strings by the presence of "T" and format them as local time
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

/**
 * Build the Recharts XAxis props object shared by every time-series chart.
 * Centralising this ensures all charts use identical tick spacing and labels.
 *
 * Tufte notes applied here:
 *   - Tick labels use HH:MM (no seconds) for cleaner reading
 *   - minTickGap prevents label collisions on narrow panels
 *   - tick colour matches textDim (recedes behind data)
 *
 * @param {string[]} ticks  Tick timestamp array from getHourlyTicks()
 * @returns {object}        Props spread directly onto <XAxis>
 */
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
/**
 * Build the common Recharts YAxis props for most charts.
 * Width is parameterised because Greek values have varying decimal lengths.
 *
 * Tufte note: tick count reduced to 4 maximum — enough to anchor the eye
 * without cluttering the data region.
 *
 * @param {number} [width=50]  Pixel width reserved for labels
 * @returns {object}
 */
function buildYAxisProps(width) {
  return {
    tick:      { fill: C.textDim, fontSize: 9 },
    tickCount: 4,
    width:     width || 50,
    axisLine:  { stroke: C.border },
    tickLine:  false,              // Tufte: remove tick marks — the grid does this work
  };
}

/**
 * CartesianGrid props applied to every chart.
 * Tufte: gridlines should be faint and unobtrusive — they help the eye track
 * values without competing with the data lines.
 * Using a very low-opacity solid stroke rather than a dashed pattern avoids
 * the visual noise of repeated dashes.
 */
const GRID_PROPS = {
  strokeDasharray: "",           // solid line — less noisy than dashes
  stroke: "rgba(255,255,255,0.04)", // extremely faint white
  vertical: true,
  horizontal: true,
};

/**
 * Legend props applied to every chart that has one.
 * Tufte: legend text is small and dim — it identifies series without drawing
 * attention away from the data.
 */
const LEGEND_PROPS = {
  wrapperStyle: { fontSize: 10, color: C.textDim },
};

/**
 * Build ReferenceLines for each day-session boundary in `separators`.
 * Renders as a thin vertical line with a floating date label at the top.
 *
 * Tufte: the separator uses a subtle dashed style so it clearly marks a
 * categorical boundary (different day) without looking like data.
 *
 * @param {Array} separators  Output of getDaySeparators()
 * @returns {ReactNode[]}
 */
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

/**
 * Root component. Manages all application state, data loading, filtering,
 * zoom, and renders the four-tab dashboard layout.
 *
 * State hierarchy:
 *   ALL_DATA        Raw cleaned rows from Parquet (never mutated after load)
 *     └─ DATA       Filtered by selectedDate
 *          └─ VIEWED_DATA  Further sliced by zoomRange
 *               └─ [tab]ChartData  Downsampled for Recharts (tab-gated)
 */
export default function Dashboard() {

  // ── UI state ───────────────────────────────────────────────────────────────
  const [activeTab,     setActiveTab]     = useState("overview");
  const [selectedSide,  setSelectedSide]  = useState("Ask"); // "Ask" | "Bid" | "Spread"
  const [selectedDate,  setSelectedDate]  = useState("all"); // "all" | "YYYY-MM-DD"

  // Manual time-slice filter. Inputs are local datetime strings; timeRange is ISO.
  const [timeStartInput, setTimeStartInput] = useState("");
  const [timeEndInput,   setTimeEndInput]   = useState("");
  const [timeRange,      setTimeRange]      = useState(null); // null | [loISO, hiISO]
  const [timeFilterError, setTimeFilterError] = useState("");

  // ── Data state ─────────────────────────────────────────────────────────────
  const [ALL_DATA, setAllData] = useState([]);
  const [error,    setError]   = useState(null);

  // ── Zoom state ─────────────────────────────────────────────────────────────
  // zoomRange  : null = full view, or [loISO, hiISO] after a completed drag
  // dragStart  : ISO string of the mousedown point (null when not dragging)
  // dragCurrent: ISO string of the current mousemove point during a drag
  const [zoomRange,   setZoomRange]   = useState(null);
  const [dragStart,   setDragStart]   = useState(null);
  const [dragCurrent, setDragCurrent] = useState(null);
  const isDragging = dragStart !== null;


  // ── Parquet loader ─────────────────────────────────────────────────────────
  /**
   * Fetches and parses the Parquet file once on mount.
   * Uses a `cancelled` flag to avoid setting state after unmount.
   *
   * hyparquet's `parquetReadObjects` returns one plain JS object per row.
   * We rename columns to camelCase for ergonomic use throughout the component,
   * and sort by timestamp to guarantee chronological order.
   */
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

        // hyparquet needs a file-like object with byteLength + async slice
        var file = {
          byteLength: arrayBuffer.byteLength,
          slice: (start, end) => Promise.resolve(arrayBuffer.slice(start, end)),
        };

        var rawRows = await parquetReadObjects({ file });
        if (cancelled) return;

        var cleaned = rawRows
          .filter(row => row.timestamp)
          .map(row => ({
            // Core identifiers
            timestamp:    row.timestamp instanceof Date
                            ? row.timestamp.toISOString()
                            : String(row.timestamp || ""),
            side:         row.Side,

            // Underlying prices
            esPrice:      row.current_es_price,
            spxPrice:     row.spx_price,
            spxStrike:    row.spx_strike,
            futureStrike: row.future_strike,
            t:            row.t,               // time to expiry (years)

            // MBO pulling/stacking net sum
            mbo_ps:       row.MBO_pulling_stacking,

            // Call Greeks
            callDelta: row.call_delta,  callGamma: row.call_gamma,
            callVega:  row.call_vega,   callTheta: row.call_theta,
            callVanna: row.call_vanna,  callCharm: row.call_charm,
            callVomma: row.call_vomma,  callRho:   row.call_rho,

            // Put Greeks
            putDelta:  row.put_delta,   putGamma:  row.put_gamma,
            putVega:   row.put_vega,    putTheta:  row.put_theta,
            putVanna:  row.put_vanna,   putCharm:  row.put_charm,
            putVomma:  row.put_vomma,   putRho:    row.put_rho,

            // Order-book levels L1–L20 (net sum per 1-second bucket)
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
  }, []); // runs once on mount


  // ── Derived filter options ─────────────────────────────────────────────────

  /**
   * Unique calendar dates present in ALL_DATA, sorted ascending.
   * Drives the Date filter pills — auto-updates when new sessions are added.
   */
  const allDates = useMemo(() => {
    var seen = {};
    ALL_DATA.forEach(d => { var dt = isoToDate(d.timestamp); if (dt) seen[dt] = true; });
    return Object.keys(seen).sort();
  }, [ALL_DATA]);


  // ── Filtered data layers ───────────────────────────────────────────────────

  /**
   * BASE_DATA: ALL_DATA filtered by the date pill and side pill only.
   * The manual time-slice is validated against this layer so bad ranges can
   * fail safely without destroying the current visible view.
   */
  const BASE_DATA = useMemo(() => {
    return ALL_DATA.filter(d => {
      var dateOk = selectedDate === "all" || isoToDate(d.timestamp) === selectedDate;
      // Spread mode keeps both sides so mergeAskBid can pair them
      var sideOk = selectedSide === "Spread" || d.side === selectedSide;
      return dateOk && sideOk;
    });
  }, [ALL_DATA, selectedSide, selectedDate]);

  /**
   * DATA: BASE_DATA further filtered by the optional manual time-slice.
   * This remains full-resolution; chart memos downsample from VIEWED_DATA.
   */
  const DATA = useMemo(() => {
    if (!timeRange) return BASE_DATA;
    var lo = timeRange[0] < timeRange[1] ? timeRange[0] : timeRange[1];
    var hi = timeRange[0] < timeRange[1] ? timeRange[1] : timeRange[0];
    return BASE_DATA.filter(d => d.timestamp >= lo && d.timestamp <= hi);
  }, [BASE_DATA, timeRange]);

  /** Available timestamp bounds after date/side filtering but before time slicing. */
  const availableRange = useMemo(() => {
    if (!BASE_DATA.length) return null;
    return [BASE_DATA[0].timestamp, BASE_DATA[BASE_DATA.length - 1].timestamp];
  }, [BASE_DATA]);

  /**
   * VIEWED_DATA: DATA further sliced to the zoom window.
   * All chart memos depend on this — zoom is applied in one place.
   * When zoomRange is null, VIEWED_DATA === DATA (no copy made).
   */
  const VIEWED_DATA = useMemo(() => {
    if (!zoomRange) return DATA;
    var lo = zoomRange[0] < zoomRange[1] ? zoomRange[0] : zoomRange[1];
    var hi = zoomRange[0] < zoomRange[1] ? zoomRange[1] : zoomRange[0];
    return DATA.filter(d => d.timestamp >= lo && d.timestamp <= hi);
  }, [DATA, zoomRange]);

  // Only merge when Spread mode is active — no-op cost otherwise
  const mergedViewedData = useMemo(() => {
    if (selectedSide !== "Spread" || !VIEWED_DATA.length) return [];
    return mergeAskBid(VIEWED_DATA);
  }, [VIEWED_DATA, selectedSide]);

  /**
   * Single data layer consumed by every chart.
   * Ask/Bid: raw VIEWED_DATA rows with standard field names.
   * Spread:  normalizeSpreads() remaps spread_* → standard names so charts
   *          need zero conditional logic.
   */
  const displayData = useMemo(() => {
    if (selectedSide === "Spread") return normalizeSpreads(mergedViewedData);
    return VIEWED_DATA;
  }, [selectedSide, VIEWED_DATA, mergedViewedData]);


  // ── Tab-gated, downsampled chart data ─────────────────────────────────────
  /**
   * Each tab's chart data is computed only when that tab is active (the
   * activeTab guard returns null early for inactive tabs). This prevents
   * Recharts from instantiating SVG trees for off-screen tabs.
   *
   * All memos depend on VIEWED_DATA so filters and zoom propagate through
   * automatically.
   */

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
  // These drive the header stat badges and Session Summary — they must always
  // reflect the current VIEWED_DATA even when a tab is inactive.

  // Last row of displayData — has standard field names in all three modes
  const latestDisplayRow = displayData.length
    ? displayData[displayData.length - 1]
    : (ALL_DATA.length ? ALL_DATA[ALL_DATA.length - 1] : null);

  const askCount = useMemo(
    () => VIEWED_DATA.filter(d => d.side === "Ask").length,
    [VIEWED_DATA]
  );
  const bidCount = useMemo(
    () => VIEWED_DATA.filter(d => d.side === "Bid").length,
    [VIEWED_DATA]
  );
  const netMBO = useMemo(
    () => VIEWED_DATA.reduce((s, d) => s + (d.mbo_ps || 0), 0),
    [VIEWED_DATA]
  );

  const mboHeatData = useMemo(() => {
    if (!latestDisplayRow) return [];
    return Array.from({ length: 20 }, (_, i) => ({
      level: "L" + (i + 1),
      value: latestDisplayRow["mbo" + (i + 1)],
    }));
  }, [latestDisplayRow]);

  const maxMboAbs = useMemo(
    () => Math.max(...mboHeatData.map(x => Math.abs(x.value || 0)), 1),
    [mboHeatData]
  );


  // ── Early returns for loading / error ─────────────────────────────────────
  if (error)           return <div style={{ color: C.ask, padding: 40, fontFamily: "monospace", background: C.bg, minHeight: "100vh" }}>Failed to load data: {error}</div>;
  if (!ALL_DATA.length) return <div style={{ color: C.accent1, padding: 40, fontFamily: "monospace", background: C.bg, minHeight: "100vh" }}>Loading data…</div>;
  if (!latestDisplayRow) return null;


  // ── Shared x-axis config (computed once per render) ────────────────────────
  /**
   * Pick the downsampled slice that is currently visible so ticks align
   * with the actual rendered points. Falls back to VIEWED_DATA when no tab
   * has computed its data yet (shouldn't normally happen).
   */
  // Use the full viewed data for tick generation, not the downsampled chart slice.
  // This keeps x-axis labels stable when zooming.
  var activeSlice = (
    activeTab === "overview"       ? (overviewChartData?.price) :
    activeTab === "greeks"         ? greeksChartData :
    activeTab === "microstructure" ? (microChartData?.mboBar) :
    activeTab === "order book"     ? orderBookChartData :
    null
  ) || displayData;

  // IMPORTANT:
  // Ticks must come from the actual rendered chart data.
  // If ticks come from VIEWED_DATA but the chart is downsampled,
  // Recharts may not find matching x-values, so labels disappear.
  var timeTicks = getNiceTicksFromRenderedData(activeSlice);
  // Switch to date+time labels when the visible span exceeds one day
  var activeSpanMs = activeSlice && activeSlice.length >= 2
    ? new Date(activeSlice[activeSlice.length - 1].timestamp).getTime()
      - new Date(activeSlice[0].timestamp).getTime()
    : 0;
  var tickFmt = activeSpanMs > 86400000 ? formatDayHourTick : formatHourTick;
  var timeAxisProps = buildTimeAxisProps(timeTicks, tickFmt);
  /**
   * Day separators for multi-session views. Only relevant when selectedDate
   * is "all" and VIEWED_DATA spans more than one calendar date.
   * Pass the full (non-downsampled) VIEWED_DATA so we don't miss the exact
   * first-row boundary due to stride skipping.
   */
  var daySeparators = getDaySeparators(VIEWED_DATA);


  // ── Zoom event handlers ────────────────────────────────────────────────────
  /**
   * These three handlers are attached only to the ES Price ComposedChart.
   * Recharts' synthetic mouse events supply `e.activeLabel`, which is the
   * x-axis value (timestamp string) of the hovered data point.
   *
   * Flow:
   *   mousedown  → record dragStart
   *   mousemove  → update dragCurrent (live ReferenceArea highlight)
   *   mouseup    → commit zoomRange if drag spanned ≥ 2 distinct points
   */
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

  function clearTimeFilter() {
    setTimeRange(null);
    setTimeStartInput("");
    setTimeEndInput("");
    setTimeFilterError("");
    resetZoom();
  }

  function applyTimeFilter() {
    setTimeFilterError("");

    if (!availableRange) {
      setTimeFilterError("No data is available for the current date/side filters.");
      return;
    }

    var startIso = localInputValueToIso(timeStartInput);
    var endIso   = localInputValueToIso(timeEndInput);

    if (!startIso || !endIso) {
      setTimeFilterError("Pick both a start and end time.");
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

    var rowsInRange = BASE_DATA.filter(d => d.timestamp >= lo && d.timestamp <= hi);
    if (!rowsInRange.length) {
      setTimeFilterError("No rows exist in that window. It may fall inside a session gap.");
      return;
    }

    setTimeRange([lo, hi]);
    resetZoom();
  }

  function fillFullAvailableTimeRange() {
    if (!availableRange) return;
    setTimeStartInput(isoToLocalInputValue(availableRange[0]));
    setTimeEndInput(isoToLocalInputValue(availableRange[1]));
    setTimeFilterError("");
  }

  /** Changing the date resets zoom and manual time filters — old timestamps don't map to new session */
  function handleDateChange(date) {
    setSelectedDate(date);
    setTimeRange(null);
    setTimeStartInput("");
    setTimeEndInput("");
    setTimeFilterError("");
    resetZoom();
  }

  function handleSideChange(side) {
    setSelectedSide(side);
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

  /** Human-readable label for the zoom window duration shown in the header */
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

  // Normalise drag endpoints so dragLo is always the earlier timestamp
  var dragLo = (dragStart && dragCurrent)
    ? (dragStart < dragCurrent ? dragStart : dragCurrent) : null;
  var dragHi = (dragStart && dragCurrent)
    ? (dragStart < dragCurrent ? dragCurrent : dragStart) : null;


  // ── JSX ────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh", background: C.bg, color: C.text,
      fontFamily: "'DM Mono', 'Courier New', monospace",
      padding: "24px 28px", boxSizing: "border-box",
    }}>

      {/* ════════════════════════════════════════════════════════════════════
          HEADER
          Shows: title, latest timestamp, row count, key stat badges.
          Stat badges (ES Price, SPX Price, Call Delta, Call Gamma) give the
          researcher an at-a-glance orientation before reading any chart.
      ════════════════════════════════════════════════════════════════════ */}
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
              <span style={{ color: C.accent3 }}>· time slice active</span>
            )}
            {isZoomed && (
              <span style={{ color: C.accent5 }}>· {zoomDurationLabel()}</span>
            )}
          </div>
        </div>

        {/* Key stat badges — always reflect the current zoom/filter/mode view */}
        <div style={{ display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
          <StatBadge label="ES Price"   value={latestDisplayRow?.esPrice   != null ? latestDisplayRow.esPrice.toFixed(1)   : "—"} color={C.accent1} />
          <StatBadge label="SPX Price"  value={latestDisplayRow?.spxPrice  != null ? latestDisplayRow.spxPrice.toFixed(1)  : "—"} color={C.accent4} />
          <StatBadge label="Call Delta" value={latestDisplayRow?.callDelta != null ? latestDisplayRow.callDelta.toFixed(3) : "—"} color={C.accent3} greek="delta" />
          <StatBadge label="Call Gamma" value={latestDisplayRow?.callGamma != null ? latestDisplayRow.callGamma.toFixed(5) : "—"} color={C.accent5} greek="gamma" />
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          FILTER BAR
          Date pills → Side pills → (conditional) Reset Zoom button.
          A thin divider separates each group visually.
      ════════════════════════════════════════════════════════════════════ */}
      <div style={{ display: "flex", gap: 16, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>

        {/* Date filter — pills generated from allDates (auto-updates with data) */}
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

        {/* Side / Spread filter */}
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

        {/* Manual time-slice filter — local browser time, validated against available rows */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase" }}>Time Slice</span>
          <input
            type="datetime-local"
            step="1"
            value={timeStartInput}
            onChange={e => setTimeStartInput(e.target.value)}
            style={{
              background: "#0b0d15", color: C.text, border: "1px solid " + C.border,
              borderRadius: 6, padding: "4px 7px", fontSize: 10,
              fontFamily: "'DM Mono', monospace", colorScheme: "dark",
            }}
          />
          <span style={{ color: C.textDim, fontSize: 10 }}>→</span>
          <input
            type="datetime-local"
            step="1"
            value={timeEndInput}
            onChange={e => setTimeEndInput(e.target.value)}
            style={{
              background: "#0b0d15", color: C.text, border: "1px solid " + C.border,
              borderRadius: 6, padding: "4px 7px", fontSize: 10,
              fontFamily: "'DM Mono', monospace", colorScheme: "dark",
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

        {/* Reset Zoom — only visible when a zoom is active */}
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

      {/* ════════════════════════════════════════════════════════════════════
          TAB BAR
          Four tabs: Overview · Greeks · Microstructure · Order Book.
          The active tab is highlighted with accent1; inactive tabs are dim.
      ════════════════════════════════════════════════════════════════════ */}
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

      {/* Empty state — shown when filters produce no matching rows */}
      {!VIEWED_DATA.length && (
        <div style={{ color: C.textDim, padding: "40px 0", textAlign: "center", fontSize: 13 }}>
          No data matches the current filters.
        </div>
      )}


      {/* ════════════════════════════════════════════════════════════════════
          OVERVIEW TAB
          Grid: [ES+SPX Price (span 2)] [Delta Evolution]
                [MBO Net Flow (span 2)]  [Session Summary]

          The ES Price chart doubles as the zoom controller: mouse-down/move/up
          draw an amber ReferenceArea; on mouse-up the selection is committed to
          zoomRange, which propagates through VIEWED_DATA to all other charts.
      ════════════════════════════════════════════════════════════════════ */}
      {activeTab === "overview" && overviewChartData && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>

          {/* ── ES / SPX Price — zoom controller ── */}
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
                {/* Live drag-selection amber highlight */}
                {renderZoomSelection()}
                {/* Session boundary separators */}
                {renderDaySeparators(daySeparators)}
              </ComposedChart>
            </ResponsiveContainer>
            {!isZoomed && (
              <div style={{ fontSize: 9, color: C.muted, letterSpacing: "0.06em" }}>
                CLICK &amp; DRAG ANY TIME-SERIES CHART TO ZOOM — APPLIES TO ALL CHARTS
              </div>
            )}
          </Panel>

          {/* ── Delta Evolution ── */}
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

          {/* ── MBO Net Flow ── */}
          <Panel title="MBO Net Flow" subtitle="Stacking / pulling net signal per second" span={2}>
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

          {/* ── Session Summary ── */}
          <Panel title="Session Summary" subtitle="Current view snapshot">
            <div style={{ display: "flex", flexDirection: "column", gap: 12, justifyContent: "center", flex: 1 }}>
              <StatBadge
                label="Net MBO Flow"
                value={(netMBO > 0 ? "+" : "") + netMBO.toFixed(0)}
                color={netMBO > 0 ? C.bid : C.ask}
              />
              <div style={{ display: "flex", gap: 20 }}>
                <StatBadge label="Ask rows" value={askCount} color={C.ask} />
                <StatBadge label="Bid rows" value={bidCount} color={C.bid} />
              </div>
              <div style={{ fontSize: 10, color: C.textDim }}>
                <GreekLabel name="gamma" label="Gamma" /> latest:{" "}
                <span style={{ color: C.accent4 }}>
                  {latestDisplayRow?.callGamma != null ? latestDisplayRow.callGamma.toFixed(6) : "—"}
                </span>
              </div>
              <div style={{ fontSize: 10, color: C.textDim }}>
                <GreekLabel name="vega" label="Vega" /> latest:{" "}
                <span style={{ color: C.accent3 }}>
                  {latestDisplayRow?.callVega != null ? latestDisplayRow.callVega.toFixed(3) : "—"}
                </span>
              </div>
            </div>
          </Panel>

        </div>
      )}


      {/* ════════════════════════════════════════════════════════════════════
          GREEKS TAB
          2-column grid of time-series charts for all eight Greeks.
          Each chart shows the call (solid) and put (dashed) variant.
          All 7 charts share greeksChartData — one downsample allocation.
      ════════════════════════════════════════════════════════════════════ */}
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


      {/* ════════════════════════════════════════════════════════════════════
          MICROSTRUCTURE TAB
          3-column grid:
            [MBO Net Flow (span 3)]
            [Delta vs MBO Scatter (span 2)]  [Ask/Bid Distribution]
      ════════════════════════════════════════════════════════════════════ */}
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

          {/* Scatter: ES Price (x) vs Call Delta (y), coloured by MBO direction */}
          <Panel title={<GreekLabel name="delta" label="Delta vs MBO Signal" />} subtitle="Call delta coloured by net flow direction" span={2}>
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

          {/* Ask / Bid row count breakdown with progress bars */}
          <Panel title="Ask / Bid Distribution" subtitle="Row counts by side">
            <div style={{ display: "flex", flexDirection: "column", gap: 12, justifyContent: "center", flex: 1 }}>
              {["Ask", "Bid"].map(side => {
                var count = side === "Ask" ? askCount : bidCount;
                var pct   = VIEWED_DATA.length ? (count / VIEWED_DATA.length) * 100 : 0;
                return (
                  <div key={side}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: side === "Ask" ? C.ask : C.bid }}>{side}</span>
                      <span style={{ color: C.text }}>{count.toLocaleString()} ({pct.toFixed(0)}%)</span>
                    </div>
                    <div style={{ background: C.border, borderRadius: 3, height: 5 }}>
                      <div style={{ height: "100%", width: pct + "%", background: side === "Ask" ? C.ask : C.bid, borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 6, fontSize: 10, color: C.textDim }}>
                Net flow:{" "}
                <span style={{ color: netMBO > 0 ? C.bid : C.ask, fontWeight: 700 }}>
                  {(netMBO > 0 ? "+" : "") + netMBO.toFixed(0)}
                </span>
              </div>
            </div>
          </Panel>

        </div>
      )}


      {/* ════════════════════════════════════════════════════════════════════
          ORDER BOOK TAB
          [MBO Level Snapshot — L1–L20 horizontal bar (span 2)]
          [10 × paired line charts for level pairs L1/L2 … L19/L20]

          The snapshot bar chart uses the `latestDisplayRow` (not downsampled)
          so values are always exact for the most recent second.
          The pair line charts share orderBookChartData (one downsample).
      ════════════════════════════════════════════════════════════════════ */}
      {activeTab === "order book" && orderBookChartData && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>

          <Panel title="MBO Level Snapshot" subtitle="Net order quantity by level — latest second (L1–L20)" span={2}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={mboHeatData} layout="vertical">
                <CartesianGrid {...GRID_PROPS} horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: C.textDim, fontSize: 9 }}
                  axisLine={{ stroke: C.border }} tickLine={false}
                />
                <YAxis
                  dataKey="level" type="category"
                  tick={{ fill: C.textDim, fontSize: 9 }} width={28}
                  axisLine={{ stroke: C.border }} tickLine={false}
                />
                <ReferenceLine x={0} stroke={C.muted} strokeWidth={1} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="value" name="Net Order Size">
                  {mboHeatData.map((d, i) => (
                    <Cell
                      key={i}
                      fill={d.value >= 0 ? C.accent1 : C.accent2}
                      opacity={0.4 + (Math.abs(d.value || 0) / maxMboAbs) * 0.6}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          {/* Paired time-series for each adjacent level pair */}
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

      {/* ── Footer ── */}
      <div style={{ marginTop: 20, fontSize: 9, color: C.textDim, textAlign: "right", letterSpacing: "0.08em" }}>
        SPX OPTIONS ANALYTICS · DATA PROVIDED BY DR. MOREHEAD
      </div>

    </div>
  );
}
