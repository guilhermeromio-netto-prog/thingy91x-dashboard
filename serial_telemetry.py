#!/usr/bin/env python3
"""Thingy:91 X serial telemetry poller — VCOM0 shell @ 115200 → serial-telemetry.json"""
from __future__ import annotations

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
PORTS = [
    os.environ.get("THINGY_PORT", ""),
    "/dev/cu.usbmodem102",
    "/dev/tty.usbmodem102",
]
BAUD = 115200
POLL_S = float(os.environ.get("THINGY_SERIAL_POLL", "10"))
AT_CMDS = ["at AT%XVBAT", "at AT%XMONITOR", "at AT+CESQ"]

RE_TEMP = re.compile(r"Temperature:\s*([-+]?\d+(?:\.\d+)?)\s*C", re.I)
RE_HUM = re.compile(r"Humidity:\s*([-+]?\d+(?:\.\d+)?)\s*%", re.I)
RE_PRESS = re.compile(r"Pressure:\s*([-+]?\d+(?:\.\d+)?)(?:\s*(Pa|kPa|hPa|mbar))?", re.I)
# ATT DBG: "Got location: lat: X, lon: Y, acc: Z, method: ..."
RE_GOT_LOC = re.compile(
    r"Got\s+location\s*:\s*lat\s*:\s*([-+]?\d+(?:\.\d+)?)\s*,\s*lon\s*:\s*([-+]?\d+(?:\.\d+)?)",
    re.I,
)
# Same-line or multi-line latitude / longitude (NCS location sample style)
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
        "band": None,
        "rsrp": None,
        "rsrq": None,
        "temperatureC": None,
        "humidityPct": None,
        "pressure": None,
        "pressureUnit": None,
        "pressureRaw": None,
        "lat": None,
        "lon": None,
        "locationAccuracy": None,
        "locationSource": None,
        "tac": None,
        "tacDec": None,
        "eci": None,
        "eciDec": None,
        "mcc": None,
        "mnc": None,
        "uartLocSnippets": [],
        "rawNotes": err or "",
        "ok": False,
        "port": None,
    }



def normalize_pressure(raw: float):
    """BME680 Zephyr often logs kPa as 'Pa'. São Paulo ~930 hPa.
    Values ~50–120 → treat as kPa → store hPa (*10). Already-hPa (~850–1100) kept.
    """
    if raw is None:
        return None, None
    if 50.0 <= raw <= 120.0:
        return round(raw * 10.0, 2), "hPa_from_kPa"
    if 850.0 <= raw <= 1100.0:
        return round(raw, 2), "hPa"
    if 50000.0 <= raw <= 120000.0:  # true Pa
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


def parse_xmonitor(body: str, state: dict):
    # CSV-ish with quoted strings
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
    # <reg>,<full>,<short>,<plmn>,<tac>,<AcT>,<band>,<cell_id>[,phys,earfcn,rsrp,snr,...]
    if len(parts) >= 4 and parts[3]:
        state["mccMnc"] = parts[3]
    if len(parts) >= 2 and parts[1]:
        state["operator"] = parts[1]
    elif state.get("mccMnc"):
        state["operator"] = state["operator"] or state["mccMnc"]
    if len(parts) >= 7 and parts[6]:
        try:
            state["band"] = int(parts[6])
        except ValueError:
            state["band"] = parts[6]
    # optional rsrp at index 10 — only accept Nordic coded range 0..97 (ignore bitmasks like 11100000)
    if len(parts) >= 11 and parts[10] and parts[10].isdigit():
        try:
            v = int(parts[10])
            if 0 <= v <= 97:
                state["rsrp"] = v - 140
        except ValueError:
            pass
    # RSRQ coded 0..34 at index 15 when present; skip binary-looking strings
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
        try:
            state["eciDec"] = int(parts[7], 16)
        except ValueError:
            pass
    plmn = state.get("mccMnc") or ""
    if plmn.isdigit() and len(plmn) >= 5:
        try:
            state["mcc"] = int(plmn[:3])
            state["mnc"] = int(plmn[3:])
        except ValueError:
            pass
    notes = state.get("rawNotes") or ""
    if len(parts) >= 8:
        notes = (notes + f" cell={parts[7]} tac={parts[4] if len(parts)>4 else ''} act={parts[5] if len(parts)>5 else ''}").strip()
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
    # Prefer explicit ATT / NCS location formats
    for rx in (RE_GOT_LOC, RE_LATLON, RE_LATLON2, RE_MAPS_URL):
        m = rx.search(txt)
        if m and try_set_latlon(state, m.group(1), m.group(2)):
            break
    else:
        # Multi-line latitude / longitude printed separately
        ml = RE_LAT_ONLY.search(txt)
        mn = RE_LON_ONLY.search(txt)
        if ml and mn:
            try_set_latlon(state, ml.group(1), mn.group(1))
    # Keep short UART location breadcrumbs (for debugging missing coords)
    snips = state.get("uartLocSnippets") or []
    for line in txt.splitlines():
        if RE_LOC_SNIP.search(line):
            s = re.sub(r"\s+", " ", line).strip()[:180]
            if s and s not in snips:
                snips.append(s)
    if snips:
        state["uartLocSnippets"] = snips[-12:]
    # LOCATION success / fail breadcrumbs (precise; avoid marking cloud-only as fix)
    if re.search(r"Got\s+location|Location acquired successfully|latitude\s*[:=]\s*[-+]?\d", txt, re.I):
        state["rawNotes"] = ((state.get("rawNotes") or "") + " loc_ok").strip()[:400]
        if state.get("lat") is None:
            # Cloud Wi-Fi/cellular often succeeds without printing coords on UART
            state["rawNotes"] = ((state.get("rawNotes") or "") + " loc_no_coords_uart").strip()[:400]
        state["locationSource"] = state.get("locationSource") or "uart"
    if re.search(r"Location request failed|Getting location timed out|LOCATION_EVT_(ERROR|TIMEOUT)|Failed to acquire location", txt, re.I):
        state["rawNotes"] = ((state.get("rawNotes") or "") + " loc_fail").strip()[:400]
    if re.search(r"Cloud location request|LOCATION_EVT_CLOUD_LOCATION", txt, re.I):
        state["rawNotes"] = ((state.get("rawNotes") or "") + " loc_cloud_req").strip()[:400]
        if state.get("lat") is None:
            state["locationSource"] = state.get("locationSource") or "cloud_pending"


def open_port():
    last_err = None
    for p in PORTS:
        if not p:
            continue
        if not os.path.exists(p):
            last_err = f"missing {p}"
            continue
        try:
            s = serial.Serial(p, BAUD, timeout=0.35, write_timeout=2, exclusive=True)
            return s, p, None
        except TypeError:
            # older pyserial without exclusive=
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
    try:
        while True:
            try:
                if ser is None or not ser.is_open:
                    ser, port, err = open_port()
                    if not ser:
                        # Soft fail: keep last-known sensors; only mark offline
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

                # send AT batch
                for cmd in AT_CMDS:
                    try:
                        ser.write((cmd + "\n").encode())
                    except Exception as e:
                        raise SerialException(str(e))
                    time.sleep(0.45)
                raw = drain(ser, 1.6)
                # also listen briefly for spontaneous env/location lines
                raw += drain(ser, 2.0)
                txt = raw.decode(errors="replace")
                ingest_text(txt, state)
                state["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                state["port"] = port
                state["ok"] = state.get("batteryMv") is not None or state.get("operator") is not None or state.get("temperatureC") is not None
                notes = state.get("rawNotes") or ""
                if notes.startswith("starting") or notes.startswith("port "):
                    notes = ""
                if not notes:
                    notes = "at_ok" if state["ok"] else "no_parse"
                state["rawNotes"] = notes[:400]
                atomic_write(OUT, state)
                try:
                    atomic_write(OUT_ALT, state)
                except Exception:
                    pass
                # idle listen for spontaneous logs until next poll
                idle_end = time.time() + max(2.0, POLL_S - 4.5)
                while time.time() < idle_end:
                    chunk = ser.read(4096)
                    if chunk:
                        ingest_text(chunk.decode(errors="replace"), state)
                        state["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                        state["ok"] = True
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
