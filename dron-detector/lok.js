// Położenie orientacyjne drona bez Remote ID z siły sygnału w kilku walizkach (sieć LoRa, net.h w Heltec).
//
// Model: RSSI = A[pasmo] + poprawka[walizka] - 10·n·log10(d), d - odległość w 3D (dron na założonej wysokości).
// Moc nadajnika drona jest nieznana, więc dla każdego punktu siatki liczymy wspólne przesunięcie δ
// (najlepsze dopasowanie z łagodnym przyciąganiem do zera) i błąd dopasowania wszystkich pomiarów.
// Dzięki temu ten sam rachunek daje: 1 walizka - pierścień (odległość z typowej mocy), 2 - pas,
// 3 i więcej - obszar. Wynik to mapa prawdopodobieństwa, a nie jedna kropka.
//
// Kalibracja: drony z Remote ID podają pozycję GPS, więc ich sygnał w każdej walizce poprawia A pasma
// i poprawkę walizki (antena, przewód). Zapis w przeglądarce (localStorage).
"use strict";
const RidLok = (() => {
  const SIGMA = 6;         // dB - rozrzut uśrednionego RSSI (odbicia, ustawienie anten drona)
  const SIGMA_D = 8;       // dB - niepewność mocy nadajnika (inne drony, inne anteny)
  const H_DEF = 30;        // m - założona wysokość drona nad walizkami, gdy nieznana
  const N_DEF = 2.5;       // wykładnik tłumienia (2 = wolna przestrzeń, 3-4 = las, zabudowa)
  const A_DEF = { "2G4": -30, "5G": -37, BLE: -50 };  // RSSI z 1 m (typowo, przed kalibracją)
  const GRID = 61;
  const WINDOW_MS = 12000;  // pomiary brane do mediany
  const FRESH_MS = 15000;   // walizka nie słyszy drona dłużej - pomijana
  const CAL_KEY = "rid-lok-cal";
  const M_LAT = 110540;

  const band = (ch) => (!ch ? "BLE" : ch > 14 ? "5G" : "2G4");
  const load = () => { try { return JSON.parse(localStorage.getItem(CAL_KEY)) || null; } catch { return null; } };
  // kalibracja: średnia „RSSI z 1 m” osobno dla każdej walizki i pasma (raw[walizka][pasmo] = {v, cnt});
  // z niej: poprawka walizki = różnica względem walizki 1 w pasmach zmierzonych przez obie, A pasma = średnia po walizkach
  let cal = load();
  if (!cal?.raw) cal = { raw: {}, cnt: 0 };  // także zapis ze starszej wersji pliku
  let calDirty = 0, der = null;
  const saveCal = () => { try { localStorage.setItem(CAL_KEY, JSON.stringify(cal)); } catch { /* tryb prywatny */ } };
  const CAL_MIN = 3;  // tyle pomiarów, zanim średnia zacznie się liczyć
  function derive() {
    const raw = cal.raw, off = {}, A = {}, Acnt = {};
    for (const s of Object.keys(raw)) {
      if (s === "1") continue;
      const diffs = Object.keys(raw[s]).filter((b) => raw[s][b].cnt >= CAL_MIN && raw[1]?.[b]?.cnt >= CAL_MIN).map((b) => raw[s][b].v - raw[1][b].v);
      if (diffs.length) off[s] = Math.max(-15, Math.min(15, diffs.reduce((a, v) => a + v, 0) / diffs.length));
    }
    for (const b of Object.keys(A_DEF)) {
      let sum = 0, w = 0;
      for (const s of Object.keys(raw)) {
        const r = raw[s][b];
        if (!r || r.cnt < CAL_MIN) continue;
        sum += (r.v - (off[s] || 0)) * r.cnt;
        w += r.cnt;
      }
      if (w) { A[b] = sum / w; Acnt[b] = w; }
    }
    return { off, A, Acnt };
  }
  const D = () => der || (der = derive());
  const A = (b) => D().A[b] ?? A_DEF[b];
  const off = (s) => D().off[s] ?? 0;

  // klucz drona -> walizka -> pasmo -> [[czas, rssi]]
  const obs = new Map();

  function note(key, site, rssi, ch, t = Date.now()) {
    if (rssi == null || rssi <= -127 || rssi >= 0) return;
    let k = obs.get(key);
    if (!k) obs.set(key, (k = new Map()));
    let s = k.get(site);
    if (!s) k.set(site, (s = new Map()));
    const b = band(ch);
    let l = s.get(b);
    if (!l) s.set(b, (l = []));
    l.push([t, rssi]);
    while (l.length && t - l[0][0] > WINDOW_MS) l.shift();
    if (l.length > 40) l.shift();
  }

  // dron zmienił klucz (bez ID pod adresem MAC, potem z UAS ID / nazwą sieci)
  function rename(from, to) {
    const a = obs.get(from);
    if (!a || from === to) return;
    obs.delete(from);
    const b = obs.get(to);
    if (!b) { obs.set(to, a); return; }
    for (const [site, bands] of a) {
      if (!b.has(site)) { b.set(site, bands); continue; }
      for (const [bn, l] of bands) b.get(site).set(bn, (b.get(site).get(bn) || []).concat(l).sort((x, y) => x[0] - y[0]));
    }
  }

  const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // świeże poziomy: [{site, band, r (mediana dBm), n, t}]
  function levels(key, now = Date.now()) {
    const out = [];
    for (const [site, bands] of obs.get(key) || [])
      for (const [b, l] of bands) {
        const fresh = l.filter((x) => now - x[0] <= WINDOW_MS);
        if (!fresh.length || now - fresh[fresh.length - 1][0] > FRESH_MS) continue;
        out.push({ site, band: b, r: Math.round(median(fresh.map((x) => x[1]))), n: fresh.length, t: fresh[fresh.length - 1][0] });
      }
    return out.sort((a, b) => b.r - a.r);
  }

  // płaskie współrzędne w metrach wokół punktu odniesienia
  function proj(lat0, lon0) {
    const mLon = M_LAT * Math.cos((lat0 * Math.PI) / 180);
    return {
      xy: (lat, lon) => [(lon - lon0) * mLon, (lat - lat0) * M_LAT],
      ll: (x, y) => [lat0 + y / M_LAT, lon0 + x / mLon],
    };
  }

  // sites: {nr: {lat, lon}}; h - wysokość drona nad walizkami (m) albo null
  function estimate(key, sites, h = null) {
    const L = levels(key).filter((o) => sites[o.site]);
    if (!L.length) return null;
    const hh = h != null && h > 0 ? h : H_DEF;
    const used = [...new Set(L.map((o) => o.site))].map((s) => sites[s]);
    const lat0 = used.reduce((a, s) => a + s.lat, 0) / used.length, lon0 = used.reduce((a, s) => a + s.lon, 0) / used.length;
    const P = proj(lat0, lon0);
    const pts = L.map((o) => ({ ...o, xy: P.xy(sites[o.site].lat, sites[o.site].lon), exp: A(o.band) + off(o.site) }));
    // zasięg siatki: rozstaw walizek i odległość z typowej mocy dla najsilniejszego sygnału
    const spread = Math.max(0, ...pts.map((p) => Math.hypot(p.xy[0], p.xy[1])));
    const d3 = 10 ** ((pts[0].exp - pts[0].r) / (10 * N_DEF));
    const dEst = Math.sqrt(Math.max(0, d3 * d3 - hh * hh));
    const R = Math.min(4000, Math.max(200, spread * 3, dEst * 3 + spread));
    const cell = (2 * R) / GRID, w = (SIGMA / SIGMA_D) ** 2;
    const p = new Float64Array(GRID * GRID);
    let best = 0, max = 0;
    for (let j = 0; j < GRID; j++) {
      const y = R - (j + 0.5) * cell;  // wiersz 0 = północ
      for (let i = 0; i < GRID; i++) {
        const x = -R + (i + 0.5) * cell;
        let sum = 0;
        const e = pts.map((q) => {
          const d = Math.sqrt((x - q.xy[0]) ** 2 + (y - q.xy[1]) ** 2 + hh * hh);
          const v = q.r - (q.exp - 10 * N_DEF * Math.log10(d));  // nadwyżka sygnału względem typowej mocy
          sum += v;
          return v;
        });
        const delta = sum / (e.length + w);
        const cost = e.reduce((a, v) => a + (v - delta) ** 2, 0) + w * delta * delta;
        const v = Math.exp(-cost / (2 * SIGMA * SIGMA));
        p[j * GRID + i] = v;
        if (v > max) { max = v; best = j * GRID + i; }
      }
    }
    if (!(max > 0)) return null;
    const bx = -R + ((best % GRID) + 0.5) * cell, by = R - (Math.floor(best / GRID) + 0.5) * cell;
    let tot = 0, var2 = 0;
    for (let k = 0; k < p.length; k++) {
      const x = -R + ((k % GRID) + 0.5) * cell, y = R - (Math.floor(k / GRID) + 0.5) * cell;
      tot += p[k];
      var2 += p[k] * ((x - bx) ** 2 + (y - by) ** 2);
    }
    // obraz do mapy: tylko obszar, w którym leży 90% prawdopodobieństwa; środek mocniej, brzeg słabiej
    const sorted = Float64Array.from(p).sort().reverse();
    let acc = 0, cut = 0;
    for (const v of sorted) { acc += v; cut = v; if (acc >= 0.9 * tot) break; }
    const cv = document.createElement("canvas");
    cv.width = cv.height = GRID;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(GRID, GRID);
    for (let k = 0; k < p.length; k++) {
      if (p[k] < cut) continue;
      const q = p[k] / max;
      img.data[4 * k] = 255; img.data[4 * k + 1] = 140; img.data[4 * k + 2] = 0;
      img.data[4 * k + 3] = Math.round(40 + 110 * q);
    }
    ctx.putImageData(img, 0, 0);
    const [lat, lon] = P.ll(bx, by);
    return {
      lat, lon, err: Math.sqrt(var2 / tot), sites: used.length, levels: L, h: hh,
      ring: used.length === 1,
      // jedna walizka: odległość od niej (kierunku nie znamy)
      dist: used.length === 1 ? Math.hypot(bx - pts[0].xy[0], by - pts[0].xy[1]) : null,
      img: cv.toDataURL(), bounds: [P.ll(-R, -R), P.ll(R, R)],
    };
  }

  // dron z Remote ID: znana pozycja -> poprawka A pasma i walizek
  const lastCal = new Map();
  function calibrate(key, lat, lon, h, sites) {
    const now = Date.now();
    for (const o of levels(key, now)) {
      const s = sites[o.site];
      if (!s || now - o.t > 3000) continue;
      const id = `${key}|${o.site}|${o.band}`;
      if (now - (lastCal.get(id) || 0) < 3000) continue;
      lastCal.set(id, now);
      const P = proj(s.lat, s.lon), [x, y] = P.xy(lat, lon);
      const d = Math.sqrt(x * x + y * y + (h != null && h > 0 ? h * h : H_DEF * H_DEF));
      if (d < 15) continue;  // tuż przy walizce model nie działa
      const a = o.r + 10 * N_DEF * Math.log10(d);  // RSSI z 1 m wg tego pomiaru
      const site = (cal.raw[o.site] ||= {});
      const r = (site[o.band] ||= { v: a, cnt: 0 });
      r.cnt++;
      r.v += (a - r.v) / Math.min(r.cnt, 300);  // średnia, potem średnia krocząca z ~300 ostatnich
      der = null;
      cal.cnt++;
      calDirty++;
    }
    if (calDirty >= 5) { calDirty = 0; saveCal(); }
  }

  function calInfo() {
    return {
      cnt: cal.cnt,
      A: Object.fromEntries(Object.keys(A_DEF).map((b) => [b, { v: Math.round(A(b)), cnt: D().Acnt[b] || 0 }])),
      off: Object.fromEntries(Object.entries(D().off).map(([s, v]) => [s, Math.round(v * 10) / 10])),
    };
  }
  function calReset() { cal = { raw: {}, cnt: 0 }; der = null; saveCal(); }

  return { note, rename, levels, estimate, calibrate, calInfo, calReset, band, H_DEF, N_DEF };
})();
