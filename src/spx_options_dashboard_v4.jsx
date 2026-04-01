// Version 4 reads from a parquet file and aggregates the data.
// WIP x-axes are still messed up
import { useState, useEffect } from "react";
import * as duckdb from "@duckdb/duckdb-wasm";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ScatterChart, Scatter, Cell,
  ReferenceLine, Area, AreaChart, ComposedChart
} from "recharts";

// ── Aggregated Parquet URL ────────────────────────────────────────────────────
// Upload fixed_output_agg.parquet to your R2 bucket and update this URL
const PARQUET_URL = "https://pub-73edacec404b41a29ac6cf15672e387f.r2.dev/output_agg.parquet";

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  bg: "#07080f",
  panel: "#0e1019",
  border: "#1c1f2e",
  accent1: "#00e5ff",
  accent2: "#ff6b35",
  accent3: "#a78bfa",
  accent4: "#34d399",
  accent5: "#f59e0b",
  muted: "#4b5263",
  text: "#c8cfe0",
  textDim: "#5a6070",
  buy: "#34d399",
  sell: "#f87171",
};

// ── Greek Definitions ─────────────────────────────────────────────────────────
const GREEK_DEFINITIONS = {
  delta:  "Change in option premium per $1 move in the underlying. Calls range 0 to 1, Puts -1 to 0. Approaches +/-0.5 at-the-money.",
  gamma:  "Rate of change of delta per $1 move in the underlying. Highest at-the-money; falls as the option moves further in or out of the money.",
  theta:  "Daily option value decay as expiration approaches. Almost always negative for long options; accelerates near expiry.",
  vega:   "Change in option premium per 1% move in implied volatility. Rising IV increases both call and put values, and vice versa.",
  rho:    "Change in option price per 1% move in the risk-free rate. Calls have positive rho, puts negative. Least impactful for short-dated options.",
  vanna:  "Rate of change of delta w.r.t. IV — equivalently, rate of change of vega w.r.t. underlying price.",
  charm:  "Rate of change of delta over time (delta decay). Measures how delta shifts as expiration approaches.",
  vomma:  "Rate of change of vega w.r.t. IV. High vomma means vega accelerates as volatility rises (vega convexity).",
};

// ── Greek Tooltip Label ───────────────────────────────────────────────────────
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
        fontSize: 9, color: C.accent1,
        border: "1px solid " + C.accent1, borderRadius: "50%",
        width: 13, height: 13, display: "inline-flex",
        alignItems: "center", justifyContent: "center",
        lineHeight: 1, flexShrink: 0, fontWeight: 700,
      }}>?</span>
      {show && def && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 9999,
          background: "#13151f", border: "1px solid " + C.accent1,
          borderRadius: 8, padding: "10px 14px", width: 250,
          fontSize: 11, fontFamily: "'DM Mono', monospace",
          color: C.text, lineHeight: 1.7, pointerEvents: "none",
          boxShadow: "0 4px 24px rgba(0,229,255,0.1)",
        }}>
          <div style={{ color: C.accent1, fontWeight: 700, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.1em", fontSize: 10 }}>
            {label}
          </div>
          {def}
        </div>
      )}
    </span>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────
function Panel({ title, subtitle, children, span = 1 }) {
  return (
    <div style={{
      background: C.panel, border: "1px solid " + C.border,
      borderRadius: 12, padding: "18px 20px",
      gridColumn: "span " + span, display: "flex",
      flexDirection: "column", gap: 12,
    }}>
      <div>
        <div style={{ fontSize: 11, letterSpacing: "0.12em", color: C.accent1, textTransform: "uppercase", fontFamily: "'DM Mono', monospace", marginBottom: 2 }}>
          {title}
        </div>
        {subtitle && <div style={{ fontSize: 11, color: C.textDim, fontFamily: "'DM Mono', monospace" }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

// ── Stat Badge ────────────────────────────────────────────────────────────────
function StatBadge({ label, value, color, greek }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "'DM Mono', monospace" }}>
        {greek ? <GreekLabel name={greek} label={label} /> : label}
      </span>
      <span style={{ fontSize: 22, fontWeight: 700, color: color || C.text, fontFamily: "'DM Mono', monospace", letterSpacing: "-0.02em" }}>{value}</span>
    </div>
  );
}

// ── Chart Tooltip ─────────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: "#13151f", border: "1px solid " + C.border, borderRadius: 8, padding: "10px 14px", fontSize: 11, fontFamily: "'DM Mono', monospace", color: C.text }}>
      <div style={{ color: C.accent1, marginBottom: 6 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <span style={{ color: C.text }}>{typeof p.value === "number" ? p.value.toFixed(4) : p.value}</span>
        </div>
      ))}
    </div>
  );
}



function formatTimeTick(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);

  const hours = String(dt.getHours()).padStart(2, "0");
  const minutes = String(dt.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function getNiceTimeTicks(data, maxTicks = 7) {
  if (!data.length) return [];
  if (data.length <= maxTicks) return data.map(d => d.timestamp);

  const ticks = [];
  const lastIndex = data.length - 1;
  const step = Math.max(1, Math.ceil(lastIndex / (maxTicks - 1)));

  for (let i = 0; i <= lastIndex; i += step) {
    ticks.push(data[i].timestamp);
  }

  const lastTick = data[lastIndex].timestamp;
  if (ticks[ticks.length - 1] !== lastTick) {
    ticks.push(lastTick);
  }

  return ticks;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("overview");
  const [DATA, setData] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadParquet() {
      setData([]);
      setError(null);

      let db  = null;
      let conn = null;

      try {
        // ── 1. Initialize DuckDB-WASM via jsDelivr CDN bundles ────────────────
        const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
        const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

        const workerUrl = URL.createObjectURL(
          new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
        );
        const worker = new Worker(workerUrl);
        const logger = new duckdb.ConsoleLogger();
        db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        URL.revokeObjectURL(workerUrl);

        if (cancelled) return;

        // ── 2. Connect and query ──────────────────────────────────────────────
        conn = await db.connect();

        // Data is already aggregated — no SAMPLE needed, just read it all
        const query = `
          SELECT
            timestamp,
            Side,
            current_es_price,
            spx_price,
            spx_strike,
            t,
            MBO_pulling_stacking,
            call_delta,   put_delta,
            call_gamma,   call_vega,
            call_theta,   put_theta,
            call_vanna,   call_charm,
            call_vomma,   call_rho,   put_rho,
            MBO_1,  MBO_2,  MBO_3,  MBO_4,
            MBO_5,  MBO_6,  MBO_7,  MBO_8,
            MBO_9,  MBO_10, MBO_11, MBO_12,
            MBO_13, MBO_14
          FROM read_parquet('${PARQUET_URL}')
          ORDER BY timestamp
        `;

        const result = await conn.query(query);
        if (cancelled) return;

        // ── 3. Convert Arrow result → plain JS objects ────────────────────────
        const rawRows = result.toArray().map(row => row.toJSON());
        console.log("DuckDB rows loaded:", rawRows.length);

        // ── 4. Map to dashboard field names ───────────────────────────────────
        const cleaned = rawRows
          .filter(row => row.timestamp)
          .map((row, i) => ({
            timestamp:  String(row.timestamp),
            index:      i,
            esPrice:    row.current_es_price,
            spxPrice:   row.spx_price,
            strike:     row.spx_strike,
            t:          row.t,
            side:       row.Side,
            mbo_ps:     row.MBO_pulling_stacking,
            callDelta:  row.call_delta,
            putDelta:   row.put_delta,
            gamma:      row.call_gamma,
            vega:       row.call_vega,
            callTheta:  row.call_theta,
            putTheta:   row.put_theta,
            vanna:      row.call_vanna,
            charm:      row.call_charm,
            vomma:      row.call_vomma,
            callRho:    row.call_rho,
            putRho:     row.put_rho,
            ...Object.fromEntries(
              Array.from({ length: 14 }, (_, j) => ["mbo" + (j + 1), row["MBO_" + (j + 1)]])
            ),
          }));

        console.log("Final cleaned rows:", cleaned.length);
        if (!cancelled) setData(cleaned);

      } catch (err) {
        if (cancelled) return;
        console.error("DuckDB load failed:", err);
        setError(err?.message || "Failed to load data.");
      } finally {
        try { if (conn) await conn.close();    } catch (_) {}
        try { if (db)   await db.terminate();  } catch (_) {}
      }
    }

    loadParquet();
    return () => { cancelled = true; };
  }, []);

  if (error) return (
    <div style={{ color: C.sell, padding: 40, fontFamily: "monospace", background: C.bg, minHeight: "100vh" }}>
      Failed to load data: {error}
    </div>
  );

  if (!DATA.length) return (
    <div style={{ color: C.accent1, padding: 40, fontFamily: "monospace", background: C.bg, minHeight: "100vh" }}>
      Loading data…
    </div>
  );

  const latest = DATA[DATA.length - 1];
  const tabs = ["overview", "greeks", "microstructure", "order book"];

  const mboHeatData = Array.from({ length: 14 }, (_, i) => ({
    level: "L" + (i + 1),
    value: latest["mbo" + (i + 1)],
  }));


  const stackCount = DATA.filter(d => d.mbo_ps > 0).length;
  const pullCount  = DATA.length - stackCount;
  const timeTicks = getNiceTimeTicks(DATA, 7);

  const timeAxisProps = {
    dataKey: "timestamp",
    ticks: timeTicks,
    tickFormatter: formatTimeTick,
    interval: 0,
    minTickGap: 24,
    tickMargin: 8,
    tick: { fill: C.textDim, fontSize: 9 },
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'DM Mono', 'Courier New', monospace", padding: "24px 28px", boxSizing: "border-box" }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 16 }}>
        <div>
          <div style={{ fontSize: 9, letterSpacing: "0.25em", color: C.accent1, textTransform: "uppercase", marginBottom: 4 }}>
            SPX / ES Options Analytics
          </div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: "#fff", letterSpacing: "-0.03em" }}>
            S&P 500 Derivative
          </h1>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>
            {latest.timestamp} · T = {latest.t} · {DATA.length} observations
          </div>
        </div>

        <div style={{ display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
          <StatBadge label="ES Price"   value={latest.esPrice?.toFixed(1)}   color={C.accent1} />
          <StatBadge label="SPX Price"  value={latest.spxPrice?.toFixed(1)}  color={C.accent4} />
          <StatBadge label="Call Delta" value={latest.callDelta?.toFixed(3)} color={C.accent3} greek="delta" />
          <StatBadge label="Gamma"      value={latest.gamma?.toFixed(5)}     color={C.accent5} greek="gamma" />
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid " + C.border }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            background: activeTab === t ? C.accent1 : "transparent",
            color: activeTab === t ? C.bg : C.textDim,
            border: "none", borderRadius: "6px 6px 0 0",
            padding: "7px 18px", fontSize: 10, letterSpacing: "0.1em",
            textTransform: "uppercase", cursor: "pointer",
            fontFamily: "'DM Mono', monospace",
            fontWeight: activeTab === t ? 700 : 400,
          }}>{t}</button>
        ))}
      </div>

      {/* ── OVERVIEW TAB ── */}
      {activeTab === "overview" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>

          <Panel title="Underlying Price" subtitle="ES vs SPX intraday" span={2}>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis {...timeAxisProps} />
                <YAxis domain={["auto", "auto"]} tick={{ fill: C.textDim, fontSize: 9 }} width={55} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10, color: C.textDim }} />
                <Line type="monotone" dataKey="esPrice"  stroke={C.accent1} dot={false} strokeWidth={2} name="ES Price" />
                <Line type="monotone" dataKey="spxPrice" stroke={C.accent4} dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="SPX Price" />
                <ReferenceLine y={5250} stroke={C.muted} strokeDasharray="6 3" label={{ value: "Strike", fill: C.muted, fontSize: 9 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>


          <Panel title={<GreekLabel name="delta" label="Delta Evolution" />} subtitle="Call & Put delta vs time" span={2}>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis {...timeAxisProps} />
                <YAxis domain={[-1, 1]} tick={{ fill: C.textDim, fontSize: 9 }} width={40} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine y={0} stroke={C.muted} />
                <Area type="monotone" dataKey="callDelta" stroke={C.accent1} fill={C.accent1} fillOpacity={0.08} dot={false} strokeWidth={2} name="Call Delta" />
                <Area type="monotone" dataKey="putDelta"  stroke={C.accent2} fill={C.accent2} fillOpacity={0.08} dot={false} strokeWidth={2} name="Put Delta" />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title="MBO Signal" subtitle="Stacking vs Pulling">
            <div style={{ display: "flex", flexDirection: "column", gap: 16, justifyContent: "center", flex: 1 }}>
              <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                <StatBadge label="Stacking" value={stackCount} color={C.buy} />
                <StatBadge label="Pulling"  value={pullCount}  color={C.sell} />
              </div>
              <div style={{ background: C.border, borderRadius: 6, height: 8, overflow: "hidden" }}>
                <div style={{ height: "100%", width: ((stackCount / DATA.length) * 100) + "%", background: "linear-gradient(90deg, " + C.buy + ", " + C.accent1 + ")", borderRadius: 6 }} />
              </div>
              <div style={{ fontSize: 10, color: C.textDim }}>
                {((stackCount / DATA.length) * 100).toFixed(0)}% stacking bias
              </div>
            </div>
          </Panel>
        </div>
      )}

      {/* ── GREEKS TAB ── */}
      {activeTab === "greeks" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>

          <Panel
            title={
              <span style={{ display: "inline-flex", gap: 16, alignItems: "center" }}>
                <GreekLabel name="gamma" label="Gamma" />
                <span style={{ color: C.muted }}>&amp;</span>
                <GreekLabel name="vega"  label="Vega" />
              </span>
            }
            subtitle="Convexity measures over time"
            span={2}
          >
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis {...timeAxisProps} />
                <YAxis yAxisId="l" tick={{ fill: C.textDim, fontSize: 9 }} width={60} />
                <YAxis yAxisId="r" orientation="right" tick={{ fill: C.textDim, fontSize: 9 }} width={50} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar  yAxisId="r" dataKey="vega"  fill={C.accent3} opacity={0.4} name="Vega" />
                <Line yAxisId="l" type="monotone" dataKey="gamma" stroke={C.accent4} dot={false} strokeWidth={2} name="Gamma" />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="vanna" label="Vanna" />} subtitle="Rate of change of delta w.r.t. IV">
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis {...timeAxisProps} />
                <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={55} />
                <ReferenceLine y={0} stroke={C.muted} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="vanna" stroke={C.accent5} fill={C.accent5} fillOpacity={0.15} dot={false} strokeWidth={2} name="Vanna" />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="charm" label="Charm" />} subtitle="Delta decay over time">
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis {...timeAxisProps} />
                <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={55} />
                <ReferenceLine y={0} stroke={C.muted} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="charm" stroke="#ec4899" fill="#ec4899" fillOpacity={0.15} dot={false} strokeWidth={2} name="Charm" />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="theta" label="Theta" />} subtitle="Time decay — calls vs puts">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis {...timeAxisProps} />
                <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={55} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="callTheta" stroke={C.sell}    dot={false} strokeWidth={2} name="Call Theta" />
                <Line type="monotone" dataKey="putTheta"  stroke={C.accent5} dot={false} strokeWidth={2} strokeDasharray="4 2" name="Put Theta" />
              </LineChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="vomma" label="Vomma" />} subtitle="Vega convexity (d2P/dσ2)">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis {...timeAxisProps} />
                <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={55} />
                <ReferenceLine y={0} stroke={C.muted} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="vomma" name="Vomma">
                  {DATA.map((d, i) => <Cell key={i} fill={d.vomma >= 0 ? C.accent4 : C.sell} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="rho" label="Rho" />} subtitle="Interest rate sensitivity — calls vs puts">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis {...timeAxisProps} />
                <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={55} />
                <ReferenceLine y={0} stroke={C.muted} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="callRho" stroke={C.accent1} dot={false} strokeWidth={2} name="Call Rho" />
                <Line type="monotone" dataKey="putRho"  stroke={C.accent2} dot={false} strokeWidth={2} strokeDasharray="4 2" name="Put Rho" />
              </LineChart>
            </ResponsiveContainer>
          </Panel>
        </div>
      )}

      {/* ── MICROSTRUCTURE TAB ── */}
      {activeTab === "microstructure" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>

          <Panel title="Stacking / Pulling Signal" subtitle="MBO order flow over time (+1 stack, -1 pull)" span={3}>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis {...timeAxisProps} />
                <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={30} />
                <ReferenceLine y={0} stroke={C.muted} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="mbo_ps" name="Stack / Pull">
                  {DATA.map((d, i) => <Cell key={i} fill={d.mbo_ps > 0 ? C.buy : C.sell} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={<GreekLabel name="delta" label="Delta vs MBO Signal" />} subtitle="Call delta colored by stack/pull" span={2}>
            <ResponsiveContainer width="100%" height={200}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis
                  type="number"
                  dataKey="esPrice"
                  name="ES Price"
                  tick={{ fill: C.textDim, fontSize: 9 }}
                  tickCount={6}
                  minTickGap={28}
                  domain={["dataMin", "dataMax"]}
                  label={{ value: "ES Price", fill: C.textDim, fontSize: 9, position: "insideBottom", offset: -4 }}
                />
                <YAxis dataKey="callDelta" name="Call Delta" tick={{ fill: C.textDim, fontSize: 9 }} width={45} />
                <Tooltip cursor={{ stroke: C.muted }} content={<CustomTooltip />} />
                <Scatter data={DATA} name="Observations">
                  {DATA.map((d, i) => <Cell key={i} fill={d.mbo_ps > 0 ? C.buy : C.sell} opacity={0.8} />)}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 16, fontSize: 10, color: C.textDim }}>
              <span style={{ color: C.buy }}>● Stacking</span>
              <span style={{ color: C.sell }}>● Pulling</span>
            </div>
          </Panel>

          <Panel title="Trade Side Distribution" subtitle="Buy vs Sell observations">
            <div style={{ display: "flex", flexDirection: "column", gap: 14, justifyContent: "center", flex: 1 }}>
              {["BUY", "SELL"].map(side => {
                const count = DATA.filter(d => d.side === side).length;
                const pct = (count / DATA.length) * 100;
                return (
                  <div key={side}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: side === "BUY" ? C.buy : C.sell }}>{side}</span>
                      <span style={{ color: C.text }}>{count} ({pct.toFixed(0)}%)</span>
                    </div>
                    <div style={{ background: C.border, borderRadius: 4, height: 6 }}>
                      <div style={{ height: "100%", width: pct + "%", background: side === "BUY" ? C.buy : C.sell, borderRadius: 4 }} />
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 8, fontSize: 10, color: C.textDim }}>
                <GreekLabel name="gamma" label="Gamma" /> at latest: <span style={{ color: C.accent4 }}>{latest.gamma?.toFixed(5)}</span>
              </div>
              <div style={{ fontSize: 10, color: C.textDim }}>
                <GreekLabel name="vega" label="Vega" /> at latest: <span style={{ color: C.accent3 }}>{latest.vega?.toFixed(3)}</span>
              </div>
            </div>
          </Panel>
        </div>
      )}

      {/* ── ORDER BOOK TAB ── */}
      {activeTab === "order book" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>

          <Panel title="MBO Level Snapshot" subtitle="Signed order quantity by book level (latest)" span={2}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={mboHeatData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                <XAxis type="number" tick={{ fill: C.textDim, fontSize: 9 }} />
                <YAxis dataKey="level" type="category" tick={{ fill: C.textDim, fontSize: 10 }} width={30} />
                <ReferenceLine x={0} stroke={C.muted} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="value" name="Order Size">
                  {mboHeatData.map((d, i) => (
                    <Cell key={i} fill={d.value >= 0 ? C.accent1 : C.accent2} opacity={0.75 + Math.abs(d.value) / 600 * 0.25} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          {[["mbo1", "mbo2"], ["mbo3", "mbo4"]].map(([a, b], idx) => (
            <Panel key={idx} title={"Book Levels " + a.toUpperCase() + " & " + b.toUpperCase()} subtitle="Signed order flow over time">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={DATA}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis {...timeAxisProps} />
                  <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={45} />
                  <ReferenceLine y={0} stroke={C.muted} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Line type="monotone" dataKey={a} stroke={C.accent1} dot={false} strokeWidth={1.5} name={a.toUpperCase()} />
                  <Line type="monotone" dataKey={b} stroke={C.accent2} dot={false} strokeWidth={1.5} name={b.toUpperCase()} />
                </LineChart>
              </ResponsiveContainer>
            </Panel>
          ))}
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: 20, fontSize: 9, color: C.textDim, textAlign: "right", letterSpacing: "0.08em" }}>
        SPX OPTIONS ANALYTICS · DATA PROVIDED BY DR. MOREHEAD
      </div>
    </div>
  );
}