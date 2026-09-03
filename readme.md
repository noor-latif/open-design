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

No `efibootmgr --bootnext`, no `VTOYDEFAULTIMAGE` auto-boot — manual selection after reboot avoids NVRAM and boot-loop traps.

## `abt` CLI

```
abt --help
abt version
abt build [--arch x86_64] [--outdir ./out] [--workdir ./work] [--profile abt]
abt fetch <url> [--out FILE] [--sha256 HASH]     # host-side fetch with validation
abt validate <file>                              # check ISO 9660 magic bytes
abt catalog list | show <id> | fetch             # inspect remote catalog
abt ventoy --copy <device|mountpoint>            # deploy airboot.iso to Ventoy USB
```

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
- **Optional** `ventoy/ventoy.json` `VTOYDEFAULTIMAGE` — set once by operator, never written by AirBoot at runtime (boot-loop risk)

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

`catalog/manifest.json` is the Phase 3 remote catalog. MVP ships with hard-coded entries in `scripts/abt-menu.sh` and a local `catalog/manifest.json` for host-side `abt catalog` / future OTA fetch.

```json
{
  "version": 1,
  "updated": "2026-09-03",
  "images": [
    {
      "id": "ubuntu-24.04",
      "name": "Ubuntu 24.04.3 LTS Desktop",
      "url": "https://releases.ubuntu.com/24.04.3/ubuntu-24.04.3-desktop-amd64.iso",
      "sha256": "...",
      "arch": "x86_64",
      "size_human": "6.0G"
    }
  ]
}
```

Future: fetch + verify a signed remote manifest instead of rebuilding the ISO.

## Edge Cases

See `plan.md` for the full register. Highlights: captive portal defense, dirty-bit repair, SSID spaces, DPI stalls (aria2c → wget fallback), resume, missing firmware, Secure Boot.

## Development

```sh
# Lint shell scripts
shellcheck abt scripts/*.sh aports-patch/*.sh

# Host-side fetch smoke test (no hardware needed)
./abt fetch https://releases.ubuntu.com/24.04.3/ubuntu-24.04.3-desktop-amd64.iso --out /tmp/test.iso
./abt validate /tmp/test.iso

# Build ISO (needs docker, ~2 GB, privileged for loop devices)
./abt build
```

## Project Status

- **Phase 0** — Build environment: done (Dockerfile, aports, reference clones)
- **Phase 1 — MVP**: `scripts/abt-menu.sh` + `genapkovl-abt.sh` + `mkimg.abt.sh` scaffolded, awaiting hardware acceptance
- **Phase 2 — Robustness**: captive-portal check, sanitization, cache prompt implemented
- **Phase 3 — Catalog polish**: local manifest + remote-fetch path scaffolded
- **Phase 4 — Orchestration**: deferred (preseed/seed.iso, optional auto-boot)

## License

MIT. Ventoy (GPLv3) and netboot.xyz (Apache 2.0) are referenced as external projects; their licenses do not apply to AirBoot code.
