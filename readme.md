# AirBoot — `abt`

> **Like netboot.xyz, but works over Wi-Fi and boots via Ventoy.**

Over-the-air ISO fetcher and boot companion for Ventoy. A tiny, RAM-resident Alpine micro-OS that lets Wi-Fi-only laptops connect to wireless networks, download OS images directly to local storage, and hand off cleanly to Ventoy — no Ethernet required.

```
Ventoy USB (GPT)                    RAM micro-OS
┌──────────────────────┐           ┌─────────────────────┐
│ Part 1: Ventoy exFAT │◄──writes──│  abt fetcher        │
│  ISO/airboot.iso     │           │  wpa_supplicant     │
│  ISO/ubuntu-*.iso    │           │  aria2c  dialog     │
│ Part 2: UEFI boot    │──boots───►│  validate  reboot  │
└──────────────────────┘           └─────────────────────┘
```

## Quickstart

### 1. Get `abt`

```sh
git clone https://github.com/noor/airboot && cd airboot
chmod +x abt
./abt --help
# or install to PATH
sudo install -m755 abt /usr/local/bin/abt
```

### 2. Build the micro-OS ISO (requires Docker)

```sh
abt build              # builds out/airboot.iso via Alpine aports
# custom arch/outdir:
abt build --arch x86_64 --outdir ./out
```

### 3. Deploy to Ventoy USB

```sh
# Create Ventoy USB first: https://www.ventoy.net/en/doc_start.html
# Then copy:
abt ventoy --copy /dev/sdX          # or manually:
cp out/airboot.iso /run/media/$USER/Ventoy/ISO/airboot.iso
```

### 4. Boot

1. Boot the Ventoy USB → select `airboot.iso`
2. AirBoot scans Wi-Fi, you pick SSID + enter PSK
3. Pick an image from the catalog (or paste a custom HTTPS URL)
4. `aria2c` fetches the ISO to the Ventoy partition with resume + magic-byte validation
5. Reboot → Ventoy menu → select the fetched ISO → install

Manual selection by default (no `efibootmgr --bootnext`, no auto `VTOYDEFAULTIMAGE` write) — avoids NVRAM and boot-loop traps. Ventoy *does* have cancel prevention when `VTOYDEFAULTIMAGE` is used: `VTOY_MENU_TIMEOUT` seconds + any key aborts (see `plan.md` §VTOYDEFAULTIMAGE research). Phase 4 can opt-in to 5-sec auto-boot with a self-destructing reset script via `ventoy_grub.cfg`.

## `abt` CLI

```
abt --help
abt version
abt build [--arch x86_64] [--outdir ./out] [--workdir ./work] [--profile abt]
abt fetch <url> [--out FILE] [--sha256 HASH]     # host-side fetch with validation
abt validate <file>                              # check ISO 9660 magic bytes
abt catalog list | search <term> | show <id> | fetch   # full roster (170+), provider column
abt ventoy --copy <device|mountpoint>            # deploy airboot.iso to Ventoy USB
```
`catalog list` always shows the **full** roster (netboot.xyz + upstream ISOs). MVP default download is **Debian 12 netinst (700M)** — not Ubuntu 6G — so it works on mobile/metered Wi-Fi.

Host-side `abt fetch` is useful for testing catalog URLs without booting the micro-OS. It mirrors the same `CD001` validation and `aria2c --continue` semantics as `abt-menu.sh`.

## Architecture

**Two-stage, separation of concerns:**

- **Stage 1 — `airboot.iso`** (RAM-resident Alpine): Wi-Fi + fetcher only. Never mutates Ventoy boot config.
- **Stage 2 — Ventoy**: bootloader only. Lists any `.iso` on the exFAT partition, boots the user's selection.

**Why this split:** Ventoy's bootloader is proven, signed, and handles 1300+ ISOs. AirBoot doesn't reimplement booting — it just lands the file where Ventoy can find it.

## Design Decisions

| Decision | Why |
|----------|-----|
| `wpa_supplicant + udhcpc`, not `iwd` | No D-Bus, no DHCP races — bulletproof in live envs |
| Tag-based SSID parsing | SSIDs contain spaces; `awk '{print $1}'` truncates them |
| `/etc/local.d/` autostart, not `inittab` sed | Avoids fragile double-sed overwrite |
| `CD001` at offset 32769 | Defeats captive portals that return HTML |
| `fsck.exfat -y` auto-repair | Users yank USBs from Windows → dirty bit → read-only mount |
| Force `.iso` extension + sanitize | Ventoy filters by extension |
| Cache-aware (`--continue` + prompt) | Skip re-download if already present |

## Ventoy Interface

- **Partition label** `Ventoy` (exFAT) — located via `blkid -L Ventoy`, never `/dev/sdX`
- **ISO drop** → `…/ISO/*.iso` — Ventoy recurses and lists known extensions
- **Optional** `ventoy/ventoy.json` `VTOYDEFAULTIMAGE` — set once by operator (e.g. `"VTOY_DEFAULT_IMAGE": "/ISO/debian-12-netinst.iso"` + `"VTOY_MENU_TIMEOUT": "5"` gives 5-sec any-key-cancel auto-boot). AirBoot never writes it by default (persistence trap). See `plan.md` for research.
- **VTOY_MENU_TIMEOUT** — verified: any key during countdown aborts auto-boot (Ventoy plugson docs + `grub.cfg:2554`). So loop protection exists, but persistence still needs a reset script.

## netboot.xyz Interface

- Studied for its **endpoint manifest** model (`endpoints.yml` → per-OS iPXE templates). AirBoot's `catalog/manifest.json` mirrors that shape: an array of `{id, name, url, sha256, arch, version}` with optional signature — but for **direct HTTPS ISO downloads** validated at fetch time.
- Fetcher stays agnostic; a manifest edit ships a new distro without rebuilding the ISO.

Reference clones (for interface study, gitignored):

```
reference/netboot.xyz   # https://github.com/netbootxyz/netboot.xyz
reference/Ventoy        # https://github.com/ventoy/Ventoy
reference/aports        # https://gitlab.alpinelinux.org/alpine/aports
```

Re-clone with: `./build.sh --clone-refs` or `abt build --clone-refs`.

## Catalog

`abt catalog list` always shows the **full** roster — `catalog/netboot-full.json` (172 entries from `endpoints.yml` + upstream ISOs, generated by `scripts/generate-catalog.py`). `catalog/manifest.json` is the same 7-entry MVP subset kept for OTA fallback when offline.

Each entry has a `provider` (authoritative upstream, not AirBoot-curated):
- Ventoy ISOs: `Debian (cdimage.debian.org)`, `Omarchy (iso.omarchy.org, GitHub omacom/omarchy)`, `Ubuntu (releases.ubuntu.com)`, `CachyOS (mirror.cachyos.org)` … — single `.iso` with CD001, Ventoy-bootable.
- Netboot bundles: `netboot.xyz (github.com/netbootxyz/asset-mirror / boot.netboot.xyz)` — separate `vmlinuz` + `initrd` + `filesystem.squashfs`/`airootfs.sfs` files that netboot.xyz's iPXE `kernel`/`initrd` commands chainload together. Ventoy **cannot** boot that bundle — it needs the monolithic ISO. No one curates a single "YUMI/Ventoy catalog" of direct ISO downloads; upstream official mirrors are the source, netboot.xyz just mirrors bursts.

Example — Omarchy appears **twice** for a reason:
- `omarchy-4.0.2` → `https://iso.omarchy.org/omarchy-4.0.2.iso` (5.8G, `provider: Omarchy (iso.omarchy.org)`, `ventoy_bootable: true`) — Ventoy yes.
- `omarchy` → `/asset-mirror/.../4.0.2/ airootfs.sfs+vmlinuz+initrd` (`provider: netboot.xyz`, `ventoy_bootable: false`) — iPXE only: `kernel vmlinuz archiso_http_srv=…` + `initrd` + `archiso_pxe_http` (see `reference/netboot.xyz/roles/.../live-omarchy.ipxe.j2`).

```sh
abt catalog list                 # 172 full roster, provider + iso/netboot columns
abt catalog search omarchy       # 3 hits (1 iso + 2 netboot bundles)
abt catalog search debian        # provider shows cdimage.debian.org vs netboot.xyz
abt catalog show omarchy-4.0.2   # provider: Omarchy (iso.omarchy.org)
abt catalog show omarchy         # netboot bundle — notes explain squashfs vs ISO
```

Generate/refresh full catalog from the pinned `endpoints.yml`:
```sh
./scripts/generate-catalog.py          # re-reads endpoints.yml → writes catalog/netboot-full.json
./scripts/generate-catalog.py --check  # lint: debian first, omarchy present
```

Remote OTA: fetcher tries `ABT_CATALOG_URL` (default `manifest.json`) then falls back to hard-coded `CATALOG_FALLBACK` in `scripts/abt-menu.sh` (Debian 700M ★ first).

## Edge Cases

See `plan.md` for the full register. Highlights: captive portal defense, dirty-bit repair, SSID spaces, DPI stalls (aria2c → wget fallback), resume, missing firmware, Secure Boot.

## Development

```sh
# Lint shell scripts
shellcheck abt scripts/*.sh aports-patch/*.sh

# Host-side fetch smoke test (no hardware needed) — use 700M Debian for mobile
./abt fetch https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.11.0-amd64-netinst.iso --out /tmp/debian.iso
./abt validate /tmp/debian.iso
./abt catalog search omarchy
./abt catalog search debian
./abt catalog show omarchy-4.0.2   # provider + squashfs explanation

# Build ISO (needs docker, ~2 GB, privileged for loop devices)
./abt build
```

## Project Status

- **Phase 0** — Build environment: done (Dockerfile, aports, reference clones)
- **Phase 1 — MVP**: `scripts/abt-menu.sh` (Debian 700M fallback first) + `genapkovl-abt.sh` + `mkimg.abt.sh` scaffolded, awaiting hardware acceptance
- **Phase 2 — Robustness**: captive-portal check, sanitization, cache prompt implemented
- **Phase 3 — Catalog polish**: local manifest + remote-fetch path scaffolded
- **Phase 4 — Orchestration**: deferred (preseed/seed.iso, optional auto-boot)

## License

MIT. Ventoy (GPLv3) and netboot.xyz (Apache 2.0) are referenced as external projects; their licenses do not apply to AirBoot code.
