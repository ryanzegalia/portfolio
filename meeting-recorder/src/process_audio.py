"""Per-process WASAPI audio capture for Windows 10 19041+ (Build 19041).

Captures audio output from a specific process (by PID) using the WASAPI
Process Loopback API via ActivateAudioInterfaceAsync. This allows capturing
Discord and BG3 audio as separate, clean streams.

Falls back gracefully if per-process capture is unavailable.
"""

import ctypes
import ctypes.wintypes as wintypes
import struct
import threading
import time
from pathlib import Path

import numpy as np
import psutil

# --- Windows version check ---

_BUILD_NUMBER = None


def _get_build_number() -> int:
    """Get the Windows build number."""
    global _BUILD_NUMBER
    if _BUILD_NUMBER is None:
        try:
            ver = ctypes.windll.ntdll.RtlGetVersion
            class OSVERSIONINFOW(ctypes.Structure):
                _fields_ = [
                    ("dwOSVersionInfoSize", wintypes.DWORD),
                    ("dwMajorVersion", wintypes.DWORD),
                    ("dwMinorVersion", wintypes.DWORD),
                    ("dwBuildNumber", wintypes.DWORD),
                    ("dwPlatformId", wintypes.DWORD),
                    ("szCSDVersion", wintypes.WCHAR * 128),
                ]
            info = OSVERSIONINFOW()
            info.dwOSVersionInfoSize = ctypes.sizeof(info)
            ver(ctypes.byref(info))
            _BUILD_NUMBER = info.dwBuildNumber
        except Exception:
            _BUILD_NUMBER = 0
    return _BUILD_NUMBER


def is_process_loopback_supported() -> bool:
    """Check if WASAPI Process Loopback is available (Windows 10 2004+)."""
    return _get_build_number() >= 19041


# --- Process discovery ---

# Known process names for games and communication apps
DISCORD_PROCESS_NAMES = {"discord.exe", "discordptb.exe", "discordcanary.exe"}
BG3_PROCESS_NAMES = {"bg3.exe", "bg3_dx11.exe", "bg3_vulkan.exe"}


def find_process_pid(process_names: set[str]) -> int | None:
    """Find the PID of a running process by name (case-insensitive).

    Returns the first matching PID, or None if not found.
    """
    for proc in psutil.process_iter(["name", "pid"]):
        try:
            if proc.info["name"].lower() in process_names:
                return proc.info["pid"]
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return None


def find_all_process_pids(process_names: set[str]) -> list[int]:
    """Find ALL PIDs matching the given process names (case-insensitive).

    Multi-process apps like Discord (Electron) spread audio across child
    processes. Returns all matching PIDs so we can try each one.
    """
    pids = []
    for proc in psutil.process_iter(["name", "pid"]):
        try:
            if proc.info["name"].lower() in process_names:
                pids.append(proc.info["pid"])
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return pids


def wait_for_process(
    process_names: set[str],
    timeout: float = 120.0,
    poll_interval: float = 3.0,
) -> int | None:
    """Wait for a process to start, polling periodically.

    Returns PID when found, or None after timeout.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        pid = find_process_pid(process_names)
        if pid is not None:
            name = psutil.Process(pid).name()
            print(f"[process_audio] Found {name} (PID {pid})")
            return pid
        time.sleep(poll_interval)
    return None


# --- COM Structures and Constants ---

# GUIDs
class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    def __init__(self, s=None):
        super().__init__()
        if s:
            import uuid
            u = uuid.UUID(s)
            self.Data1 = u.time_low
            self.Data2 = u.time_mid
            self.Data3 = u.time_hi_version
            for i, b in enumerate(u.node.to_bytes(6, "big")):
                self.Data4[i + 2] = b
            self.Data4[0] = u.clock_seq_hi_variant
            self.Data4[1] = u.clock_seq_low


IID_IAudioClient = GUID("{1CB9AD4C-DBFA-4c32-B178-C2F568A703B2}")
IID_IAudioCaptureClient = GUID("{C8ADBD64-E71E-48a0-A4DE-185C395CD317}")

# Audio format
WAVE_FORMAT_IEEE_FLOAT = 3
WAVE_FORMAT_EXTENSIBLE = 0xFFFE

# Activation types
AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0
AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1

# Process loopback modes
PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0

# Share mode
AUDCLNT_SHAREMODE_SHARED = 0

# Stream flags
AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000

# PROPVARIANT types
VT_BLOB = 65


class WAVEFORMATEX(ctypes.Structure):
    _fields_ = [
        ("wFormatTag", ctypes.c_ushort),
        ("nChannels", ctypes.c_ushort),
        ("nSamplesPerSec", ctypes.c_ulong),
        ("nAvgBytesPerSec", ctypes.c_ulong),
        ("nBlockAlign", ctypes.c_ushort),
        ("wBitsPerSample", ctypes.c_ushort),
        ("cbSize", ctypes.c_ushort),
    ]


class AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS(ctypes.Structure):
    _fields_ = [
        ("TargetProcessId", ctypes.c_ulong),
        ("ProcessLoopbackMode", ctypes.c_int),
    ]


class AUDIOCLIENT_ACTIVATION_PARAMS(ctypes.Structure):
    _fields_ = [
        ("ActivationType", ctypes.c_int),
        ("ProcessLoopbackParams", AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS),
    ]


class BLOB(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_ulong),
        ("pBlobData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


class PROPVARIANT(ctypes.Structure):
    _fields_ = [
        ("vt", ctypes.c_ushort),
        ("wReserved1", ctypes.c_ushort),
        ("wReserved2", ctypes.c_ushort),
        ("wReserved3", ctypes.c_ushort),
        ("blob", BLOB),
    ]


# Virtual device ID string for process loopback
VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback"


# --- Manual COM interface definitions ---
# IAudioClient and IAudioCaptureClient are NOT in any COM type library.
# They must be defined manually with correct vtable layout (from audioclient.h).
# Pattern follows pycaw: https://github.com/AndreMiras/pycaw

_COMTYPES_AVAILABLE = False

try:
    import comtypes
    from comtypes import COMMETHOD, HRESULT

    REFERENCE_TIME = ctypes.c_longlong

    class IAudioCaptureClient(comtypes.IUnknown):
        _iid_ = comtypes.GUID("{C8ADBD64-E71E-48a0-A4DE-185C395CD317}")
        _methods_ = (
            # GetBuffer
            COMMETHOD(
                [],
                HRESULT,
                "GetBuffer",
                (["out"], ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)), "ppData"),
                (["out"], ctypes.POINTER(ctypes.c_uint32), "pNumFramesToRead"),
                (["out"], ctypes.POINTER(ctypes.c_ulong), "pdwFlags"),
                (["out"], ctypes.POINTER(ctypes.c_uint64), "pu64DevicePosition"),
                (["out"], ctypes.POINTER(ctypes.c_uint64), "pu64QPCPosition"),
            ),
            # ReleaseBuffer
            COMMETHOD(
                [],
                HRESULT,
                "ReleaseBuffer",
                (["in"], ctypes.c_uint32, "NumFramesRead"),
            ),
            # GetNextPacketSize
            COMMETHOD(
                [],
                HRESULT,
                "GetNextPacketSize",
                (["out"], ctypes.POINTER(ctypes.c_uint32), "pNumFramesInNextPacket"),
            ),
        )

    class IAudioClient(comtypes.IUnknown):
        _iid_ = comtypes.GUID("{1CB9AD4C-DBFA-4c32-B178-C2F568A703B2}")
        _methods_ = (
            # Initialize
            COMMETHOD(
                [],
                HRESULT,
                "Initialize",
                (["in"], ctypes.c_uint, "ShareMode"),
                (["in"], ctypes.c_uint, "StreamFlags"),
                (["in"], REFERENCE_TIME, "hnsBufferDuration"),
                (["in"], REFERENCE_TIME, "hnsPeriodicity"),
                (["in"], ctypes.POINTER(WAVEFORMATEX), "pFormat"),
                (["in"], ctypes.POINTER(comtypes.GUID), "AudioSessionGuid"),
            ),
            # GetBufferSize
            COMMETHOD(
                [],
                HRESULT,
                "GetBufferSize",
                (["out"], ctypes.POINTER(ctypes.c_uint32), "pNumBufferFrames"),
            ),
            # GetStreamLatency
            COMMETHOD(
                [],
                HRESULT,
                "GetStreamLatency",
                (["out"], ctypes.POINTER(REFERENCE_TIME), "phnsLatency"),
            ),
            # GetCurrentPadding
            COMMETHOD(
                [],
                HRESULT,
                "GetCurrentPadding",
                (["out"], ctypes.POINTER(ctypes.c_uint32), "pNumPaddingFrames"),
            ),
            # IsFormatSupported
            COMMETHOD(
                [],
                HRESULT,
                "IsFormatSupported",
                (["in"], ctypes.c_uint, "ShareMode"),
                (["in"], ctypes.POINTER(WAVEFORMATEX), "pFormat"),
                (["out"], ctypes.POINTER(ctypes.POINTER(WAVEFORMATEX)), "ppClosestMatch"),
            ),
            # GetMixFormat
            COMMETHOD(
                [],
                HRESULT,
                "GetMixFormat",
                (["out"], ctypes.POINTER(ctypes.POINTER(WAVEFORMATEX)), "ppDeviceFormat"),
            ),
            # GetDevicePeriod
            COMMETHOD(
                [],
                HRESULT,
                "GetDevicePeriod",
                (["out"], ctypes.POINTER(REFERENCE_TIME), "phnsDefaultDevicePeriod"),
                (["out"], ctypes.POINTER(REFERENCE_TIME), "phnsMinimumDevicePeriod"),
            ),
            # Start
            COMMETHOD([], HRESULT, "Start"),
            # Stop
            COMMETHOD([], HRESULT, "Stop"),
            # Reset
            COMMETHOD([], HRESULT, "Reset"),
            # SetEventHandle
            COMMETHOD(
                [],
                HRESULT,
                "SetEventHandle",
                (["in"], ctypes.c_void_p, "eventHandle"),
            ),
            # GetService
            COMMETHOD(
                [],
                HRESULT,
                "GetService",
                (["in"], ctypes.POINTER(comtypes.GUID), "riid"),
                (["out"], ctypes.POINTER(ctypes.POINTER(comtypes.IUnknown)), "ppv"),
            ),
        )

    _COMTYPES_AVAILABLE = True

except ImportError:
    pass


# --- Process Loopback Capture ---

# Raw ctypes COM vtable function types for the completion handler.
# Using raw ctypes instead of comtypes.COMObject avoids pointer marshaling
# issues with ActivateAudioInterfaceAsync.
_QUERYFUNC = ctypes.WINFUNCTYPE(
    ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)
)
_ADDRELFUNC = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
_COMPLETEFUNC = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)
_GETRESULTFUNC = ctypes.WINFUNCTYPE(
    ctypes.c_long, ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_long), ctypes.POINTER(ctypes.c_void_p),
)


def _activate_process_loopback(pid: int):
    """Activate an IAudioClient for per-process loopback capture.

    Uses ActivateAudioInterfaceAsync from mmdevapi.dll with a raw ctypes
    COM completion handler (no comtypes.COMObject dependency).

    Returns a raw c_void_p pointer to the IAudioClient.
    Raises RuntimeError if activation fails.
    """
    # Load mmdevapi
    mmdevapi = ctypes.windll.LoadLibrary("mmdevapi.dll")

    # Build activation params
    activation_params = AUDIOCLIENT_ACTIVATION_PARAMS()
    activation_params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
    activation_params.ProcessLoopbackParams.TargetProcessId = pid
    activation_params.ProcessLoopbackParams.ProcessLoopbackMode = (
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
    )

    # Pack into PROPVARIANT
    params_size = ctypes.sizeof(activation_params)
    params_bytes = (ctypes.c_ubyte * params_size)()
    ctypes.memmove(params_bytes, ctypes.addressof(activation_params), params_size)

    propvariant = PROPVARIANT()
    propvariant.vt = VT_BLOB
    propvariant.blob.cbSize = params_size
    propvariant.blob.pBlobData = params_bytes

    # Completion state
    completion_event = threading.Event()
    audio_client_result = [None]  # raw c_void_p value
    error_result = [None]
    ref_count = ctypes.c_long(1)

    # Raw COM vtable callbacks
    @_QUERYFUNC
    def qi(this, riid, ppv):
        ppv[0] = this
        ref_count.value += 1
        return 0  # S_OK

    @_ADDRELFUNC
    def addref(this):
        ref_count.value += 1
        return ref_count.value

    @_ADDRELFUNC
    def release(this):
        ref_count.value -= 1
        return ref_count.value

    @_COMPLETEFUNC
    def activate_completed(this, activate_operation):
        try:
            if not activate_operation:
                error_result[0] = "ActivateCompleted: operation is NULL"
                return 0

            # Read vtable -> GetActivateResult at index 3
            vtable_ptr = ctypes.cast(activate_operation, ctypes.POINTER(ctypes.c_void_p))[0]
            get_result_ptr = ctypes.cast(vtable_ptr, ctypes.POINTER(ctypes.c_void_p))[3]
            get_result = _GETRESULTFUNC(get_result_ptr)

            hr_out = ctypes.c_long()
            iface_out = ctypes.c_void_p()
            hr = get_result(activate_operation, ctypes.byref(hr_out), ctypes.byref(iface_out))

            if hr == 0 and hr_out.value == 0 and iface_out.value:
                audio_client_result[0] = iface_out.value
            else:
                # Convert signed to unsigned for readable HRESULT
                result_hr = hr_out.value & 0xFFFFFFFF
                error_result[0] = f"Process audio activation failed (HRESULT: {result_hr:#010x})"
        except Exception as e:
            error_result[0] = str(e)
        finally:
            completion_event.set()
        return 0

    # Build vtable: [QueryInterface, AddRef, Release, ActivateCompleted]
    VTABLE = ctypes.c_void_p * 4
    vtable = VTABLE(
        ctypes.cast(qi, ctypes.c_void_p),
        ctypes.cast(addref, ctypes.c_void_p),
        ctypes.cast(release, ctypes.c_void_p),
        ctypes.cast(activate_completed, ctypes.c_void_p),
    )
    # COM object = pointer to vtable pointer
    vtable_ptr = ctypes.cast(ctypes.pointer(vtable), ctypes.c_void_p)
    handler_obj = ctypes.pointer(vtable_ptr)
    handler_as_void = ctypes.cast(handler_obj, ctypes.c_void_p)

    # Call ActivateAudioInterfaceAsync
    fn = mmdevapi.ActivateAudioInterfaceAsync
    fn.restype = ctypes.c_long  # raw HRESULT (no auto-raise)
    fn.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]

    iid = IID_IAudioClient
    async_op = ctypes.c_void_p()

    hr = fn(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        ctypes.addressof(iid),
        ctypes.addressof(propvariant),
        handler_as_void.value,
        ctypes.addressof(async_op),
    )

    if hr != 0:
        raise RuntimeError(f"ActivateAudioInterfaceAsync failed: {hr & 0xFFFFFFFF:#010x}")

    # Wait for completion
    if not completion_event.wait(timeout=10.0):
        raise RuntimeError("ActivateAudioInterfaceAsync timed out")

    if error_result[0]:
        raise RuntimeError(error_result[0])

    if audio_client_result[0] is None:
        raise RuntimeError("No audio client returned from activation")

    return audio_client_result[0]


class ProcessLoopbackStream:
    """Captures audio from a specific process via WASAPI Process Loopback.

    Provides timestamped audio buffers compatible with ChunkedAudioRecorder.
    """

    MAX_ACTIVATION_RETRIES = 12  # Max retries for 0x80070002 (no audio session, ~60s)

    def __init__(self, pid: int, label: str = "process"):
        self.pid = pid
        self.label = label
        self._running = False
        self._thread: threading.Thread | None = None
        self._buffers: list[tuple[float, np.ndarray]] = []
        self._lock = threading.Lock()
        self._sample_rate: int = 44100
        self._channels: int = 2
        self._error: str | None = None
        self._retry_count: int = 0

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    @property
    def channels(self) -> int:
        return self._channels

    @property
    def error(self) -> str | None:
        return self._error

    @property
    def buffer_count(self) -> int:
        with self._lock:
            return len(self._buffers)

    def get_buffers_and_clear(self) -> list[tuple[float, np.ndarray]]:
        """Get all captured buffers and clear the internal list.

        Returns list of (perf_counter_time, mono_float32_samples).
        """
        with self._lock:
            buffers = self._buffers
            self._buffers = []
            return buffers

    def start(self) -> bool:
        """Start capturing audio from the process. Returns True if started."""
        if not is_process_loopback_supported():
            self._error = "Process loopback not supported (requires Windows 10 2004+)"
            return False

        self._running = True
        self._buffers = []
        self._error = None
        self._thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        """Stop capturing."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None

    def _capture_loop(self) -> None:
        """Main capture loop using WASAPI process loopback.

        Retries activation iteratively (not recursively) when the target
        process has no audio session yet (0x80070002).
        """
        while self._running and self._retry_count <= self.MAX_ACTIVATION_RETRIES:
            try:
                import comtypes

                # Initialize COM for this thread
                comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)

                try:
                    # _activate_process_loopback returns a raw c_void_p integer
                    raw_ptr = _activate_process_loopback(self.pid)

                    # Cast raw pointer to comtypes IUnknown, then QueryInterface to IAudioClient
                    unk = ctypes.cast(raw_ptr, ctypes.POINTER(comtypes.IUnknown))
                    audio_client = unk.QueryInterface(IAudioClient)

                    # Hard-code format: process loopback virtual device does NOT
                    # implement GetMixFormat() (returns E_NOTIMPL).
                    # Use CD-quality PCM matching Microsoft's ApplicationLoopback sample.
                    fmt = WAVEFORMATEX()
                    fmt.wFormatTag = 1  # WAVE_FORMAT_PCM
                    fmt.nChannels = 2
                    fmt.nSamplesPerSec = 44100
                    fmt.wBitsPerSample = 16
                    fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample // 8  # 4
                    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign  # 176400
                    fmt.cbSize = 0

                    self._sample_rate = fmt.nSamplesPerSec
                    self._channels = fmt.nChannels
                    block_align = fmt.nBlockAlign

                    print(f"[process_audio:{self.label}] Format: {self._sample_rate}Hz, "
                          f"{self._channels}ch, {fmt.wBitsPerSample}bit")

                    # Initialize in shared mode with loopback + auto-convert flags
                    # (matches Microsoft ApplicationLoopback sample)
                    stream_flags = (AUDCLNT_STREAMFLAGS_LOOPBACK |
                                    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM)
                    audio_client.Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        stream_flags,
                        0,  # buffer duration (system default)
                        0,  # periodicity
                        ctypes.pointer(fmt),
                        None,  # session GUID
                    )

                    # Get capture client via GetService, then QueryInterface to typed interface
                    capture_iid = comtypes.GUID("{C8ADBD64-E71E-48a0-A4DE-185C395CD317}")
                    capture_client_unk = audio_client.GetService(capture_iid)
                    capture_client = capture_client_unk.QueryInterface(IAudioCaptureClient)

                    # Start capturing
                    audio_client.Start()
                    self._retry_count = 0  # Reset on successful activation
                    print(f"[process_audio:{self.label}] Capturing PID {self.pid}")

                    while self._running:
                        # Check if process is still alive
                        if not psutil.pid_exists(self.pid):
                            print(f"[process_audio:{self.label}] PID {self.pid} no longer exists")
                            return

                        # Read available packets
                        packet_length = capture_client.GetNextPacketSize()

                        while packet_length > 0 and self._running:
                            data_ptr, num_frames, flags, _, _ = capture_client.GetBuffer()

                            t = time.perf_counter()

                            if num_frames > 0:
                                # Read int16 PCM samples, convert to float32
                                byte_count = num_frames * block_align
                                buffer = np.ctypeslib.as_array(data_ptr, shape=(byte_count,))
                                int16_samples = np.frombuffer(
                                    bytes(buffer), dtype=np.int16
                                ).copy()
                                # Normalize to [-1.0, 1.0] float32
                                samples = int16_samples.astype(np.float32) / 32768.0

                                # Mix down to mono if multichannel
                                if self._channels > 1:
                                    samples = samples.reshape(-1, self._channels).mean(axis=1)

                                with self._lock:
                                    self._buffers.append((t, samples))

                            capture_client.ReleaseBuffer(num_frames)
                            packet_length = capture_client.GetNextPacketSize()

                        time.sleep(0.01)  # 10ms polling interval

                    # Stop and clean up
                    audio_client.Stop()
                    return  # Normal exit

                finally:
                    comtypes.CoUninitialize()

            except ImportError as e:
                self._error = f"Missing dependency: {e}. Install comtypes: pip install comtypes"
                print(f"[process_audio:{self.label}] {self._error}")
                return
            except Exception as e:
                err_str = str(e)
                if "0x80070002" in err_str and self._retry_count < self.MAX_ACTIVATION_RETRIES:
                    # Process exists but has no active audio session yet -- retry
                    self._retry_count += 1
                    print(f"[process_audio:{self.label}] PID {self.pid} has no audio session, "
                          f"retry {self._retry_count}/{self.MAX_ACTIVATION_RETRIES} in 5s...")
                    time.sleep(5.0)
                    continue  # Loop back to retry
                self._error = err_str
                print(f"[process_audio:{self.label}] Capture error: {e}")
                return


class MultiProcessCapture:
    """Manages multiple per-process audio capture streams.

    For campaign sessions: captures Discord (player voices) and BG3 (game audio)
    as separate streams alongside the regular mic capture.
    """

    def __init__(self):
        self._streams: dict[str, ProcessLoopbackStream] = {}
        self._streams_lock = threading.Lock()
        self._discovery_thread: threading.Thread | None = None
        self._running = False

    @property
    def streams(self) -> dict[str, ProcessLoopbackStream]:
        with self._streams_lock:
            return dict(self._streams)

    def start(self, auto_discover: bool = True) -> None:
        """Start capturing. If auto_discover, polls for Discord/BG3 processes."""
        self._running = True

        if auto_discover:
            self._discovery_thread = threading.Thread(
                target=self._discover_and_attach, daemon=True
            )
            self._discovery_thread.start()

    def stop(self) -> dict[str, list[tuple[float, np.ndarray]]]:
        """Stop all streams and return remaining buffers keyed by stream label."""
        self._running = False
        if self._discovery_thread:
            self._discovery_thread.join(timeout=5)
            self._discovery_thread = None

        with self._streams_lock:
            remaining = {}
            for label, stream in self._streams.items():
                stream.stop()
                remaining[label] = stream.get_buffers_and_clear()
            return remaining

    def get_buffers_and_clear(self) -> dict[str, list[tuple[float, np.ndarray]]]:
        """Get and clear buffers from all active streams."""
        with self._streams_lock:
            result = {}
            for label, stream in self._streams.items():
                result[label] = stream.get_buffers_and_clear()
            return result

    def get_sample_rates(self) -> dict[str, int]:
        """Get sample rates for all active streams."""
        with self._streams_lock:
            return {label: stream.sample_rate for label, stream in self._streams.items()}

    def add_stream(self, label: str, pid: int) -> bool:
        """Manually add a capture stream for a specific PID."""
        with self._streams_lock:
            if label in self._streams:
                return True  # Already capturing

        stream = ProcessLoopbackStream(pid, label)
        if stream.start():
            with self._streams_lock:
                self._streams[label] = stream
            print(f"[multi_capture] Added stream '{label}' for PID {pid}")
            return True
        else:
            print(f"[multi_capture] Failed to start stream '{label}': {stream.error}")
            return False

    def _try_activate_pid(self, pid: int) -> bool:
        """Quick test: can we activate process loopback for this PID?

        Returns True if activation succeeds (process has an audio session).
        """
        try:
            import comtypes
            comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
            try:
                raw_ptr = _activate_process_loopback(pid)
                # Success -- release the pointer and return True
                unk = ctypes.cast(raw_ptr, ctypes.POINTER(comtypes.IUnknown))
                unk.Release()
                return True
            except RuntimeError:
                return False
            finally:
                comtypes.CoUninitialize()
        except Exception:
            return False

    def _discover_and_attach(self) -> None:
        """Poll for Discord and BG3 processes, attaching when found.

        For multi-process apps like Discord (Electron), tries ALL matching
        PIDs and picks the one with an active audio session.
        """
        targets = {
            "discord": DISCORD_PROCESS_NAMES,
            "game": BG3_PROCESS_NAMES,
        }

        while self._running:
            for label, process_names in targets.items():
                with self._streams_lock:
                    if label in self._streams:
                        stream = self._streams[label]
                        # Remove if process died or stream errored (allows retry)
                        if not psutil.pid_exists(stream.pid):
                            print(f"[multi_capture] {label} process died, removing stream")
                            stream.stop()
                            del self._streams[label]
                        elif stream.error:
                            print(f"[multi_capture] {label} stream errored, will retry: {stream.error}")
                            stream.stop()
                            del self._streams[label]
                        continue

                # Try ALL matching PIDs -- multi-process apps may have audio
                # in a child process, not the first one psutil finds
                pids = find_all_process_pids(process_names)
                if not pids:
                    continue

                # Quick-test each PID to find the one with an active audio session
                attached = False
                for pid in pids:
                    if self._try_activate_pid(pid):
                        if self.add_stream(label, pid):
                            print(f"[multi_capture] {label}: PID {pid} has active audio (tested {len(pids)} PIDs)")
                            attached = True
                            break

                # If none had audio sessions yet, just attach to the first PID
                # and let the retry logic in ProcessLoopbackStream handle it
                if not attached and pids:
                    self.add_stream(label, pids[0])

            time.sleep(5.0)  # Check every 5 seconds
