# Embedded Linux: Custom Firmware for a Dual-Screen Handheld

Notes on embedded Linux systems work on a custom dual-screen Linux handheld built around a Rockchip RK3568 SoC. The platform runs a customized build of an upstream open-source firmware project (ROCKNIX as the upstream base), with a Wayland/sway compositor, RetroArch, and standalone emulators.

## Platform and packaging strategy

Customization ships as an overlay that survives OTA updates, so device-specific changes are not wiped by an upstream image refresh. The upstream system layer is forked only in the narrow places where kernel and device-tree work require it. That two-tier split, an overlay for most changes and a narrow fork where the kernel demands it, was a deliberate decision, revisited and refined the same day it was made rather than left as a first guess.

## End-to-end touch latency instrumentation

The most involved piece is a touch latency measurement rig built from scratch, because "it feels laggy" is not a number anyone can act on. It has three parts:

- An automated tap injector creates a uinput clone of the touch panel's hardware identity, so synthetic taps are kernel-timestamped exactly as a real finger would be, with no human in the loop.
- A Wayland presentation-time hook, implemented as a dlsym shim with no measurable overhead, captures actual hardware frame-flip timestamps. This isolated the compositor's own contribution at 24.4 ms measured.
- Three compositor render-timing configurations were A/B tested at 30 automated taps each. The configuration that dropped no frames shipped, cutting measured end-to-end stylus latency from about 50 ms to about 45.5 ms mean. A later compositor render-timing refinement, validated on the same rig before shipping, took roughly another 5 ms off the flip path (July 2026): the rig keeps paying for itself, because every subsequent latency claim is a measurement rather than an impression.

## GPU ceiling, established by measurement

Whether the GPU could be pushed further was answered empirically rather than assumed. With the Panfrost kernel driver bound, the compositor fell back to software rendering: no mapped GPU libraries and a 12 fps softpipe benchmark. The two upstream conditions that would reopen hardware acceleration were documented, so the ceiling is a recorded finding with a path forward, not a dead end.

## Kernel and power research, then shipped power management

The SoC BSP device tree was read directly to ground power-management decisions: a single non-WFI cpuidle state exposed through PSCI, with its entry and exit latencies. A known cpuidle/BL31 firmware deadlock was documented alongside the vendor-blob versions that fix it, and a specific cpuidle governor was recommended on that basis.

That research graduated into a shipped power stack (July 2026). Lid and power events route through custom sleep hooks, and a "deep park" feature handles the abandoned-device case: after a configurable period asleep on battery (default 24 hours), the device schedules a dark RTC wake, gives a short grace window, and powers itself fully off only if it confirms it is still unattended and not on a charger. Any human input aborts the sequence. The full path, sleep through dark wake through conditional poweroff, was verified end-to-end on hardware rather than assumed from the design. One regeneration trap surfaced and was fixed along the way: a boot-time script was silently rewriting the sleep hook every boot, so the canonical source had to move upstream of the regenerator, a classic embedded lesson about knowing which copy of a file is authoritative.

## Display suspend/resume triage

Root cause of a suspend/resume display failure was traced to the display-controller re-initialization path. An initial GPU-clock hypothesis was ruled out by verifying the relevant upstream fixes were already present in the running build, and the finding was cross-referenced against a public upstream issue rather than treated in isolation.

## Input stack across three paths

Three applications reach input through three different paths: direct evdev enumeration, SDL, and custom hooks. Each was diagnosed on its own terms:

- A compositor-owned virtual pointer node was blocking direct evdev enumeration.
- An SDL controller-GUID CRC mismatch between SDL versions was resolved with a dual-GUID mapping, so the same controller resolves correctly under both versions.

## A bottom-screen input surface for DOS emulation

The dual-screen form factor invited a bespoke feature: a keyboard-and-trackpad input surface rendered on the lower screen for DOS games running on the upper one (completed July 2026). The surface injects input through the emulator's own input stack rather than faking hardware events, offers keyboard, gamepad-mapping, and combined modes, and ships with per-game control-doctrine strips so each title presents the inputs it actually needs. A curated library of 109 DOS titles with artwork runs against it. The hardest bug was a stale per-core options file silently overriding every global input setting, found by tracing which of three candidate config layers the emulator actually honored, the same diagnose-each-path-on-its-own-terms approach as the input-stack work above.

## Multi-user profiles and the save mesh

The devices are shared, so save data became a systems problem. A multi-user layer gives each player their own save profile via a bind-mount flip with a controller-navigable picker at boot, live on two devices (July 2026). Underneath it, a save-synchronization mesh keeps handhelds and a desktop in agreement, and a daemon on the home server auto-converts Nintendo DS saves between the two emulators' incompatible formats (one per device class) with verification, backup, and a health gate on every conversion; 53 saves ride the mesh. The conversion is fail-closed: a save that does not verify is not propagated.

## 32-bit ports on a 64-bit userland

A library of community game ports targets 32-bit ARM, while the device runs a 64-bit userland. Rather than accept the incompatibility, the armhf loader path was proven out with a 32-bit library tree, and native ports now run on the aarch64 firmware (July 2026), extending the device's library beyond what its firmware nominally supports.

The through-line is measurement before change: kernel-timestamped taps, hardware frame-flip timestamps, and direct device-tree reading, so each fix rests on an observed number rather than a guess.
