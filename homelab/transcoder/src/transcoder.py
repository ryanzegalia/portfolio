"""Media FFmpeg transcoder -- runs in ThreadPoolExecutor threads."""

import ctypes
from ctypes import wintypes
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

import config
from progress import progress_tracker

log = logging.getLogger(__name__)

# Prevent console window popup on Windows
CREATE_NO_WINDOW = 0x08000000

# Track active FFmpeg PIDs for emergency kill
active_pids: set[int] = set()


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class TranscodeResult:
    success: bool
    output_path: str | None = None
    output_size: int | None = None
    error: str | None = None


class InsufficientDiskError(Exception):
    """Not enough disk space to complete replacement."""


class DeferredError(Exception):
    """File should be retried later (e.g. locked by media server)."""


class TranscodeError(Exception):
    """Transcode or replacement failed."""


# ---------------------------------------------------------------------------
# FFmpeg command builder
# ---------------------------------------------------------------------------

def build_ffmpeg_cmd(
    job: dict,
    hwaccel: bool = True,
    subtitle_mode: str = "copy",
) -> tuple[list[str], str]:
    """Build FFmpeg command and return (cmd, output_path).

    subtitle_mode: "copy" | "srt" | "none"
    """
    input_path = job["path"]
    job_id = job["id"]
    basename = Path(input_path).stem + ".mkv"

    output_dir = Path(config.CACHE_DIR) / str(job_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = str(output_dir / basename)

    cmd: list[str] = ["ffmpeg", "-y"]

    # Hardware acceleration (primary path)
    if hwaccel:
        cmd += ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]

    cmd += ["-i", input_path, "-map", "0"]

    # Video encoder
    cmd += ["-c:v", "hevc_nvenc", "-preset", config.FFMPEG_PRESET]

    # Audio: always copy
    cmd += ["-c:a", "copy"]

    # Subtitles
    if subtitle_mode == "copy":
        cmd += ["-c:s", "copy"]
    elif subtitle_mode == "srt":
        cmd += ["-c:s", "srt"]
    elif subtitle_mode == "none":
        cmd += ["-sn"]

    # Rate control
    cmd += [
        "-rc", "vbr",
        "-cq", str(config.FFMPEG_CQ),
        "-qmin", "1",
        "-qmax", "51",
        "-rc-lookahead", "32",
        "-temporal-aq", "1",
        "-spatial-aq", "1",
        "-b_ref_mode", "middle",
        "-bf", "3",
    ]

    # HDR10 passthrough
    if job.get("hdr_type") == "HDR10":
        cmd += [
            "-color_primaries", "bt2020",
            "-color_trc", "smpte2084",
            "-colorspace", "bt2020nc",
        ]

    # Deinterlacing
    if job.get("is_interlaced"):
        if hwaccel:
            cmd += ["-vf", "yadif_cuda=0:-1:0"]
        else:
            cmd += ["-vf", "yadif=0:-1:0"]

    # Muxing / progress
    cmd += ["-max_muxing_queue_size", "9999", "-progress", "pipe:1", "-nostats"]

    cmd.append(output_path)

    return cmd, output_path


# ---------------------------------------------------------------------------
# Core transcode logic
# ---------------------------------------------------------------------------

STALL_TIMEOUT = 300  # 5 minutes with no stdout output = ffmpeg is hung


def _run_ffmpeg(
    job: dict,
    hwaccel: bool,
    subtitle_mode: str,
) -> TranscodeResult:
    """Execute a single FFmpeg run with stall watchdog. Returns TranscodeResult."""
    cmd, output_path = build_ffmpeg_cmd(job, hwaccel=hwaccel, subtitle_mode=subtitle_mode)
    log.debug("FFmpeg command: %s", " ".join(cmd))

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=CREATE_NO_WINDOW,
    )
    active_pids.add(proc.pid)

    # Drain stderr in background thread to prevent pipe deadlock.
    # On Windows, pipe buffers are ~4-8KB. FFmpeg writes version info, codec
    # details, and stream mapping to stderr during init. If the buffer fills
    # while we're blocking on stdout read, both processes deadlock.
    stderr_chunks: list[bytes] = []

    def _drain_stderr():
        try:
            while True:
                chunk = proc.stderr.read(4096)
                if not chunk:
                    break
                stderr_chunks.append(chunk)
        except Exception:
            pass

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    # Watchdog: kill ffmpeg if stdout goes silent for STALL_TIMEOUT seconds
    activity = threading.Event()
    stall_killed = threading.Event()

    def _watchdog():
        while proc.poll() is None and not stall_killed.is_set():
            if not activity.wait(timeout=STALL_TIMEOUT):
                # Recheck -- process may have exited while we were waiting
                if stall_killed.is_set() or proc.poll() is not None:
                    return
                # No output for STALL_TIMEOUT -- ffmpeg is hung
                log.warning(
                    "Job %d: ffmpeg stalled (%ds no output), killing PID %d",
                    job["id"], STALL_TIMEOUT, proc.pid,
                )
                try:
                    proc.kill()
                except OSError:
                    pass
                stall_killed.set()
                return
            activity.clear()

    wd = threading.Thread(target=_watchdog, daemon=True)
    wd.start()

    try:
        duration = job.get("duration", 0)

        for raw_line in proc.stdout:
            activity.set()  # Poke the watchdog
            line = raw_line.decode("utf-8", errors="replace").strip()

            if line.startswith("out_time_us="):
                try:
                    us = int(line.split("=", 1)[1])
                    if duration > 0:
                        progress = us / (duration * 1_000_000)
                        progress_tracker.update(job["id"], progress=min(progress, 1.0))
                except (ValueError, ZeroDivisionError):
                    pass

            elif line.startswith("speed="):
                speed_str = line.split("=", 1)[1].strip().rstrip("x")
                if speed_str and speed_str != "N/A":
                    try:
                        progress_tracker.update(job["id"], speed=float(speed_str))
                    except ValueError:
                        pass

        proc.wait()
        stderr_thread.join(timeout=5)  # Wait for stderr drain to finish
        was_stall_killed = stall_killed.is_set()
        stall_killed.set()  # Stop watchdog cleanly

        if was_stall_killed:
            return TranscodeResult(
                success=False,
                output_path=output_path,
                error=f"FFmpeg stalled (no output for {STALL_TIMEOUT}s)",
            )

        if proc.returncode != 0:
            stderr = b"".join(stderr_chunks).decode("utf-8", errors="replace")
            return TranscodeResult(
                success=False,
                output_path=output_path,
                error=stderr[-500:],
            )

        try:
            output_size = os.path.getsize(output_path)
        except OSError:
            output_size = None

        return TranscodeResult(
            success=True,
            output_path=output_path,
            output_size=output_size,
        )

    except Exception as e:
        proc.kill()
        proc.wait()
        return TranscodeResult(success=False, output_path=output_path, error=str(e))

    finally:
        stall_killed.set()
        active_pids.discard(proc.pid)


def transcode(job: dict) -> TranscodeResult:
    """Run FFmpeg transcode with four-tier retry. Called from ThreadPoolExecutor."""
    job_id = job["id"]

    # Tier 1: primary path -- hwaccel + copy subtitles
    result = _run_ffmpeg(job, hwaccel=True, subtitle_mode="copy")

    if result.success:
        return result

    error_lower = (result.error or "").lower()

    # Tier 2a: subtitle error -> retry with srt conversion
    if "unknown encoder" in error_lower or "mov_text" in error_lower:
        log.warning("[%s] Subtitle mux error, retrying with srt conversion", job_id)
        cleanup_output(result)
        result = _run_ffmpeg(job, hwaccel=True, subtitle_mode="srt")

        if result.success:
            return result

        # Tier 2b: srt still fails -> drop subtitles
        log.warning("[%s] Subtitle srt failed, retrying without subtitles", job_id)
        cleanup_output(result)
        result = _run_ffmpeg(job, hwaccel=True, subtitle_mode="none")

        if result.success:
            return result

    # Tier 3: NVENC session limit
    if "openencodesessionex failed" in error_lower:
        log.error("[%s] NVENC session limit hit", job_id)
        cleanup_output(result)
        return TranscodeResult(
            success=False,
            error="NVENC session limit -- reduce concurrent workers",
        )

    # Tier 4: decode error -> software decode fallback
    if any(kw in error_lower for kw in ("decode", "cuvid", "hwaccel")):
        log.warning("[%s] HW decode error, retrying with software decode", job_id)
        cleanup_output(result)
        result = _run_ffmpeg(job, hwaccel=False, subtitle_mode="copy")

        if result.success:
            return result

        # Software decode + subtitle fallback
        sub_error = (result.error or "").lower()
        if "unknown encoder" in sub_error or "mov_text" in sub_error:
            log.warning("[%s] SW decode + subtitle error, dropping subs", job_id)
            cleanup_output(result)
            result = _run_ffmpeg(job, hwaccel=False, subtitle_mode="none")

    return result


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _ffprobe_duration(path: str) -> float | None:
    """Get duration in seconds via ffprobe."""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                path,
            ],
            capture_output=True,
            text=True,
            creationflags=CREATE_NO_WINDOW,
            timeout=30,
        )
        data = json.loads(out.stdout)
        return float(data["format"]["duration"])
    except Exception as e:
        log.warning("ffprobe failed for %s: %s", path, e)
        return None


def _ffprobe_streams(path: str) -> dict:
    """Count audio and subtitle streams."""
    counts = {"audio": 0, "subtitle": 0}
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_streams",
                path,
            ],
            capture_output=True,
            text=True,
            creationflags=CREATE_NO_WINDOW,
            timeout=30,
        )
        data = json.loads(out.stdout)
        for stream in data.get("streams", []):
            codec_type = stream.get("codec_type", "")
            if codec_type in counts:
                counts[codec_type] += 1
    except Exception as e:
        log.warning("ffprobe stream count failed for %s: %s", path, e)
    return counts


def validate(job: dict, result: TranscodeResult) -> tuple[bool, str]:
    """Validate transcoded output against original.

    Returns (True, "") on pass or (False, reason) on failure.
    """
    if not result.output_path or not os.path.exists(result.output_path):
        return False, "Output file does not exist"

    output_size = result.output_size or 0
    original_size = job.get("file_size", 0)

    # Duration check: within 1%
    expected_duration = job.get("duration", 0)
    if expected_duration > 0:
        actual_duration = _ffprobe_duration(result.output_path)
        if actual_duration is not None:
            diff_pct = abs(actual_duration - expected_duration) / expected_duration
            if diff_pct > 0.01:
                return False, (
                    f"Duration mismatch: expected {expected_duration:.1f}s, "
                    f"got {actual_duration:.1f}s ({diff_pct:.2%} off)"
                )

    # Size check: 5-100% of original
    # Blu-ray remuxes (especially animated) legitimately compress to ~10-15% with HEVC
    if original_size > 0 and output_size > 0:
        size_ratio = output_size / original_size
        if size_ratio < 0.05:
            return False, (
                f"Output too small: {output_size} bytes "
                f"({size_ratio:.1%} of original {original_size})"
            )
        if size_ratio > 1.0:
            return False, (
                f"Output larger than original: {output_size} bytes "
                f"({size_ratio:.1%} of original {original_size})"
            )

    # Stream count check (warning only)
    original_streams = _ffprobe_streams(job["path"])
    output_streams = _ffprobe_streams(result.output_path)
    if original_streams["audio"] != output_streams["audio"]:
        log.warning(
            "[%s] Audio stream count mismatch: %d -> %d",
            job["id"], original_streams["audio"], output_streams["audio"],
        )
    if original_streams["subtitle"] != output_streams["subtitle"]:
        log.warning(
            "[%s] Subtitle stream count mismatch: %d -> %d",
            job["id"], original_streams["subtitle"], output_streams["subtitle"],
        )

    return True, ""


# ---------------------------------------------------------------------------
# Active stream check
# ---------------------------------------------------------------------------

def is_file_being_streamed(path: str) -> bool:
    """Check if a file is currently being played in the media server."""
    try:
        resp = httpx.get(
            f"{config.MEDIA_SERVER_URL}/Sessions",
            params={"api_key": config.MEDIA_SERVER_API_KEY},
            timeout=5,
        )
        resp.raise_for_status()

        normalized = path.replace("\\", "/")
        for session in resp.json():
            now_playing = session.get("NowPlayingItem", {})
            session_path = now_playing.get("Path", "").replace("\\", "/")
            if session_path == normalized:
                return True
        return False

    except Exception:
        return False  # API failure = assume not streaming


# ---------------------------------------------------------------------------
# File replacement
# ---------------------------------------------------------------------------

def _set_creation_time(path: str, timestamp: float) -> None:
    """Set file creation time on Windows via Win32 SetFileTime.

    Preserves the original file's creation date after replacement so the
    media server doesn't treat transcoded files as "Recently Added."
    """
    try:
        kernel32 = ctypes.windll.kernel32
        # Windows FILETIME: 100-nanosecond intervals since 1601-01-01
        EPOCH_AS_FILETIME = 116444736000000000
        ft_val = int(timestamp * 10_000_000) + EPOCH_AS_FILETIME

        handle = kernel32.CreateFileW(
            path,
            256,          # FILE_WRITE_ATTRIBUTES
            7,            # FILE_SHARE_READ | WRITE | DELETE
            None,
            3,            # OPEN_EXISTING
            0x02000000,   # FILE_FLAG_BACKUP_SEMANTICS
            None,
        )
        if handle == wintypes.HANDLE(-1).value:
            log.warning("Could not open %s to set creation time", path)
            return

        ft = wintypes.FILETIME(ft_val & 0xFFFFFFFF, ft_val >> 32)
        kernel32.SetFileTime(handle, ctypes.byref(ft), None, None)
        kernel32.CloseHandle(handle)
        log.info("Preserved creation time on %s", Path(path).name)
    except Exception as e:
        log.warning("Failed to set creation time on %s: %s", path, e)


def replace_original(
    original_path: str,
    output_path: str,
    original_size: int,
) -> str:
    """Replace original file with transcoded output. Returns final path.

    Uses atomic-ish os.replace chain with .bak rollback safety.
    Final path may differ from original if extension changed to .mkv.
    """
    # Determine final path (may change extension to .mkv)
    orig_ext = Path(original_path).suffix.lower()
    if orig_ext != ".mkv":
        final_path = str(Path(original_path).with_suffix(".mkv"))
    else:
        final_path = original_path

    bak_path = original_path + ".bak"
    new_path = original_path + ".new"

    # 1. Disk space pre-check
    dir_path = os.path.dirname(original_path)
    free = shutil.disk_usage(dir_path).free
    needed = original_size + os.path.getsize(output_path)
    if free < needed:
        raise InsufficientDiskError(
            f"Need {needed:,} bytes, have {free:,} free"
        )

    # 2. Handle locked/read-only files
    try:
        current_mode = os.stat(original_path).st_mode
        if not (current_mode & 0o200):
            os.chmod(original_path, current_mode | 0o200)
    except PermissionError:
        raise DeferredError("File locked -- possibly by media server or another process")

    # 3. Save original file's creation time
    try:
        saved_ctime = os.path.getctime(original_path)
    except OSError:
        saved_ctime = None

    # 4. Check same filesystem
    try:
        same_device = os.stat(output_path).st_dev == os.stat(original_path).st_dev
    except OSError:
        same_device = False

    try:
        if same_device:
            # Same device: os.replace chain (fast, atomic on Windows)
            os.replace(original_path, bak_path)
            os.replace(output_path, final_path)
        else:
            # Cross-device: copy to .new on same device, then replace chain
            shutil.copy2(output_path, new_path)
            os.replace(original_path, bak_path)
            os.replace(new_path, final_path)

        # Validate file exists after replacement
        if not os.path.exists(final_path):
            if os.path.exists(bak_path):
                os.replace(bak_path, original_path)
            raise TranscodeError("Replacement failed -- original restored from backup")

        # 5. Restore original creation time so media server doesn't bump "Recently Added"
        if saved_ctime is not None:
            _set_creation_time(final_path, saved_ctime)

        # Remove backup (non-critical)
        try:
            os.remove(bak_path)
        except OSError:
            log.warning("Could not remove backup: %s", bak_path)

        # Clean up output from cache
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except OSError:
            pass

        # If extension changed, remove old file if it still exists
        if final_path != original_path:
            try:
                if os.path.exists(original_path):
                    os.remove(original_path)
            except OSError:
                log.warning("Could not remove old extension file: %s", original_path)

    except (InsufficientDiskError, DeferredError, TranscodeError):
        raise
    except OSError as e:
        # Rollback: restore from backup if possible
        if os.path.exists(bak_path) and not os.path.exists(original_path):
            os.replace(bak_path, original_path)
            log.error("Replacement failed, restored from backup: %s", e)
        raise

    return final_path


# ---------------------------------------------------------------------------
# Cleanup helpers
# ---------------------------------------------------------------------------

def cleanup_output(result: TranscodeResult) -> None:
    """Remove output file if it exists."""
    if result.output_path:
        try:
            if os.path.exists(result.output_path):
                os.remove(result.output_path)
        except OSError as e:
            log.warning("Could not clean up output %s: %s", result.output_path, e)


def kill_all_ffmpeg() -> None:
    """Emergency kill all tracked FFmpeg processes."""
    for pid in list(active_pids):
        try:
            os.kill(pid, 9)
            log.warning("Killed FFmpeg PID %d", pid)
        except OSError:
            pass
    active_pids.clear()
