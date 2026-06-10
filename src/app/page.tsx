"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface BLEService {
  uuid: string;
  characteristics: BLECharacteristic[];
}

interface BLECharacteristic {
  uuid: string;
  properties: string[];
}

interface ScannedDevice {
  device: BluetoothDevice;
  rssi: number | null;
  services: string[];
}

interface SensorData {
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
  ts: number;
}

type ConnectionState = "idle" | "scanning" | "connecting" | "connected" | "error";

// ── Mini sparkline chart ───────────────────────────────────────────────────────

interface SparklineProps {
  data: number[];
  color: string;
  label: string;
  value: number;
  unit?: string;
}

function Sparkline({ data, color, label, value, unit = "" }: SparklineProps) {
  const width = 180;
  const height = 52;
  const pad = 4;

  const min = Math.min(...data, -1);
  const max = Math.max(...data, 1);
  const range = max - min || 1;

  const pts = data
    .map((v, i) => {
      const x = pad + (i / Math.max(data.length - 1, 1)) * (width - pad * 2);
      const y = pad + (1 - (v - min) / range) * (height - pad * 2);
      return `${x},${y}`;
    })
    .join(" ");

  const zeroY = pad + (1 - (0 - min) / range) * (height - pad * 2);

  return (
    <div
      style={{
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        padding: "12px 14px 8px",
        minWidth: 200,
        flex: "1 1 180px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontFamily: "monospace", color: "rgba(255,255,255,0.45)", letterSpacing: "0.08em" }}>
          {label}
        </span>
        <span style={{ fontSize: 18, fontWeight: 700, color, fontFamily: "monospace" }}>
          {value.toFixed(3)}
          <span style={{ fontSize: 10, fontWeight: 400, color: "rgba(255,255,255,0.4)", marginLeft: 2 }}>{unit}</span>
        </span>
      </div>
      <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
        {/* zero line */}
        {zeroY > pad && zeroY < height - pad && (
          <line x1={pad} y1={zeroY} x2={width - pad} y2={zeroY} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
        )}
        {data.length > 1 && (
          <>
            {/* glow fill */}
            <polyline
              points={`${pad},${height - pad} ${pts} ${width - pad},${height - pad}`}
              fill={color}
              fillOpacity={0.07}
              stroke="none"
            />
            {/* line */}
            <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {/* dot */}
            {(() => {
              const last = pts.split(" ").pop()!;
              const [lx, ly] = last.split(",").map(Number);
              return <circle cx={lx} cy={ly} r={3} fill={color} />;
            })()}
          </>
        )}
      </svg>
    </div>
  );
}

// ── History buffer hook ────────────────────────────────────────────────────────

function useHistory(maxLen = 80) {
  const [history, setHistory] = useState<SensorData[]>([]);
  const push = useCallback((d: SensorData) => {
    setHistory((prev) => [...prev.slice(-(maxLen - 1)), d]);
  }, [maxLen]);
  return { history, push };
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BLEMonitor() {
  const [state, setState] = useState<ConnectionState>("idle");
  const [scanned, setScanned] = useState<ScannedDevice[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<BluetoothDevice | null>(null);
  const [services, setServices] = useState<BLEService[]>([]);
  const [latest, setLatest] = useState<SensorData | null>(null);
  const [rawLog, setRawLog] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [selectedTab, setSelectedTab] = useState<"accel" | "gyro">("accel");
  const [notifyChar, setNotifyChar] = useState<BluetoothRemoteGATTCharacteristic | null>(null);

  const { history, push } = useHistory(80);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rawLog]);

  const supported = typeof navigator !== "undefined" && "bluetooth" in navigator;

  // ── Scan ──────────────────────────────────────────────────────────────────

  const handleScan = async () => {
    if (!supported) {
      setErrorMsg("Web Bluetooth API is not supported in this browser.");
      setState("error");
      return;
    }
    setState("scanning");
    setErrorMsg("");
    setScanned([]);
    try {
      const device = await (navigator as any).bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ["generic_access", "generic_attribute", "battery_service"],
      });
      const entry: ScannedDevice = {
        device,
        rssi: null,
        services: device.uuids ?? [],
      };
      setScanned([entry]);
      setState("idle");
    } catch (e: any) {
      if (e?.name === "NotFoundError") {
        setState("idle");
      } else {
        setErrorMsg(e?.message ?? "Unknown error");
        setState("error");
      }
    }
  };

  // ── Connect & discover ────────────────────────────────────────────────────

  const handleConnect = async (entry: ScannedDevice) => {
    setState("connecting");
    setErrorMsg("");
    setServices([]);
    try {
      const server = await entry.device.gatt!.connect();
      setConnectedDevice(entry.device);

      const srvList = await server.getPrimaryServices();
      const parsed: BLEService[] = [];
      for (const srv of srvList) {
        const chars = await srv.getCharacteristics();
        const cList: BLECharacteristic[] = chars.map((c) => ({
          uuid: c.uuid,
          properties: Object.keys(c.properties).filter(
            (k) => (c.properties as any)[k] === true
          ),
        }));
        parsed.push({ uuid: srv.uuid, characteristics: cList });
      }
      setServices(parsed);
      setState("connected");
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Connection failed");
      setState("error");
    }
  };

  // ── Start notify ──────────────────────────────────────────────────────────

  const handleStartNotify = async (serviceUUID: string, charUUID: string) => {
    if (!connectedDevice?.gatt?.connected) return;
    try {
      const server = connectedDevice.gatt!;
      const srv = await server.getPrimaryService(serviceUUID);
      const char = await srv.getCharacteristic(charUUID);
      await char.startNotifications();
      setNotifyChar(char);
      char.addEventListener("characteristicvaluechanged", (e: any) => {
        const val: DataView = e.target.value;
        const text = new TextDecoder().decode(val);
        addLog(text);
        try {
          const json = JSON.parse(text) as Omit<SensorData, "ts">;
          const point: SensorData = { ...json, ts: Date.now() };
          setLatest(point);
          push(point);
        } catch {
          /* non-JSON payload */
        }
      });
    } catch (e: any) {
      setErrorMsg("Notify failed: " + (e?.message ?? ""));
    }
  };

  const handleStopNotify = async () => {
    if (!notifyChar) return;
    try {
      await notifyChar.stopNotifications();
    } catch { /* ignore */ }
    setNotifyChar(null);
  };

  const handleDisconnect = () => {
    handleStopNotify();
    connectedDevice?.gatt?.disconnect();
    setConnectedDevice(null);
    setServices([]);
    setLatest(null);
    setState("idle");
  };

  const addLog = (msg: string) =>
    setRawLog((prev) => [...prev.slice(-199), `[${new Date().toLocaleTimeString()}] ${msg}`]);

  // ── Derived chart data ────────────────────────────────────────────────────

  const field = (key: keyof SensorData) => history.map((h) => h[key] as number);

  // ── Status badge ──────────────────────────────────────────────────────────

  const statusColor: Record<ConnectionState, string> = {
    idle: "#6b7280",
    scanning: "#f59e0b",
    connecting: "#3b82f6",
    connected: "#22c55e",
    error: "#ef4444",
  };

  const statusLabel: Record<ConnectionState, string> = {
    idle: "Idle",
    scanning: "Scanning…",
    connecting: "Connecting…",
    connected: "Connected",
    error: "Error",
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0c10",
        color: "#e2e8f0",
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
        padding: "0 0 60px",
      }}
    >
      {/* ── Header ─────────────────────────────────────────────── */}
      <header
        style={{
          background: "rgba(255,255,255,0.03)",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          padding: "18px 28px",
          display: "flex",
          alignItems: "center",
          gap: 14,
          position: "sticky",
          top: 0,
          zIndex: 100,
          backdropFilter: "blur(12px)",
        }}
      >
        {/* BLE icon */}
        <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5" />
        </svg>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.02em", color: "#f1f5f9" }}>
            BLE Monitor
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 1 }}>
            Web Bluetooth · IMU Real-time Dashboard
          </div>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              fontWeight: 500,
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 20,
              padding: "4px 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: statusColor[state],
                boxShadow: state === "connected" ? `0 0 6px ${statusColor.connected}` : "none",
              }}
            />
            {statusLabel[state]}
          </span>

          {state === "connected" && (
            <button onClick={handleDisconnect} style={btnStyle("#ef4444", "rgba(239,68,68,0.12)")}>
              Disconnect
            </button>
          )}
        </div>
      </header>

      <main style={{ maxWidth: 980, margin: "0 auto", padding: "28px 20px 0" }}>

        {/* ── Error banner ──────────────────────────────────────── */}
        {state === "error" && errorMsg && (
          <div
            style={{
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 10,
              padding: "12px 16px",
              marginBottom: 20,
              fontSize: 13,
              color: "#fca5a5",
            }}
          >
            ⚠ {errorMsg}
          </div>
        )}

        {!supported && (
          <div
            style={{
              background: "rgba(245,158,11,0.1)",
              border: "1px solid rgba(245,158,11,0.3)",
              borderRadius: 10,
              padding: "12px 16px",
              marginBottom: 20,
              fontSize: 13,
              color: "#fcd34d",
            }}
          >
            Web Bluetooth is not supported in this browser. Use Chrome / Edge on desktop or Android.
          </div>
        )}

        {/* ── Scan section ──────────────────────────────────────── */}
        <section style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={sectionTitle}>Nearby Devices</h2>
            <button
              onClick={handleScan}
              disabled={state === "scanning" || state === "connecting" || !supported}
              style={btnStyle("#818cf8", "rgba(129,140,248,0.12)")}
            >
              {state === "scanning" ? (
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <SpinnerIcon /> Scanning…
                </span>
              ) : (
                "Scan for Devices"
              )}
            </button>
          </div>

          {scanned.length === 0 ? (
            <div style={emptyHint}>Press Scan to discover BLE devices around you.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {scanned.map((entry, i) => (
                <div key={i} style={deviceRowStyle(connectedDevice?.id === entry.device.id)}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: "#f1f5f9" }}>
                      {entry.device.name ?? "Unknown Device"}
                    </div>
                    <div style={{ fontSize: 11, fontFamily: "monospace", color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
                      ID: {entry.device.id}
                    </div>
                    {entry.services.length > 0 && (
                      <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {entry.services.map((s) => (
                          <span key={s} style={uuidBadge}>{s}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {connectedDevice?.id !== entry.device.id ? (
                    <button
                      onClick={() => handleConnect(entry)}
                      disabled={state === "connecting"}
                      style={btnStyle("#22c55e", "rgba(34,197,94,0.12)")}
                    >
                      Connect
                    </button>
                  ) : (
                    <span style={{ fontSize: 12, color: "#22c55e", fontWeight: 600 }}>● Connected</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Services & Characteristics ────────────────────────── */}
        {state === "connected" && services.length > 0 && (
          <section style={cardStyle}>
            <h2 style={sectionTitle}>Services &amp; Characteristics</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {services.map((srv) => (
                <div key={srv.uuid}>
                  <div
                    style={{
                      fontSize: 11,
                      fontFamily: "monospace",
                      color: "#818cf8",
                      marginBottom: 6,
                      letterSpacing: "0.04em",
                    }}
                  >
                    SERVICE — {srv.uuid}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 12 }}>
                    {srv.characteristics.map((c) => (
                      <div
                        key={c.uuid}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          background: "rgba(255,255,255,0.03)",
                          border: "1px solid rgba(255,255,255,0.07)",
                          borderRadius: 8,
                          padding: "8px 12px",
                          flexWrap: "wrap",
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontFamily: "monospace", color: "#94a3b8" }}>{c.uuid}</div>
                          <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {c.properties.map((p) => (
                              <span key={p} style={propBadge(p)}>
                                {p}
                              </span>
                            ))}
                          </div>
                        </div>
                        {c.properties.includes("notify") && (
                          notifyChar ? (
                            <button onClick={handleStopNotify} style={btnStyle("#ef4444", "rgba(239,68,68,0.1)")}>
                              Stop Notify
                            </button>
                          ) : (
                            <button
                              onClick={() => handleStartNotify(srv.uuid, c.uuid)}
                              style={btnStyle("#22c55e", "rgba(34,197,94,0.1)")}
                            >
                              Start Notify
                            </button>
                          )
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Real-time charts ──────────────────────────────────── */}
        {history.length > 0 && latest && (
          <section style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={sectionTitle}>Real-time IMU Data</h2>
              <div style={{ display: "flex", gap: 4 }}>
                {(["accel", "gyro"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setSelectedTab(t)}
                    style={{
                      padding: "5px 14px",
                      borderRadius: 20,
                      border: "1px solid",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                      transition: "all .15s",
                      background: selectedTab === t ? "rgba(129,140,248,0.15)" : "transparent",
                      borderColor: selectedTab === t ? "#818cf8" : "rgba(255,255,255,0.1)",
                      color: selectedTab === t ? "#818cf8" : "rgba(255,255,255,0.4)",
                    }}
                  >
                    {t === "accel" ? "Accelerometer" : "Gyroscope"}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {selectedTab === "accel" ? (
                <>
                  <Sparkline data={field("ax")} color="#818cf8" label="AX" value={latest.ax} unit="g" />
                  <Sparkline data={field("ay")} color="#38bdf8" label="AY" value={latest.ay} unit="g" />
                  <Sparkline data={field("az")} color="#34d399" label="AZ" value={latest.az} unit="g" />
                </>
              ) : (
                <>
                  <Sparkline data={field("gx")} color="#f472b6" label="GX" value={latest.gx} unit="°/s" />
                  <Sparkline data={field("gy")} color="#fb923c" label="GY" value={latest.gy} unit="°/s" />
                  <Sparkline data={field("gz")} color="#facc15" label="GZ" value={latest.gz} unit="°/s" />
                </>
              )}
            </div>

            {/* numeric summary bar */}
            <div
              style={{
                marginTop: 14,
                display: "grid",
                gridTemplateColumns: "repeat(6, 1fr)",
                gap: 6,
                background: "rgba(255,255,255,0.03)",
                borderRadius: 10,
                padding: "10px 14px",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              {(["ax", "ay", "az", "gx", "gy", "gz"] as (keyof SensorData)[]).map((k) => (
                <div key={k} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", letterSpacing: "0.08em" }}>
                    {k.toUpperCase()}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", marginTop: 2 }}>
                    {(latest[k] as number).toFixed(3)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Raw log ───────────────────────────────────────────── */}
        {rawLog.length > 0 && (
          <section style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h2 style={sectionTitle}>Raw Log</h2>
              <button onClick={() => setRawLog([])} style={btnStyle("#6b7280", "rgba(107,114,128,0.1)")}>
                Clear
              </button>
            </div>
            <div
              style={{
                background: "#050608",
                borderRadius: 8,
                padding: "12px 14px",
                maxHeight: 200,
                overflowY: "auto",
                fontFamily: "monospace",
                fontSize: 11,
                color: "#86efac",
                lineHeight: 1.7,
                border: "1px solid rgba(255,255,255,0.07)",
              }}
            >
              {rawLog.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
              <div ref={logEndRef} />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

// ── Style helpers ─────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 16,
  padding: "22px 22px",
  marginBottom: 18,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "rgba(255,255,255,0.45)",
  margin: 0,
};

const emptyHint: React.CSSProperties = {
  textAlign: "center",
  color: "rgba(255,255,255,0.25)",
  fontSize: 13,
  padding: "28px 0",
};

function btnStyle(accent: string, bg: string): React.CSSProperties {
  return {
    padding: "7px 16px",
    borderRadius: 20,
    border: `1px solid ${accent}55`,
    background: bg,
    color: accent,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    transition: "opacity .15s",
    whiteSpace: "nowrap",
  };
}

function deviceRowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    background: active ? "rgba(34,197,94,0.05)" : "rgba(255,255,255,0.03)",
    border: `1px solid ${active ? "rgba(34,197,94,0.2)" : "rgba(255,255,255,0.07)"}`,
    borderRadius: 10,
    padding: "12px 14px",
  };
}

const uuidBadge: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "monospace",
  background: "rgba(129,140,248,0.1)",
  border: "1px solid rgba(129,140,248,0.2)",
  color: "#a5b4fc",
  borderRadius: 4,
  padding: "2px 6px",
};

function propBadge(prop: string): React.CSSProperties {
  const colors: Record<string, string> = {
    notify: "#22c55e",
    read: "#38bdf8",
    write: "#f59e0b",
    indicate: "#818cf8",
  };
  const c = colors[prop] ?? "#94a3b8";
  return {
    fontSize: 10,
    fontFamily: "monospace",
    background: `${c}18`,
    border: `1px solid ${c}44`,
    color: c,
    borderRadius: 4,
    padding: "2px 6px",
  };
}

function SpinnerIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      style={{ animation: "spin 0.8s linear infinite" }}
    >
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <path d="M21 12a9 9 0 11-6.219-8.56" />
    </svg>
  );
}