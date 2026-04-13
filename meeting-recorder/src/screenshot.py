"""Timed screenshot capture for campaign sessions.

Captures the BG3 game window (or full screen fallback) at regular intervals,
saving full-resolution WebP images with timestamps aligned to audio chunks.

Uses bettercam (DXGI Desktop Duplication) instead of mss (GDI BitBlt) because
GDI cannot reliably capture DirectX games -- it returns stale/cached frames.
"""

import hashlib
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import psutil

# Lazy imports -- these may not be installed in all environments
_bettercam = None
_win32gui = None
_win32process = None
_Image = None


def _ensure_deps():
    global _bettercam, _win32gui, _win32process, _Image
    if _bettercam is None:
        import bettercam
        _bettercam = bettercam
    if _win32gui is None:
        try:
            import win32gui
            _win32gui = win32gui
        except ImportError:
            pass
    if _win32process is None:
        try:
            import win32process
            _win32process = win32process
        except ImportError:
            pass
    if _Image is None:
        from PIL import Image
        _Image = Image


# Process names for BG3 (multiple executables depending on renderer)
BG3_PROCESS_NAMES = {"bg3.exe", "bg3_dx11.exe", "bg3_vulkan.exe"}


def find_bg3_window() -> dict | None:
    """Find the BG3 game window and return its bounding box.

    Returns dict with keys: left, top, width, height -- or None if not found.
    """
    if _win32gui is None or _win32process is None:
        return None

    result = {}

    def _enum_callback(hwnd, _):
        if not _win32gui.IsWindowVisible(hwnd):
            return
        title = _win32gui.GetWindowText(hwnd).lower()
        # BG3 window titles contain "baldur's gate" or the exe name
        if "baldur" in title or "bg3" in title:
            try:
                _, pid = _win32process.GetWindowThreadProcessId(hwnd)
                proc = psutil.Process(pid)
                if proc.name().lower() in BG3_PROCESS_NAMES:
                    # Try DwmGetWindowAttribute for accurate bounds in borderless mode
                    got_dwm = False
                    try:
                        import ctypes
                        import ctypes.wintypes
                        dwmapi = ctypes.windll.dwmapi
                        dwm_rect = ctypes.wintypes.RECT()
                        DWMWA_EXTENDED_FRAME_BOUNDS = 9
                        hr = dwmapi.DwmGetWindowAttribute(
                            hwnd, DWMWA_EXTENDED_FRAME_BOUNDS,
                            ctypes.byref(dwm_rect), ctypes.sizeof(dwm_rect),
                        )
                        if hr == 0:
                            result["left"] = dwm_rect.left
                            result["top"] = dwm_rect.top
                            result["width"] = dwm_rect.right - dwm_rect.left
                            result["height"] = dwm_rect.bottom - dwm_rect.top
                            got_dwm = True
                    except Exception:
                        pass
                    if not got_dwm:
                        rect = _win32gui.GetWindowRect(hwnd)
                        result["left"] = rect[0]
                        result["top"] = rect[1]
                        result["width"] = rect[2] - rect[0]
                        result["height"] = rect[3] - rect[1]
            except Exception:
                pass

    try:
        _win32gui.EnumWindows(_enum_callback, None)
    except Exception:
        pass

    return result if result else None


class ScreenshotCapture:
    """Captures screenshots at regular intervals during a campaign session.

    Screenshots are saved as full-resolution WebP images, timestamped and
    grouped with their corresponding audio chunk for AI processing.
    """

    def __init__(
        self,
        output_dir: Path,
        interval: float = 30.0,
        jpeg_quality: int = 75,
        chunk_interval: float = 600.0,
    ):
        self.output_dir = output_dir
        self.interval = interval
        self.quality = jpeg_quality  # Used for WebP quality too
        self.chunk_interval = chunk_interval

        self._running = False
        self._thread: threading.Thread | None = None
        self._frame_count = 0
        self._skipped_dupes = 0
        self._session_start: float = 0.0
        self._screenshots: list[dict] = []  # [{path, timestamp, offset_seconds, chunk_index}]
        self._lock = threading.Lock()
        self._last_hash: str = ""

    @property
    def screenshots(self) -> list[dict]:
        with self._lock:
            return list(self._screenshots)

    @property
    def frame_count(self) -> int:
        return self._frame_count

    def start(self) -> None:
        """Start capturing screenshots in a background thread."""
        _ensure_deps()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._running = True
        self._frame_count = 0
        self._skipped_dupes = 0
        self._session_start = time.time()
        self._screenshots = []
        self._last_hash = ""
        self._thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._thread.start()
        print(f"[screenshot] Started capturing every {self.interval}s to {self.output_dir}")

    def stop(self) -> list[dict]:
        """Stop capturing and return the list of screenshot metadata."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        print(f"[screenshot] Stopped. Captured {self._frame_count} screenshots"
              f" ({self._skipped_dupes} duplicates skipped)")
        with self._lock:
            return list(self._screenshots)

    def get_screenshots_for_chunk(self, chunk_index: int) -> list[dict]:
        """Get all screenshots that belong to a specific chunk."""
        with self._lock:
            return [s for s in self._screenshots if s["chunk_index"] == chunk_index]

    def _capture_loop(self) -> None:
        """Main capture loop -- takes a screenshot every interval seconds."""
        camera = _bettercam.create(output_idx=0)
        try:
            while self._running:
                try:
                    self._take_screenshot(camera)
                except Exception as e:
                    print(f"[screenshot] Capture error: {e}")

                # Sleep in small increments so stop() is responsive
                deadline = time.time() + self.interval
                while self._running and time.time() < deadline:
                    time.sleep(0.5)
        finally:
            del camera

    def _is_duplicate(self, frame) -> bool:
        """Check if this frame is identical to the previous one.

        Uses subsampled MD5 (every 10th pixel) for speed.
        """
        h = hashlib.md5(frame[::10, ::10].tobytes()).hexdigest()
        if h == self._last_hash:
            return True
        self._last_hash = h
        return False

    def _take_screenshot(self, camera) -> None:
        """Capture a single screenshot via DXGI Desktop Duplication."""
        now = time.time()
        offset_seconds = now - self._session_start

        # Calculate which chunk this screenshot belongs to
        chunk_index = int(offset_seconds // self.chunk_interval)

        # Grab frame from DXGI -- returns numpy (H,W,4) BGRA or None if no new frame
        frame = camera.grab()
        if frame is None:
            time.sleep(0.05)
            frame = camera.grab()
        if frame is None:
            return  # No new frame available (screen truly static)

        # Skip duplicate frames
        if self._is_duplicate(frame):
            self._skipped_dupes += 1
            return

        # Crop to BG3 window if found
        bg3_window = find_bg3_window()
        source = "primary_monitor"
        if bg3_window and bg3_window["width"] > 100 and bg3_window["height"] > 100:
            x = max(0, bg3_window["left"])
            y = max(0, bg3_window["top"])
            w = bg3_window["width"]
            h = bg3_window["height"]
            # Clamp to frame bounds
            y2 = min(y + h, frame.shape[0])
            x2 = min(x + w, frame.shape[1])
            if y2 > y and x2 > x:
                frame = frame[y:y2, x:x2]
                source = "bg3_window"

        # bettercam defaults to output_color='RGB' (3ch) -- no channel swap needed
        if frame.shape[2] == 4:
            img = _Image.fromarray(frame[:, :, :3])  # RGBA -> RGB (drop alpha)
        else:
            img = _Image.fromarray(frame)  # Already RGB

        # Save as full-resolution WebP
        timestamp_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        filename = f"frame_{self._frame_count:04d}_{timestamp_str}.webp"
        filepath = self.output_dir / filename

        img.save(filepath, "WebP", quality=self.quality)

        # Record metadata
        meta = {
            "path": str(filepath),
            "filename": filename,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "offset_seconds": round(offset_seconds, 1),
            "chunk_index": chunk_index,
            "width": img.width,
            "height": img.height,
            "size_bytes": filepath.stat().st_size,
            "source": source,
        }

        with self._lock:
            self._screenshots.append(meta)

        self._frame_count += 1
