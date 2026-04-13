"""Media Scanner -- walks media directories and probes files with ffprobe."""

import asyncio
import json
import logging
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import PurePosixPath

from sqlalchemy import func

from app import config
from app.database import File, SessionLocal

logger = logging.getLogger(__name__)

# Drive health state for one-shot alerts
_drive_unhealthy: bool = False


# ---------------------------------------------------------------------------
# Path translation helpers
# ---------------------------------------------------------------------------

def docker_to_host(path: str) -> str:
    """Convert Docker container path to host path."""
    if path.startswith(config.PATH_PREFIX_DOCKER):
        relative = path[len(config.PATH_PREFIX_DOCKER):]
        return config.PATH_PREFIX_HOST + relative.replace("/", "\\")
    return path


def host_to_docker(path: str) -> str:
    """Convert host path to Docker container path."""
    normalized = path.replace("\\", "/")
    prefix = config.PATH_PREFIX_HOST.replace("\\", "/")
    if normalized.startswith(prefix):
        relative = normalized[len(prefix):]
        return config.PATH_PREFIX_DOCKER + relative
    return path


# ---------------------------------------------------------------------------
# ffprobe helpers
# ---------------------------------------------------------------------------

# Bitrate floors by resolution tier (bits per second).
# Files below these thresholds are already more compressed than
# HEVC CQ 24 would produce -- transcoding would make them bigger.
_BITRATE_FLOORS = {
    720: 2_000_000,    # 2.0 Mbps for SD/720p
    1080: 4_500_000,   # 4.5 Mbps for 1080p
    9999: 10_000_000,  # 10.0 Mbps for 4K+
}


def _should_skip_low_bitrate(metadata: dict) -> bool:
    """Check if source bitrate is too low for CQ 24 to save space."""
    bit_rate = metadata.get("bit_rate")
    if not bit_rate or bit_rate <= 0:
        return False  # Can't determine -- let it through

    resolution = metadata.get("resolution", "")
    try:
        height = int(resolution.split("x")[1]) if "x" in resolution else 0
    except (ValueError, IndexError):
        return False

    for max_height, floor in sorted(_BITRATE_FLOORS.items()):
        if height <= max_height:
            return bit_rate < floor

    return False


_SOURCE_PATTERNS = [
    (re.compile(r"(?i)\bremux\b"), "remux"),
    (re.compile(r"(?i)\bblu-?ray\b"), "bluray"),
    (re.compile(r"(?i)\bweb-?dl\b"), "webdl"),
    (re.compile(r"(?i)\bweb-?rip\b"), "webrip"),
    (re.compile(r"(?i)\bhdtv\b"), "hdtv"),
]


def _detect_source_type(path: str) -> str:
    """Detect source type from filename (Remux, BluRay, WEB-DL, etc.)."""
    filename = os.path.basename(path)
    for pattern, source_type in _SOURCE_PATTERNS:
        if pattern.search(filename):
            return source_type
    return "unknown"


def _calculate_priority(bit_rate: int, source_type: str) -> int:
    """Calculate queue priority from bitrate and source type. Higher = sooner."""
    if bit_rate >= 20_000_000:
        priority = 100
    elif bit_rate >= 10_000_000:
        priority = 75
    elif bit_rate >= 7_000_000:
        priority = 50
    else:
        priority = 25

    # Remuxes get a boost -- they're always the biggest savings
    if source_type == "remux":
        priority = min(priority + 10, 110)

    return priority


def _detect_hdr_type(video_stream: dict) -> str:
    """Detect HDR type from ffprobe video stream data."""
    color_primaries = video_stream.get("color_primaries", "")
    color_transfer = video_stream.get("color_transfer", "")

    # Check for Dolby Vision in side_data_list
    side_data = video_stream.get("side_data_list", [])
    for sd in side_data:
        if "DOVI configuration record" in sd.get("side_data_type", ""):
            return "DV"

    if color_primaries == "bt2020nc" or color_primaries == "bt2020":
        if color_transfer == "smpte2084":
            return "HDR10"
        if color_transfer == "arib-std-b67":
            return "HLG"

    return "SDR"


def _detect_bit_depth(video_stream: dict) -> int:
    """Detect video bit depth from stream data."""
    bits = video_stream.get("bits_per_raw_sample")
    if bits:
        try:
            return int(bits)
        except (ValueError, TypeError):
            pass

    pix_fmt = video_stream.get("pix_fmt", "")
    if "10" in pix_fmt:
        return 10
    if "12" in pix_fmt:
        return 12
    return 8


def _detect_interlaced(video_stream: dict) -> bool:
    """Detect interlaced content from field_order."""
    field_order = video_stream.get("field_order", "")
    return field_order in ("tt", "bb", "tb", "bt")


def _parse_ffprobe(output: str) -> dict:
    """Parse ffprobe JSON output into a flat dict of file metadata."""
    data = json.loads(output)
    streams = data.get("streams", [])
    fmt = data.get("format", {})

    video_stream = None
    audio_count = 0
    subtitle_count = 0
    has_pgs = False

    for s in streams:
        codec_type = s.get("codec_type", "")
        if codec_type == "video" and video_stream is None:
            video_stream = s
        elif codec_type == "audio":
            audio_count += 1
        elif codec_type == "subtitle":
            subtitle_count += 1
            if s.get("codec_name") in ("hdmv_pgs_subtitle", "dvd_subtitle"):
                has_pgs = True

    if video_stream is None:
        return {}

    width = video_stream.get("width")
    height = video_stream.get("height")
    resolution = f"{width}x{height}" if width and height else None

    duration_raw = fmt.get("duration")
    duration = float(duration_raw) if duration_raw else None

    bit_rate_raw = fmt.get("bit_rate")
    bit_rate = int(bit_rate_raw) if bit_rate_raw else None

    file_size_raw = fmt.get("size")
    file_size = int(file_size_raw) if file_size_raw else None

    return {
        "codec": video_stream.get("codec_name"),
        "container": fmt.get("format_name"),
        "duration": duration,
        "bit_rate": bit_rate,
        "resolution": resolution,
        "file_size": file_size,
        "audio_streams": audio_count,
        "subtitle_streams": subtitle_count,
        "video_bit_depth": _detect_bit_depth(video_stream),
        "hdr_type": _detect_hdr_type(video_stream),
        "is_interlaced": _detect_interlaced(video_stream),
        "has_pgs_subs": has_pgs,
    }


def _run_ffprobe_sync(docker_path: str) -> dict:
    """Run ffprobe synchronously. For use in background threads."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        docker_path,
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=config.FFPROBE_TIMEOUT,
        )
        if result.returncode != 0:
            logger.warning("ffprobe failed for %s: %s", docker_path, result.stderr[:200])
            return {}
        return _parse_ffprobe(result.stdout)
    except subprocess.TimeoutExpired:
        logger.warning("ffprobe timed out for %s", docker_path)
        return {}
    except Exception:
        logger.exception("ffprobe error for %s", docker_path)
        return {}


async def _run_ffprobe(docker_path: str) -> dict:
    """Run ffprobe on a file and return parsed metadata. Async wrapper."""
    return await asyncio.to_thread(_run_ffprobe_sync, docker_path)


# ---------------------------------------------------------------------------
# Library detection
# ---------------------------------------------------------------------------

def _detect_library(docker_path: str) -> str:
    """Determine library name from docker path."""
    for lib_name, lib_path in config.MEDIA_DIRS.items():
        if docker_path.startswith(lib_path):
            return lib_name
    return "unknown"


# ---------------------------------------------------------------------------
# Scan functions
# ---------------------------------------------------------------------------

def _walk_media_files():
    """Walk all media directories and yield (docker_path, library_name) tuples."""
    for lib_name, lib_path in config.MEDIA_DIRS.items():
        if not os.path.isdir(lib_path):
            logger.warning("Media directory does not exist: %s", lib_path)
            continue
        for entry in _recursive_scandir(lib_path):
            if entry.is_file(follow_symlinks=False):
                ext = os.path.splitext(entry.name)[1].lower()
                if ext in config.VALID_EXTENSIONS:
                    yield entry.path, lib_name


def _recursive_scandir(path: str):
    """Recursively yield DirEntry objects using os.scandir."""
    try:
        with os.scandir(path) as it:
            for entry in it:
                if entry.is_dir(follow_symlinks=False):
                    yield from _recursive_scandir(entry.path)
                else:
                    yield entry
    except PermissionError:
        logger.warning("Permission denied: %s", path)
    except OSError as e:
        logger.warning("OS error scanning %s: %s", path, e)


def _walk_library_files(lib_path: str):
    """Yield media file entries for a single library path."""
    for entry in _recursive_scandir(lib_path):
        if entry.is_file(follow_symlinks=False):
            ext = os.path.splitext(entry.name)[1].lower()
            if ext in config.VALID_EXTENSIONS:
                yield entry


def _check_media_health(db) -> bool:
    """Return True if media dirs appear healthy (drive mounted + populated).

    Compares file count on disk vs DB. If disk has <5% of DB count
    for any library, the drive is likely unmapped -- abort delete detection.
    """
    for lib_name, lib_path in config.MEDIA_DIRS.items():
        if not os.path.isdir(lib_path):
            logger.warning("Media dir missing: %s -- skipping delete detection", lib_path)
            return False

        disk_count = sum(1 for _ in _walk_library_files(lib_path))

        db_count = (
            db.query(func.count(File.id))
            .filter(File.library == lib_name, File.status.notin_(["skipped"]))
            .scalar()
            or 0
        )

        if db_count > 100 and disk_count < db_count * 0.05:
            logger.error(
                "DRIVE HEALTH CHECK FAILED: %s has %d files in DB but only %d on disk. "
                "Drive likely unmapped. Skipping delete detection.",
                lib_name, db_count, disk_count,
            )
            return False

    return True


def _schedule_alert(title: str, description: str, color: int) -> None:
    """Schedule an async alert from a sync context (background thread)."""
    from app.notifier import send_alert

    payload = {"title": title, "description": description, "color": color}
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(send_alert(payload=payload), loop)
        else:
            asyncio.run(send_alert(payload=payload))
    except Exception:
        logger.exception("Failed to send drive health alert")


def _quick_scan_sync():
    """Quick scan (sync): discover new files and detect deleted files. No ffprobe.

    Runs entirely in a background thread to avoid blocking the event loop.
    """
    logger.info("Starting quick scan")
    db = SessionLocal()
    try:
        # Collect all files currently on disk
        disk_files = {}  # host_path -> (docker_path, library)
        for docker_path, lib_name in _walk_media_files():
            host_path = docker_to_host(docker_path)
            disk_files[host_path] = (docker_path, lib_name)

        # Get all known paths from DB
        known_paths = set(
            row[0] for row in db.query(File.path).all()
        )

        # Find new files
        new_files = []
        for host_path, (docker_path, lib_name) in disk_files.items():
            if host_path not in known_paths:
                new_files.append(File(
                    path=host_path,
                    library=lib_name,
                    status="pending",
                    priority=0,
                ))

        # Batch insert new files
        if new_files:
            for i in range(0, len(new_files), config.SCAN_BATCH_SIZE):
                batch = new_files[i:i + config.SCAN_BATCH_SIZE]
                db.add_all(batch)
                db.commit()
            logger.info("Quick scan: added %d new files", len(new_files))

        # Drive health check before delete detection
        global _drive_unhealthy
        media_healthy = _check_media_health(db)

        deleted_count = 0
        if media_healthy:
            # Drive recovered -- send alert if previously unhealthy
            if _drive_unhealthy:
                _drive_unhealthy = False
                logger.info("Media drives recovered -- resuming normal scanning")
                _schedule_alert(
                    title="Media Drive Recovered",
                    description="Media drives are accessible again. Normal scanning resumed.",
                    color=0x00FF00,
                )

            # Detect deleted files -- files in DB that are no longer on disk
            disk_host_paths = set(disk_files.keys())
            deleted_paths = known_paths - disk_host_paths

            if deleted_paths:
                # Only mark active files as deleted (not already done/skipped/quarantined)
                for i in range(0, len(deleted_paths), config.SCAN_BATCH_SIZE):
                    batch = list(deleted_paths)[i:i + config.SCAN_BATCH_SIZE]
                    updated = (
                        db.query(File)
                        .filter(
                            File.path.in_(batch),
                            File.status.notin_(["skipped", "done", "quarantined"]),
                        )
                        .update(
                            {"status": "skipped", "error_msg": "File no longer exists"},
                            synchronize_session="fetch",
                        )
                    )
                    deleted_count += updated
                    db.commit()
                if deleted_count:
                    logger.info("Quick scan: marked %d deleted files as skipped", deleted_count)
        else:
            # Drive unhealthy -- skip delete detection to preserve queue
            if not _drive_unhealthy:
                _drive_unhealthy = True
                _schedule_alert(
                    title="Media Drive Unavailable",
                    description=(
                        f"Drive health check failed -- only {len(disk_files)} files found on disk "
                        f"(expected thousands). Delete detection paused until drive recovers.\n\n"
                        f"**Queue is preserved.** Transcoding will resume automatically "
                        f"when the drive returns."
                    ),
                    color=0xFF4500,
                )
            logger.warning(
                "Skipping delete detection -- media drives appear unhealthy. "
                "%d files on disk (expected thousands).",
                len(disk_files),
            )

        logger.info(
            "Quick scan complete: %d files on disk, %d new, %d marked deleted",
            len(disk_files),
            len(new_files),
            deleted_count,
        )

    except Exception:
        db.rollback()
        logger.exception("Quick scan failed")
        raise
    finally:
        db.close()


async def quick_scan():
    """Quick scan: discover new files and detect deleted files. Runs in thread."""
    await asyncio.to_thread(_quick_scan_sync)


def _full_scan_sync():
    """Full scan (sync): run ffprobe on files needing probe.

    Runs entirely in a background thread to avoid blocking the event loop.
    Processes in batches to avoid loading all files into memory at once.
    """
    logger.info("Starting full scan")

    # Count total first (lightweight query)
    db = SessionLocal()
    try:
        total = (
            db.query(File.id)
            .filter(
                (File.scanned_at.is_(None)) | (File.status == "pending")
            )
            .count()
        )
    finally:
        db.close()

    if total == 0:
        logger.info("Full scan: no files need probing")
        return

    logger.info("Full scan: %d files to probe", total)

    probed = 0
    skipped = 0
    errors = 0

    while True:
        db = SessionLocal()
        try:
            batch = (
                db.query(File)
                .filter(
                    (File.scanned_at.is_(None)) | (File.status == "pending")
                )
                .order_by(File.id)
                .limit(config.SCAN_BATCH_SIZE)
                .all()
            )

            if not batch:
                break

            for f in batch:
                docker_path = host_to_docker(f.path)

                # Check file still exists
                if not os.path.exists(docker_path):
                    f.status = "skipped"
                    f.error_msg = "File no longer exists"
                    # Must set scanned_at so the next batch query does not re-fetch this row.
                    f.scanned_at = datetime.now(timezone.utc)
                    skipped += 1
                    continue

                # Check mtime -- skip if already scanned and mtime hasn't changed
                if f.scanned_at is not None and f.status != "pending":
                    try:
                        mtime = datetime.fromtimestamp(
                            os.path.getmtime(docker_path), tz=timezone.utc
                        )
                        if mtime <= f.scanned_at:
                            continue
                    except OSError:
                        continue

                metadata = _run_ffprobe_sync(docker_path)
                if not metadata:
                    f.status = "error"
                    f.error_msg = "ffprobe failed or returned no video stream"
                    f.scanned_at = datetime.now(timezone.utc)
                    errors += 1
                    continue

                # Update file metadata
                f.codec = metadata["codec"]
                f.container = metadata["container"]
                f.duration = metadata["duration"]
                f.bit_rate = metadata["bit_rate"]
                f.resolution = metadata["resolution"]
                f.file_size = metadata["file_size"]
                f.audio_streams = metadata["audio_streams"]
                f.subtitle_streams = metadata["subtitle_streams"]
                f.video_bit_depth = metadata["video_bit_depth"]
                f.hdr_type = metadata["hdr_type"]
                f.is_interlaced = metadata["is_interlaced"]
                f.has_pgs_subs = metadata.get("has_pgs_subs", False)
                f.source_type = _detect_source_type(f.path)
                f.scanned_at = datetime.now(timezone.utc)

                # Apply skip rules
                if metadata["hdr_type"] == "DV":
                    f.status = "skipped"
                    f.error_msg = "Dolby Vision -- cannot preserve RPU layer through NVENC"
                    skipped += 1
                elif metadata["codec"] in ("hevc", "h265"):
                    f.status = "skipped"
                    f.error_msg = "Already HEVC encoded"
                    skipped += 1
                elif _should_skip_low_bitrate(metadata):
                    br_mbps = round((metadata["bit_rate"] or 0) / 1_000_000, 1)
                    f.status = "skipped"
                    f.error_msg = f"Bitrate too low ({br_mbps} Mbps) -- already efficiently compressed"
                    skipped += 1
                else:
                    f.status = "queued"
                    f.original_size = metadata["file_size"]
                    f.priority = _calculate_priority(
                        metadata.get("bit_rate", 0) or 0, f.source_type
                    )
                    probed += 1

            db.commit()
            logger.info(
                "Full scan progress: %d queued, %d skipped, %d errors so far",
                probed, skipped, errors,
            )

        except Exception:
            db.rollback()
            logger.exception("Full scan batch failed")
        finally:
            db.close()

    logger.info(
        "Full scan complete: %d queued, %d skipped, %d errors",
        probed, skipped, errors,
    )


async def full_scan():
    """Full scan: run ffprobe on files needing probe. Runs in thread."""
    await asyncio.to_thread(_full_scan_sync)


async def scan_file(path: str, priority: int = 50):
    """Scan a single file immediately (e.g., from a webhook notification).

    Args:
        path: Host path or Docker path to the media file.
        priority: Priority level for queue ordering. Default 50 (higher = sooner).
    """
    # Normalize to both path formats
    if path.startswith(config.PATH_PREFIX_DOCKER):
        docker_path = path
        host_path = docker_to_host(path)
    else:
        host_path = path
        docker_path = host_to_docker(path)

    logger.info("Scanning single file: %s (priority=%d)", host_path, priority)

    db = SessionLocal()
    try:
        # Check extension
        ext = os.path.splitext(docker_path)[1].lower()
        if ext not in config.VALID_EXTENSIONS:
            logger.info("Skipping %s -- not a valid media extension", host_path)
            return

        metadata = await _run_ffprobe(docker_path)
        if not metadata:
            logger.warning("ffprobe failed for %s", docker_path)
            return

        library = _detect_library(docker_path)

        # Upsert: find existing or create new
        f = db.query(File).filter(File.path == host_path).first()
        if f is None:
            f = File(path=host_path, library=library)
            db.add(f)

        f.codec = metadata["codec"]
        f.container = metadata["container"]
        f.duration = metadata["duration"]
        f.bit_rate = metadata["bit_rate"]
        f.resolution = metadata["resolution"]
        f.file_size = metadata["file_size"]
        f.audio_streams = metadata["audio_streams"]
        f.subtitle_streams = metadata["subtitle_streams"]
        f.video_bit_depth = metadata["video_bit_depth"]
        f.hdr_type = metadata["hdr_type"]
        f.is_interlaced = metadata["is_interlaced"]
        f.has_pgs_subs = metadata.get("has_pgs_subs", False)
        f.source_type = _detect_source_type(host_path)
        f.scanned_at = datetime.now(timezone.utc)
        f.priority = priority

        if metadata["hdr_type"] == "DV":
            f.status = "skipped"
            f.error_msg = "Dolby Vision -- cannot preserve RPU layer through NVENC"
        elif metadata["codec"] in ("hevc", "h265"):
            f.status = "skipped"
            f.error_msg = "Already HEVC encoded"
        elif _should_skip_low_bitrate(metadata):
            br_mbps = round((metadata["bit_rate"] or 0) / 1_000_000, 1)
            f.status = "skipped"
            f.error_msg = f"Bitrate too low ({br_mbps} Mbps) -- already efficiently compressed"
        else:
            f.status = "queued"
            f.original_size = metadata["file_size"]
            # Use calculated priority if none provided (default 50 = webhook)
            if priority == 50:
                f.priority = _calculate_priority(
                    metadata.get("bit_rate", 0) or 0, f.source_type
                )
            f.error_msg = None

        db.commit()
        logger.info("Scanned %s: status=%s, codec=%s", host_path, f.status, f.codec)

    except Exception:
        db.rollback()
        logger.exception("Failed to scan file %s", host_path)
        raise
    finally:
        db.close()