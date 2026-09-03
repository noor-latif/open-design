#!/usr/bin/env python3
"""
generate-catalog.py — expand netboot.xyz endpoints.yml into AirBoot catalogs

Reads reference/netboot.xyz/endpoints.yml (netboot's ~130 squashfs/kernel endpoints)
and produces:
  catalog/netboot-full.json  — raw netboot endpoints re-shaped as AirBoot-ish entries
  (with boot.netboot.xyz asset-mirror URLs, plus curated ISO overrides where known)

Also merges curated ISO overrides (including Omarchy) so `catalog/manifest.json`
ends up being the *curated Ventoy-ISO* catalog that actually boots via Ventoy,
while netboot-full.json is the full fidelity netboot roster for reference/search.

Usage:
  ./scripts/generate-catalog.py
  ./scripts/generate-catalog.py --check   # lint only
  ./scripts/generate-catalog.py --out catalog/netboot-full.json

Mobile note: debian-12-netinst stays the MVP default (smallest). The full catalog
is large (130 entries) but most are squashfs netboot assets, not single ISOs —
not Ventoy-bootable without reconstruction. Only curated `manifest.json` entries
with `url` pointing to a real .iso are Ventoy-friendly.
"""
import argparse, json, sys, os, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENDPOINTS = ROOT / "reference/netboot.xyz/endpoints.yml"
MANIFEST = ROOT / "catalog/manifest.json"
FULL_OUT = ROOT / "catalog/netboot-full.json"

# Curated ISO overrides — real single-file ISOs that Ventoy can boot.
# Supplement netboot's squashfs endpoints with direct upstream ISO URLs.
# Size/sha filled where we have them; others left null for later enrichment.
ISO_OVERRIDES = {
    "debian-12-netinst": {
        "id": "debian-12-netinst",
        "name": "Debian 12 (Bookworm) netinst",
        "url": "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.11.0-amd64-netinst.iso",
        "arch": "x86_64", "version": "12.11.0", "size_human": "700M",
        "homepage": "https://www.debian.org/distrib/",
        "tags": ["mvp", "small", "netinst"], "os": "debian"
    },
    "debian-13-netinst": {
        "id": "debian-13-netinst",
        "name": "Debian 13 (Trixie) netinst — testing",
        "url": "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-13.6.0-amd64-netinst.iso",
        "arch": "x86_64", "version": "13.6.0", "size_human": "700M",
        "homepage": "https://www.debian.org/distrib/",
        "tags": ["debian", "netinst"], "os": "debian"
    },
    "omarchy-4.0.2": {
        "id": "omarchy-4.0.2",
        "name": "Omarchy 4.0.2 (Arch + Hyprland)",
        "url": "https://iso.omarchy.org/omarchy-4.0.2.iso",
        "arch": "x86_64", "version": "4.0.2", "size_human": "5.8G",
        "sha256": "2ef8e624aa1bec7e277e28056b8535a6c9373ba48d7ede3f1a01cb6d2373cfb8",
        "homepage": "https://omarchy.org",
        "netboot_endpoint": "omarchy",
        "tags": ["omarchy", "arch"], "os": "omarchy"
    },
    "omarchy-netboot": {  # netboot's own squashfs flavor — not Ventoy ISO, but keep for search
        "id": "omarchy-netboot",
        "name": "Omarchy 4.0.2 (netboot squashfs)",
        "url": None,
        "netboot_path": "/asset-mirror/releases/download/4.0.2-abf09efd/",
        "netboot_files": ["airootfs.sfs", "initrd", "vmlinuz"],
        "arch": "x86_64", "version": "4.0.2",
        "homepage": "https://omarchy.org",
        "tags": ["omarchy", "netboot", "not-ventoy"], "os": "omarchy"
    },
    "ubuntu-24.04": {
        "id": "ubuntu-24.04",
        "name": "Ubuntu 24.04.3 LTS (Noble) Desktop",
        "url": "https://releases.ubuntu.com/24.04.3/ubuntu-24.04.3-desktop-amd64.iso",
        "arch": "x86_64", "version": "24.04.3", "size_human": "6.0G",
        "homepage": "https://ubuntu.com/download/desktop",
        "tags": ["ubuntu", "large"], "os": "ubuntu"
    },
    "arch-2025.09": {
        "id": "arch-2025.09",
        "name": "Arch Linux 2025.09",
        "url": "https://geo.mirror.pkgbuild.com/iso/2025.09.01/archlinux-2025.09.01-x86_64.iso",
        "arch": "x86_64", "version": "2025.09.01", "size_human": "1.2G",
        "homepage": "https://archlinux.org/download/",
        "tags": ["arch"], "os": "arch"
    },
    "fedora-42-workstation": {
        "id": "fedora-42-workstation",
        "name": "Fedora 42 Workstation",
        "url": "https://download.fedoraproject.org/pub/fedora/linux/releases/42/Workstation/x86_64/iso/Fedora-Workstation-Live-x86_64-42-1.1.iso",
        "arch": "x86_64", "version": "42", "size_human": "2.3G",
        "homepage": "https://fedoraproject.org/workstation/download",
        "tags": ["fedora"], "os": "fedora"
    },
    "cachyos": {
        "id": "cachyos-260809",
        "name": "CachyOS 260809 (Arch-optimized)",
        "url": "https://mirror.cachyos.org/iso/cachyos-260809.iso",
        "arch": "x86_64", "version": "260809", "size_human": "2.5G",
        "homepage": "https://cachyos.org",
        "netboot_endpoint": "cachyos",
        "tags": ["arch", "cachyos"], "os": "cachyos"
    },
}

def load_endpoints():
    import yaml
    with open(ENDPOINTS) as f:
        raw = yaml.safe_load(f)
    eps = raw.get("endpoints", raw)  # file is {endpoints: {key: {...}}}
    if isinstance(eps, dict) and "endpoints" in eps:
        eps = eps["endpoints"]
    return eps

def endpoint_to_entry(key, val):
    # Map netboot endpoint to AirBoot-ish entry.
    # Most are squashfs netboot, not single ISOs — mark accordingly.
    os_name = val.get("os", "?")
    version = str(val.get("version", ""))
    flavor = val.get("flavor", "")
    arch = val.get("arch", "x86_64")
    path = val.get("path", "")
    files = val.get("files", [])
    # Prefer ISO file if endpoint already has one (e.g. tails, proxmox.iso)
    iso_file = next((f for f in files if f.endswith(".iso")), None)
    # Build URL: if there's an .iso in files, it's at boot.netboot.xyz's github mirror
    # path is like /asset-mirror/releases/download/4.0.2-abf09efd/
    # full url would be https://github.com/netbootxyz/asset-mirror/releases/download/... + file
    # but netboot's live_endpoint is https://github.com/netbootxyz  — path is under that.
    url = None
    if iso_file and path:
        # Use github asset-mirror for iso-bearing endpoints
        url = f"https://github.com/netbootxyz/asset-mirror/releases/download/{path.strip('/').split('/')[-1]}/{iso_file}" if "/asset-mirror/" in path else None
        # Fallback: many iso endpoints have direct path, try to reconstruct
        # For proxmox, path is /asset-mirror/.../proxmox.iso — that is the iso itself
    # Otherwise, no single ISO — keep as netboot-only
    name = f"{os_name} {version} {flavor}".strip()
    if not name or name == os_name:
        name = f"{os_name} {key}"
    return {
        "id": key,
        "name": name,
        "description": f"netboot.xyz endpoint — {os_name} {version} {flavor} ({arch}) — {'ISO' if iso_file else 'squashfs/netboot (not Ventoy single ISO)'}",
        "url": url,
        "arch": arch,
        "version": version,
        "os": os_name,
        "flavor": flavor,
        "netboot_path": path,
        "netboot_files": files,
        "netboot_iso_file": iso_file,
        "sha256": None,
        "size_human": None,
        "tags": ["netboot", "squashfs" if not iso_file else "iso"] + ([os_name] if os_name != "?" else []),
        "ventoy_bootable": bool(iso_file),
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(FULL_OUT))
    ap.add_argument("--check", action="store_true", help="lint only")
    ap.add_argument("--with-iso-overrides", action="store_true", default=True, help="merge ISO overrides into full catalog")
    args = ap.parse_args()

    try:
        eps = load_endpoints()
    except FileNotFoundError:
        print(f"Missing {ENDPOINTS} — run ./build.sh --clone-refs first", file=sys.stderr)
        sys.exit(1)
    except ImportError as e:
        print(f"Need PyYAML: pip install pyyaml ({e})", file=sys.stderr)
        sys.exit(1)

    entries = []
    for k, v in sorted(eps.items()):
        entries.append(endpoint_to_entry(k, v))

    # Merge ISO overrides: replace or add
    by_id = {e["id"]: e for e in entries}
    for oid, o in ISO_OVERRIDES.items():
        # If override id already exists (e.g. omarchy), replace/enrich
        if oid in by_id:
            by_id[oid].update({k: v for k, v in o.items() if v is not None})
            # ensure ventoy_bootable
            by_id[oid]["ventoy_bootable"] = bool(o.get("url"))
        else:
            # New entry — mark ventoy bootable if url present
            e = dict(o)
            e.setdefault("ventoy_bootable", bool(o.get("url")))
            e.setdefault("description", e.get("name", oid))
            entries.append(e)
            by_id[oid] = e
        # also handle omarchy -> omarchy-4.0.2 mapping
        if oid == "omarchy-4.0.2" and "omarchy" in by_id:
            # keep netboot omarchy separate; don't overwrite it
            pass

    # De-duplicate by id
    seen = set()
    deduped = []
    for e in entries:
        if e["id"] not in seen:
            deduped.append(e)
            seen.add(e["id"])

    # Sort: ventoy-bootable ISOs first, then small->large, then alphabetically
    def sort_key(e):
        bootable = 0 if e.get("ventoy_bootable") else 1
        # parse size
        size_order = {"M": 0, "G": 1}
        sh = e.get("size_human") or "Z"
        # debian netinst should sort first regardless
        if e["id"] == "debian-12-netinst":
            return (-1, 0, e["id"])
        return (bootable, sh, e["id"])
    deduped.sort(key=sort_key)

    full = {
        "version": 1,
        "updated": "2026-09-03",
        "source": "https://github.com/noor/airboot (generated from netboot.xyz endpoints.yml)",
        "counts": {
            "total": len(deduped),
            "ventoy_bootable_iso": sum(1 for e in deduped if e.get("ventoy_bootable")),
            "netboot_squashfs": sum(1 for e in deduped if not e.get("ventoy_bootable")),
        },
        "notes": "Full netboot.xyz roster re-shaped for AirBoot search. Only entries with ventoy_bootable:true and a url are direct ISOs Ventoy can boot. Others are squashfs/netboot (kernel+initrd+squashfs) — not single ISOs. Curated Ventoy ISOs live in catalog/manifest.json (small MVP). Use `abt catalog --full list | grep omarchy` to search.",
        "images": deduped,
    }

    # Also report omarchy hits
    omarchy_hits = [e for e in deduped if "omarchy" in e.get("id","").lower() or e.get("os")=="omarchy"]
    print(f"Endpoints: {len(eps)} → entries: {len(deduped)} (bootable ISO: {full['counts']['ventoy_bootable_iso']}, squashfs: {full['counts']['netboot_squashfs']})")
    print(f"Omarchy hits: {len(omarchy_hits)}")
    for h in omarchy_hits:
        print(f"  - {h['id']}: url={h.get('url')} ventoy_bootable={h.get('ventoy_bootable')} path={h.get('netboot_path')}")

    if args.check:
        # Validate curated manifest still has debian first
        with open(MANIFEST) as f:
            m = json.load(f)
        first = m["images"][0]["id"] if m["images"] else "?"
        if first != "debian-12-netinst":
            print(f"WARN: manifest first entry is {first}, expected debian-12-netinst for mobile MVP", file=sys.stderr)
            sys.exit(2)
        # Check omarchy present
        if not any(i["id"].startswith("omarchy") for i in m["images"]):
            print("WARN: manifest missing omarchy entry", file=sys.stderr)
            sys.exit(2)
        print("check ok")
        return

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        json.dump(full, f, indent=2)
    print(f"Wrote {out} ({out.stat().st_size/1024:.1f} KB)")

if __name__ == "__main__":
    main()
