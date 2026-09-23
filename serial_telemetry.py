#!/usr/bin/env python3
"""Thingy:91 X serial telemetry poller — VCOM0 shell @ 115200 → serial-telemetry.json"""
from __future__ import annotations

import glob
import json
import os
import re
import sys
import time
from pathlib import Path

try:
    import serial
    from serial import SerialException
except ImportError:
    print("pyserial missing — pip3 install --user pyserial", file=sys.stderr)
    sys.exit(1)

DASH = Path(__file__).resolve().parent
OUT = DASH / "serial-telemetry.json"
OUT_ALT = Path("/tmp/thingy-serial-telemetry.json")
PID_FILE = DASH / "serial_telemetry.pid"
BAUD = 115200
POLL_S = float(os.environ.get("THINGY_SERIAL_POLL", "10"))

# Zephyr shell form: "at AT..."
AT_CMDS = [
    "at AT%XVBAT",
    "at AT%XMONITOR",
    "at AT+CESQ",
    "at AT+CGPADDR",
    "at AT+CGPADDR=0",
    "at AT+COPS?",
    "at AT%XCBAND",
    "at AT%XCBAND=?",
    "at AT+CEREG?",
    "at AT%XSYSTEMMODE?",
    "at AT%XSNRSQ",
]

# Nordic AcT (nRF91 %XMONITOR / +COPS / +CEREG)
ACT_MAP = {
    0: "GSM",
    1: "GSM Compact",
    2: "UTRAN",
    3: "GSM/EGPRS",
    4: "UTRAN/HSDPA",
    5: "UTRAN/HSUPA",
    6: "UTRAN/HSPA",
    7: "LTE-M",
    8: "EC-GSM-IoT",
    9: "NB-IoT",
}

PLMN_HINTS = {
    "72410": "VIVO",
    "72406": "VIVO",
    "72423": "VIVO",
    "72411": "VIVO",
    "72405": "Claro",
    "72402": "TIM",
    "72403": "TIM",
    "72404": "TIM",
    "72431": "Oi",
    "72416": "Oi",
}

RE_TEMP = re.compile(r"Temperature:\s*([-+]?\d+(?:\.\d+)?)\s*C", re.I)
RE_HUM = re.compile(r"Humidity:\s*([-+]?\d+(?:\.\d+)?)\s*%", re.I)
RE_PRESS = re.compile(r"Pressure:\s*([-+]?\d+(?:\.\d+)?)(?:\s*(Pa|kPa|hPa|mbar))?", re.I)
RE_GOT_LOC = re.compile(
    r"Got\s+location\s*:\s*lat\s*:\s*([-+]?\d+(?:\.\d+)?)\s*,\s*lon\s*:\s*([-+]?\d+(?:\.\d+)?)",
    re.I,
)
RE_LATLON = re.compile(
    r"(?:lat(?:itude)?[:\s=]+|\"lat\"\s*:\s*)([-+]?\d{1,2}\.\d{2,})[,;\s\r\n]+"
    r"(?:lon(?:gitude)?[:\s=]+|\"lon\"\s*:\s*|lng[:\s=]+)([-+]?\d{1,3}\.\d{2,})",
    re.I | re.S,
)
RE_LATLON2 = re.compile(
    r"([-+]?\d{1,2}\.\d{4,})\s*[,;]\s*([-+]?\d{1,3}\.\d{4,}).*(?:GNSS|GPS|location|fix)",
    re.I,
)
RE_MAPS_URL = re.compile(
    r"maps\.google\.com/\?q=([-+]?\d+(?:\.\d+)?),([-+]?\d+(?:\.\d+)?)",
    re.I,
)
RE_LAT_ONLY = re.compile(r"\blatitude\s*[:=]\s*([-+]?\d{1,2}\.\d{2,})", re.I)
RE_LON_ONLY = re.compile(r"\blongitude\s*[:=]\s*([-+]?\d{1,3}\.\d{2,})", re.I)
RE_LOC_SNIP = re.compile(
    r".*(?:Got location|latitude|longitude|LOCATION_|Location request|location_module|nrf_cloud_location|maps\.google).*",
    re.I,
)
RE_XVBAT = re.compile(r"%XVBAT:\s*(\d+)", re.I)
RE_XMON = re.compile(r"%XMONITOR:\s*(.+)", re.I)
RE_CESQ = re.compile(r"\+CESQ:\s*([\d,\s]+)", re.I)
RE_CGPADDR = re.compile(r"\+CGPADDR:\s*\d+\s*,\s*\"?([0-9a-fA-F.:]+)\"?", re.I)
RE_COPS = re.compile(r"\+COPS:\s*(.+)", re.I)
RE_XCBAND = re.compile(r"%XCBAND:\s*(.+)", re.I)
RE_CEREG = re.compile(r"\+CEREG:\s*(.+)", re.I)
RE_XSYS = re.compile(r"%XSYSTEMMODE:\s*(.+)", re.I)
RE_XSNRSQ = re.compile(r"%XSNRSQ:\s*(.+)", re.I)
RE_WIFI_COUNT = re.compile(
    r"(?:found|scanned|detected)\s+(\d+)\s+(?:wi-?fi|wifi)\s+(?:ap|aps|access)",
    re.I,
)
RE_WIFI_COUNT2 = re.compile(
    r"(\d+)\s+(?:wi-?fi|wifi)\s+(?:ap|aps|access.?points?)\s+(?:found|scanned|detected)",
    re.I,
)
RE_WIFI_AP_LINE = re.compile(
    r"(?:wi-?fi|wifi).*(?:ssid|bssid|ap\b)|(?:ssid|bssid).*(?:wi-?fi|wifi)",
    re.I,
)
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def write_pid():
    PID_FILE.write_text(str(os.getpid()))


def clear_pid():
    try:
        if PID_FILE.exists() and PID_FILE.read_text().strip() == str(os.getpid()):
            PID_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def atomic_write(path: Path, obj: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    data = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    tmp.write_text(data)
    os.replace(tmp, path)


def blank_state(err=None):
    return {
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "batteryMv": None,
        "operator": None,
        "mccMnc": None,
        "mcc": None,
        "mnc": None,
        "band": None,
        "supportedBands": None,
        "rsrp": None,
        "rsrq": None,
        "snr": None,
        "ipAddress": None,
        "networkMode": None,
        "accessTech": None,
        "ueMode": None,
        "systemMode": None,
        "tac": None,
        "tacDec": None,
        "eci": None,
        "eciDec": None,
        "cellId": None,
        "wifiApCount": None,
        "wifiStatus": None,
        "temperatureC": None,
        "humidityPct": None,
        "pressure": None,
        "pressureUnit": None,
        "pressureRaw": None,
        "lat": None,
        "lon": None,
        "locationAccuracy": None,
        "locationSource": None,
        "uartLocSnippets": [],
        "rawNotes": err or "",
        "ok": False,
        "port": None,
    }


def discover_ports():
    """Prefer cu.usbmodem*102, then tty, then any usbmodem*, then hardcoded."""
    seen = []
    env = (os.environ.get("THINGY_PORT") or "").strip()
    if env:
        seen.append(env)
    patterns = (
        "/dev/cu.usbmodem*102",
        "/dev/tty.usbmodem*102",
        "/dev/cu.usbmodem*",
        "/dev/tty.usbmodem*",
    )
    for pat in patterns:
        for p in sorted(glob.glob(pat)):
            if p not in seen:
                seen.append(p)
    for p in ("/dev/cu.usbmodem102", "/dev/tty.usbmodem102"):
        if p not in seen:
            seen.append(p)
    return seen


def normalize_pressure(raw: float):
    """BME680 Zephyr often logs kPa as 'Pa'. São Paulo ~930 hPa."""
    if raw is None:
        return None, None
    if 50.0 <= raw <= 120.0:
        return round(raw * 10.0, 2), "hPa_from_kPa"
    if 850.0 <= raw <= 1100.0:
        return round(raw, 2), "hPa"
    if 50000.0 <= raw <= 120000.0:
        return round(raw / 100.0, 2), "hPa_from_Pa"
    return round(raw, 2), "raw"


def try_set_latlon(state: dict, lat, lon, source="uart"):
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    if -90 <= lat <= 90 and -180 <= lon <= 180 and not (lat == 0 and lon == 0):
        state["lat"], state["lon"] = lat, lon
        state["locationSource"] = source
        return True
    return False


def split_csv_quoted(body: str):
    parts, cur, in_q = [], "", False
    for ch in body.strip():
        if ch == '"':
            in_q = not in_q
            continue
        if ch == "," and not in_q:
            parts.append(cur.strip())
            cur = ""
            continue
        cur += ch
    parts.append(cur.strip())
    return parts


def apply_plmn_hint(state: dict):
    plmn = str(state.get("mccMnc") or "").strip()
    if plmn.isdigit() and len(plmn) >= 5:
        try:
            state["mcc"] = int(plmn[:3])
            state["mnc"] = int(plmn[3:])
        except ValueError:
            pass
    hint = PLMN_HINTS.get(plmn)
    op = (state.get("operator") or "").strip()
    if hint:
        if not op or op == plmn or op.isdigit():
            state["operator"] = hint
    elif op and op.isdigit() and op == plmn:
        # keep digits only if no hint
        pass


def map_act(act_raw):
    try:
        act = int(str(act_raw).strip())
    except (TypeError, ValueError):
        return None, None
    name = ACT_MAP.get(act)
    return act, name


def set_network_mode(state: dict, act_name: str | None):
    if not act_name:
        return
    state["accessTech"] = act_name
    # Compose with GNSS flag from system mode when present
    sys = state.get("systemMode") or {}
    gnss = sys.get("gnss") if isinstance(sys, dict) else None
    if gnss:
        state["networkMode"] = f"{act_name} GPS"
    else:
        state["networkMode"] = state.get("networkMode") or act_name


def parse_xmonitor(body: str, state: dict):
    parts = split_csv_quoted(body)
    # <reg>,<full>,<short>,<plmn>,<tac>,<AcT>,<band>,<cell_id>[,phys,earfcn,rsrp,snr,...]
    if len(parts) >= 4 and parts[3]:
        state["mccMnc"] = parts[3]
    if len(parts) >= 2 and parts[1]:
        state["operator"] = parts[1]
    elif len(parts) >= 3 and parts[2]:
        state["operator"] = parts[2]
    if len(parts) >= 7 and parts[6]:
        try:
            state["band"] = int(parts[6])
        except ValueError:
            state["band"] = parts[6]
    if len(parts) >= 6 and parts[5]:
        _act, act_name = map_act(parts[5])
        set_network_mode(state, act_name)
    # rsrp coded 0..97 at index 10
    if len(parts) >= 11 and parts[10] and parts[10].isdigit():
        try:
            v = int(parts[10])
            if 0 <= v <= 97:
                state["rsrp"] = v - 140
        except ValueError:
            pass
    # snr: Nordic index − 24 → dB (0..127)
    if len(parts) >= 12 and parts[11] and parts[11].isdigit():
        try:
            v = int(parts[11])
            if 0 <= v <= 127:
                state["snr"] = v - 24
        except ValueError:
            pass
    # RSRQ coded 0..34 at index 15 when present
    if len(parts) >= 16 and parts[15] and parts[15].isdigit() and len(parts[15]) <= 2:
        try:
            v = int(parts[15])
            if 0 <= v <= 34:
                state["rsrq"] = (v - 40) / 2.0
        except ValueError:
            pass
    if len(parts) >= 5 and parts[4]:
        state["tac"] = parts[4]
        try:
            state["tacDec"] = int(parts[4], 16)
        except ValueError:
            pass
    if len(parts) >= 8 and parts[7]:
        state["eci"] = parts[7]
        state["cellId"] = parts[7]
        try:
            state["eciDec"] = int(parts[7], 16)
        except ValueError:
            pass
    apply_plmn_hint(state)
    notes = state.get("rawNotes") or ""
    if len(parts) >= 8:
        notes = (
            notes
            + f" cell={parts[7]} tac={parts[4] if len(parts) > 4 else ''} act={parts[5] if len(parts) > 5 else ''}"
        ).strip()
    state["rawNotes"] = notes[:400]


def parse_cesq(body: str, state: dict):
    nums = [p.strip() for p in body.split(",")]
    if len(nums) >= 6:
        try:
            rsrq_i = int(nums[4])
            rsrp_i = int(nums[5])
            if rsrp_i != 255:
                state["rsrp"] = rsrp_i - 140
            if rsrq_i != 255:
                state["rsrq"] = (rsrq_i - 40) / 2.0
        except ValueError:
            pass


def parse_cgpaddr(body_or_ip: str, state: dict):
    ip = body_or_ip.strip().strip('"')
    if not ip or ip in ("0.0.0.0", "::"):
        return
    # IPv4 or IPv6-ish
    if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", ip) or ":" in ip:
        state["ipAddress"] = ip


def parse_cops(body: str, state: dict):
    parts = split_csv_quoted(body)
    # +COPS: <mode>[,<format>,<oper>[,<AcT>]]
    if len(parts) >= 3 and parts[2]:
        oper = parts[2].strip()
        if oper.isdigit() and len(oper) >= 5:
            state["mccMnc"] = state.get("mccMnc") or oper
            apply_plmn_hint(state)
            if not state.get("operator") or str(state.get("operator")).isdigit():
                apply_plmn_hint(state)
        else:
            state["operator"] = oper
    if len(parts) >= 4 and parts[3]:
        _act, act_name = map_act(parts[3])
        set_network_mode(state, act_name)
    apply_plmn_hint(state)


def parse_xcband(body: str, state: dict):
    body = body.strip()
    # List form: (1,2,3,...) or 1,2,3
    m = re.search(r"\(([^)]+)\)", body)
    if m:
        bands = []
        for tok in m.group(1).split(","):
            tok = tok.strip()
            if tok.isdigit():
                bands.append(int(tok))
        if bands:
            state["supportedBands"] = bands
        return
    # Single current band
    if body.isdigit():
        try:
            state["band"] = int(body)
        except ValueError:
            pass


def parse_cereg(body: str, state: dict):
    parts = split_csv_quoted(body)
    # +CEREG: <n>,<stat>[,<tac>,<ci>,<AcT>...]  or <stat>,...
    # Find hex tac/ci-ish fields
    hex_fields = [p for p in parts if re.fullmatch(r"[0-9A-Fa-f]{2,8}", p or "")]
    if len(hex_fields) >= 1 and not state.get("tac"):
        state["tac"] = hex_fields[0]
        try:
            state["tacDec"] = int(hex_fields[0], 16)
        except ValueError:
            pass
    if len(hex_fields) >= 2 and not state.get("eci"):
        state["eci"] = hex_fields[1]
        state["cellId"] = hex_fields[1]
        try:
            state["eciDec"] = int(hex_fields[1], 16)
        except ValueError:
            pass
    for p in reversed(parts):
        if p.isdigit() and int(p) in ACT_MAP:
            _act, act_name = map_act(p)
            set_network_mode(state, act_name)
            break


def parse_xsystemmode(body: str, state: dict):
    parts = [p.strip() for p in body.split(",")]
    if len(parts) < 3:
        return
    try:
        lte_m = int(parts[0])
        nb = int(parts[1])
        gnss = int(parts[2])
        pref = int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else None
    except ValueError:
        return
    state["systemMode"] = {"lteM": lte_m, "nbIot": nb, "gnss": gnss, "preference": pref}
    # nRF Cloud networkInfo.ueMode: 2 ≈ LTE-M, 1 ≈ NB-IoT
    if lte_m and not nb:
        state["ueMode"] = 2
    elif nb and not lte_m:
        state["ueMode"] = 1
    elif pref is not None:
        state["ueMode"] = pref
    # Refresh networkMode with GPS suffix if we already know AcT
    at = state.get("accessTech")
    if at:
        set_network_mode(state, at)
    elif lte_m:
        set_network_mode(state, "LTE-M")
    elif nb:
        set_network_mode(state, "NB-IoT")


def parse_xsnrsq(body: str, state: dict):
    parts = [p.strip() for p in body.split(",")]
    if not parts:
        return
    try:
        v = int(parts[0])
        # Nordic %XSNRSQ: 0–127 → SNR = value − 24 (same as XMONITOR)
        if 0 <= v <= 127:
            state["snr"] = v - 24
    except ValueError:
        pass


def ingest_wifi(txt: str, state: dict):
    for rx in (RE_WIFI_COUNT, RE_WIFI_COUNT2):
        m = rx.search(txt)
        if m:
            try:
                state["wifiApCount"] = int(m.group(1))
                state["wifiStatus"] = f"{state['wifiApCount']} APs"
                return
            except ValueError:
                pass
    # Count AP-ish lines in this chunk
    hits = [ln for ln in txt.splitlines() if RE_WIFI_AP_LINE.search(ln)]
    if hits:
        n = len(hits)
        prev = state.get("wifiApCount") or 0
        state["wifiApCount"] = max(prev, n)
        state["wifiStatus"] = state.get("wifiStatus") or f"{state['wifiApCount']} APs (uart)"
    elif re.search(r"wi-?fi\s+scan|scanning\s+wi-?fi|wifi_scan", txt, re.I):
        state["wifiStatus"] = state.get("wifiStatus") or "scan"


def ingest_text(txt: str, state: dict):
    txt = ANSI.sub("", txt)
    m = RE_XVBAT.search(txt)
    if m:
        state["batteryMv"] = int(m.group(1))
    m = RE_XMON.search(txt)
    if m:
        parse_xmonitor(m.group(1), state)
    m = RE_CESQ.search(txt)
    if m:
        parse_cesq(m.group(1), state)
    for m in RE_CGPADDR.finditer(txt):
        parse_cgpaddr(m.group(1), state)
    m = RE_COPS.search(txt)
    if m:
        parse_cops(m.group(1), state)
    for m in RE_XCBAND.finditer(txt):
        parse_xcband(m.group(1), state)
    m = RE_CEREG.search(txt)
    if m:
        parse_cereg(m.group(1), state)
    m = RE_XSYS.search(txt)
    if m:
        parse_xsystemmode(m.group(1), state)
    m = RE_XSNRSQ.search(txt)
    if m:
        parse_xsnrsq(m.group(1), state)
    ingest_wifi(txt, state)
    apply_plmn_hint(state)

    m = RE_TEMP.search(txt)
    if m:
        state["temperatureC"] = float(m.group(1))
    m = RE_HUM.search(txt)
    if m:
        state["humidityPct"] = float(m.group(1))
    m = RE_PRESS.search(txt)
    if m:
        raw = float(m.group(1))
        unit = (m.group(2) or "").lower()
        if unit == "kpa" or (not unit and 50.0 <= raw <= 120.0):
            hpa, how = raw * 10.0, "hPa_from_kPa"
        elif unit == "pa" and raw > 1000:
            hpa, how = raw / 100.0, "hPa_from_Pa"
        elif unit in ("hpa", "mbar") or (850.0 <= raw <= 1100.0):
            hpa, how = raw, "hPa"
        else:
            hpa, how = normalize_pressure(raw)
        state["pressure"] = round(float(hpa), 2)
        state["pressureUnit"] = how
        state["pressureRaw"] = raw
    for rx in (RE_GOT_LOC, RE_LATLON, RE_LATLON2, RE_MAPS_URL):
        m = rx.search(txt)
        if m and try_set_latlon(state, m.group(1), m.group(2)):
            break
    else:
        ml = RE_LAT_ONLY.search(txt)
        mn = RE_LON_ONLY.search(txt)
        if ml and mn:
            try_set_latlon(state, ml.group(1), mn.group(1))
    snips = state.get("uartLocSnippets") or []
    for line in txt.splitlines():
        if RE_LOC_SNIP.search(line):
            s = re.sub(r"\s+", " ", line).strip()[:180]
            if s and s not in snips:
                snips.append(s)
    if snips:
        state["uartLocSnippets"] = snips[-12:]
    if re.search(r"Got\s+location|Location acquired successfully|latitude\s*[:=]\s*[-+]?\d", txt, re.I):
        state["rawNotes"] = ((state.get("rawNotes") or "") + " loc_ok").strip()[:400]
        if state.get("lat") is None:
            state["rawNotes"] = ((state.get("rawNotes") or "") + " loc_no_coords_uart").strip()[:400]
        state["locationSource"] = state.get("locationSource") or "uart"
    if re.search(
        r"Location request failed|Getting location timed out|LOCATION_EVT_(ERROR|TIMEOUT)|Failed to acquire location",
        txt,
        re.I,
    ):
        state["rawNotes"] = ((state.get("rawNotes") or "") + " loc_fail").strip()[:400]
    if re.search(r"Cloud location request|LOCATION_EVT_CLOUD_LOCATION", txt, re.I):
        state["rawNotes"] = ((state.get("rawNotes") or "") + " loc_cloud_req").strip()[:400]
        if state.get("lat") is None:
            state["locationSource"] = state.get("locationSource") or "cloud_pending"


def open_port():
    last_err = None
    for p in discover_ports():
        if not p:
            continue
        if not os.path.exists(p):
            last_err = f"missing {p}"
            continue
        try:
            s = serial.Serial(p, BAUD, timeout=0.35, write_timeout=2, exclusive=True)
            return s, p, None
        except TypeError:
            try:
                s = serial.Serial(p, BAUD, timeout=0.35, write_timeout=2)
                return s, p, None
            except Exception as e:
                last_err = f"{p}: {e}"
        except SerialException as e:
            last_err = f"{p}: {e}"
        except Exception as e:
            last_err = f"{p}: {e}"
    return None, None, last_err or "no shell port"


def drain(ser, seconds=0.8):
    t0 = time.time()
    buf = b""
    while time.time() - t0 < seconds:
        chunk = ser.read(4096)
        if chunk:
            buf += chunk
        else:
            time.sleep(0.05)
    return buf


def main():
    write_pid()
    state = blank_state("starting")
    ser = None
    port = None
    print(f"[serial_telemetry] writing {OUT}", flush=True)
    print(f"[serial_telemetry] port candidates: {discover_ports()}", flush=True)
    try:
        while True:
            try:
                if ser is None or not ser.is_open:
                    ser, port, err = open_port()
                    if not ser:
                        state["ok"] = False
                        state["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                        state["rawNotes"] = f"port busy/unavailable: {err}"[:400]
                        atomic_write(OUT, state)
                        try:
                            atomic_write(OUT_ALT, state)
                        except Exception:
                            pass
                        time.sleep(3)
                        continue
                    print(f"[serial_telemetry] opened {port}", flush=True)
                    time.sleep(0.2)
                    try:
                        ser.reset_input_buffer()
                    except Exception:
                        pass

                for cmd in AT_CMDS:
                    try:
                        ser.write((cmd + "\n").encode())
                    except Exception as e:
                        raise SerialException(str(e))
                    time.sleep(0.35)
                raw = drain(ser, 2.0)
                raw += drain(ser, 2.0)
                txt = raw.decode(errors="replace")
                ingest_text(txt, state)
                state["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                state["port"] = port
                state["ok"] = (
                    state.get("batteryMv") is not None
                    or state.get("operator") is not None
                    or state.get("mccMnc") is not None
                    or state.get("temperatureC") is not None
                    or state.get("ipAddress") is not None
                    or state.get("rsrp") is not None
                )
                notes = state.get("rawNotes") or ""
                if notes.startswith("starting") or notes.startswith("port "):
                    notes = ""
                if not notes:
                    notes = "at_ok" if state["ok"] else "no_parse"
                state["rawNotes"] = notes[:400]
                apply_plmn_hint(state)
                atomic_write(OUT, state)
                try:
                    atomic_write(OUT_ALT, state)
                except Exception:
                    pass
                idle_end = time.time() + max(2.0, POLL_S - 5.5)
                while time.time() < idle_end:
                    chunk = ser.read(4096)
                    if chunk:
                        ingest_text(chunk.decode(errors="replace"), state)
                        state["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                        state["ok"] = True
                        apply_plmn_hint(state)
                        atomic_write(OUT, state)
                    else:
                        time.sleep(0.1)
            except (SerialException, OSError) as e:
                print(f"[serial_telemetry] port error: {e}", flush=True)
                try:
                    if ser:
                        ser.close()
                except Exception:
                    pass
                ser = None
                state["ok"] = False
                state["rawNotes"] = f"port error: {e}"[:400]
                state["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                atomic_write(OUT, state)
                time.sleep(2.5)
            except Exception as e:
                print(f"[serial_telemetry] err: {e}", flush=True)
                state["ok"] = False
                state["rawNotes"] = str(e)[:400]
                state["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                atomic_write(OUT, state)
                time.sleep(2.5)
    finally:
        clear_pid()
        try:
            if ser:
                ser.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
