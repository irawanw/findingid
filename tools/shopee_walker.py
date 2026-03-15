"""
shopee_walker.py — Human-like mouse simulator for Shopee browsing
================================================================
Simulates realistic human behavior:
  - Bezier-curve mouse movement (no straight lines)
  - Random speed variation (fast in middle, slow at start/end)
  - Natural scrolling with momentum
  - Periodic link discovery and clicking via Windows Accessibility API
  - 10-15 second wander loops, then pick & click a product link

Hotkeys (work even when browser is focused):
  F8          — Pause / Resume
  F9          — Stop completely
  F10         — Skip current wander, click immediately

Requirements:
    pip install pywin32 pillow numpy comtypes keyboard

Usage:
    1. Open Chrome/Edge and navigate to a Shopee page
    2. Run:  python shopee_walker.py
    3. Use F8/F9/F10 to control
"""

import ctypes
import ctypes.wintypes
import math
import random
import time
import sys
import threading

import numpy as np

# ── Random Shopee search keywords (for recovery navigation) ──────────────────
SEARCH_KEYWORDS = [
    "baju", "sepatu", "tas", "hp samsung", "laptop", "kamera", "jam tangan",
    "headphone", "kursi gaming", "meja belajar", "lampu tidur", "parfum pria",
    "skincare wajah", "mainan anak", "buku pelajaran", "alat masak", "selimut",
    "powerbank", "mouse wireless", "charger usb c",
]

# ── Win32 SendInput (real OS-level events, bypasses JS detection) ─────────────
MOUSEEVENTF_MOVE        = 0x0001
MOUSEEVENTF_LEFTDOWN    = 0x0002
MOUSEEVENTF_LEFTUP      = 0x0004
MOUSEEVENTF_WHEEL       = 0x0800
MOUSEEVENTF_ABSOLUTE    = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

INPUT_MOUSE = 0

class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx",          ctypes.c_long),
        ("dy",          ctypes.c_long),
        ("mouseData",   ctypes.c_ulong),
        ("dwFlags",     ctypes.c_ulong),
        ("time",        ctypes.c_ulong),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]

class INPUT(ctypes.Structure):
    class _INPUT(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT)]
    _anonymous_ = ("_input",)
    _fields_    = [("type", ctypes.c_ulong), ("_input", _INPUT)]

user32 = ctypes.windll.user32

def _send_mouse(flags, dx=0, dy=0, data=0):
    """Fire a single SendInput mouse event."""
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(
        dx=dx, dy=dy, mouseData=data, dwFlags=flags,
        time=0, dwExtraInfo=None
    )
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))

def screen_size():
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)

def get_cursor_pos():
    pt = ctypes.wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y

# ── Bezier curve mouse movement ───────────────────────────────────────────────

def bezier_points(p0, p1, p2, p3, n=60):
    """Cubic Bezier from p0→p3 via control points p1,p2."""
    t = np.linspace(0, 1, n).reshape(-1, 1)  # (n,1) so it broadcasts with (2,) points
    b = (
        (1-t)**3       * np.array(p0) +
        3*(1-t)**2*t   * np.array(p1) +
        3*(1-t)*t**2   * np.array(p2) +
        t**3           * np.array(p3)
    )  # shape (n, 2)
    return [(int(row[0]), int(row[1])) for row in b]

def ease_in_out(t):
    """Smooth speed: slow start, fast middle, slow end."""
    return t * t * (3 - 2 * t)

def move_to(tx, ty, duration=None):
    """
    Move cursor from current position to (tx, ty) along a Bezier curve.
    duration: seconds (auto if None, based on distance)
    """
    sx, sy = get_cursor_pos()
    dist   = math.hypot(tx - sx, ty - sy)
    if dist < 2:
        return

    if duration is None:
        # Human speed: ~400-900 px/s, slower for short moves
        speed  = random.uniform(400, 900)
        duration = max(0.08, min(dist / speed, 1.2))

    # Random control points for natural curve (not a straight line)
    off = dist * random.uniform(0.15, 0.45)
    angle = math.atan2(ty - sy, tx - sx)
    perp  = angle + math.pi / 2

    c1 = (
        sx + dist * random.uniform(0.2, 0.4) * math.cos(angle) + off * random.uniform(-0.5, 0.5) * math.cos(perp),
        sy + dist * random.uniform(0.2, 0.4) * math.sin(angle) + off * random.uniform(-0.5, 0.5) * math.sin(perp),
    )
    c2 = (
        sx + dist * random.uniform(0.6, 0.8) * math.cos(angle) + off * random.uniform(-0.5, 0.5) * math.cos(perp),
        sy + dist * random.uniform(0.6, 0.8) * math.sin(angle) + off * random.uniform(-0.5, 0.5) * math.sin(perp),
    )

    steps = max(20, int(dist / 8))
    points = bezier_points((sx, sy), c1, c2, (tx, ty), steps)

    t0 = time.perf_counter()
    for i, (px, py) in enumerate(points):
        # Ease-in-out timing
        progress = ease_in_out(i / max(len(points) - 1, 1))
        target_t = t0 + duration * progress
        now      = time.perf_counter()
        if target_t > now:
            time.sleep(target_t - now)

        _send_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    dx=int(px * 65535 / max(screen_size()[0] - 1, 1)),
                    dy=int(py * 65535 / max(screen_size()[1] - 1, 1)))

        # Micro-jitter — humans aren't perfectly smooth
        if random.random() < 0.1:
            time.sleep(random.uniform(0.005, 0.025))

def left_click(hold=None):
    """Press and release left button with human hold time."""
    if hold is None:
        hold = random.uniform(0.05, 0.15)
    _send_mouse(MOUSEEVENTF_LEFTDOWN)
    time.sleep(hold)
    _send_mouse(MOUSEEVENTF_LEFTUP)

# ── Natural scroll ────────────────────────────────────────────────────────────

def scroll(lines, natural=True):
    """
    Scroll `lines` (positive = down, negative = up).
    natural=True adds acceleration: slow start, fast middle, slow end.
    """
    if lines == 0:
        return
    direction = 1 if lines > 0 else -1
    total     = abs(lines)

    if natural and total > 3:
        # Break into chunks with momentum curve
        chunks = []
        remaining = total
        while remaining > 0:
            chunk = min(random.randint(1, 3), remaining)
            chunks.append(chunk * direction)
            remaining -= chunk
        for chunk in chunks:
            _send_mouse(MOUSEEVENTF_WHEEL, data=ctypes.c_ulong(-chunk * 120).value)
            time.sleep(random.uniform(0.04, 0.12))
    else:
        for _ in range(total):
            _send_mouse(MOUSEEVENTF_WHEEL, data=ctypes.c_ulong(-direction * 120).value)
            time.sleep(random.uniform(0.03, 0.09))

# ── Link discovery via Windows UIAutomation ──────────────────────────────────
#
# Uses the `uiautomation` package which wraps the Windows Accessibility API.
# Chrome/Edge expose every real <a href> element through this API — no JS needed.
#
# Chrome MUST be started with:
#   chrome.exe --force-renderer-accessibility
# (add this flag to your Chrome shortcut, or see SETUP note below)
#
# SETUP (one-time):
#   1. Right-click Chrome shortcut → Properties
#   2. In "Target" field, append:  --force-renderer-accessibility
#   3. Example: "C:\...\chrome.exe" --force-renderer-accessibility

def find_product_links():
    """
    Find Shopee product links via Windows UIAutomation (accessibility tree).
    Searches Chrome by class name — does NOT rely on it being the foreground window.
    Returns list of (x, y, url).
    """
    try:
        import uiautomation as auto

        sw, sh = screen_size()

        # Find Chrome by window class — works even if Python terminal has focus
        chrome_hwnd = user32.FindWindowW("Chrome_WidgetWin_1", None)
        if not chrome_hwnd:
            print("[detect] Chrome window not found (is it open?)")
            return []

        browser = auto.ControlFromHandle(chrome_hwnd)
        if not browser:
            print("[detect] ControlFromHandle returned None")
            return []

        # Generator: walk the full accessibility tree depth-first
        def walk(ctrl, depth=0):
            if depth > 22:
                return
            try:
                yield ctrl
                for child in ctrl.GetChildren():
                    yield from walk(child, depth + 1)
            except Exception:
                pass

        total_hyperlinks = 0
        product_links    = []
        other_links      = []

        for ctrl in walk(browser):
            try:
                if ctrl.ControlType != auto.ControlType.HyperlinkControl:
                    continue
                total_hyperlinks += 1

                rect = ctrl.BoundingRectangle
                w = rect.right  - rect.left
                h = rect.bottom - rect.top
                if w < 30 or h < 15:
                    continue
                if rect.left < 0 or rect.top < 0:
                    continue
                if rect.right > sw or rect.bottom > sh:
                    continue

                cx = (rect.left + rect.right)  // 2
                cy = (rect.top  + rect.bottom) // 2

                # Try Name first, then LegacyIAccessible value
                url = ""
                try:    url = ctrl.Name or ""
                except Exception: pass
                if not url:
                    try:    url = ctrl.GetLegacyIAccessiblePattern().Value or ""
                    except Exception: pass

                href = str(url).lower()
                if "/product/" in href or "-i." in href:
                    product_links.append((cx, cy, url))
                else:
                    other_links.append((cx, cy, url))

            except Exception:
                continue

        print(f"[detect] accessibility tree: {total_hyperlinks} hyperlinks total | "
              f"{len(product_links)} product | {len(other_links)} other")

        return product_links if product_links else other_links

    except ImportError:
        print("[detect] uiautomation not installed — pip install uiautomation")
        return []
    except Exception as e:
        print(f"[detect] error: {e}")
        return []


def grid_click_positions(sw, sh, safe_y1, safe_y2):
    """
    Fallback: return a list of plausible product-card centre positions
    on a Shopee search-results page (5-column grid layout).
    Used when UIAutomation finds nothing.
    """
    # Shopee search grid typically starts below the filter bar (~260px)
    # and cards are roughly 200px wide × 300px tall on 1366×768
    grid_top    = max(safe_y1, int(sh * 0.30))
    grid_bottom = safe_y2
    cols        = 5
    col_w       = sw // cols

    positions = []
    row_y = grid_top + 100
    while row_y < grid_bottom - 60:
        for col in range(cols):
            cx = int(col_w * col + col_w * 0.5)
            cx = max(60, min(sw - 60, cx))
            positions.append((cx, row_y, ""))
        row_y += int(sh * 0.38)   # next row

    return positions

# ── Hotkey controller ─────────────────────────────────────────────────────────

class HotkeyController:
    """
    Global hotkeys via the `keyboard` library.
    Works even when Chrome/Edge has focus.

      F8  — toggle pause/resume
      F9  — stop
      F10 — skip wander, click now
    """
    def __init__(self):
        self._paused    = threading.Event()   # set = paused
        self._skip      = threading.Event()   # set = skip wander now
        self._stop      = threading.Event()   # set = exit
        self._lock      = threading.Lock()

        try:
            import keyboard
            keyboard.add_hotkey("f8",  self._toggle_pause,  suppress=False)
            keyboard.add_hotkey("f9",  self._do_stop,       suppress=False)
            keyboard.add_hotkey("f10", self._do_skip,       suppress=False)
            print("[hotkey] F8=pause/resume  F9=stop  F10=skip-wander")
        except Exception as e:
            print(f"[hotkey] keyboard lib unavailable ({e}), using Ctrl+C only")

    def _toggle_pause(self):
        if self._paused.is_set():
            self._paused.clear()
            print("\n[hotkey] ▶  RESUMED")
        else:
            self._paused.set()
            print("\n[hotkey] ⏸  PAUSED  (F8 to resume)")

    def _do_stop(self):
        self._stop.set()
        self._paused.clear()   # unblock wander loop if paused
        print("\n[hotkey] ⏹  STOP requested")

    def _do_skip(self):
        self._skip.set()
        self._paused.clear()
        print("\n[hotkey] ⏭  SKIP — clicking now")

    # ── helpers called by ShopeeWalker ──────────────────────────────
    @property
    def should_stop(self):
        return self._stop.is_set()

    @property
    def is_paused(self):
        return self._paused.is_set()

    @property
    def skip_requested(self):
        return self._skip.is_set()

    def clear_skip(self):
        self._skip.clear()

    def wait_if_paused(self, interval=0.2):
        """Call this in tight loops; blocks while paused, returns False if stopped."""
        while self._paused.is_set():
            if self._stop.is_set():
                return False
            time.sleep(interval)
        return not self._stop.is_set()


# ── Human behavior patterns ───────────────────────────────────────────────────

class ShopeeWalker:
    def __init__(self):
        self.sw, self.sh = screen_size()
        self.hotkey       = HotkeyController()

        # Safe mouse zone:
        #   top  = 145px — well below browser chrome/minimize/close buttons
        #   bottom = 78% of screen height — stay away from footer
        self.vp_x1 = 60
        self.vp_y1 = 145
        self.vp_x2 = self.sw - 60
        self.vp_y2 = int(self.sh * 0.78)

        # Periodic home navigation: every 120-240 seconds
        self._next_home_at = time.time() + random.uniform(120, 240)

        print(f"[walker] screen: {self.sw}x{self.sh}  "
              f"safe zone: y={self.vp_y1}..{self.vp_y2}\n")

    def _clamp(self, x, y):
        """Clamp a point to the safe viewport zone."""
        return (
            max(self.vp_x1, min(self.vp_x2, x)),
            max(self.vp_y1, min(self.vp_y2, y)),
        )

    def random_viewport_point(self):
        x = random.randint(self.vp_x1 + 40, self.vp_x2 - 40)
        y = random.randint(self.vp_y1 + 20, self.vp_y2 - 20)
        return x, y

    def _alive(self):
        """Return True if should keep running (handles pause blocking)."""
        return self.hotkey.wait_if_paused()

    def _sleep(self, seconds):
        """Interruptible sleep — breaks early on stop/pause."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self.hotkey.should_stop:
                return
            if not self._alive():
                return
            time.sleep(0.15)

    def _set_clipboard(self, text):
        """Copy text to Windows clipboard via pywin32 (already a dependency)."""
        import win32clipboard
        win32clipboard.OpenClipboard()
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
        win32clipboard.CloseClipboard()

    def _get_current_url(self):
        """
        Read the current URL from Chrome's address bar via UIAutomation.
        Returns the URL string, or None if it can't be read.
        """
        try:
            import uiautomation as auto
            chrome_hwnd = user32.FindWindowW("Chrome_WidgetWin_1", None)
            if not chrome_hwnd:
                return None
            browser = auto.ControlFromHandle(chrome_hwnd)

            def find_edit(ctrl, depth=0):
                if depth > 10:
                    return None
                try:
                    if ctrl.ControlType == auto.ControlType.EditControl:
                        val = ctrl.GetValuePattern().Value
                        if val is not None and ('://' in val or 'shopee' in val):
                            return val
                except Exception:
                    pass
                try:
                    for child in ctrl.GetChildren():
                        r = find_edit(child, depth + 1)
                        if r is not None:
                            return r
                except Exception:
                    pass
                return None

            return find_edit(browser)
        except Exception:
            return None

    def _navigate_home(self):
        """Navigate Chrome to a random Shopee search page via the address bar."""
        import win32api, win32con
        kw  = random.choice(SEARCH_KEYWORDS).replace(' ', '+')
        url = f"https://shopee.co.id/search?keyword={kw}"
        print(f"[walker] navigating home → {url}")

        self._set_clipboard(url)

        # Ctrl+L — focus address bar
        win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
        win32api.keybd_event(ord('L'), 0, 0, 0)
        win32api.keybd_event(ord('L'), 0, win32con.KEYEVENTF_KEYUP, 0)
        win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)
        time.sleep(0.4)

        # Ctrl+A then Ctrl+V to replace existing URL
        win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
        win32api.keybd_event(ord('A'), 0, 0, 0)
        win32api.keybd_event(ord('A'), 0, win32con.KEYEVENTF_KEYUP, 0)
        win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)
        time.sleep(0.1)

        win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
        win32api.keybd_event(ord('V'), 0, 0, 0)
        win32api.keybd_event(ord('V'), 0, win32con.KEYEVENTF_KEYUP, 0)
        win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)
        time.sleep(0.2)

        # Enter to navigate
        win32api.keybd_event(win32con.VK_RETURN, 0, 0, 0)
        win32api.keybd_event(win32con.VK_RETURN, 0, win32con.KEYEVENTF_KEYUP, 0)

    def wander(self, seconds):
        """
        Wander mouse for `seconds` seconds — stays strictly within safe zone.
        Scroll amount kept small (max 3 lines) to avoid drifting to footer.
        """
        deadline = time.time() + seconds
        while time.time() < deadline and not self.hotkey.should_stop and not self.hotkey.skip_requested:
            if not self._alive():
                return

            mode = random.choice(["read", "scan", "pause", "hover"])

            if mode == "pause":
                time.sleep(random.uniform(0.8, 2.2))

            elif mode == "hover":
                cx, cy = get_cursor_pos()
                for _ in range(random.randint(2, 4)):
                    nx, ny = self._clamp(
                        cx + random.randint(-35, 35),
                        cy + random.randint(-20, 20),
                    )
                    move_to(nx, ny, duration=random.uniform(0.25, 0.7))
                    time.sleep(random.uniform(0.1, 0.35))

            elif mode == "read":
                cx, cy = get_cursor_pos()
                nx, ny = self._clamp(
                    cx + random.randint(-140, 140),
                    cy + random.randint(-70, 70),
                )
                move_to(nx, ny)
                time.sleep(random.uniform(0.3, 1.1))

            else:  # scan
                x, y = self.random_viewport_point()
                move_to(x, y)
                time.sleep(random.uniform(0.2, 0.7))

            # Occasional small scroll — max 3 lines, equal up/down chance
            if random.random() < 0.30:
                lines = random.randint(1, 3)
                direction = random.choice([1, -1])
                scroll(lines * direction)
                time.sleep(random.uniform(0.3, 0.8))

    def pick_and_click(self):
        """
        Find a Shopee product link via UIAutomation and click it.
        Only considers links strictly within the safe y zone.
        Returns True if a link was clicked, False otherwise.
        """
        print("[walker] scanning for product links...")
        all_links = find_product_links()

        # Keep only links inside the safe vertical zone AND 30–80% of screen width
        x_min = int(self.sw * 0.30)
        x_max = int(self.sw * 0.80)
        links = [(lx, ly, url) for lx, ly, url in all_links
                 if self.vp_y1 <= ly <= self.vp_y2 and x_min <= lx <= x_max]

        if not links:
            print(f"[walker] no links in safe zone (y={self.vp_y1}..{self.vp_y2}) "
                  f"— falling back to grid positions")
            grid = grid_click_positions(self.sw, self.sh, self.vp_y1, self.vp_y2)
            if not grid:
                print("[walker] grid fallback empty — skipping click")
                return False
            lx, ly, url = random.choice(grid)
            print(f"[walker] grid fallback → ({lx}, {ly})")
            lx, ly = self._clamp(lx, ly)
            move_to(lx, ly)
            time.sleep(random.uniform(0.12, 0.30))
            left_click()
            print("[walker] clicked (grid fallback — no back navigation)")
            return False  # don't go back; we can't confirm navigation happened

        # Weight by closeness to vertical center of safe zone
        mid_y   = (self.vp_y1 + self.vp_y2) / 2
        weights = [1 / (1 + abs(ly - mid_y) / self.sh) for _, ly, *_ in links]
        total   = sum(weights)
        weights = [w / total for w in weights]
        idx     = random.choices(range(len(links)), weights=weights)[0]
        lx, ly, url = links[idx]

        print(f"[walker] → {str(url)[:80]}")

        # Approach then close in
        ax, ay = self._clamp(lx + random.randint(-55, 55),
                             ly + random.randint(-35, 35))
        move_to(ax, ay)
        time.sleep(random.uniform(0.15, 0.4))

        move_to(lx, ly)
        time.sleep(random.uniform(0.12, 0.30))

        # Tiny last-moment jitter
        jx, jy = self._clamp(lx + random.randint(-3, 3),
                              ly + random.randint(-2, 2))
        move_to(jx, jy, duration=random.uniform(0.04, 0.09))
        time.sleep(random.uniform(0.06, 0.15))

        left_click()
        print("[walker] clicked")
        return True

    def scroll_page(self):
        """Modest page scroll — no extreme jumps."""
        action = random.choice(["down", "down", "up"])  # 2:1 bias down
        if action == "down":
            scroll(random.randint(3, 5))
        else:
            scroll(-random.randint(2, 4))

    def run(self):
        """
        Main loop:
          1. Wander listing page
          2. Click a product link
          3. Wait for product page to load
          4. Wander product page
          5. Go back
          6. Repeat
        """
        print("[walker] starting...\n")
        print("[walker] TIP: start Chrome with --force-renderer-accessibility "
              "for best link detection\n")

        # Navigate to a fresh Shopee search page on start
        self._navigate_home()
        self._next_home_at = time.time() + random.uniform(120, 240)
        self._sleep(4.0)

        # Move mouse to centre of safe zone to start
        cx = self.sw // 2
        cy = (self.vp_y1 + self.vp_y2) // 2
        move_to(cx, cy, duration=0.5)
        self._sleep(0.5)

        cycle = 0
        while not self.hotkey.should_stop:
            if not self._alive():
                break

            cycle += 1
            print(f"\n[walker] ── cycle {cycle} ──  [F8=pause  F9=stop  F10=skip]")

            # ── Phase 1: wander listing page ─────────────────────────
            wander_secs = random.uniform(10, 15)
            print(f"[walker] wandering listing page {wander_secs:.1f}s")
            self.wander(wander_secs)
            if self.hotkey.should_stop: break
            self.hotkey.clear_skip()

            # Optional light scroll before clicking
            if random.random() < 0.55:
                self.scroll_page()
                self._sleep(random.uniform(0.4, 1.2))
            if self.hotkey.should_stop: break

            # ── Phase 2: find & click a product link ─────────────────
            clicked = self.pick_and_click()
            if self.hotkey.should_stop: break

            if not clicked:
                # No product link visible — short extra wander then retry
                self.wander(random.uniform(4, 7))
                continue

            # ── Phase 3: wait for product page to load ───────────────
            load_wait = random.uniform(2.5, 4.5)
            print(f"[walker] waiting {load_wait:.1f}s for product page...")
            self._sleep(load_wait)
            if self.hotkey.should_stop: break

            # ── Phase 4: wander product page ─────────────────────────
            prod_secs = random.uniform(8, 14)
            print(f"[walker] wandering product page {prod_secs:.1f}s")
            self.wander(prod_secs)
            if self.hotkey.should_stop: break
            self.hotkey.clear_skip()

            # ── Phase 5: Ctrl+L → type shopee.co.id → Enter ─────────────
            import win32api, win32con
            print("[walker] → Ctrl+L → shopee.co.id")
            self._set_clipboard("shopee.co.id")
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

            back_wait = random.uniform(2.5, 4.0)
            print(f"[walker] waiting {back_wait:.1f}s for shopee.co.id to load...")
            self._sleep(back_wait)

            # Periodic reset: navigate home every 120-240 seconds
            if time.time() >= self._next_home_at:
                self._navigate_home()
                self._next_home_at = time.time() + random.uniform(120, 240)
                print(f"[walker] next home reset in {(self._next_home_at - time.time()):.0f}s")
                self._sleep(random.uniform(3.5, 5.5))


# ── Entry point ───────────────────────────────────────────────────────────────

def check_deps():
    pkg_map = {"win32api": "pywin32", "uiautomation": "uiautomation",
               "numpy": "numpy", "keyboard": "keyboard"}
    missing = []
    for mod, pkg in pkg_map.items():
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    if missing:
        print("Missing packages. Install with:")
        print(f"  pip install {' '.join(missing)}")
        sys.exit(1)

if __name__ == "__main__":
    if sys.platform != "win32":
        print("This tool requires Windows.")
        sys.exit(1)

    check_deps()

    print("=" * 50)
    print("  Shopee Walker")
    print("  F8  = Pause / Resume")
    print("  F9  = Stop")
    print("  F10 = Skip wander, click now")
    print("=" * 50 + "\n")

    walker = ShopeeWalker()

    try:
        walker.run()
    except KeyboardInterrupt:
        pass

    print("[walker] done.")
