# Reference integrations

This repo vendors no code from `netboot.xyz` or `Ventoy`. Their repositories are cloned locally for interface study:

- **netboot.xyz** — studied `endpoints.yml` (hundreds of distro entries), `roles/netbootxyz/templates/menu/*.ipxe.j2`, and the `boot.netboot.xyz` asset-mirror layout to design `catalog/manifest.json` and the fetcher's URL handling. Clone: `git clone --depth 1 https://github.com/netbootxyz/netboot.xyz.git reference/netboot.xyz`
- **Ventoy** — studied `INSTALL/ventoy/*`, `ventoy.json` (`VTOYDEFAULTIMAGE` etc.), exFAT partitioning (`blkid -L Ventoy`), and the plugin framework to ensure AirBoot never mutates boot config and always writes to `ISO/*.iso`. Clone: `git clone --depth 1 https://github.com/ventoy/Ventoy.git reference/Ventoy`
- **aports** — studied `scripts/mkimage.sh`, `mkimg.standard.sh`, `genapkovl-dhcp.sh` to build `aports-patch/mkimg.abt.sh` and `scripts/genapkovl-abt.sh` correctly. Clone: `git clone --depth 1 https://gitlab.alpinelinux.org/alpine/aports.git reference/aports`

Re-clone all:

```sh
./build.sh --clone-refs
# or: ./abt build --clone-refs
```

The `reference/` directory is `.gitignore`d — re-clonable, not vendored.
