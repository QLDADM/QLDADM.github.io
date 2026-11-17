// UV-K5 z firmware DRON-K5 podłączony kablem programującym (K1, układ CH340).
// Android (Chrome): WebUSB z własnym sterownikiem CH340 - Android nie ma sterownika tego układu, więc
// przeglądarka dostaje urządzenie bezpośrednio. Komputer (Chrome / Edge): Web Serial - tam CH340 ma
// sterownik systemu i WebUSB nie dostałby dostępu.
// Radio wysyła linie DD (pasma alarmowe) i DP (panorama), opis w dron-k5/skaner/app/link.h.
// Dane są trzymane według źródła: "usb" = radio przy tym urządzeniu (walizka 1); później walizki przez LoRa.
"use strict";

const RidK5 = (() => {
  const BAUD = 38400;
  const VID = 0x1a86;                        // WCH (CH340 / CH341)
  const ORDER = ["433", "UHF", "868", "915", "1G2"];
  const BAND_NAME = { "433": "433 MHz", UHF: "410–450 MHz", "868": "868 MHz", "915": "915 MHz", "1G2": "1,2 GHz (wideo)" };
  const SCORE_MAX = 12, SCORE_MAYBE = 3;
  const FRESH_S = 10;                        // wszystkie pasma po kolei: każde co ~3 s
  const PANO_LEARN_S = 20;                   // panorama: 4 przebiegi nauki szumu po ~4 s, pierwsza linia DP po 5.
  const android = /Android/i.test(navigator.userAgent);
  const useUsb = !!navigator.usb && (android || !navigator.serial);
  const supported = useUsb || !!navigator.serial;

  const sources = new Map();                 // klucz -> { label, bands: {nazwa: {...}}, pano, at }
  let changeCb = () => {}, alarmCb = () => {};
  let link = null;                           // aktualne połączenie: { kind, close, write }
  let state = "off";                         // off | connecting | on | error
  let stateMsg = "";

  // ------------------------------------------------------------ dane

  function source(key, label) {
    let s = sources.get(key);
    if (!s) { s = { label, bands: {}, pano: null, at: 0, mode: "" }; sources.set(key, s); }
    s.label = label || s.label;
    return s;
  }

  // jedna linia tekstu od radia
  function feedLine(key, label, line) {
    const p = line.trim().split(",");
    const s = source(key, label);
    const now = Date.now();
    if (p[0] === "DD" && p.length === 6) {
      const name = p[1], b = s.bands[name] || (s.bands[name] = {});
      const wasAlarm = !!b.alarm;
      Object.assign(b, { score: +p[2], distinct: +p[3], dbm: +p[4], alarm: p[5] === "1", at: now });
      s.at = now; s.mode = "bands";
      if (b.alarm !== wasAlarm) alarmCb(s, name, b.alarm);
      changeCb();
    } else if (p[0] === "DP" && p.length === 4) {
      s.pano = { khz: +p[1], dbm: +p[2], cols: +p[3], at: now };
      s.at = now; s.mode = "pano";
      changeCb();
    } else if (p[0] === "DI") {
      s.id = p.slice(1).join(" ");
      changeCb();
    }
  }

  // ------------------------------------------------------------ CH340 przez WebUSB (Android)

  // sekwencja jak w usb-serial-for-android / sterowniku Linux ch341
  async function ch340Open(dev) {
    await dev.open();
    if (dev.configuration === null) await dev.selectConfiguration(1);
    await dev.claimInterface(0);
    const alt = dev.configuration.interfaces[0].alternate;
    const epIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk").endpointNumber;
    const epOut = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk").endpointNumber;
    const out = (request, value, index) =>
      dev.controlTransferOut({ requestType: "vendor", recipient: "device", request, value, index });
    await dev.controlTransferIn({ requestType: "vendor", recipient: "device", request: 0x5f, value: 0, index: 0 }, 2);
    await out(0xa1, 0, 0);                                   // inicjalizacja
    let factor = Math.floor(1532620800 / BAUD), div = 3;     // 38400 -> 0x6483 / 0x18
    while (factor > 0xfff0 && div > 0) { factor >>= 3; div--; }
    factor = 0x10000 - factor;
    await out(0x9a, 0x1312, (factor & 0xff00) | div | 0x80); // 0x80: bez czekania na pełny bufor
    await out(0x9a, 0x0f2c, factor & 0xff);
    await out(0x9a, 0x2518, 0x00c3);                         // 8N1, odbiór i nadawanie
    await out(0xa4, ~0x60 & 0xffff, 0);                      // DTR i RTS włączone (jak pyserial)
    return {
      kind: "USB",
      read: async () => {
        const r = await dev.transferIn(epIn, 64);
        return r.data ? new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength) : new Uint8Array();
      },
      write: (bytes) => dev.transferOut(epOut, bytes),
      close: async () => { try { await dev.close(); } catch { /* już zamknięte */ } },
      dev,
    };
  }

  // ------------------------------------------------------------ Web Serial (komputer)

  async function serialOpen(port) {
    await port.open({ baudRate: BAUD });
    let reader = port.readable.getReader();
    return {
      kind: "port szeregowy",
      read: async () => {
        const { value, done } = await reader.read();
        if (done) throw new Error("port zamknięty");
        return value;
      },
      write: async (bytes) => { const w = port.writable.getWriter(); try { await w.write(bytes); } finally { w.releaseLock(); } },
      close: async () => {
        try { await reader.cancel(); } catch { /* */ }
        try { reader.releaseLock(); } catch { /* */ }
        try { await port.close(); } catch { /* */ }
      },
      port,
    };
  }

  // ------------------------------------------------------------ połączenie

  function setState(st, msg) { state = st; stateMsg = msg || ""; changeCb(); }

  async function send(cmd) {
    if (!link) return;
    try { await link.write(new TextEncoder().encode(cmd + "\r\n")); } catch { /* błąd wyjdzie przy odczycie */ }
  }

  async function run(l) {
    link = l;
    const key = "usb", label = "W1·USB";
    let buf = "", identified = false;
    const dec = new TextDecoder();
    setState("connecting", "sprawdzam, czy to radio z DRON-K5…");
    // CYD też ma CH340: bez odpowiedzi DRON-K5 w 3 s rozłączamy, żeby nie przejąć innej płytki
    const idTimer = setTimeout(() => {
      if (!identified) { setState("error", "Urządzenie nie odpowiada jak DRON-K5. Sprawdź, czy radio jest włączone i ma wgrany DRON-K5."); stop(false); }
    }, 3000);
    send("ID");
    try {
      while (link === l) {
        buf += dec.decode(await l.read(), { stream: true });
        let i;
        while ((i = buf.search(/[\r\n]/)) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line) continue;
          if (!identified && /^D[DPI],/.test(line)) {
            identified = true;
            clearTimeout(idTimer);
            setState("on", "");
            send("TIME " + Math.floor(Date.now() / 1000));   // zegar dziennika alarmów w radiu
            if (!line.startsWith("DI")) send("ID");
          }
          if (identified) feedLine(key, label, line);
        }
        if (buf.length > 512) buf = "";
      }
    } catch (e) {
      if (link === l) setState("error", "Połączenie z radiem przerwane" + (e && e.message ? ` (${e.message})` : "") + ".");
    }
    clearTimeout(idTimer);
    if (link === l) link = null;
    await l.close();
    const s = sources.get(key);
    if (s) for (const [name, b] of Object.entries(s.bands)) if (b.alarm) { b.alarm = false; alarmCb(s, name, false); }
    changeCb();
  }

  async function openUsbDevice(dev) {
    try { run(await ch340Open(dev)); } catch (e) {
      setState("error", `Nie udało się otworzyć kabla USB: ${e.message || e}`);
    }
  }

  async function openSerialPort(port) {
    try { run(await serialOpen(port)); } catch (e) {
      setState("error", `Nie udało się otworzyć portu: ${e.message || e}. Zamknij inne programy używające kabla (agent, CHIRP).`);
    }
  }

  // przycisk na stronie: okno wyboru urządzenia (wymaga kliknięcia)
  async function connect() {
    if (!supported) { setState("error", "Ta przeglądarka nie obsługuje USB ani portu szeregowego. Użyj Chrome na Androidzie albo Chrome / Edge na komputerze."); return; }
    try {
      if (useUsb) {
        const dev = await navigator.usb.requestDevice({ filters: [{ vendorId: VID }] });
        await openUsbDevice(dev);
      } else {
        const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: VID }] });
        await openSerialPort(port);
      }
    } catch (e) {
      if (e && e.name === "NotFoundError") { setState(link ? state : "off"); return; }  // anulowane okno
      setState("error", String(e.message || e));
    }
  }

  // forget = false: rozłączenie przez błąd / wyjęcie kabla - komunikat o błędzie zostaje na stronie
  async function stop(forget = true) {
    const l = link; link = null;
    if (l) await l.close();
    if (state !== "error" || forget) setState("off");
  }

  // radio podłączone wcześniej (zgoda zapamiętana): łączymy bez pytania, także po ponownym wpięciu kabla
  async function autoOpen() {
    if (!supported || link) return;
    try {
      if (useUsb) {
        const dev = (await navigator.usb.getDevices()).find((d) => d.vendorId === VID);
        if (dev) await openUsbDevice(dev);
      } else {
        const port = (await navigator.serial.getPorts()).find((p) => p.getInfo().usbVendorId === VID);
        if (port) await openSerialPort(port);
      }
    } catch { /* brak zgody albo zajęte - użytkownik połączy przyciskiem */ }
  }

  if (useUsb) {
    navigator.usb.addEventListener("connect", () => autoOpen());
    navigator.usb.addEventListener("disconnect", (e) => { if (link && link.dev === e.device) stop(false); });
  } else if (navigator.serial) {
    navigator.serial.addEventListener("connect", () => autoOpen());
    navigator.serial.addEventListener("disconnect", (e) => { if (link && link.port === e.target) stop(false); });
  }

  // ------------------------------------------------------------ widok

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fresh = (t) => t && (Date.now() - t) / 1000 <= FRESH_S;
  const mhz = (khz) => (khz % 1000 ? (khz / 1000).toFixed(1).replace(".", ",") : String(khz / 1000));

  // wiersz "Łącza RF" w dolnym pasku (pusty, gdy radia nigdy nie było)
  function html() {
    if (!sources.size && state === "off") return "";
    const rows = [...sources.entries()].map(([key, s]) => {
      const live = fresh(s.at);
      const sinceMode = s.modeAt ? (Date.now() - s.modeAt) / 1000 : Infinity;
      let body;
      if (s.mode === "pano" && !(s.pano && fresh(s.pano.at)) && sinceMode < PANO_LEARN_S + 20) {
        // po przełączeniu panorama ~20 s uczy się szumu i radio w tym czasie nic nie wysyła
        const left = Math.max(0, Math.ceil(PANO_LEARN_S - sinceMode));
        body = `<span class="rfnone">panorama 88–1300 MHz: nauka szumu, ${left ? `pierwszy wynik za ok. ${left} s` : "zaraz pierwszy wynik"}…</span>`;
      } else if (!live) {
        const quiet = s.at ? Math.round((Date.now() - s.at) / 1000) : 0;
        body = `<span class="rfnone">${key === "usb" && state !== "on" ? "radio rozłączone"
          : key === "usb" && quiet < 60 ? `radio nic nie wysyła od ${quiet} s (po włączeniu panoramy klawiszem 8 pierwszy wynik jest po ok. ${PANO_LEARN_S} s)`
          : "brak nowych danych"}</span>`;
      } else if (s.mode === "pano" && s.pano) {
        const p = s.pano;
        body = `<span class="rfpano">panorama 88–1300 MHz: ${p.khz ? `najsilniejszy nowy sygnał <b>${mhz(p.khz)} MHz</b> ${p.dbm} dBm` : "brak nowych sygnałów"}</span>`;
      } else {
        body = ORDER.filter((n) => s.bands[n]).map((n) => {
          const b = s.bands[n], ok = fresh(b.at);
          const cls = !ok ? "stale" : b.alarm ? "alarm" : b.score >= SCORE_MAYBE ? "maybe" : "";
          return `<span class="rfb ${cls}" title="${esc(BAND_NAME[n] || n)}: wynik ${b.score}/${SCORE_MAX}, aktywne kanały ${b.distinct}, najsilniejszy ${b.dbm} dBm${b.alarm ? " - ŁĄCZE DRONA" : ""}">
            ${esc(n)}<i style="width:${Math.round(100 * Math.min(b.score, SCORE_MAX) / SCORE_MAX)}%"></i><small>${ok ? b.dbm : "—"}</small></span>`;
        }).join("") || '<span class="rfnone">czekam na pierwszy pomiar…</span>';
      }
      const acts = key === "usb" && state === "on"
        ? `<span class="rfact"><button data-k5mode="ALL" class="${s.mode === "bands" ? "on" : ""}" title="Radio skanuje pasma alarmowe">pasma</button><button data-k5mode="PANO" class="${s.mode === "pano" ? "on" : ""}" title="Radio przegląda cały zakres 88–1300 MHz (bez alarmów)">panorama</button></span>` : "";
      return `<div class="rfrow"><span class="rfsrc" title="${esc(s.id || "UV-K5")}">${esc(s.label)}</span>${body}${acts}</div>`;
    }).join("");
    const msg = stateMsg ? `<div class="rfmsg ${state === "error" ? "bad" : ""}">${esc(stateMsg)}</div>` : "";
    return `<div id="rfbar"><b>Łącza RF (UV-K5)</b>${rows}${msg}</div>`;
  }

  function anyAlarm() {
    for (const s of sources.values()) for (const b of Object.values(s.bands)) if (b.alarm && fresh(b.at)) return true;
    return false;
  }

  function buttonState() {
    const el = document.getElementById("k5btn");
    if (!el) return;
    el.classList.toggle("k5on", state === "on");
    el.classList.toggle("k5alarm", anyAlarm());
    el.textContent = state === "on" ? "UV-K5 ✓" : state === "connecting" ? "UV-K5 …" : "UV-K5";
    el.title = state === "on" ? "Radio UV-K5 połączone kablem - kliknij, żeby rozłączyć"
      : supported ? "Połącz radio UV-K5 z DRON-K5 kablem programującym (USB)" : "Przeglądarka nie obsługuje USB - użyj Chrome";
  }

  document.addEventListener("click", (e) => {
    const m = e.target.closest("[data-k5mode]");
    if (!m) return;
    send("MODE " + m.dataset.k5mode);
    const s = sources.get("usb");  // od razu widać zmianę, zanim radio przyśle pierwszy wynik
    if (s) {
      s.mode = m.dataset.k5mode === "PANO" ? "pano" : "bands";
      s.modeAt = Date.now();
      if (s.mode === "pano") s.pano = null;
      changeCb();
    }
  });
  setInterval(() => { if (sources.size) changeCb(); }, 2000);  // wygaszanie starych danych bez nowych linii

  return {
    supported,
    connect, stop, send, feedLine, html, anyAlarm,
    toggle: () => (state === "on" || state === "connecting" ? stop() : connect()),
    autoOpen,
    sources,
    onChange: (f) => { changeCb = () => { buttonState(); f(); }; },
    onAlarm: (f) => { alarmCb = f; },
    bandName: (n) => BAND_NAME[n] || n,
    get state() { return state; },
  };
})();
