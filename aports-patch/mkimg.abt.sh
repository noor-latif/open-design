#!/bin/sh
# mkimg.abt.sh — Alpine aports build profile for AirBoot
# Drop into aports/scripts/ (or pass via --aports-patch) and build with:
#   ./mkimage.sh --tag edge --arch x86_64 --profile abt --outdir /work/out --workdir /work/work
#
# Design notes:
# - linux-firmware-other + sof-firmware are intentional: modern Intel/Realtek/Mediatek/Broadcom
#   Wi-Fi will not light up without them. We accept the size trade-off.
# - We do NOT include iwd (needs D-Bus, races with udhcpc). wpa_supplicant is the MVP.
# - iw is included for SSID scanning (iw dev <if> scan).

profile_abt() {
	profile_standard
	profile_abbrev="abt"
	title="AirBoot"
	desc="Like netboot.xyz, but works over Wi-Fi and boots via Ventoy. RAM-resident fetcher micro-OS."
	arch="x86_64"
	image_ext="iso"
	output_format="iso"
	# Keep initrd small but functional; sd-mod + usb-storage for Ventoy USB, loop + squashfs for Alpine
	kernel_cmdline="modules=loop,squashfs,sd-mod,usb-storage quiet"
	apkovl="/work/genapkovl-abt.sh"
	# Keep in sync with readme / plan runtime manifest
	apks="$apks linux-lts linux-firmware linux-firmware-other sof-firmware \
		wpa_supplicant dialog aria2 efibootmgr util-linux exfatprogs jq iw \
		dosfstools e2fsprogs ca-certificates curl wireless-regdb \
		busybox-openrc openrc"
}
