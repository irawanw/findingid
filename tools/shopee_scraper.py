"""
shopee_scraper.py — Python keyword scraper for finding.id
==========================================================
Python drives Chrome like a human:
  Tab 1 = Shopee    — search bar → XHR intercepted by extension
  Tab 2 = Tokopedia — search bar → GraphQL intercepted by extension

Per-cycle flow:
  1. Check if scraper is enabled (via extension toggle → backend)
  2. Claim job from backend
  3. Switch to Tab 1 → type keyword → browse results + click card
  4. Switch to Tab 2 → type keyword → if OTP page detected → press Back
                                    → else browse results + click card
  5. Mark job done → rest → repeat

Chrome extension handles:
  - XHR / GraphQL interception
  - Product parsing (content.js)
  - Pushing to /api/ingest (background.js)
  - Affiliate jobs (pollAffiliateJobs)

Hotkeys:  F8 = Pause/Resume   F9 = Stop

Requirements:
  pip install requests pywin32 numpy keyboard uiautomation
"""

import ctypes
import ctypes.wintypes
import json
import math
import os
import random
import sys
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import requests

# ── Load .env ─────────────────────────────────────────────────────────────────
_env = Path(__file__).resolve().parent.parent / ".env"
if _env.exists():
    for _l in _env.read_text().splitlines():
        _l = _l.strip()
        if _l and not _l.startswith("#") and "=" in _l:
            _k, _, _v = _l.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip())

# ── Config ────────────────────────────────────────────────────────────────────
API_BASE  = 'https://finding.id'
API_KEY   = os.environ.get('INGEST_API_KEY', '')
AGENT_ID  = str(uuid.uuid4())

# Mouse lock — prevents 2 scraper instances from moving the mouse simultaneously
# Lock TTL must be > longest possible job duration (search + browse + wander)
MOUSE_LOCK_TTL_S  = 12 * 60  # 12 min
MOUSE_LOCK_WAIT_S = 30        # poll interval while waiting for lock

# How long to wait after pressing Enter for the extension to catch + push XHR
SCRAPE_WAIT_S    = (20, 35)
# How long to wander/read results before moving on
WANDER_AFTER_S   = (15, 25)
# Rest between jobs
REST_BETWEEN_S   = (3 * 60, 5 * 60)
# Retry when no job available
NO_JOB_WAIT_S    = (8, 15)
# Minimum browse time even for priority jobs (let XHR fire)
PRIORITY_SCRAPE_WAIT_S = (4, 6)

# ── Win32 helpers ─────────────────────────────────────────────────────────────
MOUSEEVENTF_MOVE        = 0x0001
MOUSEEVENTF_LEFTDOWN    = 0x0002
MOUSEEVENTF_LEFTUP      = 0x0004
MOUSEEVENTF_WHEEL       = 0x0800
MOUSEEVENTF_ABSOLUTE    = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000
INPUT_MOUSE             = 0

class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', ctypes.c_long), ('dy', ctypes.c_long),
                 ('mouseData', ctypes.c_ulong), ('dwFlags', ctypes.c_ulong),
                 ('time', ctypes.c_ulong), ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]

class INPUT(ctypes.Structure):
    class _INPUT(ctypes.Union):
        _fields_ = [('mi', MOUSEINPUT)]
    _anonymous_ = ('_input',)
    _fields_    = [('type', ctypes.c_ulong), ('_input', _INPUT)]

user32 = ctypes.windll.user32

def _send_mouse(flags, dx=0, dy=0, data=0):
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(dx=dx, dy=dy, mouseData=data, dwFlags=flags,
                        time=0, dwExtraInfo=None)
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))

def screen_size():
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)

def get_cursor_pos():
    pt = ctypes.wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y

def bezier_points(p0, p1, p2, p3, n=60):
    t = np.linspace(0, 1, n).reshape(-1, 1)
    b = ((1-t)**3*np.array(p0) + 3*(1-t)**2*t*np.array(p1) +
         3*(1-t)*t**2*np.array(p2) + t**3*np.array(p3))
    return [(int(r[0]), int(r[1])) for r in b]

def move_to(tx, ty, duration=None):
    sx, sy = get_cursor_pos()
    dist = math.hypot(tx - sx, ty - sy)
    if dist < 2:
        return
    if duration is None:
        speed    = random.uniform(600, 1200)
        duration = max(0.04, min(dist / speed, 0.5))
    off   = dist * random.uniform(0.1, 0.3)
    angle = math.atan2(ty - sy, tx - sx)
    perp  = angle + math.pi / 2
    c1 = (sx + dist*random.uniform(0.2,0.4)*math.cos(angle) + off*random.uniform(-0.5,0.5)*math.cos(perp),
          sy + dist*random.uniform(0.2,0.4)*math.sin(angle) + off*random.uniform(-0.5,0.5)*math.sin(perp))
    c2 = (sx + dist*random.uniform(0.6,0.8)*math.cos(angle) + off*random.uniform(-0.5,0.5)*math.cos(perp),
          sy + dist*random.uniform(0.6,0.8)*math.sin(angle) + off*random.uniform(-0.5,0.5)*math.sin(perp))
    steps  = max(10, int(dist / 15))
    points = bezier_points((sx, sy), c1, c2, (tx, ty), steps)
    sw, sh = screen_size()
    t0 = time.perf_counter()
    for i, (px, py) in enumerate(points):
        progress = i / max(len(points) - 1, 1)
        progress = progress * progress * (3 - 2 * progress)
        target_t = t0 + duration * progress
        now = time.perf_counter()
        if target_t > now:
            time.sleep(target_t - now)
        _send_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    dx=int(px * 65535 / max(sw - 1, 1)),
                    dy=int(py * 65535 / max(sh - 1, 1)))
        if random.random() < 0.1:
            time.sleep(random.uniform(0.005, 0.025))

def left_click(hold=None):
    _send_mouse(MOUSEEVENTF_LEFTDOWN)
    time.sleep(hold or random.uniform(0.03, 0.08))
    _send_mouse(MOUSEEVENTF_LEFTUP)

def scroll_up(lines=5):
    for _ in range(lines):
        _send_mouse(MOUSEEVENTF_WHEEL, data=ctypes.c_ulong(120).value)
        time.sleep(random.uniform(0.04, 0.10))

def set_clipboard(text):
    import win32clipboard
    win32clipboard.OpenClipboard()
    win32clipboard.EmptyClipboard()
    win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
    win32clipboard.CloseClipboard()

def navigate_via_addressbar(url):
    """Ctrl+L → paste url → Enter."""
    import win32api, win32con
    print(f'[scraper] → Ctrl+L → {url}')
    set_clipboard(url)
    win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
    win32api.keybd_event(ord('L'), 0, 0, 0)
    win32api.keybd_event(ord('L'), 0, win32con.KEYEVENTF_KEYUP, 0)
    win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)
    time.sleep(0.4)
    win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
    win32api.keybd_event(ord('A'), 0, 0, 0)
    win32api.keybd_event(ord('A'), 0, win32con.KEYEVENTF_KEYUP, 0)
    win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)
    time.sleep(0.1)
    win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
    win32api.keybd_event(ord('V'), 0, 0, 0)
    win32api.keybd_event(ord('V'), 0, win32con.KEYEVENTF_KEYUP, 0)
    win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)
    time.sleep(0.15)
    win32api.keybd_event(win32con.VK_RETURN, 0, 0, 0)
    win32api.keybd_event(win32con.VK_RETURN, 0, win32con.KEYEVENTF_KEYUP, 0)

def scroll_down(lines):
    for _ in range(lines):
        _send_mouse(MOUSEEVENTF_WHEEL, data=ctypes.c_ulong(-120).value)
        time.sleep(random.uniform(0.04, 0.10))

# ── Human wander ──────────────────────────────────────────────────────────────
def wander(seconds, stop_event, priority_event=None):
    sw, sh   = screen_size()
    vp_y1, vp_y2 = 145, int(sh * 0.78)
    deadline = time.time() + seconds

    def clamp(x, y):
        return max(60, min(sw-60, x)), max(vp_y1, min(vp_y2, y))

    while time.time() < deadline and not stop_event.is_set():
        if priority_event and priority_event.is_set():
            print('[scraper] ⚡ priority job arrived — stopping wander')
            return
        mode = random.choice(['read', 'scan', 'pause', 'hover'])
        if mode == 'pause':
            time.sleep(random.uniform(0.8, 2.2))
        elif mode == 'hover':
            cx, cy = get_cursor_pos()
            for _ in range(random.randint(2, 4)):
                nx, ny = clamp(cx + random.randint(-35, 35), cy + random.randint(-20, 20))
                move_to(nx, ny, duration=random.uniform(0.25, 0.7))
                time.sleep(random.uniform(0.1, 0.35))
        elif mode == 'read':
            cx, cy = get_cursor_pos()
            nx, ny = clamp(cx + random.randint(-140, 140), cy + random.randint(-70, 70))
            move_to(nx, ny)
            time.sleep(random.uniform(0.3, 1.1))
        else:
            x = random.randint(100, sw - 100)
            y = random.randint(vp_y1 + 20, vp_y2 - 20)
            move_to(x, y)
            time.sleep(random.uniform(0.2, 0.7))

        if random.random() < 0.30:
            lines = random.randint(1, 3)
            (scroll_down if random.random() < 0.5 else scroll_up)(lines)
            time.sleep(random.uniform(0.3, 0.8))

# ── Scroll through results then click a product card ──────────────────────────
def browse_results_and_click(total_wait_s, stop_event, priority_event=None, home_url='https://shopee.co.id'):
    """
    Full browsing sequence while the XHR job runs in background.
    priority_event: if set mid-browse, cut short after minimum XHR time.
    """
    import win32api, win32con
    sw, sh = screen_size()
    deadline = time.time() + total_wait_s

    # ── Phase 1: wait for page render (2–4s) ──────────────────────────────
    time.sleep(random.uniform(2.0, 4.0))
    if stop_event.is_set(): return

    # ── Phase 2: scroll down to see cards (use ~30% of remaining time) ────
    scroll_budget = (deadline - time.time()) * 0.30
    scroll_end    = time.time() + scroll_budget
    print('[scraper] scrolling results to find a card...')
    while time.time() < scroll_end and not stop_event.is_set():
        scroll_down(random.randint(2, 4))
        # Occasionally hover mouse over a card while scanning
        if random.random() < 0.5:
            mx = random.randint(int(sw * 0.10), int(sw * 0.90))
            my = random.randint(250, int(sh * 0.72))
            move_to(mx, my, duration=random.uniform(0.25, 0.55))
        time.sleep(random.uniform(0.7, 1.8))
    if stop_event.is_set(): return

    # ── Phase 3: click a visible card ─────────────────────────────────────
    # Pick from currently visible area (row 1–2 of the grid, any of 3 columns)
    grid_x1 = int(sw * 0.08)
    grid_x2 = int(sw * 0.92)
    grid_y1 = int(sh * 0.28)
    grid_y2 = int(sh * 0.72)
    cols = 3

    col    = random.randint(0, cols - 1)
    cell_w = (grid_x2 - grid_x1) // cols
    tx = grid_x1 + col * cell_w + random.randint(20, cell_w - 20)
    ty = random.randint(grid_y1, grid_y2)

    print(f'[scraper] clicking card at ({tx}, {ty})')
    move_to(tx + random.randint(-20, 20), ty + random.randint(-12, 12))
    time.sleep(random.uniform(0.15, 0.30))
    move_to(tx, ty)
    time.sleep(random.uniform(0.08, 0.15))
    left_click()
    time.sleep(random.uniform(1.2, 2.5))   # wait for product page to load
    if stop_event.is_set(): return

    # ── Phase 4: read product page — stop early if priority job arrives ──
    remaining = deadline - time.time()
    print(f'[scraper] reading product page ({remaining:.0f}s remaining)...')
    while time.time() < deadline and not stop_event.is_set():
        if priority_event and priority_event.is_set():
            print('[scraper] priority job detected — cutting browse short')
            break
        action = random.random()
        if action < 0.60:
            # Slow read-scroll downward
            scroll_down(random.randint(2, 4))
        elif action < 0.75:
            # Glance back up (like re-reading specs)
            scroll_up(random.randint(1, 3))
        elif action < 0.90:
            # Move mouse as if reading text
            mx = random.randint(int(sw * 0.15), int(sw * 0.85))
            my = random.randint(200, int(sh * 0.82))
            move_to(mx, my, duration=random.uniform(0.4, 0.9))
        # else: idle pause
        time.sleep(random.uniform(1.0, 3.0))
    if stop_event.is_set(): return

    # ── Phase 5: Ctrl+L → home_url ────────────────────────────────────────
    navigate_via_addressbar(home_url)
    time.sleep(random.uniform(2.5, 4.0))

# ── Tab switching ─────────────────────────────────────────────────────────────
def switch_tab(n):
    """Press Ctrl+n to switch Chrome to tab n (1-indexed)."""
    import win32api, win32con
    vk = ord(str(n))
    win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
    time.sleep(0.05)
    win32api.keybd_event(vk, 0, 0, 0)
    time.sleep(0.05)
    win32api.keybd_event(vk, 0, win32con.KEYEVENTF_KEYUP, 0)
    time.sleep(0.05)
    win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)
    time.sleep(random.uniform(1.0, 1.8))   # wait for tab to focus + render

def press_back():
    """Navigate to tokopedia.com via address bar (replaces Alt+Left)."""
    navigate_via_addressbar('https://www.tokopedia.com')
    time.sleep(random.uniform(2.0, 3.5))

def get_chrome_title():
    """Return the current Chrome window title (includes page title / URL)."""
    buf = ctypes.create_unicode_buffer(512)
    hwnd = user32.FindWindowW('Chrome_WidgetWin_1', None)
    if hwnd:
        user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value

def is_otp_page():
    """Return True if Tokopedia is showing an OTP / verification page."""
    title = get_chrome_title().lower()
    triggers = ['otp', 'verifikasi', 'verify', 'verification', 'konfirmasi',
                'masukkan kode', 'enter code', 'phone number', 'nomor hp']
    return any(kw in title for kw in triggers)

# ── Keyboard typing ───────────────────────────────────────────────────────────
def type_text(text):
    """Type text with human-like delays using keyboard lib."""
    import keyboard
    for ch in text:
        keyboard.write(ch)
        time.sleep(random.uniform(0.02, 0.06))

def press_key(key):
    import win32api, win32con
    vk = {
        'enter':    win32con.VK_RETURN,
        'ctrl+a':   None,  # handled separately
        'ctrl+home': None,
    }.get(key)
    if key == 'enter':
        win32api.keybd_event(win32con.VK_RETURN, 0, 0, 0)
        time.sleep(0.05)
        win32api.keybd_event(win32con.VK_RETURN, 0, win32con.KEYEVENTF_KEYUP, 0)
    elif key == 'ctrl+a':
        win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
        win32api.keybd_event(ord('A'), 0, 0, 0)
        win32api.keybd_event(ord('A'), 0, win32con.KEYEVENTF_KEYUP, 0)
        win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)
    elif key == 'ctrl+home':
        win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
        win32api.keybd_event(win32con.VK_HOME, 0, 0, 0)
        win32api.keybd_event(win32con.VK_HOME, 0, win32con.KEYEVENTF_KEYUP, 0)
        win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)

# ── Search bar finder ─────────────────────────────────────────────────────────
def find_search_bar():
    """
    Find Shopee's search bar via UIAutomation (EditControl in header area).
    Returns (cx, cy) centre coords, or None if not found.
    """
    try:
        import uiautomation as auto
        chrome_hwnd = user32.FindWindowW('Chrome_WidgetWin_1', None)
        if not chrome_hwnd:
            print('[scraper] Chrome window not found')
            return None

        browser = auto.ControlFromHandle(chrome_hwnd)
        sw, sh  = screen_size()

        def walk(ctrl, depth=0):
            if depth > 20:
                return
            try:
                yield ctrl
                for child in ctrl.GetChildren():
                    yield from walk(child, depth + 1)
            except Exception:
                pass

        candidates = []
        for ctrl in walk(browser):
            try:
                if ctrl.ControlType not in (auto.ControlType.EditControl,
                                             auto.ControlType.ComboBoxControl):
                    continue
                rect = ctrl.BoundingRectangle
                w = rect.right - rect.left
                h = rect.bottom - rect.top
                # Search bar is wide (>200px) and in the page header area
                if w < 200 or h < 20:
                    continue
                cy = (rect.top + rect.bottom) // 2
                # Skip Chrome's own address bar (cy < 60) and anything too far down (cy > 350)
                # Shopee's search bar sits in the page header, typically cy 80-200px
                if cy < 60 or cy > 350:
                    continue
                cx = (rect.left + rect.right) // 2
                candidates.append((cx, cy, w))
            except Exception:
                continue

        if not candidates:
            print('[scraper] search bar not found via UIAutomation')
            return None

        # Pick widest candidate (most likely the main search bar)
        best = max(candidates, key=lambda c: c[2])
        print(f'[scraper] search bar found at ({best[0]}, {best[1]}) w={best[2]}')
        return best[0], best[1]

    except ImportError:
        print('[scraper] uiautomation not installed — using fallback coords')
        return None
    except Exception as e:
        print(f'[scraper] search bar error: {e}')
        return None

def search_bar_fallback_coords():
    """Estimate search bar position: horizontally centred, ~95px from top."""
    sw, _sh = screen_size()
    return sw // 2, 95

# ── Main search action ────────────────────────────────────────────────────────
def do_search(keyword, stop_event, extra_y=0):
    """
    Scroll to top → find search bar → click → clear → type keyword → Enter.
    extra_y: additional pixels to add to the search bar Y coord (e.g. Tokopedia
             needs +15–20px to land inside the input rather than above it).
    """
    sw, sh = screen_size()

    # 1. Scroll to top
    print('[scraper] scrolling to top...')
    press_key('ctrl+home')
    time.sleep(random.uniform(0.15, 0.3))
    cx, cy = sw // 2, sh // 2
    move_to(cx, cy)
    for _ in range(random.randint(1, 3)):
        scroll_up(random.randint(3, 6))
        time.sleep(random.uniform(0.08, 0.18))
        if stop_event.is_set(): return False

    time.sleep(random.uniform(0.2, 0.4))

    # 2. Find search bar
    coords = find_search_bar() or search_bar_fallback_coords()
    bx, by = coords[0], coords[1] + 60 + extra_y

    # 3. Move to search bar
    print(f'[scraper] moving to search bar ({bx}, {by}) extra_y={extra_y}...')
    move_to(bx + random.randint(-30, 30), by + random.randint(-5, 5))
    time.sleep(random.uniform(0.05, 0.12))
    move_to(bx, by)
    time.sleep(random.uniform(0.05, 0.12))

    # 4. Click search bar
    left_click()
    time.sleep(random.uniform(0.08, 0.15))

    # 5. Select all existing text and replace
    press_key('ctrl+a')
    time.sleep(random.uniform(0.05, 0.1))

    # 6. Type keyword
    print(f'[scraper] typing "{keyword}"...')
    type_text(keyword)
    time.sleep(random.uniform(0.1, 0.25))

    # 7. Press Enter
    press_key('enter')
    print('[scraper] search submitted')
    return True

# ── Backend API ───────────────────────────────────────────────────────────────
SESSION = requests.Session()
SESSION.headers.update({
    'X-API-Key':    API_KEY,
    'X-Agent-ID':   AGENT_ID,
    'Content-Type': 'application/json',
})

def claim_job():
    try:
        r = SESSION.get(f'{API_BASE}/api/jobs', timeout=10)
        if r.status_code == 200:
            return r.json().get('job')
    except Exception as e:
        print(f'[scraper] claim_job error: {e}')
    return None

def has_priority_job():
    """Peek whether any high-priority (user search) job is waiting."""
    try:
        r = SESSION.get(f'{API_BASE}/api/jobs/peek', timeout=5)
        if r.status_code == 200:
            job = r.json().get('job')
            return job is not None and job.get('priority', 0) >= 1
    except Exception:
        pass
    return False

def seed_job():
    """Trigger the backend seeder to queue a keyword job immediately."""
    try:
        r = SESSION.post(f'{API_BASE}/api/jobs/seed', timeout=10)
        if r.status_code == 200:
            print('[scraper] seeder triggered')
        else:
            print(f'[scraper] seed returned {r.status_code}')
    except Exception as e:
        print(f'[scraper] seed_job error: {e}')

def complete_job(job_id, products_ingested=0):
    try:
        SESSION.post(f'{API_BASE}/api/jobs/{job_id}/done',
                     data=json.dumps({'productsIngested': products_ingested}),
                     timeout=10)
        print(f'[scraper] job {job_id[:8]}… marked done')
    except Exception as e:
        print(f'[scraper] complete_job error: {e}')

# ── Hotkeys ───────────────────────────────────────────────────────────────────
class HotkeyController:
    def __init__(self):
        self._stop   = threading.Event()
        self._paused = threading.Event()
        try:
            import keyboard
            keyboard.add_hotkey('f8', self._toggle_pause, suppress=False)
            keyboard.add_hotkey('f9', self._do_stop,       suppress=False)
            print('[hotkey] F8=pause/resume  F9=stop')
        except Exception as e:
            print(f'[hotkey] unavailable ({e}), Ctrl+C only')

    def _toggle_pause(self):
        if self._paused.is_set():
            self._paused.clear(); print('\n[hotkey] ▶  RESUMED')
        else:
            self._paused.set();   print('\n[hotkey] ⏸  PAUSED')

    def _do_stop(self):
        self._stop.set(); self._paused.clear(); print('\n[hotkey] ⏹  STOP')

    @property
    def should_stop(self): return self._stop.is_set()

    def wait_if_paused(self):
        while self._paused.is_set():
            if self._stop.is_set(): return False
            time.sleep(0.2)
        return not self._stop.is_set()

    def sleep(self, seconds, wake_event=None):
        """Interruptible sleep. Wakes early if stop, pause cleared, or wake_event is set."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self._stop.is_set(): return
            if wake_event and wake_event.is_set(): return
            self.wait_if_paused()
            time.sleep(0.15)

# ── Mouse lock (for multi-instance coordination) ──────────────────────────────
def acquire_mouse_lock(stop_event=None, max_wait_s=300):
    """Block until this instance holds the global mouse lock or stop is set."""
    deadline = time.time() + max_wait_s
    while time.time() < deadline:
        if stop_event and stop_event.is_set():
            return False
        try:
            r = requests.post(
                f'{API_BASE}/api/scraper/lock',
                headers={'X-API-Key': API_KEY},
                json={'agent': AGENT_ID, 'ttl': MOUSE_LOCK_TTL_S},
                timeout=5,
            )
            if r.ok and r.json().get('held'):
                print(f'[scraper] 🔒 mouse lock acquired')
                return True
            holder = r.json().get('holder', '?')[:8]
            print(f'[scraper] ⏳ mouse busy (holder={holder}…) — waiting {MOUSE_LOCK_WAIT_S}s')
        except Exception as e:
            print(f'[scraper] lock request error: {e}')
        time.sleep(MOUSE_LOCK_WAIT_S)
    print('[scraper] ⚠ gave up waiting for mouse lock — proceeding anyway')
    return True

def release_mouse_lock():
    """Release the global mouse lock."""
    try:
        requests.delete(
            f'{API_BASE}/api/scraper/lock',
            headers={'X-API-Key': API_KEY},
            json={'agent': AGENT_ID},
            timeout=5,
        )
        print(f'[scraper] 🔓 mouse lock released')
    except Exception:
        pass

def is_scraper_enabled():
    """Check if the 'List Scrape' toggle is ON in the extension (synced to backend)."""
    try:
        r = requests.get(
            f'{API_BASE}/api/scraper/enabled',
            headers={'X-API-Key': API_KEY},
            timeout=5,
        )
        return r.ok and r.json().get('enabled', True)
    except Exception:
        return True  # default: enabled if backend unreachable

# ── Main loop ─────────────────────────────────────────────────────────────────
def run():
    hotkey = HotkeyController()
    sw, sh = screen_size()
    print(f'[scraper] agent={AGENT_ID[:8]}…  screen={sw}x{sh}')
    print('[scraper] Chrome must be open with finding.id extension active\n')

    # Background thread: polls every 3s and sets priority_event when a priority job arrives
    priority_event = threading.Event()

    def priority_watcher():
        while not hotkey.should_stop:
            time.sleep(3)
            if not priority_event.is_set() and has_priority_job():
                print('[scraper] ⚡ priority job detected by watcher')
                priority_event.set()

    watcher = threading.Thread(target=priority_watcher, daemon=True)
    watcher.start()

    # Trigger seeder immediately so there's always a job to pick up on startup
    seed_job()
    time.sleep(1.5)

    cycle = 0
    while not hotkey.should_stop:
        if not hotkey.wait_if_paused():
            break

        cycle += 1
        print(f'\n[scraper] ── cycle {cycle} ──  [F8=pause  F9=stop]')

        # ── 1. Claim job ──────────────────────────────────────────
        job = claim_job()
        if not job:
            wait = random.uniform(*NO_JOB_WAIT_S)
            print(f'[scraper] no job — waiting {wait:.0f}s')
            hotkey.sleep(wait)
            continue

        keyword = job.get('query', '').strip()
        job_id  = job.get('id', '')
        if not keyword:
            complete_job(job_id, 0)
            continue

        is_priority = job.get('priority', 0) >= 1
        tag = '⚡' if is_priority else '·'
        print(f'[scraper] {tag} job={job_id[:8]}… priority={job.get("priority",0)} keyword="{keyword}"')

        # Clear priority flag for this cycle — we're about to handle it
        priority_event.clear()

        # ── 2. Check if scraper is enabled via extension toggle ───
        if not is_scraper_enabled():
            print('[scraper] ⏸ List Scrape disabled in extension — waiting 30s')
            hotkey.sleep(30)
            continue

        # ── 3. SHOPEE (Tab 1) — search ────────────────────────────
        print('[scraper] switching to Shopee (tab 1)...')
        switch_tab(1)
        ok = do_search(keyword, hotkey._stop)
        if not ok or hotkey.should_stop: break

        # Brief pause — let XHR kick off
        time.sleep(random.uniform(1.0, 2.0))
        if hotkey.should_stop: break

        # ── 4. TOKOPEDIA (Tab 2) — search ─────────────────────────
        print('[scraper] switching to Tokopedia (tab 2)...')
        switch_tab(2)
        ok = do_search(keyword, hotkey._stop)
        if not ok or hotkey.should_stop: break

        time.sleep(random.uniform(1.5, 2.5))
        otp_detected = is_otp_page()
        if otp_detected:
            print('[scraper] Tokopedia OTP detected — pressing back')
            press_back()
        if hotkey.should_stop: break

        # ── 5. SHOPEE — browse (short if priority job waiting) ────
        print('[scraper] back to Shopee to browse...')
        switch_tab(1)

        if priority_event.is_set():
            wait = random.uniform(*PRIORITY_SCRAPE_WAIT_S)
            print(f'[scraper] ⚡ priority queued — short Shopee browse {wait:.0f}s')
        else:
            wait = random.uniform(*SCRAPE_WAIT_S)
            print(f'[scraper] Shopee: browsing {wait:.0f}s...')
        browse_results_and_click(wait, hotkey._stop, priority_event, home_url='https://shopee.co.id')
        if hotkey.should_stop: break

        # Wander only if no priority job waiting
        if not priority_event.is_set():
            wander_s = random.uniform(*WANDER_AFTER_S)
            print(f'[scraper] Shopee: wandering {wander_s:.0f}s')
            wander(wander_s, hotkey._stop, priority_event)
            if hotkey.should_stop: break
        else:
            print('[scraper] ⚡ skipping Shopee wander — priority job queued')

        # ── 6. TOKOPEDIA — browse (skip if OTP or priority) ───────
        if not otp_detected:
            print('[scraper] switching to Tokopedia to browse...')
            switch_tab(2)

            if priority_event.is_set():
                wait_toko = random.uniform(*PRIORITY_SCRAPE_WAIT_S)
                print(f'[scraper] ⚡ priority queued — short Tokopedia browse {wait_toko:.0f}s')
            else:
                wait_toko = random.uniform(*SCRAPE_WAIT_S)
                print(f'[scraper] Tokopedia: browsing {wait_toko:.0f}s...')
            browse_results_and_click(wait_toko, hotkey._stop, priority_event, home_url='https://www.tokopedia.com')
            if hotkey.should_stop: break

            if not priority_event.is_set():
                wander_s = random.uniform(*WANDER_AFTER_S)
                print(f'[scraper] Tokopedia: wandering {wander_s:.0f}s')
                wander(wander_s, hotkey._stop, priority_event)
                if hotkey.should_stop: break
            else:
                print('[scraper] ⚡ skipping Tokopedia wander — priority job queued')

        # ── 6. Mark job done ──────────────────────────────────────
        complete_job(job_id)

        # ── 7. Rest — browse & wander instead of idle ─────────────
        if priority_event.is_set():
            print('[scraper] ⚡ skipping rest — priority job queued')
        else:
            rest = random.uniform(*REST_BETWEEN_S)
            rest_deadline = time.time() + rest
            print(f'[scraper] resting {rest:.0f}s with active browsing')
            cycle_r = 0
            while time.time() < rest_deadline and not hotkey.should_stop:
                if priority_event.is_set():
                    print('[scraper] ⚡ priority arrived — ending rest early')
                    break
                remaining = rest_deadline - time.time()
                if remaining <= 0:
                    break
                cycle_r += 1
                # Alternate between Shopee and Tokopedia each rest cycle
                tab = 1 if cycle_r % 2 == 1 else 2
                label = 'Shopee' if tab == 1 else 'Tokopedia'
                tab_url = 'https://shopee.co.id' if tab == 1 else 'https://www.tokopedia.com'
                print(f'[scraper] rest cycle {cycle_r} → {label} (tab {tab})')
                switch_tab(tab)
                browse_t = min(random.uniform(*SCRAPE_WAIT_S), remaining * 0.5)
                browse_results_and_click(browse_t, hotkey._stop, priority_event, home_url=tab_url)
                if hotkey.should_stop or priority_event.is_set(): break
                remaining = rest_deadline - time.time()
                if remaining <= 5: break
                wander_t = min(random.uniform(*WANDER_AFTER_S), remaining * 0.6)
                wander(wander_t, hotkey._stop, priority_event)
            print('[scraper] rest done')

    print('[scraper] stopped.')

# ── Entry ─────────────────────────────────────────────────────────────────────
def check_deps():
    required = {'win32api': 'pywin32', 'numpy': 'numpy',
                 'requests': 'requests', 'keyboard': 'keyboard'}
    missing = [pkg for mod, pkg in required.items()
               if not __import__(mod) and True
               or (lambda: (lambda m: False)(__import__(mod)))()]
    # simpler check:
    missing = []
    for mod, pkg in required.items():
        try: __import__(mod)
        except ImportError: missing.append(pkg)
    if missing:
        print(f'pip install {" ".join(missing)}')
        sys.exit(1)

if __name__ == '__main__':
    if sys.platform != 'win32':
        print('Windows only.'); sys.exit(1)
    check_deps()
    print('=' * 55)
    print('  finding.id — Scraper  (Tab1=Shopee  Tab2=Tokopedia)')
    print('  F8 = Pause/Resume    F9 = Stop')
    print('  Chrome tabs:  1=Shopee  2=Tokopedia')
    print('  Toggle "List Scrape" in extension popup to pause')
    print('=' * 55 + '\n')
    try:
        run()
    except KeyboardInterrupt:
        pass
    print('[scraper] done.')
