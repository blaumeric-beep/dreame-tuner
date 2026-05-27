import { useState, useRef, useEffect, useCallback } from "react";

const SERVICE_UUID = "0000fe95-0000-1000-8000-00805f9b34fb";
const WRITE_SHORTS = [0x0010, 0x0016, 0x0018, 0x001a, 0x001b, 0x001c];
const CHUNK_SIZE = 18;

function toArr(dv: DataView | null | undefined): Uint8Array {
  if (!dv) return new Uint8Array(0);
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}
function shortId(uuid: string): number {
  const s = uuid.toLowerCase().replace(/-/g, "").replace(/^0x/, "");
  if (s.length <= 4) return parseInt(s, 16);
  if (s.length === 8) return parseInt(s.slice(4), 16);
  return parseInt(s.slice(4, 8), 16);
}
function shortLabel(uuid: string): string {
  const n = shortId(uuid);
  return isNaN(n) ? uuid.slice(0, 8).toUpperCase() : n.toString(16).toUpperCase().padStart(4, "0");
}
function hexStr(a: Uint8Array): string {
  return Array.from(a).map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
function le2(v: number) { return [v & 0xff, (v >> 8) & 0xff]; }
function le4(v: number) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }
function cs(b: number[]) { return (1 - b.reduce((a, x) => a + x, 0)) & 0xff; }
function miPkt(src: number, dst: number, cmd: number, reg: number, data: number[]): Uint8Array {
  const p = [src, dst, cmd, reg, data.length, ...data];
  const body = [p.length + 1, ...p];
  return new Uint8Array([0x55, 0xaa, ...body, cs(body), 0xff]);
}
function miWrite(reg: number, data: number[]): Uint8Array {
  return miPkt(0x20, 0x21, 0x03, reg, data);
}
function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Preset { id: string; label: string; icon: string; kmh: number; amps: number; color: string; desc: string; }
const PRESETS: Preset[] = [
  { id: "eco",   label: "Eco",   icon: "🌿", kmh: 20, amps: 12, color: "#3fb950", desc: "Sparsam & leise" },
  { id: "legal", label: "Legal", icon: "📋", kmh: 25, amps: 18, color: "#58a6ff", desc: "Straßenrecht DE" },
  { id: "sport", label: "Sport", icon: "⚡", kmh: 33, amps: 25, color: "#f0883e", desc: "Original Max" },
  { id: "turbo", label: "Turbo", icon: "🚀", kmh: 38, amps: 30, color: "#bc8cff", desc: "Entsperrt" },
];

type Phase = "idle" | "connecting" | "connected" | "busy";
type Tab = "modes" | "custom" | "ota" | "console";
interface LogEntry { text: string; type: "tx" | "rx" | "info" | "ok" | "err" | "warn"; }

export default function App() {
  const [phase, setPhase]           = useState<Phase>("idle");
  const [tab, setTab]               = useState<Tab>("modes");
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [policeMode, setPoliceMode] = useState(false);
  const [speed, setSpeed]           = useState(33);
  const [amps, setAmps]             = useState(25);
  const [battery, setBattery]       = useState<number | null>(null);
  const [currentLimit, setCurrentLimit] = useState<string | null>(null);
  const [log, setLog]               = useState<LogEntry[]>([]);
  const [hexInput, setHexInput]     = useState("FF 02 55 02");
  // OTA state
  const [fwFile, setFwFile]         = useState<File | null>(null);
  const [fwBuf, setFwBuf]           = useState<Uint8Array | null>(null);
  const [otaProgress, setOtaProgress] = useState(0);
  const [otaStatus, setOtaStatus]   = useState<"idle"|"flashing"|"done"|"error">("idle");
  const [otaConfirmed, setOtaConfirmed] = useState(false);
  const [deviceInfo, setDeviceInfo]   = useState<{reg: string; raw: string; decoded: string}[]>([]);
  const [gattInfo, setGattInfo]       = useState<{label: string; value: string}[]>([]);

  const endRef    = useRef<HTMLDivElement>(null);
  const otaEndRef = useRef<HTMLDivElement>(null);
  const wChars    = useRef<BluetoothRemoteGATTCharacteristic[]>([]);
  const rxQueue   = useRef<string[]>([]);
  const c001c     = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const c0010     = useRef<BluetoothRemoteGATTCharacteristic | null>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [log]);
  useEffect(() => { otaEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [log]);

  const addLog = useCallback((text: string, type: LogEntry["type"] = "info") => {
    setLog(p => [...p.slice(-600), { text, type }]);
  }, []);

  async function doWrite(c: BluetoothRemoteGATTCharacteristic, data: Uint8Array) {
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    try {
      if (c.properties.writeWithoutResponse) await c.writeValueWithoutResponse(buf);
      else await c.writeValue(buf);
    } catch (e: any) { addLog(`Write-Fehler: ${e?.message ?? e}`, "warn"); }
  }

  async function connect() {
    if (!("bluetooth" in navigator)) { addLog("❌ Bluefy App benutzen!", "err"); return; }
    setPhase("connecting"); setLog([]); wChars.current = []; rxQueue.current = [];
    c001c.current = null; c0010.current = null;
    addLog("Scooter suchen...", "info");

    let device: BluetoothDevice;
    try {
      device = await (navigator as any).bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SERVICE_UUID, "device_information", "battery_service"],
      });
    } catch { addLog("Verbindung abgebrochen", "err"); setPhase("idle"); return; }
    addLog(`Gerät: ${device.name ?? "Unbekannt"}`, "ok");

    let server: BluetoothRemoteGATTServer;
    try { server = await device.gatt!.connect(); }
    catch (e: any) { addLog(`GATT Fehler: ${e?.message}`, "err"); setPhase("idle"); return; }
    addLog("GATT verbunden", "ok");

    device.addEventListener("gattserverdisconnected", () => {
      addLog("Verbindung getrennt", "warn");
      setPhase("idle"); setPoliceMode(false); setCurrentLimit(null);
    });

    try {
      const bSvc = await server.getPrimaryService("battery_service");
      const bChar = await bSvc.getCharacteristic("battery_level");
      const bVal = await bChar.readValue();
      setBattery(bVal.getUint8(0));
      addLog(`Batterie: ${bVal.getUint8(0)}%`, "ok");
    } catch { addLog("Batterie: nicht lesbar", "info"); }

    // Read Device Information Service (0x180A) — lives in BLE chip, not app firmware
    try {
      const diSvc = await server.getPrimaryService("device_information");
      const diChars: {label: string; uuid: string}[] = [
        { label: "Modell",         uuid: "model_number_string" },
        { label: "Serial",         uuid: "serial_number_string" },
        { label: "Firmware",       uuid: "firmware_revision_string" },
        { label: "Hardware",       uuid: "hardware_revision_string" },
        { label: "Hersteller",     uuid: "manufacturer_name_string" },
        { label: "SW Revision",    uuid: "software_revision_string" },
      ];
      const gathered: {label: string; value: string}[] = [];
      for (const { label, uuid } of diChars) {
        try {
          const ch = await diSvc.getCharacteristic(uuid);
          const val = await ch.readValue();
          const str = new TextDecoder().decode(val).replace(/\0/g, "").trim();
          if (str) {
            gathered.push({ label, value: str });
            addLog(`ℹ️ ${label}: ${str}`, "ok");
          }
        } catch { /* char not present */ }
      }
      if (gathered.length > 0) setGattInfo(gathered);
      else addLog("Device Info Service: keine Daten", "info");
    } catch { addLog("Device Info Service: nicht verfügbar", "info"); }

    let service: BluetoothRemoteGATTService | null = null;
    try { service = await server.getPrimaryService(SERVICE_UUID); } catch {}
    if (!service) try { service = await server.getPrimaryService(0xfe95); } catch {}
    if (!service) { addLog("FE95-Service fehlt", "err"); setPhase("idle"); return; }

    const cList = await service.getCharacteristics();
    const found: BluetoothRemoteGATTCharacteristic[] = [];

    for (const c of cList) {
      const sid = shortId(c.uuid);
      const lbl = shortLabel(c.uuid);
      if (WRITE_SHORTS.includes(sid) && (c.properties.write || c.properties.writeWithoutResponse)) {
        found.push(c);
        if (sid === 0x001c) c001c.current = c;
        if (sid === 0x0010) c0010.current = c;
      }
      if (c.properties.notify || c.properties.indicate) {
        try {
          await c.startNotifications();
          c.addEventListener("characteristicvaluechanged", (e: Event) => {
            const arr = toArr((e.target as BluetoothRemoteGATTCharacteristic).value);
            if (arr.length > 0) {
              const h = hexStr(arr);
              rxQueue.current.push(h);
              addLog(`← ${lbl}: ${h}`, "rx");
              if (sid === 0x001c && arr.length >= 3 && arr[0] === 0xff && arr[2] !== 0xff) {
                const raw = arr[2];
                setCurrentLimit(`~${Math.round(raw * 33 / 85)} km/h (raw ${raw})`);
              }
            }
          });
        } catch {}
      }
    }

    if (found.length === 0) { addLog("Keine Write-Chars", "err"); setPhase("idle"); return; }
    addLog(`${found.length} Chars: ${found.map(c => shortLabel(c.uuid)).join(", ")}`, "ok");
    wChars.current = found;
    setPhase("connected");
  }

  // ── Speed packet sending ─────────────────────────────────────────────────
  async function sendPackets(kmh: number, a: number) {
    const spd10 = kmh * 10;
    const packets: [string, Uint8Array][] = [
      [`cmd03 reg0F ×10`,   miPkt(0x20,0x21,0x03,0x0f, le2(spd10))],
      [`cmd03 reg10 ×10`,   miPkt(0x20,0x21,0x03,0x10, le2(spd10))],
      [`cmd03 reg22 ×10`,   miPkt(0x20,0x21,0x03,0x22, le2(spd10))],
      [`cmd13 reg0F ×10`,   miPkt(0x20,0x21,0x13,0x0f, le2(spd10))],
      [`cmd13 reg10 ×10`,   miPkt(0x20,0x21,0x13,0x10, le2(spd10))],
      [`cmd13 reg22 ×10`,   miPkt(0x20,0x21,0x13,0x22, le2(spd10))],
      [`cmd03 reg0F raw`,   miPkt(0x20,0x21,0x03,0x0f, [kmh,0x00])],
      [`cmd13 reg0F raw`,   miPkt(0x20,0x21,0x13,0x0f, [kmh,0x00])],
      [`cmd03 reg0B mA`,    miPkt(0x20,0x21,0x03,0x0b, le2(a*1000))],
      [`cmd13 reg0B mA`,    miPkt(0x20,0x21,0x13,0x0b, le2(a*1000))],
    ];
    for (const [desc, pkt] of packets) {
      addLog(`→ Mi ${desc}`, "tx");
      for (const c of wChars.current) await doWrite(c, pkt);
      await delay(300);
    }
  }

  async function applyPreset(preset: Preset) {
    if (phase !== "connected") return;
    setPhase("busy"); setActivePreset(preset.id);
    addLog(`Setze ${preset.label}: ${preset.kmh} km/h · ${preset.amps} A`, "info");
    await sendPackets(preset.kmh, preset.amps);
    addLog(`${preset.label} gesetzt!`, "ok");
    setPhase("connected");
  }

  async function applyCustom() {
    if (phase !== "connected") return;
    setPhase("busy"); setActivePreset(null);
    addLog(`Custom: ${speed} km/h · ${amps} A`, "info");
    await sendPackets(speed, amps);
    addLog("Einstellungen gesetzt!", "ok");
    setPhase("connected");
  }

  async function togglePolice() {
    if (phase !== "connected") return;
    if (policeMode) {
      setPoliceMode(false);
      setPhase("busy"); setActivePreset("sport");
      addLog("Police deaktiviert → Sport", "info");
      await sendPackets(33, 25);
      setPhase("connected");
    } else {
      setPoliceMode(true);
      setPhase("busy"); setActivePreset("legal");
      addLog("🚨 POLICE MODE → 25 km/h", "warn");
      await sendPackets(25, 18);
      setPhase("connected");
    }
  }

  async function readCurrentLimit() {
    if (!c001c.current || phase !== "connected") return;
    setPhase("busy");
    rxQueue.current = [];
    addLog("→ Lese Speed-Limit...", "tx");
    await doWrite(c001c.current, miWrite(0x0f, [0x00, 0x00]));
    await delay(400);
    setPhase("connected");
  }

  async function readDeviceInfo() {
    if (phase !== "connected") return;
    setPhase("busy");
    setDeviceInfo([]);
    addLog("🔍 Lese Geräte-Info...", "info");

    // Mi read cmd=0x01: registers that typically hold model/firmware/serial info
    const regs = [
      { reg: 0x10, label: "Firmware Lo" },
      { reg: 0x11, label: "Firmware Hi" },
      { reg: 0x12, label: "Hardware Rev" },
      { reg: 0x13, label: "Boot Version" },
      { reg: 0x1a, label: "Serial 1" },
      { reg: 0x1b, label: "Serial 2" },
      { reg: 0x1c, label: "Serial 3" },
      { reg: 0x1d, label: "Model 1" },
      { reg: 0x1e, label: "Model 2" },
      { reg: 0x68, label: "FW Version" },
      { reg: 0x69, label: "BLE Version" },
      { reg: 0x6a, label: "ECU Info" },
      { reg: 0x7a, label: "SN Block" },
      { reg: 0x7b, label: "SN Block 2" },
    ];

    const results: {reg: string; raw: string; decoded: string}[] = [];

    for (const { reg, label } of regs) {
      rxQueue.current = [];
      // Mi read: cmd=0x01, 2-byte register (lo, hi)
      const pkt = (() => {
        const p = [0x20, 0x21, 0x01, reg, 0x02, 0x00, 0x00];
        const body = [p.length + 1, ...p];
        return new Uint8Array([0x55, 0xaa, ...body, cs(body), 0xff]);
      })();
      for (const c of wChars.current) await doWrite(c, pkt);
      await delay(380);

      const resp = rxQueue.current[0] ?? "";
      const bytes = resp.split(" ").map(h => parseInt(h, 16)).filter(n => !isNaN(n));
      // Try to decode as ASCII string
      const ascii = bytes.slice(2).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : ".").join("").replace(/\.+$/, "");
      // Also show as version numbers (e.g. lo.hi)
      const asVer = bytes.length >= 4 ? `${bytes[2]}.${bytes[3]}` : "";

      results.push({ reg: `0x${reg.toString(16).padStart(2,"0").toUpperCase()} ${label}`, raw: resp || "(keine Antwort)", decoded: ascii || asVer || "?" });
      addLog(`← Reg ${reg.toString(16).padStart(2,"0").toUpperCase()}: ${resp || "(keine)"}${ascii ? ` → "${ascii}"` : ""}`, "rx");
    }

    setDeviceInfo(results);
    addLog("Geräte-Info komplett!", "ok");
    setPhase("connected");
  }

  async function sendHex() {
    if (phase !== "connected") return;
    const bytes = hexInput.trim().split(/\s+/).map(h => parseInt(h, 16)).filter(n => !isNaN(n));
    if (!bytes.length) return;
    setPhase("busy");
    const data = new Uint8Array(bytes);
    addLog(`→ HEX: ${hexStr(data)}`, "tx");
    if (c001c.current) await doWrite(c001c.current, data);
    await delay(400);
    setPhase("connected");
  }

  async function sendSweep() {
    if (!c001c.current || phase !== "connected") return;
    setPhase("busy");
    addLog("🔍 Sweep 85→105...", "info");
    for (let v = 85; v <= 105; v++) {
      addLog(`→ FF 02 ${v.toString(16).padStart(2,"0").toUpperCase()} 02`, "tx");
      await doWrite(c001c.current, new Uint8Array([0xff, 0x02, v, 0x02]));
      await delay(350);
    }
    addLog("Sweep fertig.", "ok");
    setPhase("connected");
  }

  async function registerScan() {
    if (!c001c.current || phase !== "connected") return;
    setPhase("busy");
    addLog("📖 Register-Scan 00→1F...", "info");
    for (let r = 0; r <= 0x1f; r++) {
      addLog(`→ FF 01 ${r.toString(16).padStart(2,"0").toUpperCase()} 00`, "tx");
      await doWrite(c001c.current, new Uint8Array([0xff, 0x01, r, 0x00]));
      await delay(380);
    }
    addLog("Scan fertig.", "ok");
    setPhase("connected");
  }

  async function monitor() {
    if (phase !== "connected") return;
    setPhase("busy");
    addLog("👂 Monitor 8s (kein Senden)...", "info");
    rxQueue.current = [];
    await delay(8000);
    addLog(rxQueue.current.length > 0
      ? `${rxQueue.current.length} spontane Nachrichten!` : "Keine spontanen Nachrichten.", "ok");
    setPhase("connected");
  }

  async function testChar(charId: number) {
    const target = wChars.current.find(c => shortId(c.uuid) === charId);
    if (!target || phase !== "connected") return;
    setPhase("busy");
    const pkt = miWrite(0x0f, le2(380));
    addLog(`→ Test ${shortLabel(target.uuid)}: ${hexStr(pkt)}`, "tx");
    rxQueue.current = [];
    await doWrite(target, pkt);
    await delay(500);
    if (!rxQueue.current.length) addLog(`  ← (keine Antwort)`, "warn");
    setPhase("connected");
  }

  // ── OTA Flash ────────────────────────────────────────────────────────────
  async function pickFirmware(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFwFile(file);
    const ab = await file.arrayBuffer();
    setFwBuf(new Uint8Array(ab));
    setOtaConfirmed(false);
    setOtaStatus("idle");
    setOtaProgress(0);
    addLog(`📦 Firmware geladen: ${file.name} (${(file.size/1024).toFixed(1)} KB)`, "ok");
  }

  async function startOTA() {
    if (!fwBuf || !c0010.current || phase !== "connected") return;
    setPhase("busy");
    setOtaStatus("flashing");
    setOtaProgress(0);

    const fw = fwBuf;
    const totalSize = fw.length;
    const crc = crc32(fw);
    const chunks = Math.ceil(totalSize / CHUNK_SIZE);

    addLog(`🔥 OTA Start: ${totalSize} Bytes, ${chunks} Chunks, CRC32=0x${crc.toString(16).toUpperCase()}`, "info");

    // ── Phase 1: OTA Init ────────────────────────────────────────────────
    // Mi OTA start: cmd=0x0B src=20 dst=21, payload=[size_lo, size_hi, size_hi2, size_hi3]
    const startPkt = (() => {
      const payload = le4(totalSize);
      const p = [0x20, 0x21, 0x0b, 0x00, payload.length, ...payload];
      const body = [p.length + 1, ...p];
      return new Uint8Array([0x55, 0xaa, ...body, cs(body), 0xff]);
    })();

    addLog(`→ OTA Init: ${hexStr(startPkt)}`, "tx");
    await doWrite(c0010.current, startPkt);
    await delay(500);

    // ── Phase 2: Send chunks ─────────────────────────────────────────────
    let seq = 0;
    for (let offset = 0; offset < totalSize; offset += CHUNK_SIZE) {
      const chunk = fw.slice(offset, offset + CHUNK_SIZE);
      // Chunk packet: cmd=0x0C, seq lo+hi, then chunk data
      const chunkData = [...le2(seq), ...Array.from(chunk)];
      const p = [0x20, 0x21, 0x0c, 0x00, chunkData.length, ...chunkData];
      const body = [p.length + 1, ...p];
      const pkt = new Uint8Array([0x55, 0xaa, ...body, cs(body), 0xff]);

      await doWrite(c0010.current, pkt);

      // Log every 50 chunks
      if (seq % 50 === 0) {
        const pct = Math.round((offset / totalSize) * 100);
        addLog(`→ Chunk ${seq}/${chunks} (${pct}%)`, "tx");
      }

      setOtaProgress(Math.round(((offset + chunk.length) / totalSize) * 100));
      seq++;
      // Small delay every chunk to avoid BLE congestion
      if (seq % 10 === 0) await delay(50);
    }

    addLog(`→ Alle ${chunks} Chunks gesendet`, "ok");
    await delay(300);

    // ── Phase 3: OTA Finish ──────────────────────────────────────────────
    const crcData = le4(crc);
    const fp = [0x20, 0x21, 0x0d, 0x00, crcData.length, ...crcData];
    const fbody = [fp.length + 1, ...fp];
    const finishPkt = new Uint8Array([0x55, 0xaa, ...fbody, cs(fbody), 0xff]);

    addLog(`→ OTA Finish (CRC): ${hexStr(finishPkt)}`, "tx");
    await doWrite(c0010.current, finishPkt);
    await delay(1000);

    // ── Phase 4: Reboot ──────────────────────────────────────────────────
    const rebootPkt = miPkt(0x20, 0x21, 0x0e, 0x00, []);
    addLog(`→ Reboot-Befehl: ${hexStr(rebootPkt)}`, "tx");
    for (const c of wChars.current) await doWrite(c, rebootPkt);
    await delay(500);

    setOtaStatus("done");
    setOtaProgress(100);
    addLog("✅ OTA abgeschlossen! Scooter startet neu mit neuer Firmware.", "ok");
    addLog("   Warte 10 Sekunden, dann neu verbinden.", "info");
    setPhase("connected");
  }

  const connected = phase === "connected";
  const busy      = phase === "busy" || phase === "connecting";
  const TABS: { id: Tab; label: string }[] = [
    { id: "modes",   label: "⚡ Modi" },
    { id: "custom",  label: "🎛 Custom" },
    { id: "ota",     label: "🔥 Flash" },
    { id: "console", label: "🔧 Dev" },
  ];

  return (
    <div style={{
      minHeight: "100vh", background: "#0d1117", color: "#e6edf3",
      fontFamily: "system-ui,-apple-system,sans-serif",
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "0 0 48px", boxSizing: "border-box",
    }}>
      {/* Header */}
      <div style={{
        width: "100%", background: "#161b22", borderBottom: "1px solid #21262d",
        padding: "12px 18px", boxSizing: "border-box",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>
            <span style={{ color: "#58a6ff" }}>Dreame</span><span> Tuner</span>
          </div>
          <div style={{ fontSize: 10, color: "#8b949e" }}>2.7.0_0015 · FE95 · BLE OTA</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {battery !== null && (
            <div style={{ fontSize: 12, color: battery > 20 ? "#3fb950" : "#f85149",
              background: "#21262d", padding: "4px 10px", borderRadius: 20, fontWeight: 700 }}>
              🔋 {battery}%
            </div>
          )}
          <div style={{
            width: 10, height: 10, borderRadius: "50%",
            background: connected ? "#3fb950" : busy ? "#e3b341" : "#484f58",
            boxShadow: `0 0 6px ${connected ? "#3fb950" : busy ? "#e3b341" : "transparent"}`,
          }} />
        </div>
      </div>

      <div style={{ width: "100%", maxWidth: 480, padding: "14px 14px 0", boxSizing: "border-box" }}>

        {/* Status badge */}
        {currentLimit && (
          <div style={{ background: "#1c2128", border: "1px solid #30363d", borderRadius: 10,
            padding: "7px 14px", marginBottom: 12, fontSize: 12, color: "#8b949e",
            display: "flex", justifyContent: "space-between" }}>
            <span>📡 Aktuelles Limit</span>
            <span style={{ color: "#58a6ff", fontWeight: 700, fontFamily: "monospace" }}>{currentLimit}</span>
          </div>
        )}

        {/* Connect + Police */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button onClick={connect} disabled={busy} style={btnStyle(
            connected ? "#1a2a3a" : "#1f6feb", connected ? "#388bfd" : "#1f6feb",
            connected ? "#58a6ff" : "#fff", busy)}>
            {phase === "connecting" ? "⏳ Verbinde..." : connected ? "✓ Verbunden" : "🔵 Verbinden"}
          </button>
          <button onClick={togglePolice} disabled={!connected || busy} style={{
            ...btnStyle(policeMode ? "#2a0000" : "#1a1a1a",
              policeMode ? "#ff4444" : "#30363d",
              policeMode ? "#ff4444" : "#8b949e", !connected || busy),
            animation: policeMode ? "policePulse 1s infinite" : "none",
          }}>
            {policeMode ? "🚨 POLICE AN" : "🚨 Police"}
          </button>
        </div>

        {policeMode && (
          <div style={{ background: "#1a0000", border: "1px solid #ff4444", borderRadius: 10,
            padding: "8px 14px", marginBottom: 12, fontSize: 11, color: "#ff8080",
            textAlign: "center", fontWeight: 600 }}>
            ⚠️ 25 km/h aktiv — nochmal tippen um zurückzusetzen
          </div>
        )}

        {connected && (
          <button onClick={readCurrentLimit} disabled={busy} style={{
            width: "100%", padding: "8px 0", fontSize: 12, fontWeight: 600,
            background: "#1c2128", color: "#8b949e", border: "1px solid #30363d",
            borderRadius: 10, cursor: busy ? "not-allowed" : "pointer", marginBottom: 12,
          }}>📡 Limit lesen</button>
        )}

        {/* Tabs */}
        <div style={{ display: "flex", gap: 3, marginBottom: 14, background: "#161b22",
          borderRadius: 10, padding: 4, border: "1px solid #21262d" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, padding: "7px 0", fontSize: 11, fontWeight: 600,
              background: tab === t.id ? "#21262d" : "transparent",
              color: tab === t.id ? "#e6edf3" : "#8b949e",
              border: "none", borderRadius: 7, cursor: "pointer",
            }}>{t.label}</button>
          ))}
        </div>

        {/* ── MODES TAB ── */}
        {tab === "modes" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              {PRESETS.map(p => (
                <button key={p.id} onClick={() => applyPreset(p)} disabled={!connected || busy}
                  style={{
                    background: activePreset === p.id ? `${p.color}18` : "#161b22",
                    border: `2px solid ${activePreset === p.id ? p.color : "#30363d"}`,
                    borderRadius: 14, padding: "16px 10px", cursor: (!connected || busy) ? "not-allowed" : "pointer",
                    textAlign: "center", transition: "all 0.2s",
                    boxShadow: activePreset === p.id ? `0 0 14px ${p.color}44` : "none",
                  }}>
                  <div style={{ fontSize: 26 }}>{p.icon}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: p.color, marginTop: 3 }}>{p.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: "#e6edf3", margin: "3px 0" }}>
                    {p.kmh} <span style={{ fontSize: 11, color: "#8b949e" }}>km/h</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#8b949e" }}>{p.amps}A · {p.desc}</div>
                </button>
              ))}
            </div>
            {!connected && <div style={{ textAlign: "center", color: "#484f58", fontSize: 12, padding: "16px 0" }}>
              Zuerst verbinden
            </div>}
          </div>
        )}

        {/* ── CUSTOM TAB ── */}
        {tab === "custom" && (
          <div>
            <Slider label="Geschwindigkeit" unit="km/h" value={speed} min={15} max={50}
              color="#f0883e" onChange={v => { setSpeed(v); setActivePreset(null); }} />
            <Slider label="Motorstrom" unit="A" value={amps} min={10} max={35}
              color="#58a6ff" onChange={v => { setAmps(v); setActivePreset(null); }}
              hint="⚡ Mehr = mehr Beschleunigung" />
            <button onClick={applyCustom} disabled={!connected || busy} style={{
              width: "100%", padding: "14px 0", fontSize: 15, fontWeight: 800,
              background: connected ? "#1f6feb" : "#21262d",
              color: connected ? "#fff" : "#484f58",
              border: `2px solid ${connected ? "#388bfd" : "#30363d"}`,
              borderRadius: 12, cursor: (!connected || busy) ? "not-allowed" : "pointer", marginBottom: 12,
            }}>
              {busy ? "⏳ Wird gesetzt..." : `✓ Setzen: ${speed} km/h · ${amps} A`}
            </button>
          </div>
        )}

        {/* ── OTA FLASH TAB ── */}
        {tab === "ota" && (
          <div>
            {/* Warning box */}
            <div style={{ background: "#1a1000", border: "2px solid #e3b341", borderRadius: 12,
              padding: "14px 16px", marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#e3b341", marginBottom: 8 }}>
                ⚠️ Firmware Flash — Risiken beachten!
              </div>
              <div style={{ fontSize: 11, color: "#b08800", lineHeight: 1.7 }}>
                • Falsche Firmware = Scooter dauerhaft defekt (gebrickt)<br/>
                • Nur .bin Dateien für genau dieses Dreame-Modell benutzen<br/>
                • Firmware von <b>ScooterHacking.org</b> oder Original-Dreame-App<br/>
                • Akku muss mindestens 30% haben<br/>
                • Nicht unterbrechen während des Flashens!
              </div>
            </div>

            {/* GATT Device Information (read at connect time) */}
            {gattInfo.length > 0 && (
              <div style={{ background: "#0d2016", border: "1px solid #3fb950", borderRadius: 12,
                padding: "14px 16px", marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#3fb950", marginBottom: 10 }}>
                  ✅ Gerät identifiziert (BLE Device Info)
                </div>
                {gattInfo.map((row, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0",
                    borderBottom: i < gattInfo.length - 1 ? "1px solid #1a3a22" : "none" }}>
                    <span style={{ color: "#8b949e", fontSize: 11, minWidth: 90, flexShrink: 0 }}>{row.label}</span>
                    <span style={{ color: "#e6edf3", fontSize: 12, fontWeight: 700, fontFamily: "monospace" }}>{row.value}</span>
                  </div>
                ))}
                <div style={{ marginTop: 10, fontSize: 10, color: "#3fb950", opacity: 0.8 }}>
                  Mit diesen Daten auf ScooterHacking.org die passende Firmware suchen.
                </div>
              </div>
            )}

            {/* Device Info Reader */}
            <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 12,
              padding: "16px", marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 10, fontWeight: 600 }}>
                🔍 Schritt 1 — Gerät identifizieren
              </div>
              <button
                onClick={readDeviceInfo}
                disabled={!connected || busy}
                style={{
                  width: "100%", padding: "12px 0", fontSize: 13, fontWeight: 700,
                  background: connected ? "#0d2016" : "#161b22",
                  color: connected ? "#3fb950" : "#484f58",
                  border: `1px solid ${connected ? "#3fb950" : "#30363d"}`,
                  borderRadius: 10, cursor: (!connected || busy) ? "not-allowed" : "pointer",
                  marginBottom: deviceInfo.length ? 12 : 0,
                }}>
                {busy ? "⏳ Lese..." : "📡 Firmware & Modell auslesen"}
              </button>

              {deviceInfo.length > 0 && (
                <div style={{ fontFamily: "monospace", fontSize: 11 }}>
                  {deviceInfo.map((row, i) => (
                    <div key={i} style={{
                      display: "flex", gap: 8, padding: "5px 8px",
                      background: i % 2 === 0 ? "#0d1117" : "#161b22",
                      borderRadius: 6, marginBottom: 2, alignItems: "flex-start",
                    }}>
                      <span style={{ color: "#8b949e", minWidth: 110, flexShrink: 0 }}>{row.reg}</span>
                      <span style={{ color: "#484f58", minWidth: 0, wordBreak: "break-all", flexGrow: 1 }}>{row.raw}</span>
                      {row.decoded && row.decoded !== "?" && (
                        <span style={{ color: "#58a6ff", fontWeight: 700, flexShrink: 0, marginLeft: 4 }}>
                          → {row.decoded}
                        </span>
                      )}
                    </div>
                  ))}
                  <div style={{ marginTop: 8, padding: "6px 8px", background: "#1a1000",
                    border: "1px solid #e3b341", borderRadius: 8, fontSize: 11, color: "#e3b341" }}>
                    💡 Screenshot dieser Tabelle machen und Modellnummer suchen!
                  </div>
                </div>
              )}
            </div>

            {/* Firmware picker */}
            <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 12,
              padding: "16px", marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 10, fontWeight: 600 }}>
                📦 Schritt 2 — Firmware-Datei (.bin)
              </div>
              <label style={{
                display: "block", padding: "12px", textAlign: "center",
                background: "#21262d", border: "2px dashed #30363d", borderRadius: 10,
                cursor: "pointer", fontSize: 13, color: fwBuf ? "#3fb950" : "#8b949e",
                fontWeight: fwBuf ? 700 : 400,
              }}>
                {fwBuf
                  ? `✓ ${fwFile?.name} — ${(fwFile!.size / 1024).toFixed(1)} KB`
                  : "Tippen um .bin Datei zu wählen"}
                <input type="file" accept=".bin" onChange={pickFirmware}
                  style={{ display: "none" }} />
              </label>

              {fwBuf && (
                <div style={{ marginTop: 10, fontSize: 11, color: "#8b949e", fontFamily: "monospace",
                  background: "#010409", borderRadius: 8, padding: "8px 10px" }}>
                  <div>Größe: <span style={{ color: "#58a6ff" }}>{fwBuf.length.toLocaleString()} Bytes</span></div>
                  <div>CRC32: <span style={{ color: "#58a6ff" }}>0x{crc32(fwBuf).toString(16).toUpperCase().padStart(8,"0")}</span></div>
                  <div>Chunks: <span style={{ color: "#58a6ff" }}>{Math.ceil(fwBuf.length / CHUNK_SIZE)} × {CHUNK_SIZE}B</span></div>
                  <div>Ziel-Char: <span style={{ color: c0010.current ? "#3fb950" : "#f85149" }}>
                    {c0010.current ? "0010 ✓" : "0010 (erst verbinden!)"}
                  </span></div>
                </div>
              )}
            </div>

            {/* Confirm checkbox */}
            {fwBuf && (
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14,
                fontSize: 12, color: "#8b949e", cursor: "pointer" }}>
                <input type="checkbox" checked={otaConfirmed} onChange={e => setOtaConfirmed(e.target.checked)}
                  style={{ marginTop: 2, accentColor: "#f85149", width: 16, height: 16 }} />
                <span>Ich verstehe das Risiko. Die Firmware ist korrekt für mein Modell.
                Bei Schäden durch falsches Flashen übernehme ich selbst die Verantwortung.</span>
              </label>
            )}

            {/* Flash button */}
            {fwBuf && (
              <button
                onClick={startOTA}
                disabled={!connected || busy || !otaConfirmed || otaStatus === "flashing"}
                style={{
                  width: "100%", padding: "16px 0", fontSize: 15, fontWeight: 900,
                  background: otaConfirmed && connected ? "#3d1a00" : "#161b22",
                  color: otaConfirmed && connected ? "#ff6b35" : "#484f58",
                  border: `2px solid ${otaConfirmed && connected ? "#ff6b35" : "#30363d"}`,
                  borderRadius: 12,
                  cursor: (!connected || busy || !otaConfirmed || otaStatus === "flashing") ? "not-allowed" : "pointer",
                  marginBottom: 14, letterSpacing: 1,
                }}>
                {otaStatus === "flashing" ? `⏳ Flashe... ${otaProgress}%`
                  : otaStatus === "done" ? "✅ Flash fertig!"
                  : "🔥 FIRMWARE FLASHEN"}
              </button>
            )}

            {/* Progress bar */}
            {(otaStatus === "flashing" || otaStatus === "done") && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between",
                  fontSize: 11, color: "#8b949e", marginBottom: 4 }}>
                  <span>Fortschritt</span><span>{otaProgress}%</span>
                </div>
                <div style={{ height: 8, background: "#21262d", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${otaProgress}%`,
                    background: otaStatus === "done" ? "#3fb950" : "#f0883e",
                    borderRadius: 4, transition: "width 0.3s",
                  }} />
                </div>
              </div>
            )}

            {/* OTA done */}
            {otaStatus === "done" && (
              <div style={{ background: "#0d2016", border: "1px solid #3fb950", borderRadius: 10,
                padding: "12px 16px", marginBottom: 14, textAlign: "center" }}>
                <div style={{ fontSize: 28, marginBottom: 6 }}>✅</div>
                <div style={{ fontSize: 14, fontWeight: 800, color: "#3fb950" }}>Flash erfolgreich!</div>
                <div style={{ fontSize: 11, color: "#8b949e", marginTop: 4 }}>
                  Scooter startet neu. Warte 10s, dann neu verbinden.
                </div>
              </div>
            )}

            {/* Firmware links info */}
            <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 10,
              padding: "12px 14px", fontSize: 11, color: "#8b949e", lineHeight: 1.7 }}>
              <div style={{ fontWeight: 700, color: "#e6edf3", marginBottom: 6 }}>Wo Firmware herbekommen?</div>
              <div>• <span style={{ color: "#58a6ff" }}>scooterhacking.org</span> → Custom Firmware für viele Modelle</div>
              <div>• Dreame App → OTA Update abfangen</div>
              <div>• Original-Firmware macht das BLE-Speed-Limit wieder BLE-setzbar</div>
              <div style={{ marginTop: 8, color: "#484f58" }}>Dein Modell → Firmware 2.7.0_0015 (Dreame FE95)</div>
            </div>
          </div>
        )}

        {/* ── CONSOLE/DEV TAB ── */}
        {tab === "console" && (
          <div>
            {/* Hex input */}
            <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8, fontWeight: 600 }}>Hex-Befehl</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input value={hexInput} onChange={e => setHexInput(e.target.value)}
                placeholder="FF 02 55 02"
                style={{ flex: 1, background: "#010409", border: "1px solid #30363d", color: "#e6edf3",
                  borderRadius: 8, padding: "9px 12px", fontSize: 13, fontFamily: "Menlo,monospace" }} />
              <button onClick={sendHex} disabled={!connected || busy} style={{
                padding: "9px 14px", fontSize: 13, fontWeight: 700,
                background: "#1f6feb", color: "#fff", border: "2px solid #388bfd",
                borderRadius: 8, cursor: (!connected || busy) ? "not-allowed" : "pointer",
              }}>Senden</button>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12 }}>
              {[["Status","FF 02 55 02"],["Lesen","FF 01 00 00"],["86","FF 02 56 02"],
                ["90","FF 02 5A 02"],["95","FF 02 5F 02"],["100","FF 02 64 02"],
                ["Mode+1","FF 02 55 03"],["Mode+2","FF 02 55 04"]].map(([l,h]) => (
                <button key={l} onClick={() => setHexInput(h)} style={{
                  padding: "4px 9px", fontSize: 11, background: "#21262d", color: "#8b949e",
                  border: "1px solid #30363d", borderRadius: 6, cursor: "pointer" }}>{l}</button>
              ))}
            </div>

            {/* Tool buttons */}
            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <button onClick={sendSweep} disabled={!connected || busy} style={toolBtn("#1a1a2e","#6e40c9","#bc8cff",!connected||busy)}>🔍 Sweep</button>
              <button onClick={registerScan} disabled={!connected || busy} style={toolBtn("#1a2e1a","#238636","#3fb950",!connected||busy)}>📖 Reg-Scan</button>
              <button onClick={monitor} disabled={!connected || busy} style={toolBtn("#1a2028","#1f6feb","#58a6ff",!connected||busy)}>👂 Monitor</button>
            </div>

            <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6, marginTop: 10, fontWeight: 600 }}>
              Einzelner Char-Test (38 km/h):
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 14 }}>
              {[0x0010,0x0016,0x0018,0x001a,0x001b].map(id => (
                <button key={id} onClick={() => testChar(id)} disabled={!connected||busy}
                  style={{ padding: "5px 11px", fontSize: 11, fontWeight: 700,
                    background: "#1c2128", color: "#58a6ff",
                    border: "1px solid #1f6feb", borderRadius: 6,
                    cursor: (!connected||busy) ? "not-allowed" : "pointer" }}>
                  → {id.toString(16).toUpperCase().padStart(4,"0")}
                </button>
              ))}
            </div>

            {/* Log */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
              <div style={{ fontSize: 12, color: "#8b949e", fontWeight: 600 }}>BLE Log</div>
              <button onClick={() => setLog([])} style={{ fontSize: 11, color: "#484f58", background: "none", border: "none", cursor: "pointer" }}>Leeren</button>
            </div>
            <div style={{ background: "#010409", border: "1px solid #21262d", borderRadius: 10,
              padding: "8px 10px", maxHeight: 320, overflowY: "auto", minHeight: 60 }}>
              {!log.length && <div style={{ color: "#484f58", fontSize: 11, textAlign: "center", padding: "16px 0" }}>Log leer</div>}
              {log.map((l, i) => (
                <div key={i} style={{
                  fontSize: 11, lineHeight: 1.7, fontFamily: "Menlo,monospace", wordBreak: "break-all",
                  color: l.type === "rx" ? "#bc8cff" : l.type === "tx" ? "#58a6ff"
                    : l.type === "ok" ? "#3fb950" : l.type === "err" ? "#f85149"
                    : l.type === "warn" ? "#e3b341" : "#8b949e",
                }}>{l.text}</div>
              ))}
              <div ref={endRef} />
            </div>
          </div>
        )}

        {tab !== "console" && log.length > 0 && (
          <button onClick={() => setTab("console")} style={{
            width: "100%", padding: "7px 0", fontSize: 11, color: "#484f58",
            background: "none", border: "1px dashed #21262d", borderRadius: 8,
            cursor: "pointer", marginTop: 8,
          }}>🔧 {log.length} Log-Einträge → Dev-Tab</button>
        )}
      </div>

      <style>{`
        @keyframes policePulse { 0%,100%{box-shadow:0 0 8px #ff4444}50%{box-shadow:0 0 24px #ff4444,0 0 48px #ff4444} }
        input[type=range]{height:4px} button{font-family:inherit}
      `}</style>
    </div>
  );
}

function btnStyle(bg: string, brd: string, col: string, dis: boolean): React.CSSProperties {
  return { flex: 1, padding: "12px 0", fontSize: 13, fontWeight: 700,
    background: bg, color: col, border: `2px solid ${brd}`, borderRadius: 12,
    cursor: dis ? "not-allowed" : "pointer" };
}
function toolBtn(bg: string, brd: string, col: string, dis: boolean): React.CSSProperties {
  return { flex: 1, padding: "10px 0", fontSize: 11, fontWeight: 700,
    background: bg, color: col, border: `2px solid ${brd}`, borderRadius: 9,
    cursor: dis ? "not-allowed" : "pointer" };
}

function Slider({ label, unit, value, min, max, color, onChange, hint }: {
  label: string; unit: string; value: number; min: number; max: number;
  color: string; onChange: (v: number) => void; hint?: string;
}) {
  return (
    <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 14,
      padding: "15px 18px", marginBottom: 12, textAlign: "center" }}>
      <div style={{ fontSize: 10, color: "#8b949e", letterSpacing: 2, marginBottom: 3, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 50, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 13, color: "#8b949e", marginBottom: 10 }}>{unit}</div>
      <input type="range" min={min} max={max} value={value}
        onChange={e => onChange(+e.target.value)}
        style={{ width: "100%", accentColor: color }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#484f58", marginTop: 3 }}>
        <span>{min}</span>
        {hint && <span style={{ color: "#8b949e", fontSize: 10 }}>{hint}</span>}
        <span>{max}</span>
      </div>
    </div>
  );
}
