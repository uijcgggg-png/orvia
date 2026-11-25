#!/usr/bin/env python3
"""Orvia Companion (Windows). Standard library only.

- Connects OUT to Orvia's server (no ports opened on your PC).
- Runs only a fixed list of actions (no shell, no arbitrary commands):
  open_url, open_app, volume, lock, screenshot, type_text.
- Asks you to approve on this PC before: open_url, open_app, screenshot, type_text.
- Pair once: it shows a long random code; send it to the Orvia chat (single use, 40 seconds).
Stop it anytime with Ctrl+C or by closing the window. Remove the device in Orvia Settings to revoke access.
"""
import base64, ctypes, glob, json, os, subprocess, sys, tempfile, time, urllib.request, urllib.error, webbrowser

SB = "https://wdiukcpegqeifllhauqf.supabase.co"
KEY = "sb_publishable_-3O5QNXd4bTtFu2aOUIhkA_Ef3RVNiz"
CFG = os.path.join(os.path.expanduser("~"), ".orvia-companion.json")
WIN = sys.platform == "win32"
DRY = ("--dry-run" in sys.argv) or not WIN  # on non-Windows nothing real is executed
CONFIRM = {"open_url", "open_app", "screenshot", "type_text"}

APPS = {  # fixed allowlist: name -> what to start
    "notepad": ["notepad.exe"],
    "calculator": ["calc.exe"],
    "explorer": ["explorer.exe"],
    "task manager": ["taskmgr.exe"],
    "settings": ["explorer.exe", "ms-settings:"],
    "chrome": ["cmd", "/c", "start", "", "chrome"],
    "edge": ["cmd", "/c", "start", "", "msedge"],
    "roblox studio": "ROBLOX_STUDIO",
    "roblox": "ROBLOX_PLAYER",
}


def rpc(name, body):
    req = urllib.request.Request(SB + "/rest/v1/rpc/" + name, data=json.dumps(body).encode(),
                                 headers={"apikey": KEY, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            t = r.read().decode()
            return json.loads(t) if t else None
    except urllib.error.HTTPError as e:
        raise RuntimeError(e.read().decode()[:300])


def ask(title, text):
    """On-device approval. Returns True only if the user clicks Yes."""
    if DRY:
        print("[confirm]", title, "|", text, "-> auto-yes (dry run)" if os.environ.get("ORVIA_AUTOYES") else "-> NO")
        return bool(os.environ.get("ORVIA_AUTOYES"))
    MB_YESNO, MB_ICONQUESTION, MB_TOPMOST, MB_SETFOREGROUND = 0x4, 0x20, 0x40000, 0x10000
    r = ctypes.windll.user32.MessageBoxW(0, text, title, MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SETFOREGROUND)
    return r == 6


def find_roblox(studio):
    base = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Roblox", "Versions", "*",
                        "RobloxStudioBeta.exe" if studio else "RobloxPlayerBeta.exe")
    f = sorted(glob.glob(base))
    return [f[-1]] if f else None


def do_open_url(a):
    u = str(a.get("url", ""))
    if not (u.startswith("https://") or u.startswith("http://")) or len(u) > 1000 or any(c in u for c in "\r\n\"<>"):
        raise ValueError("only http/https links allowed")
    if DRY: return "dry-run: would open " + u
    webbrowser.open(u)
    return "opened " + u


def do_open_app(a):
    n = str(a.get("name", "")).strip().lower()
    if n not in APPS:
        raise ValueError("app not in allowlist: " + n + " (allowed: " + ", ".join(APPS) + ")")
    cmd = APPS[n]
    if cmd == "ROBLOX_STUDIO": cmd = find_roblox(True)
    if cmd == "ROBLOX_PLAYER": cmd = find_roblox(False)
    if not cmd: raise ValueError("could not find " + n + " on this PC")
    if DRY: return "dry-run: would start " + n
    subprocess.Popen(cmd)
    return "started " + n


def do_volume(a):
    d = str(a.get("direction", "")).lower()
    steps = max(1, min(int(a.get("steps", 5) or 5), 25))
    vk = {"up": 0xAF, "down": 0xAE, "mute": 0xAD}.get(d)
    if vk is None: raise ValueError("direction must be up, down or mute")
    if DRY: return "dry-run: volume %s x%d" % (d, steps)
    for _ in range(1 if d == "mute" else steps):
        ctypes.windll.user32.keybd_event(vk, 0, 0, 0); ctypes.windll.user32.keybd_event(vk, 0, 2, 0); time.sleep(0.02)
    return "volume " + d


def do_lock(a):
    if DRY: return "dry-run: would lock"
    ctypes.windll.user32.LockWorkStation()
    return "locked"


PS_SHOT = r'''
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)
$w=1280;$h=[int]($b.Height*$w/$b.Width);$s=New-Object System.Drawing.Bitmap $w,$h
$g2=[System.Drawing.Graphics]::FromImage($s);$g2.DrawImage($bmp,0,0,$w,$h)
$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|?{$_.MimeType -eq 'image/jpeg'}
$p=New-Object System.Drawing.Imaging.EncoderParameters 1
$p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality),([long]55)
$s.Save($args[0],$enc,$p)
'''


def do_screenshot(a):
    if DRY: return "dry-run: would take a screenshot"
    out = os.path.join(tempfile.gettempdir(), "orvia-shot.jpg")
    ps = os.path.join(tempfile.gettempdir(), "orvia-shot.ps1")
    open(ps, "w").write(PS_SHOT)
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, out], check=True, timeout=30,
                   creationflags=0x08000000)
    data = open(out, "rb").read()
    os.remove(out)
    return "data:image/jpeg;base64," + base64.b64encode(data).decode()


class KI(ctypes.Structure if WIN else object):
    pass


def do_type_text(a):
    t = str(a.get("text", ""))
    if not t or len(t) > 500: raise ValueError("text must be 1-500 characters")
    if DRY: return "dry-run: would type %d chars" % len(t)
    time.sleep(3)  # time to click the right window
    from ctypes import wintypes
    PUL = ctypes.POINTER(ctypes.c_ulong)
    class KBD(ctypes.Structure):
        _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", PUL)]
    class MOU(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", PUL)]
    class U(ctypes.Union):
        _fields_ = [("ki", KBD), ("mi", MOU)]
    class INP(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("u", U)]
    for ch in t:
        for flag in (0x4, 0x4 | 0x2):  # UNICODE down / up
            i = INP(1, U(ki=KBD(0, ord(ch) if ord(ch) < 0x10000 else 0x3F, flag, 0, None)))
            ctypes.windll.user32.SendInput(1, ctypes.byref(i), ctypes.sizeof(INP))
        time.sleep(0.01)
    return "typed %d characters" % len(t)


ACTIONS = {"open_url": do_open_url, "open_app": do_open_app, "volume": do_volume, "lock": do_lock,
           "screenshot": do_screenshot, "type_text": do_type_text}


def describe(act, args):
    if act == "open_url": return "Open this link?\n\n" + str(args.get("url"))
    if act == "open_app": return "Start this app?\n\n" + str(args.get("name"))
    if act == "screenshot": return "Take a screenshot of your screen and send it to your Orvia chat?"
    if act == "type_text": return "Type this text into the window you have open (after 3 seconds)?\n\n" + str(args.get("text"))[:300]
    return act


def handle(cfg, c):
    act, args = c["action"], c.get("args") or {}
    try:
        if act not in ACTIONS: raise ValueError("action not allowed")
        if act in CONFIRM and not ask("Orvia wants to do something on this PC", describe(act, args)):
            rpc("device_report", {"p_device": cfg["device_id"], "p_secret": cfg["secret"], "p_cmd": c["id"], "p_status": "rejected", "p_result": "You declined on the PC."})
            print("rejected:", act); return
        res = ACTIONS[act](args)
        st = "done"
    except Exception as e:
        res, st = str(e)[:300], "failed"
    print(st + ":", act, str(res)[:80])
    rpc("device_report", {"p_device": cfg["device_id"], "p_secret": cfg["secret"], "p_cmd": c["id"], "p_status": st, "p_result": res})


def pair():
    """Phone-style pairing: this program shows a long random code; send it to the Orvia chat within 40 seconds."""
    while True:
        r = rpc("device_register", {"p_name": os.environ.get("COMPUTERNAME", "My PC"), "p_platform": "windows"})
        c = r["code"]; code = "ORV-" + "-".join(c[i:i + 5] for i in range(0, 30, 5))
        print("\nSend this code to the Orvia chat (works once, 40 seconds):\n\n    " + code + "\n")
        t0 = time.time()
        while time.time() - t0 < 42:
            st = rpc("device_status", {"p_device": r["device_id"], "p_secret": r["secret"]})
            if st.get("paired"):
                cfg = {"device_id": r["device_id"], "secret": r["secret"]}
                json.dump(cfg, open(CFG, "w"))
                try: os.chmod(CFG, 0o600)
                except Exception: pass
                print("Linked!"); return cfg
            time.sleep(2)
        print("Code expired, making a new one...")


def main():
    if "--unpair" in sys.argv:
        if os.path.exists(CFG): os.remove(CFG)
        print("Removed local pairing."); return
    cfg = json.load(open(CFG)) if os.path.exists(CFG) else None
    if not cfg:
        try: cfg = pair()
        except Exception as e:
            print("Pairing failed:", e); input("Press Enter to close"); return
    if DRY: print("DRY RUN: nothing real will be executed.")
    print("Orvia Companion is running. Close this window or press Ctrl+C to stop.")
    while True:
        try:
            for c in rpc("device_poll", {"p_device": cfg["device_id"], "p_secret": cfg["secret"]}) or []:
                handle(cfg, c)
        except RuntimeError as e:
            if "unauthorized" in str(e):
                print("This device was removed in Orvia. Run again to pair a new code."); os.remove(CFG); return
            print("error:", str(e)[:120]); time.sleep(5)
        except Exception as e:
            print("offline, retrying...", str(e)[:80]); time.sleep(5)
        time.sleep(2)


if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("Stopped.")
