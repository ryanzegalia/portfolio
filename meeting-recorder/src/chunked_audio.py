"""Chunked audio capture for long campaign sessions.

Records multi-hour sessions with automatic chunk rotation (default 10 min).
Captures mic via PyAudio and optionally per-process audio (Discord, BG3) via
WASAPI Process Loopback. Each chunk is encoded to MP3 in a background thread.

Separated from audio.py to keep the core recording module focused.
"""

import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from audio import TARGET_SAMPLE_RATE, _encode_mono_mp3
from config import SESSIONS_DIR


class ChunkedAudioRecorder:
    """Records long sessions with automatic chunk rotation.

    Designed for 2+ hour campaign sessions. Captures mic audio via PyAudio
    and optionally per-process audio (Discord, BG3) via WASAPI Process Loopback.
    Falls back to regular WASAPI loopback if per-process capture is unavailable.

    Every chunk_interval seconds, buffers are drained and encoded to MP3 in
    a background thread, freeing memory. Peak memory stays under ~250MB.

    Audio files are saved to: sessions/{session_id}/chunk_{NN}_{stream}.mp3
    """

    def __init__(
        self,
        session_id: str,
        mic_device_index: int | None,
        loopback_device_index: int | None = None,
        chunk_interval: int = 600,
        bitrate: int = 128,
        use_process_capture: bool = True,
    ):
        self.session_id = session_id
        self.mic_device_index = mic_device_index
        self.loopback_device_index = loopback_device_index
        self.chunk_interval = chunk_interval
        self.bitrate = bitrate
        self.use_process_capture = use_process_capture

        self._recording = False
        self._started_at: datetime | None = None
        self._ended_at: datetime | None = None
        self._pa = None
        self._mic_thread: threading.Thread | None = None
        self._chunk_timer_thread: threading.Thread | None = None

        # Per-process capture (Discord + BG3)
        self._multi_capture = None  # MultiProcessCapture instance

        # WASAPI loopback fallback (all system audio)
        self._loopback_thread: threading.Thread | None = None
        self._loopback_buffers: list[tuple[float, np.ndarray]] = []
        self._loopback_rate: int = TARGET_SAMPLE_RATE

        # Mic buffers (same pattern as AudioRecorder)
        self._mic_buffers: list[tuple[float, np.ndarray]] = []
        self._lock = threading.Lock()
        self._mic_rate: int = TARGET_SAMPLE_RATE

        # Chunk tracking
        self._current_chunk: int = 0
        self._chunk_start_time: float = 0.0
        self._session_dir: Path | None = None
        self._completed_chunks: list[dict] = []  # Metadata for completed chunks
        self._encoding_threads: list[threading.Thread] = []  # Track encoding threads

    @property
    def is_recording(self) -> bool:
        return self._recording

    @property
    def started_at(self) -> datetime | None:
        return self._started_at

    @property
    def duration_seconds(self) -> float:
        if self._started_at is None:
            return 0.0
        end = self._ended_at or datetime.now(timezone.utc)
        return (end - self._started_at).total_seconds()

    @property
    def session_dir(self) -> Path | None:
        return self._session_dir

    @property
    def completed_chunks(self) -> list[dict]:
        return list(self._completed_chunks)

    @property
    def current_chunk_index(self) -> int:
        return self._current_chunk

    @property
    def stream_status(self) -> dict[str, str]:
        """Current status of each audio stream for UI display."""
        status = {"mic": "active" if self._mic_thread and self._mic_thread.is_alive() else "inactive"}
        status["system"] = "active" if self._loopback_thread and self._loopback_thread.is_alive() else "disabled"
        if self._multi_capture:
            for label, stream in self._multi_capture.streams.items():
                if stream.error:
                    status[label] = f"error: {stream.error}"
                elif stream._running:
                    status[label] = "active"
                else:
                    status[label] = "inactive"
            # Show "waiting" for expected streams not yet discovered
            if "discord" not in status:
                status["discord"] = "waiting"
            if "game" not in status:
                status["game"] = "waiting"
        else:
            status["discord"] = "disabled"
            status["game"] = "disabled"
        return status

    def start(self) -> Path:
        """Start recording. Returns the session directory path."""
        import pyaudiowpatch as pyaudio

        self._recording = True
        self._started_at = datetime.now(timezone.utc)
        self._mic_buffers = []
        self._current_chunk = 0
        self._completed_chunks = []
        self._chunk_start_time = time.perf_counter()

        # Create session directory
        self._session_dir = SESSIONS_DIR / self.session_id
        self._session_dir.mkdir(parents=True, exist_ok=True)
        (self._session_dir / "screenshots").mkdir(exist_ok=True)

        # Initialize PyAudio for mic capture
        self._pa = pyaudio.PyAudio()

        # Start mic capture thread
        if self.mic_device_index is not None:
            mic_info = self._pa.get_device_info_by_index(self.mic_device_index)
            self._mic_rate = int(mic_info["defaultSampleRate"])
            self._mic_thread = threading.Thread(target=self._capture_mic, daemon=True)
            self._mic_thread.start()

        # Start per-process capture if requested
        if self.use_process_capture:
            try:
                from process_audio import MultiProcessCapture, is_process_loopback_supported
                if is_process_loopback_supported():
                    self._multi_capture = MultiProcessCapture()
                    self._multi_capture.start(auto_discover=True)
                    print("[chunked] Per-process capture enabled")
                else:
                    print("[chunked] Per-process capture not supported on this Windows version")
            except ImportError:
                print("[chunked] Per-process capture unavailable (missing comtypes)")

        # WASAPI loopback fallback -- captures all system audio as one stream.
        # Works alongside per-process capture as a safety net.
        if self.loopback_device_index is not None:
            try:
                lb_info = self._pa.get_device_info_by_index(self.loopback_device_index)
                self._loopback_rate = int(lb_info["defaultSampleRate"])
                self._loopback_thread = threading.Thread(target=self._capture_loopback, daemon=True)
                self._loopback_thread.start()
                print(f"[chunked] WASAPI loopback capture enabled (idx={self.loopback_device_index})")
            except Exception as e:
                print(f"[chunked] WASAPI loopback failed to start: {e}")

        # Start chunk rotation timer
        self._chunk_timer_thread = threading.Thread(target=self._chunk_timer, daemon=True)
        self._chunk_timer_thread.start()

        print(f"[chunked] Session started: {self.session_id}, chunk every {self.chunk_interval}s")
        return self._session_dir

    def stop(self) -> list[dict]:
        """Stop recording and encode the final chunk. Returns all chunk metadata."""
        self._recording = False
        self._ended_at = datetime.now(timezone.utc)

        # Wait for mic capture to stop
        if self._mic_thread:
            self._mic_thread.join(timeout=5)
            self._mic_thread = None

        # Wait for loopback capture to stop
        if self._loopback_thread:
            self._loopback_thread.join(timeout=5)
            self._loopback_thread = None

        # Wait for chunk timer to stop
        if self._chunk_timer_thread:
            self._chunk_timer_thread.join(timeout=5)
            self._chunk_timer_thread = None

        # Get sample rates before stopping streams
        process_sample_rates = {}
        if self._multi_capture:
            process_sample_rates = self._multi_capture.get_sample_rates()

        # Stop per-process capture and get remaining buffers
        process_buffers = {}
        if self._multi_capture:
            process_buffers = self._multi_capture.stop()

        # CRITICAL: let WASAPI fully release streams
        time.sleep(1.0)

        # Clean up PyAudio
        if self._pa is not None:
            try:
                self._pa.terminate()
            except Exception:
                pass
            self._pa = None

        # Encode the final partial chunk
        self._encode_chunk(process_buffers, process_sample_rates)

        # Wait for all encoding threads to finish before returning
        if self._encoding_threads:
            print(f"[chunked] Waiting for {len(self._encoding_threads)} encoding threads...")
            for t in self._encoding_threads:
                t.join(timeout=30)
            self._encoding_threads.clear()

        total_duration = self.duration_seconds
        print(f"[chunked] Session stopped. {len(self._completed_chunks)} chunks, "
              f"{total_duration:.0f}s total")
        return self._completed_chunks

    def _capture_mic(self) -> None:
        """Capture microphone audio (same pattern as AudioRecorder)."""
        import pyaudiowpatch as pyaudio

        CHUNK = 1024
        stream = None
        try:
            stream = self._pa.open(
                format=pyaudio.paFloat32,
                channels=1,
                rate=self._mic_rate,
                input=True,
                input_device_index=self.mic_device_index,
                frames_per_buffer=CHUNK,
            )

            while self._recording:
                try:
                    data = stream.read(CHUNK, exception_on_overflow=False)
                    t = time.perf_counter()
                    samples = np.frombuffer(data, dtype=np.float32)
                    with self._lock:
                        self._mic_buffers.append((t, samples))
                except Exception:
                    if not self._recording:
                        break
                    time.sleep(0.01)
        finally:
            if stream is not None:
                try:
                    stream.stop_stream()
                    time.sleep(0.05)
                    stream.close()
                except Exception:
                    pass

    def _capture_loopback(self) -> None:
        """Capture WASAPI loopback audio (all system audio)."""
        import pyaudiowpatch as pyaudio

        CHUNK = 1024
        stream = None
        try:
            lb_info = self._pa.get_device_info_by_index(self.loopback_device_index)
            channels = int(lb_info["maxInputChannels"])
            stream = self._pa.open(
                format=pyaudio.paFloat32,
                channels=channels,
                rate=self._loopback_rate,
                input=True,
                input_device_index=self.loopback_device_index,
                frames_per_buffer=CHUNK,
            )

            while self._recording:
                try:
                    data = stream.read(CHUNK, exception_on_overflow=False)
                    t = time.perf_counter()
                    samples = np.frombuffer(data, dtype=np.float32)
                    # Mix to mono if stereo
                    if channels > 1:
                        samples = samples.reshape(-1, channels).mean(axis=1)
                    with self._lock:
                        self._loopback_buffers.append((t, samples))
                except Exception:
                    if not self._recording:
                        break
                    time.sleep(0.01)
        finally:
            if stream is not None:
                try:
                    stream.stop_stream()
                    time.sleep(0.05)
                    stream.close()
                except Exception:
                    pass

    def _chunk_timer(self) -> None:
        """Periodically trigger chunk rotation."""
        while self._recording:
            elapsed = time.perf_counter() - self._chunk_start_time
            if elapsed >= self.chunk_interval:
                # Time to rotate -- drain buffers and encode
                print(f"[chunked] Rotating chunk {self._current_chunk} "
                      f"({elapsed:.0f}s elapsed)")

                # Get process audio buffers and their sample rates
                process_buffers = {}
                process_sample_rates = {}
                if self._multi_capture:
                    process_sample_rates = self._multi_capture.get_sample_rates()
                    process_buffers = self._multi_capture.get_buffers_and_clear()

                self._encode_chunk(process_buffers, process_sample_rates)
                self._current_chunk += 1
                self._chunk_start_time = time.perf_counter()
            else:
                time.sleep(1.0)  # Check every second

    def _encode_chunk(self, process_buffers: dict | None = None, process_sample_rates: dict | None = None) -> None:
        """Encode current buffers to MP3 files for this chunk."""
        chunk_idx = self._current_chunk

        # Drain mic + loopback buffers
        with self._lock:
            mic_bufs = self._mic_buffers
            self._mic_buffers = []
            loopback_bufs = self._loopback_buffers
            self._loopback_buffers = []

        # Calculate chunk timing
        if mic_bufs:
            chunk_duration = sum(len(b[1]) for b in mic_bufs) / self._mic_rate
        else:
            chunk_duration = 0.0

        chunk_offset = chunk_idx * self.chunk_interval
        chunk_meta = {
            "chunk_index": chunk_idx,
            "start_offset_seconds": chunk_offset,
            "duration_seconds": round(chunk_duration, 1),
        }

        # Encode mic audio
        if mic_bufs:
            mic_audio = np.concatenate([b[1] for b in mic_bufs])
            mic_path = self._session_dir / f"chunk_{chunk_idx:02d}_mic.mp3"
            t = threading.Thread(
                target=_encode_mono_mp3,
                args=(mic_audio, mic_path, self._mic_rate, self.bitrate),
                daemon=True,
            )
            t.start()
            self._encoding_threads.append(t)
            chunk_meta["mic_audio_path"] = str(mic_path.relative_to(SESSIONS_DIR.parent))
        else:
            chunk_meta["mic_audio_path"] = None

        # Encode per-process audio streams
        if process_buffers:
            for label, bufs in process_buffers.items():
                if not bufs:
                    continue
                audio = np.concatenate([b[1] for b in bufs])
                stream_rate = (process_sample_rates or {}).get(label, TARGET_SAMPLE_RATE)
                stream_path = self._session_dir / f"chunk_{chunk_idx:02d}_{label}.mp3"
                t = threading.Thread(
                    target=_encode_mono_mp3,
                    args=(audio, stream_path, stream_rate, self.bitrate),
                    daemon=True,
                )
                t.start()
                self._encoding_threads.append(t)
                chunk_meta[f"{label}_audio_path"] = str(
                    stream_path.relative_to(SESSIONS_DIR.parent)
                )

        # If no per-process streams, note it for fallback
        if not process_buffers or all(not v for v in process_buffers.values()):
            chunk_meta["discord_audio_path"] = None
            chunk_meta["game_audio_path"] = None

        # Encode WASAPI loopback (all system audio -- fallback/supplement)
        if loopback_bufs:
            lb_audio = np.concatenate([b[1] for b in loopback_bufs])
            lb_path = self._session_dir / f"chunk_{chunk_idx:02d}_system.mp3"
            t = threading.Thread(
                target=_encode_mono_mp3,
                args=(lb_audio, lb_path, self._loopback_rate, self.bitrate),
                daemon=True,
            )
            t.start()
            self._encoding_threads.append(t)
            chunk_meta["system_audio_path"] = str(lb_path.relative_to(SESSIONS_DIR.parent))
        else:
            chunk_meta["system_audio_path"] = None

        self._completed_chunks.append(chunk_meta)
        print(f"[chunked] Chunk {chunk_idx} encoded: {chunk_duration:.0f}s")
