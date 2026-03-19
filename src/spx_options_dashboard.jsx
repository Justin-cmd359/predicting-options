import { useState, useEffect } from "react";
import Papa from "papaparse";
import {
  LineChart, Line, BarChart, Bar, RadarChart, Radar,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ScatterChart, Scatter, Cell,
  ReferenceLine, Area, AreaChart, ComposedChart
} from "recharts";

// ── CSV Data URL ──────────────────────────────────────────────────────────────
// Replace this with your Cloudflare R2 public URL after uploading fixed_output.csv
const CSV_URL = "https://pub-73edacec404b41a29ac6cf15672e387f.r2.dev/fixed_output.csv";

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  bg: "#07080f",
  panel: "#0e1019",
  border: "#1c1f2e",
  accent1: "#00e5ff",   // cyan
  accent2: "#ff6b35",   // orange
  accent3: "#a78bfa",   // violet
  accent4: "#34d399",   // emerald
  accent5: "#f59e0b",   // amber
  muted: "#4b5263",
  text: "#c8cfe0",
  textDim: "#5a6070",
  buy: "#34d399",
  sell: "#f87171",
};

const GREEK_COLORS = {
  callDelta: C.accent1,
  putDelta: C.accent2,
  gamma: C.accent4,
  vega: C.accent3,
  callTheta: C.sell,
  vanna: C.accent5,
  charm: "#ec4899",
  vomma: "#818cf8",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function Panel({ title, subtitle, children, span = 1 }) {
  return (
    <div style={{
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: "18px 20px",
      gridColumn: `span ${span}`,
      display: "flex",
      flexDirection: "column",
      gap: 12,
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

function StatBadge({ label, value, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "'DM Mono', monospace" }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color: color || C.text, fontFamily: "'DM Mono', monospace", letterSpacing: "-0.02em" }}>{value}</span>
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#13151f", border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 11, fontFamily: "'DM Mono', monospace", color: C.text }}>
      <div style={{ color: C.accent1, marginBottom: 6 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <span style={{ color: C.text }}>{typeof p.value === "number" ? p.value.toFixed(4) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("overview");
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const [DATA, setData] = useState([]);
  const [error, setError] = useState(null);

  // useEffect(() => {
  //   Papa.parse(CSV_URL, {
  //     header: true,
  //     dynamicTyping: true,
  //     download: true,
  //     complete: (results) => {
  //       const cleaned = results.data
  //         .filter(row => row.timestamp)
  //         .map((row, i) => ({
  //           timestamp: row.timestamp,
  //           index: i,
  //           esPrice: row.current_es_price,
  //           spxPrice: row.spx_price,
  //           strike: row.spx_strike,
  //           t: row.t,
  //           side: row.Side,
  //           mbo_ps: row.MBO_pulling_stacking,
  //           callDelta: row.call_delta,
  //           putDelta: row.put_delta,
  //           gamma: row.call_gamma,
  //           vega: row.call_vega,
  //           callTheta: row.call_theta,
  //           putTheta: row.put_theta,
  //           vanna: row.call_vanna,
  //           charm: row.call_charm,
  //           vomma: row.call_vomma,
  //           callRho: row.call_rho,
  //           putRho: row.put_rho,
  //           ...Object.fromEntries(
  //             Array.from({ length: 14 }, (_, j) => [`mbo${j + 1}`, row[`MBO_${j + 1}`]])
  //           ),
  //         }));
  //         // Sample down to 1000 evenly-spaced rows for rendering
  //       const step = Math.max(1, Math.floor(cleaned.length / 1000));
  //       const sampled = cleaned.filter((_, i) => i % step === 0);
  //       setData(sampled);
  //       // setData(cleaned);
  //     },
  //     error: (err) => setError(err.message),
  //   });
  // }, []);
  const [sampleSize, setSampleSize] = useState(5000);
  useEffect(() => {
  const SAMPLE_SIZE = 5000; // adjust this number as needed
  const sampled = [];
  let totalRows = 0;

  Papa.parse(CSV_URL, {
    header: true,
    dynamicTyping: true,
    download: true,
    step: (row) => {
      totalRows++;
      // Reservoir sampling - gives even distribution across full dataset
      if (sampled.length < SAMPLE_SIZE) {
        sampled.push(row.data);
      } else {
        const j = Math.floor(Math.random() * totalRows);
        if (j < SAMPLE_SIZE) {
          sampled[j] = row.data;
        }
      }
    },
    complete: () => {
      const cleaned = sampled
        .filter(row => row.timestamp)
        .map((row, i) => ({
          timestamp: row.timestamp,
          index: i,
          esPrice: row.current_es_price,
          spxPrice: row.spx_price,
          strike: row.spx_strike,
          t: row.t,
          side: row.Side,
          mbo_ps: row.MBO_pulling_stacking,
          callDelta: row.call_delta,
          putDelta: row.put_delta,
          gamma: row.call_gamma,
          vega: row.call_vega,
          callTheta: row.call_theta,
          putTheta: row.put_theta,
          vanna: row.call_vanna,
          charm: row.call_charm,
          vomma: row.call_vomma,
          callRho: row.call_rho,
          putRho: row.put_rho,
          ...Object.fromEntries(
            Array.from({ length: 14 }, (_, j) => [`mbo${j + 1}`, row[`MBO_${j + 1}`]])
          ),
        }));
      // Sort by timestamp to maintain time order after reservoir sampling
      cleaned.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      setData(cleaned);
    },
    error: (err) => setError(err.message),
  });
  }, []);
  if (error) return (
    <div style={{ color: C.sell, padding: 40, fontFamily: "monospace" }}>
      ✕ Failed to load data: {error}
    </div>
  );

  if (!DATA.length) return (
    <div style={{ color: C.accent1, padding: 40, fontFamily: "monospace", background: C.bg, minHeight: "100vh" }}>
      ◈ Loading data...
    </div>
  );

  const latest = DATA[DATA.length - 1];

  const tabs = ["overview", "greeks", "microstructure", "order book"];

  // MBO heatmap data — last observation
  const mboHeatData = Array.from({ length: 14 }, (_, i) => ({
    level: `L${i + 1}`,
    value: latest[`mbo${i + 1}`],
  }));

  // Greeks radar for latest
  const radarData = [
    { greek: "Δ Call", value: Math.abs(latest.callDelta) * 100 },
    { greek: "Δ Put", value: Math.abs(latest.putDelta) * 100 },
    { greek: "Γ ×1k", value: latest.gamma * 1000 },
    { greek: "Vega/10", value: Math.abs(latest.vega) / 10 },
    { greek: "Vanna×k", value: Math.abs(latest.vanna) * 1000 },
    { greek: "Charm×k", value: Math.abs(latest.charm) * 1000 },
    { greek: "Vomma", value: Math.abs(latest.vomma) },
  ];

  // stacking/pulling distribution
  const stackCount = DATA.filter(d => d.mbo_ps > 0).length;
  const pullCount = DATA.length - stackCount;

  return (
    <div style={{
      minHeight: "100vh",
      background: C.bg,
      color: C.text,
      fontFamily: "'DM Mono', 'Courier New', monospace",
      padding: "24px 28px",
      boxSizing: "border-box",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 9, letterSpacing: "0.25em", color: C.accent1, textTransform: "uppercase", marginBottom: 4 }}>
            ◈ SPX / ES Options Analytics
          </div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: "#fff", letterSpacing: "-0.03em" }}>
            S&P 500 Derivative
          </h1>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>
            {latest.timestamp} · T = {latest.t} · {DATA.length} observations
          </div>
        </div>
        <div style={{ display: "flex", gap: 20 }}>
          <StatBadge label="ES Price" value={latest.esPrice.toFixed(1)} color={C.accent1} />
          <StatBadge label="SPX Price" value={latest.spxPrice.toFixed(1)} color={C.accent4} />
          <StatBadge label="Δ Call" value={latest.callDelta.toFixed(3)} color={C.accent3} />
          <StatBadge label="Γ" value={latest.gamma.toFixed(5)} color={C.accent5} />
        </div>
        <select
          value={sampleSize}
          onChange={(e) => setSampleSize(Number(e.target.value))}
          style={{
            background: C.panel,
            color: C.text,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 11,
            fontFamily: "'DM Mono', monospace",
            cursor: "pointer",
          }}
        >
          <option value={1000}>1,000 rows</option>
          <option value={5000}>5,000 rows</option>
          <option value={10000}>10,000 rows</option>
          <option value={50000}>50,000 rows</option>
        </select>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: `1px solid ${C.border}`, paddingBottom: 0 }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            background: activeTab === t ? C.accent1 : "transparent",
            color: activeTab === t ? C.bg : C.textDim,
            border: "none",
            borderRadius: "6px 6px 0 0",
            padding: "7px 18px",
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: "'DM Mono', monospace",
            fontWeight: activeTab === t ? 700 : 400,
            transition: "all 0.15s",
          }}>{t}</button>
        ))}
      </div>

      {/* ── OVERVIEW TAB ── */}
      {activeTab === "overview" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>

          {/* Price over time */}
          <Panel title="Underlying Price" subtitle="ES vs SPX intraday" span={2}>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="timestamp" tick={{ fill: C.textDim, fontSize: 9 }} interval={7} />
                <YAxis domain={["auto", "auto"]} tick={{ fill: C.textDim, fontSize: 9 }} width={55} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10, color: C.textDim }} />
                <Line type="monotone" dataKey="esPrice" stroke={C.accent1} dot={false} strokeWidth={2} name="ES Price" />
                <Line type="monotone" dataKey="spxPrice" stroke={C.accent4} dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="SPX Price" />
                <ReferenceLine y={5250} stroke={C.muted} strokeDasharray="6 3" label={{ value: "Strike", fill: C.muted, fontSize: 9 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>

          {/* Greeks Radar */}
          <Panel title="Greeks Snapshot" subtitle="Latest observation">
            <ResponsiveContainer width="100%" height={200}>
              <RadarChart data={radarData}>
                <PolarGrid stroke={C.border} />
                <PolarAngleAxis dataKey="greek" tick={{ fill: C.textDim, fontSize: 9 }} />
                <PolarRadiusAxis tick={{ fill: C.textDim, fontSize: 8 }} />
                <Radar dataKey="value" stroke={C.accent1} fill={C.accent1} fillOpacity={0.15} strokeWidth={2} />
              </RadarChart>
            </ResponsiveContainer>
          </Panel>

          {/* Delta over time */}
          <Panel title="Delta Evolution" subtitle="Call & Put delta vs time" span={2}>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="timestamp" tick={{ fill: C.textDim, fontSize: 9 }} interval={7} />
                <YAxis domain={[-1, 1]} tick={{ fill: C.textDim, fontSize: 9 }} width={40} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine y={0} stroke={C.muted} />
                <Area type="monotone" dataKey="callDelta" stroke={C.accent1} fill={C.accent1} fillOpacity={0.08} dot={false} strokeWidth={2} name="Call Δ" />
                <Area type="monotone" dataKey="putDelta" stroke={C.accent2} fill={C.accent2} fillOpacity={0.08} dot={false} strokeWidth={2} name="Put Δ" />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          {/* Stack/Pull summary */}
          <Panel title="MBO Signal" subtitle="Stacking vs Pulling">
            <div style={{ display: "flex", flexDirection: "column", gap: 16, justifyContent: "center", flex: 1 }}>
              <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                <StatBadge label="Stacking" value={stackCount} color={C.buy} />
                <StatBadge label="Pulling" value={pullCount} color={C.sell} />
              </div>
              <div style={{ background: C.border, borderRadius: 6, height: 8, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(stackCount / DATA.length) * 100}%`, background: `linear-gradient(90deg, ${C.buy}, ${C.accent1})`, borderRadius: 6, transition: "width 0.5s" }} />
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

          <Panel title="Gamma & Vega" subtitle="Convexity measures over time" span={2}>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="timestamp" tick={{ fill: C.textDim, fontSize: 9 }} interval={7} />
                <YAxis yAxisId="l" tick={{ fill: C.textDim, fontSize: 9 }} width={60} />
                <YAxis yAxisId="r" orientation="right" tick={{ fill: C.textDim, fontSize: 9 }} width={50} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar yAxisId="r" dataKey="vega" fill={C.accent3} opacity={0.4} name="Vega" />
                <Line yAxisId="l" type="monotone" dataKey="gamma" stroke={C.accent4} dot={false} strokeWidth={2} name="Gamma" />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title="Vanna" subtitle="Delta sensitivity to IV">
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="timestamp" tick={{ fill: C.textDim, fontSize: 9 }} interval={7} />
                <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={55} />
                <ReferenceLine y={0} stroke={C.muted} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="vanna" stroke={C.accent5} fill={C.accent5} fillOpacity={0.15} dot={false} strokeWidth={2} name="Vanna" />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title="Charm" subtitle="Delta decay over time">
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="timestamp" tick={{ fill: C.textDim, fontSize: 9 }} interval={7} />
                <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={55} />
                <ReferenceLine y={0} stroke={C.muted} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="charm" stroke="#ec4899" fill="#ec4899" fillOpacity={0.15} dot={false} strokeWidth={2} name="Charm" />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title="Theta" subtitle="Time decay — calls vs puts">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="timestamp" tick={{ fill: C.textDim, fontSize: 9 }} interval={7} />
                <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={55} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="callTheta" stroke={C.sell} dot={false} strokeWidth={2} name="Call θ" />
                <Line type="monotone" dataKey="putTheta" stroke={C.accent5} dot={false} strokeWidth={2} strokeDasharray="4 2" name="Put θ" />
              </LineChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title="Vomma" subtitle="Vega convexity (d²P/dσ²)">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="timestamp" tick={{ fill: C.textDim, fontSize: 9 }} interval={7} />
                <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={55} />
                <ReferenceLine y={0} stroke={C.muted} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="vomma" name="Vomma">
                  {DATA.map((d, i) => <Cell key={i} fill={d.vomma >= 0 ? C.accent4 : C.sell} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        </div>
      )}

      {/* ── MICROSTRUCTURE TAB ── */}
      {activeTab === "microstructure" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>

          <Panel title="Stacking / Pulling Signal" subtitle="MBO order flow over time" span={3}>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="timestamp" tick={{ fill: C.textDim, fontSize: 9 }} interval={7} />
                <YAxis tick={{ fill: C.textDim, fontSize: 9 }} width={30} />
                <ReferenceLine y={0} stroke={C.muted} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="mbo_ps" name="Stack(+1) / Pull(-1)">
                  {DATA.map((d, i) => <Cell key={i} fill={d.mbo_ps > 0 ? C.buy : C.sell} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          {/* Delta vs MBO signal scatter */}
          <Panel title="Delta vs MBO Signal" subtitle="Call delta colored by stack/pull" span={2}>
            <ResponsiveContainer width="100%" height={200}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="esPrice" name="ES Price" tick={{ fill: C.textDim, fontSize: 9 }} label={{ value: "ES Price", fill: C.textDim, fontSize: 9, position: "insideBottom", offset: -4 }} />
                <YAxis dataKey="callDelta" name="Call Delta" tick={{ fill: C.textDim, fontSize: 9 }} width={45} />
                <Tooltip cursor={{ stroke: C.muted }} content={<CustomTooltip />} />
                <Scatter data={DATA} name="Observations">
                  {DATA.map((d, i) => (
                    <Cell key={i} fill={d.mbo_ps > 0 ? C.buy : C.sell} opacity={0.8} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 16, fontSize: 10, color: C.textDim }}>
              <span style={{ color: C.buy }}>● Stacking</span>
              <span style={{ color: C.sell }}>● Pulling</span>
            </div>
          </Panel>

          {/* Side distribution */}
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
                      <div style={{ height: "100%", width: `${pct}%`, background: side === "BUY" ? C.buy : C.sell, borderRadius: 4 }} />
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 8, fontSize: 10, color: C.textDim }}>
                Gamma at latest: <span style={{ color: C.accent4 }}>{latest.gamma.toFixed(5)}</span>
              </div>
              <div style={{ fontSize: 10, color: C.textDim }}>
                Vega at latest: <span style={{ color: C.accent3 }}>{latest.vega.toFixed(3)}</span>
              </div>
            </div>
          </Panel>
        </div>
      )}

      {/* ── ORDER BOOK TAB ── */}
      {activeTab === "order book" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>

          <Panel title="MBO Level Snapshot" subtitle="Order quantity by book level (latest)" span={2}>
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

          {/* MBO levels over time - select top 4 */}
          {[["mbo1", "mbo2"], ["mbo3", "mbo4"]].map(([a, b], idx) => (
            <Panel key={idx} title={`Book Levels ${a.toUpperCase()} & ${b.toUpperCase()}`} subtitle="Signed order flow over time">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={DATA}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="timestamp" tick={{ fill: C.textDim, fontSize: 9 }} interval={7} />
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