# Custom Media Transcoder

A custom media transcoding system built to replace an open-source orchestrator that had reliability issues at scale with a 19,000+ file library. Rather than continue building workarounds (server watchdog, node watchdog, ghost node cleaner, error resetter), a purpose-built replacement was more sustainable.

## Architecture

```text
Scanner (FastAPI) -----> PostgreSQL/SQLite
    |                         |
    | ffprobe                 | queue
    v                         v
Media Library           Worker (FFmpeg)
    ^                         |
    |    atomic replace       |
    +-------------------------+
              |
         Jellyfin notify
```

**Scanner** (`server/`): Walks media directories, probes files with ffprobe, applies skip rules, manages the transcode queue. Runs as a FastAPI server inside Docker.

**Worker** (`worker/`): Pulls jobs from the queue, builds FFmpeg commands, manages NVENC hardware acceleration, handles retries. Runs on the machine with the GPU.

## Key Features

### Smart Bitrate Analysis

Resolution-aware bitrate floors prevent pointless transcodes. A 1080p file at 3 Mbps is already more compressed than HEVC CQ 24 would produce -- transcoding it would make the file larger.

```
SD/720p:  2.0 Mbps floor
1080p:    4.5 Mbps floor
4K+:     10.0 Mbps floor
```

HDR detection reads color primaries, transfer characteristics, and Dolby Vision side data from ffprobe output. DV files are automatically skipped because NVENC can't preserve the RPU metadata layer.

### 4-Tier Transcode Retry

Each job cascades through increasingly aggressive fallback strategies:

1. **Primary:** CUDA hwaccel + copy all streams
2. **Subtitle fallback:** Convert PGS/DVD subs to SRT, then drop subtitles entirely
3. **NVENC session limit:** Detect and report (reduce concurrent workers)
4. **Software decode:** Fall back to CPU decoding when CUVID fails

### Stall Watchdog

A per-process watchdog thread monitors FFmpeg stdout. If no progress output arrives for 5 minutes, the process is killed and the job retries at the next tier. This catches FFmpeg hangs that would otherwise block a worker slot indefinitely.

### Drive Health Monitoring

Before marking files as deleted, the scanner compares on-disk file counts against the database. If any library has less than 5% of expected files, the drive is assumed unmapped and delete detection is paused. This prevents the queue from being wiped when a network drive temporarily disconnects.

## Source Files

- [`src/scanner.py`](src/scanner.py) -- Media scanner with ffprobe parsing, HDR detection, bitrate analysis, drive health monitoring
- [`src/transcoder.py`](src/transcoder.py) -- FFmpeg command builder, NVENC params, retry tiers, stall watchdog, atomic file replacement
