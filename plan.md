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
| 2 | Drop forced auto-boot (`VTOYDEFAULTIMAGE`) by default | Avoids boot-loop traps, JSON corruption, reset-timing paradoxes. User selects ISO manually. BUT: Ventoy **does** have loop prevention — `VTOY_MENU_TIMEOUT` (any key cancels countdown). `VTOYDEFAULTIMAGE` (an ISO path like `/ISO/debian.iso`) just sets `default` + waits `VTOY_MENU_TIMEOUT` seconds; pressing any key aborts. Trap is **persistence**: if AirBoot writes `ventoy.json` and never clears it, every subsequent boot re-auto-selects. Phase 4 adds opt-in auto-boot with `jq` + `blkid -L Ventoy` (never `/dev/sdX`) and a self-destructing reset script (deletes `VTOYDEFAULTIMAGE` after one boot). Default MVP stays manual. See §Ventoy VTOYDEFAULTIMAGE research. |
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

## Ventoy VTOYDEFAULTIMAGE research (2026-09-03)

Verified against `reference/Ventoy` (grub-2.04, `INSTALL/grub/grub.cfg`, `GRUB2/MOD_SRC/.../ventoy_cmd.c`, `Plugson/www/plugson_control.html`):

- `VTOY_DEFAULT_IMAGE` = absolute path like `/ISO/debian-12-netinst.iso` (or `/ISO/subdir/foo.iso`).
- `ventoy_cmd.c:ventoy_set_default_menu()` matches it against `g_ventoy_img_list` (populated by `vt_list_img`) and emits `set default='VID_...'` (list mode) or `set default='DIR_...>'` (tree mode). Called **before** `vt_dynamic_menu`.
- `VTOY_MENU_TIMEOUT` (seconds, default 0 = wait forever). When set, `grub.cfg` does `set timeout=$VTOY_MENU_TIMEOUT` near line 2554, so GRUB counts down and auto-boots `default`. The Ventoy plugson docs say: *"During the countdown, pressing any key will stop the countdown and wait for user operation."* That **is** loop-trap prevention — 3-10 sec window to cancel.
- Special `F[2-9]>(/path)` syntax in `grub.cfg:2729` (`regexp --set 1:vtHotkey --set 2:vtDefault "(F[2-9])>(.*)"`) maps F-keys to browser/diagnosis/localboot — not the normal `VTOY_DEFAULT_IMAGE` path.
- **Why we still default to manual**: (1) persistence — `ventoy.json` lives on the USB; without a reset, every boot auto-selects same ISO; (2) corrupted JSON from concurrent writes; (3) failed ISO keeps looping; (4) portable USBs have no NVRAM; (5) `efibootmgr --bootnext` is similarly volatile. So: default = manual. Opt-in Phase 4 auto-boot (with `jq`, `blkid -L Ventoy`, and a one-shot reset script that deletes `VTOY_DEFAULT_IMAGE` after boot) would look like:

```json
// ventoy/ventoy.json — operator-set once, AirBoot never mutates by default
{
  "control": [
    { "VTOY_DEFAULT_IMAGE": "/ISO/debian-12-netinst.iso" },
    { "VTOY_MENU_TIMEOUT": "5" }
  ]
}
```
Any key within 5 sec cancels and shows Ventoy menu. Reset script: a tiny `ventoy/ventoy_grub.cfg` hook that on next boot does `rm` or `jq 'del(.control[] | select(.VTOY_DEFAULT_IMAGE))'` via `blkid -L Ventoy` mount, then reboots clean.

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
├── abt                       # host CLI (shell) — `catalog list` always full (172)
├── plan.md / readme.md / REFERENCE.md
├── build.sh / Dockerfile     # Docker build driver (alpine:3.20)
├── scripts/
│   ├── abt-menu.sh           # fetcher (runs inside micro-OS) — MVP default: debian-12-netinst (700M)
│   ├── genapkovl-abt.sh      # overlay generator (/etc/local.d)
│   └── generate-catalog.py   # endpoints.yml → catalog/netboot-full.json + manifest
├── aports-patch/mkimg.abt.sh # build profile (linux-firmware-other + sof-firmware)
├── catalog/
│   ├── manifest.json         # 7-entry MVP subset (fallback offline) with provider fields
│   └── netboot-full.json     # 172-entry full roster (netboot.xyz + upstream ISOs, provider + ventoy_bootable)
└── reference/                # cloned for interface study (gitignored)
    ├── netboot.xyz (endpoints.yml, templates)
    ├── Ventoy (grub.cfg, ventoy_cmd.c)
    └── aports
```

## Open Questions / Risks

- Flash wear: multi-GB rewrites degrade cheap NAND — document SSD target for heavy use.
- Firmware size vs "micro": accept compatibility > size for MVP.
- WPA-Enterprise deferred to Phase 4.
- Secure Boot: MVP assumes disabled or Ventoy MOK enrolled.

## Catalog strategy (2026-09-03 update, --full removed)

- **MVP default download**: `debian-12-netinst` (700M, mobile/metered friendly) — not Ubuntu 6G. `CATALOG_FALLBACK` in `abt-menu.sh` ordered small→large.
- **`abt catalog list` always full**: 172 entries from `catalog/netboot-full.json` (generated from `reference/netboot.xyz/endpoints.yml` + upstream ISO overrides via `scripts/generate-catalog.py`). No `--full` flag — list is full by default; `--full` is silently ignored for compat. `catalog/manifest.json` (7 entries) is just the offline fallback.
- **Provider (not "curated")**: each image has `provider` — the authoritative host, not AirBoot's opinion. Examples: `Debian (cdimage.debian.org)`, `Omarchy (iso.omarchy.org, GitHub omacom/omarchy)`, `Ubuntu (releases.ubuntu.com)`, `CachyOS (mirror.cachyos.org)` for monolithic Ventoy ISOs; `netboot.xyz (github.com/netbootxyz/asset-mirror / boot.netboot.xyz)` for netboot bundles. YUMI/Ventoy themselves don't host a download catalog — YUMI is a multiboot installer that now reuses Ventoy's bootloader, Ventoy lists 1300+ *tested* ISOs but not downloads; netboot.xyz is the only broad download catalog, but for Ventoy you need its single-file ISOs, not its bundles.
- **Squashfs vs Ventoy ISO — what it means**: netboot.xyz mostly doesn't host single ISOs. For each OS it stores separate files (`vmlinuz` + `initrd` + `filesystem.squashfs` or `airootfs.sfs`) on GitHub Releases (`asset-mirror`) and at `boot.netboot.xyz`. iPXE boots them with `kernel vmlinuz … archiso_http_srv=…` + `initrd initrd` + `initrd airootfs.sfs` (see `reference/netboot.xyz/roles/.../live-omarchy.ipxe.j2`). Ventoy can't boot that — it expects one `.iso` with ISO9660 magic `CD001` at 32769 and El Torito. Copying the three files together doesn't make an ISO. Omarchy therefore has two representations: `iso.omarchy.org/omarchy-4.0.2.iso` (5.8G, `ventoy_bootable: true`, provider omarchy.org) for Ventoy, and `asset-mirror 4.0.2: airootfs.sfs+vmlinuz+initrd` (`ventoy_bootable: false`, provider netboot.xyz) for iPXE.
- **Omarchy search**: `abt catalog search omarchy` now hits 3 rows: 1 Ventoy ISO + 2 netboot bundles. `abt catalog show omarchy-4.0.2` shows `provider: Omarchy (iso.omarchy.org …)`; `abt catalog show omarchy` explains `ventoy_bootable: false`.
- **Full list columns**: `ID  NAME  ARCH  SIZE  PROVIDER  BOOTABLE (iso/netboot)` — provider truncated to 24 chars, `iso` = Ventoy.`

## Definition of Done (MVP)

A Wi-Fi-only laptop with empty internal disk can: boot Ventoy USB → launch AirBoot → join Wi-Fi via menu → fetch **Debian 12 netinst (700M)** ISO onto Ventoy partition → reboot → manually boot ISO from Ventoy menu → reach Debian installer — zero pre-staged ISOs, no Ethernet. (Ubuntu 24.04 still available as large alternative on unmetered Wi-Fi.)
