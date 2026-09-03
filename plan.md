# AirBoot — Plan

> Like netboot.xyz, but works over Wi-Fi and boots via Ventoy.

AirBoot (`abt`) is a lightweight, RAM-resident Alpine micro-OS that lets Wi-Fi-only laptops connect to wireless, download OS images directly to local storage (netboot style), and hand off cleanly to Ventoy — no Ethernet required.

## Problem

Modern ultra-thin laptops ship without Ethernet and lack functional PXE-over-Wi-Fi in firmware. Two dominant paradigms break:

- **netboot.xyz** requires PXE / wired network boot — UEFI PXE stacks (UNDI) are wired-only; no WPA supplicant exists pre-boot.
- **Ventoy** requires ISOs pre-staged on USB — needs manual download & copy from another machine.

AirBoot bridges the gap: a tiny, always-current fetcher that rides on top of Ventoy, pulling images over Wi-Fi on demand.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                 Ventoy USB Drive (GPT)                       │
│  ┌──────────────────────────┐  ┌────────────────────────┐  │
│  │ Part 1: "Ventoy" (exFAT) │  │ Part 2: UEFI bootloader │  │
│  │  ├── ISO/                │  │  (signed Ventoy grub)  │  │
│  │  │   ├── airboot.iso     │  │                        │  │
│  │  │   └── *.iso           │  │                        │  │
│  │  └── ventoy/             │  │                        │  │
│  └──────────────────────────┘  └────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                             ▲
                             │ boots
┌────────────────────────────┴────────────────────────────────┐
│  airboot.iso (RAM-resident Alpine micro-OS)                   │
│   1. Detect & connect Wi-Fi (wpa_supplicant + udhcpc)        │
│   2. Present catalog / custom HTTPS URL                        │
│   3. Download ISO via aria2c (parallel, resumable)            │
│   4. Validate ISO magic bytes (defeat captive portals)        │
│   5. Flush & unmount                                            │
│   6. Reboot → Ventoy menu → user selects ISO                  │
└──────────────────────────────────────────────────────────────┘
```

**Separation of concerns:** AirBoot = network fetcher. Ventoy = bootloader. They never mutate each other's boot config.

## Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Drop `efibootmgr --bootnext` | Portable Ventoy USBs create no persistent NVRAM entry; temp entries are volatile and rarely named "Ventoy". |
| 2 | Drop forced auto-boot (`VTOYDEFAULTIMAGE`) | Avoids boot-loop traps, JSON corruption, reset-timing paradoxes. User selects ISO manually. |
| 3 | `wpa_supplicant + udhcpc`, not `iwd` | iwd needs D-Bus and races with manual DHCP; wpa_supplicant is bulletproof in live envs. |
| 4 | Tag-based SSID parsing | SSIDs contain spaces; naive `awk '{print $1}'` truncates them. |
| 5 | Autostart via `/etc/local.d/`, not `inittab` sed | Direct inittab editing is fragile and caused double-sed overwrite bugs. |
| 6 | Validate ISO magic bytes (CD001) | Defeats captive portals returning HTML instead of the image. |
| 7 | Auto-repair exFAT dirty bit | Users yank USBs from Windows without ejecting; Linux then mounts read-only. |
| 8 | Force `.iso` extension | Ventoy only lists known image extensions. |
| 9 | Cache-aware downloads | Skip re-download if ISO already exists on Ventoy partition. |

## Phased Implementation

### Phase 0 — Build Environment
- [x] Docker container: `alpine:3.20` (privileged, workspace-mounted)
- [x] ISO toolchain: `alpine-sdk xorriso syslinux grub-efi squashfs-tools mtools dosfstools abuild`
- [x] Unprivileged builder user + `abuild-keygen`
- [x] Clone `aports` (shallow) + reference repos (`netboot.xyz`, `Ventoy`)
- [ ] Acceptance: `mkimage.sh` builds a stock Alpine ISO

### Phase 1 — MVP Core
- [ ] `scripts/abt-menu.sh`: mount Ventoy by label, fsck, Wi-Fi scan/connect, catalog, aria2c download, reboot
- [ ] `scripts/genapkovl-abt.sh` using `/etc/local.d/abt-menu.start`
- [ ] `aports-patch/mkimg.abt.sh` (profile_abbrev="abt")
- [ ] Acceptance: Wi-Fi-only laptop fetches Ubuntu 24.04, reboots, ISO appears + boots from Ventoy menu

### Phase 2 — Robustness
- [ ] Captive portal defense: `hexdump` check for `CD001` at offset 32769
- [ ] Filename sanitization: force `.iso`, strip specials
- [ ] Resume via `aria2c --continue`
- [ ] Cache check: `dialog --yesno` before overwrite
- [ ] Stall fallback to `wget` single-thread
- [ ] Acceptance: captive portal rejected; dirty USB self-repairs

### Phase 3 — UX & Catalog Polish
- [ ] Progress bar + ETA from aria2c
- [ ] Remote catalog: signed JSON manifest (SHA256) instead of hard-coded URLs
- [ ] Multi-arch awareness (x86_64 / aarch64)
- [ ] Graceful cancel at every dialog step
- [ ] Acceptance: manifest edit ships new distro without ISO rebuild

### Phase 4 — v2.0 Netboot Orchestration
- [ ] Preseed / autoinstall bundling via seed.iso
- [ ] Optional auto-boot via `jq` + blkid (never `/dev/sdX`)
- [ ] GRUB param injection via `ventoy_grub.cfg`
- [ ] Acceptance: hands-free automated install, no boot-loop on cancel

## Technical Specification

### Runtime package manifest
```
alpine-base linux-lts linux-firmware linux-firmware-other sof-firmware
wpa_supplicant dialog aria2 efibootmgr util-linux exfatprogs
dosfstools e2fsprogs ca-certificates curl jq iw
```
`linux-firmware-other` + `sof-firmware` critical — modern Intel/Realtek/Mediatek/Broadcom Wi-Fi needs them.

### Build profile (`aports-patch/mkimg.abt.sh`)
See file for canonical definition.

### Ventoy layout
```
/dev/sdX
 ├── Part 1 (exFAT, label "Ventoy")  ← ISO/ + ventoy/
 └── Part 2 (FAT, signed UEFI boot)
```
Deploy AirBoot as `/ISO/airboot.iso`; optionally default via static `ventoy.json` `VTOYDEFAULTIMAGE` (set once by operator, never by AirBoot).

## Reference Integrations

- **netboot.xyz**: consulted for endpoint manifest model (`endpoints.yml`), iPXE menu generation, catalog structure, asset mirroring strategy. AirBoot's `catalog/manifest.json` mirrors that model but for direct ISO HTTPS URLs with SHA256. Reference clone: `reference/netboot.xyz`.
- **Ventoy**: consulted for partition layout (exFAT label "Ventoy"), `ventoy.json` schema, extension filtering, `ventoy_grub.cfg` injection, plugin framework. Reference clone: `reference/Ventoy`.

## Edge-Case Register

| Edge case | Symptom | Mitigation | Phase |
|-----------|---------|------------|-------|
| Captive portal | Downloads HTML, boot panics | CD001 magic-byte check | 2 |
| exFAT dirty bit | Read-only mount | fsck.exfat -a | 1/2 |
| Spaces in SSID | Wrong network | Tag-based dialog mapping | 1 |
| Spaces in filename | Ventoy hides ISO | Sanitize + force .iso | 2 |
| Enterprise DPI | aria2c stalls 99% | Fallback wget | 2 |
| WPA-Enterprise | Cannot connect PSK menu | Document limitation | 4 |
| Missing firmware | wlan0 absent | firmware packages | 1 |
| Partial download | Corrupt ISO | aria2c --continue + prompt | 2 |
| Warm-reboot USB skip | Boots internal disk | F12 re-select | doc |
| Secure Boot | Unsigned kernel rejected | Disable / MOK | doc |

## Test Matrix

| Scenario | Expected |
|----------|----------|
| Clean WPA2-PSK | Fetch + reboot + manual boot succeeds |
| SSID with spaces | Correct network joined |
| Hotel captive portal | Rejected with error |
| Dirty exFAT | Auto-repaired, proceeds |
| Existing ISO cache | Prompt skip/redownload |
| Interrupted 50% | Resumes on next run |
| No Wi-Fi adapter | Clean error, no crash |
| Custom HTTPS URL | Fetches arbitrary ISO, validates |

## Repository Layout

```
airboot/
├── abt                       # host CLI (shell)
├── plan.md
├── readme.md
├── build.sh                  # Docker build driver
├── Dockerfile
├── scripts/
│   ├── abt-menu.sh           # fetcher (runs inside micro-OS)
│   └── genapkovl-abt.sh      # overlay generator
├── aports-patch/
│   └── mkimg.abt.sh          # build profile
├── catalog/
│   └── manifest.json         # remote catalog (Phase 3)
└── reference/                # cloned for interface study (gitignored)
    ├── netboot.xyz
    ├── Ventoy
    └── aports
```

## Open Questions / Risks

- Flash wear: multi-GB rewrites degrade cheap NAND — document SSD target for heavy use.
- Firmware size vs "micro": accept compatibility > size for MVP.
- WPA-Enterprise deferred to Phase 4.
- Secure Boot: MVP assumes disabled or Ventoy MOK enrolled.

## Definition of Done (MVP)

A Wi-Fi-only laptop with empty internal disk can: boot Ventoy USB → launch AirBoot → join Wi-Fi via menu → fetch Ubuntu 24.04 ISO onto Ventoy partition → reboot → manually boot ISO from Ventoy menu → reach Ubuntu installer — zero pre-staged ISOs, no Ethernet.
