#!/bin/sh
# abt-menu.sh — AirBoot provisioning / fetcher (runs inside the Alpine micro-OS)
# POSIX sh, no bashisms — must run in Alpine busybox ash.
#
# Responsibilities:
#   1. Locate + mount Ventoy exFAT partition (blkid -L Ventoy)
#   2. Repair dirty bit (fsck.exfat -y) + write-permission test
#   3. Wi-Fi: scan (iw), tag-based SSID menu (dialog), connect (wpa_supplicant + udhcpc)
#   4. Network readiness loop (ping 1.1.1.1)
#   5. Catalog menu (hard-coded MVP + custom HTTPS URL) — Phase 3: remote manifest
#   6. Download via aria2c (-x 8 -s 8, --continue), fallback to wget on stall
#   7. Validate ISO magic bytes (CD001 at 32769), force .iso, sanitize
#   8. Sync + unmount + reboot with "select manually" instructions
#
# Non-goals (by design):
#   - No efibootmgr --bootnext (volatile NVRAM on portable USBs)
#   - No VTOYDEFAULTIMAGE auto-boot (boot-loop trap)
#   - No iwd (needs D-Bus, races DHCP)
#
# Every dialog step has a Cancel path that returns to the previous menu or exits gracefully.

set -eu

# ---------- constants ----------
VENTOY_LABEL="Ventoy"
VENTOY_MNT="/mnt/ventoy"
VENTOY_ISO_DIR="ISO"
ABT_COUNTRY="SE"  # default, overridden by preseed airboot.json country
WPA_CONF="/tmp/wpa_supplicant.conf"
WPA_CTRL="/tmp/wpa_ctrl"
DIALOG_BACKTITLE="AirBoot — Like netboot.xyz, but works over Wi-Fi and boots via Ventoy"
CATALOG_URL_DEFAULT="https://raw.githubusercontent.com/noor/airboot/main/catalog/manifest.json"

# Hard-coded MVP catalog (mirrors catalog/manifest.json; OTA manifest overrides when reachable)
# Format: id|label|url — ordered small→large so mobile/metered default is Debian netinst (700M).
CATALOG_FALLBACK="debian-12-netinst|Debian 12 netinst (700M) ★ MVP default — mobile-friendly|https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.11.0-amd64-netinst.iso
omarchy-4.0.2|Omarchy 4.0.2 (5.8G) — Arch+Hyprland|https://iso.omarchy.org/omarchy-4.0.2.iso
arch-2025.09|Arch Linux 2025.09 (1.2G)|https://geo.mirror.pkgbuild.com/iso/2025.09.01/archlinux-2025.09.01-x86_64.iso
fedora-42-workstation|Fedora 42 Workstation (2.3G)|https://download.fedoraproject.org/pub/fedora/linux/releases/42/Workstation/x86_64/iso/Fedora-Workstation-Live-x86_64-42-1.1.iso
ubuntu-24.04|Ubuntu 24.04.3 LTS Desktop (6.0G) — unmetered only|https://releases.ubuntu.com/24.04.3/ubuntu-24.04.3-desktop-amd64.iso
custom|Custom HTTPS URL…|__CUSTOM__"

# ---------- helpers ----------
log() { printf '[abt] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Fatal: $*\n\nDropping to shell. Type 'abt-menu' to retry." 10 70 || true; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# Ensure we have a sane TERM for dialog
export TERM="${TERM:-linux}"

# Cleanup on exit
cleanup() {
	# Kill wpa_supplicant we started, if any
	if [ -f /tmp/abt_wpa.pid ]; then
		kill "$(cat /tmp/abt_wpa.pid)" 2>/dev/null || true
		rm -f /tmp/abt_wpa.pid
	fi
}
trap cleanup EXIT INT TERM

# ---------- 0. sanity ----------
for cmd in dialog blkid mount umount fsck.exfat hexdump iw wpa_supplicant wpa_passphrase udhcpc ping aria2c; do
	# fsck.exfat lives as fsck.exfat; aria2c optional for fallback path — warn once
	if [ "$cmd" = "aria2c" ] && ! command -v aria2c >/dev/null 2>&1; then
		log "aria2c not found — will use wget fallback"
		continue
	fi
	if ! command -v "$cmd" >/dev/null 2>&1; then
		# iw is optional on wired-only test rigs; fail soft
		if [ "$cmd" = "iw" ]; then log "iw not found — Wi-Fi scan will be limited"; continue; fi
		die "missing $cmd"
	fi
done

# Must be root
if [ "$(id -u)" -ne 0 ]; then die "must run as root"; fi

# ---------- 1. Mount Ventoy ----------
mount_ventoy() {
	log "Locating Ventoy partition (label=$VENTOY_LABEL)…"
	VENTOY_DEV="$(blkid -L "$VENTOY_LABEL" 2>/dev/null || true)"
	if [ -z "$VENTOY_DEV" ]; then
		# Fallback: try to find exFAT partition with ISO/ dir
		log "blkid -L $VENTOY_LABEL found nothing; scanning block devices…"
		for dev in /dev/sd* /dev/nvme* /dev/mmcblk* /dev/vd*; do
			[ -b "$dev" ] || continue
			lbl="$(blkid -o value -s LABEL "$dev" 2>/dev/null || true)"
			if [ "$lbl" = "$VENTOY_LABEL" ]; then VENTOY_DEV="$dev"; break; fi
		done
	fi
	if [ -z "$VENTOY_DEV" ]; then
		dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Ventoy partition not found.\n\nLooked for label \"$VENTOY_LABEL\" via blkid.\n\nIs the Ventoy USB inserted? Try re-plugging and retry." 12 70
		return 1
	fi
	log "Ventoy device: $VENTOY_DEV"

	# Auto-repair dirty bit BEFORE mount (otherwise Linux mounts ro)
	if command -v fsck.exfat >/dev/null 2>&1; then
		log "Checking exFAT dirty bit on $VENTOY_DEV…"
		# fsck.exfat -y repairs dirty bit non-interactively; -a is deprecated on newer exfatprogs
		# Try -y first, fall back to -a
		fsck.exfat -y "$VENTOY_DEV" 2>&1 | head -20 || fsck.exfat -a "$VENTOY_DEV" 2>&1 | head -20 || true
	fi

	mkdir -p "$VENTOY_MNT"
	# Unmount if already mounted elsewhere
	umount "$VENTOY_DEV" 2>/dev/null || true
	umount "$VENTOY_MNT" 2>/dev/null || true

	if ! mount -t exfat "$VENTOY_DEV" "$VENTOY_MNT" 2>/dev/null; then
		# Fallback: let kernel auto-detect
		mount "$VENTOY_DEV" "$VENTOY_MNT" || {
			dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Failed to mount $VENTOY_DEV at $VENTOY_MNT.\n\nTried exfat and auto. Check dmesg." 10 70
			return 1
		}
	fi
	log "Mounted $VENTOY_DEV at $VENTOY_MNT"

	# Write-permission test (catches ro mount from dirty bit)
	if ! touch "$VENTOY_MNT/.abt_write_test" 2>/dev/null; then
		dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Ventoy partition is read-only.\n\nEven after fsck, write failed.\n\n• Remove USB safely from Windows next time (Eject)\n• Or reformat the Ventoy data partition as exFAT." 12 70
		umount "$VENTOY_MNT" 2>/dev/null || true
		return 1
	fi
	rm -f "$VENTOY_MNT/.abt_write_test"

	# Detect existing ISO dir (handles ISOS vs ISO — user has ISOS) — Ventoy recurses so any works
	for _cand in "ISOS" "ISO" "iso" "isos"; do
		if [ -d "$VENTOY_MNT/$_cand" ]; then VENTOY_ISO_DIR="$_cand"; break; fi
	done
	# Ensure ISO dir exists
	mkdir -p "$VENTOY_MNT/$VENTOY_ISO_DIR"
	return 0
}

# Retry mount with user prompt
while ! mount_ventoy; do
	dialog --backtitle "$DIALOG_BACKTITLE" --yesno "Retry mounting Ventoy USB?" 7 50 || die "Ventoy mount cancelled by user"
done

# ---------- 1b. Preseed Wi-Fi (Pi Imager style — multiple networks) ----------
# Checks $VENTOY_MNT/airboot.json (host-side `abt wifi add`) before manual scan.
# JSON format: {"version":1,"country":"SE","networks":[{"ssid":"Home","psk":"..."},...]}
# Mirror also checked at ventoy/airboot.json and airboot.conf for compat. Stored chmod 600.
# Order matters: first network is highest priority.

find_wlan_if() {
	WLAN_IF=""
	for iface in /sys/class/net/wlan* /sys/class/net/wl*; do
		[ -e "$iface" ] || continue
		WLAN_IF="$(basename "$iface")"
		break
	done
	if [ -z "$WLAN_IF" ]; then
		WLAN_IF="$(iw dev 2>/dev/null | awk '$1=="Interface"{print $2; exit}' || true)"
	fi
	if [ -n "$WLAN_IF" ]; then
		ip link set "$WLAN_IF" up 2>/dev/null || true
		sleep 1
	fi
	printf '%s' "$WLAN_IF"
}

# Try to connect using preseeded JSON (no dialogs for PSK). Returns 0 on success.
connect_wifi_preseed() {
	SSID="$1"
	PSK="$2"
	KEY_MGMT="$3"  # "NONE" for open, else psk
	# WLAN_IF must already be set globally
	if [ -z "$WLAN_IF" ]; then
		log "preseed: no wlan iface"
		return 1
	fi
	log "preseed: trying [$SSID] on $WLAN_IF (country $ABT_COUNTRY)…"
	pkill -f "wpa_supplicant.*$WLAN_IF" 2>/dev/null || true
	rm -f "$WPA_CONF" "$WPA_CTRL"/* 2>/dev/null || true
	mkdir -p "$WPA_CTRL"
	if [ "$KEY_MGMT" = "NONE" ] || [ -z "$PSK" ]; then
		cat > "$WPA_CONF" <<EOF
ctrl_interface=DIR=$WPA_CTRL GROUP=netdev
update_config=1
country=$ABT_COUNTRY
network={
	ssid="$SSID"
	key_mgmt=NONE
}
EOF
	else
		if ! wpa_passphrase "$SSID" "$PSK" > "$WPA_CONF" 2>/dev/null; then
			cat > "$WPA_CONF" <<EOF
ctrl_interface=DIR=$WPA_CTRL GROUP=netdev
update_config=1
country=$ABT_COUNTRY
network={
	ssid="$SSID"
	psk="$PSK"
}
EOF
		else
			if ! grep -q "^country=" "$WPA_CONF" 2>/dev/null; then
				sed -i "1i country=$ABT_COUNTRY" "$WPA_CONF" 2>/dev/null || {
					tmp_wpa="/tmp/wpa_with_country.conf"
					printf 'country=%s\n' "$ABT_COUNTRY" > "$tmp_wpa"
					cat "$WPA_CONF" >> "$tmp_wpa"
					mv "$tmp_wpa" "$WPA_CONF"
				}
			fi
			if ! grep -q "ctrl_interface" "$WPA_CONF" 2>/dev/null; then
				sed -i "1i ctrl_interface=DIR=$WPA_CTRL GROUP=netdev" "$WPA_CONF" 2>/dev/null || true
			fi
		fi
	fi
	chmod 600 "$WPA_CONF"
	wpa_supplicant -B -i "$WLAN_IF" -c "$WPA_CONF" -P /tmp/abt_wpa.pid 2>&1 | head -20 || true
	sleep 2
	log "preseed: DHCP on $WLAN_IF…"
	udhcpc -i "$WLAN_IF" -q -n -t 5 2>&1 | tail -20 || true
	for attempt in 1 2 3 4 5; do
		if ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; then
			log "preseed: network ready via 1.1.1.1"
			return 0
		fi
		if ping -c1 -W2 8.8.8.8 >/dev/null 2>&1; then
			log "preseed: network ready via 8.8.8.8"
			return 0
		fi
		sleep 1
	done
	log "preseed: [$SSID] failed (no ping)"
	pkill -f "wpa_supplicant.*$WLAN_IF" 2>/dev/null || true
	return 1
}

try_preseed_wifi() {
	PRESEED=""
	for cand in "$VENTOY_MNT/airboot.json" "$VENTOY_MNT/ventoy/airboot.json" "$VENTOY_MNT/airboot.conf" "$VENTOY_MNT/ventoy/airboot.conf"; do
		if [ -f "$cand" ]; then PRESEED="$cand"; break; fi
	done
	if [ -z "$PRESEED" ]; then
		log "preseed: none found (checked airboot.json @ Ventoy root/ventoy/)"
		return 1
	fi
	log "preseed: found $PRESEED"
	if ! command -v jq >/dev/null 2>&1; then
		log "preseed: jq missing, cannot parse $PRESEED"
		return 1
	fi
	if ! jq -e '.networks' "$PRESEED" >/dev/null 2>&1; then
		log "preseed: invalid JSON (no .networks)"
		return 1
	fi
	count="$(jq '.networks | length' "$PRESEED" 2>/dev/null || echo 0)"
	if [ "$count" -eq 0 ]; then
		log "preseed: empty networks"
		return 1
	fi
	# Country
	_country="$(jq -r '.country // empty' "$PRESEED" 2>/dev/null || true)"
	if [ -n "$_country" ] && [ "$_country" != "null" ]; then
		ABT_COUNTRY="$_country"
		log "preseed: country $_country"
		# Try to set reg domain early
		if command -v iw >/dev/null 2>&1; then
			iw reg set "$ABT_COUNTRY" 2>/dev/null || true
		fi
	fi
	# Ensure wlan iface up before looping
	WLAN_IF="$(find_wlan_if)"
	if [ -z "$WLAN_IF" ]; then
		dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Preseeded Wi-Fi found ($count networks) but no Wi-Fi adapter detected.\n\nFalling back to manual scan." 9 70 || true
		return 1
	fi
	# Iterate networks in order (Pi Imager priority)
	i=0
	while [ "$i" -lt "$count" ]; do
		ssid="$(jq -r --argjson idx "$i" '.networks[$idx].ssid // empty' "$PRESEED" 2>/dev/null || true)"
		psk="$(jq -r --argjson idx "$i" '.networks[$idx].psk // empty' "$PRESEED" 2>/dev/null || true)"
		key_mgmt="$(jq -r --argjson idx "$i" '.networks[$idx].key_mgmt // empty' "$PRESEED" 2>/dev/null || true)"
		if [ "$psk" = "null" ]; then psk=""; fi
		if [ "$key_mgmt" = "null" ]; then key_mgmt=""; fi
		if [ -z "$ssid" ] || [ "$ssid" = "null" ]; then
			i=$((i+1))
			continue
		fi
		# Show trying dialog briefly? Use log + infobox
		dialog --backtitle "$DIALOG_BACKTITLE" --infobox "Preseeded Wi-Fi ($((i+1))/$count): trying\n  [$ssid]…" 6 60 2>/dev/null || true
		sleep 1
		if connect_wifi_preseed "$ssid" "$psk" "$key_mgmt"; then
			dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Auto-connected via preseed:\n  [$ssid] ($ABT_COUNTRY)\n\nProceeding to image catalog.\nManual scan skipped." 9 65 || true
			CHOSEN_SSID="$ssid"
			log "preseed: success with [$ssid]"
			return 0
		fi
		i=$((i+1))
	done
	log "preseed: all $count networks failed"
	dialog --backtitle "$DIALOG_BACKTITLE" --yesno "Preseeded Wi-Fi failed — none of the $count saved networks connected.\n\n• Country: $ABT_COUNTRY\n• Tried: $(jq -r '.networks[].ssid' "$PRESEED" 2>/dev/null | head -5 | tr '\n' ',' | sed 's/,/, /g')\n\nTry manual Wi-Fi scan instead?" 14 70 && return 1 || return 2
}

# ---------- 2. Wi-Fi ----------
# Returns: selected SSID in $CHOSEN_SSID
scan_wifi() {
	# Find wireless interface
	WLAN_IF=""
	for iface in /sys/class/net/wlan* /sys/class/net/wl*; do
		[ -e "$iface" ] || continue
		WLAN_IF="$(basename "$iface")"
		break
	done
	# Fallback: ip link
	if [ -z "$WLAN_IF" ]; then
		WLAN_IF="$(iw dev 2>/dev/null | awk '$1=="Interface"{print $2; exit}' || true)"
	fi
	if [ -z "$WLAN_IF" ]; then
		dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "No Wi-Fi adapter found (no wlan0/wl*).\n\n• Is firmware present? (linux-firmware-other + sof-firmware)\n• Try: dmesg | grep -i firmware\n• Or use Ethernet (eth0 fallback) — press OK to skip Wi-Fi." 13 70
		return 1
	fi
	log "Wi-Fi interface: $WLAN_IF"

	# Bring up
	ip link set "$WLAN_IF" up 2>/dev/null || true
	sleep 1

	# Scan
	log "Scanning for SSIDs on $WLAN_IF…"
	SCAN_TMP="/tmp/abt_scan.txt"
	SCAN_RAW="/tmp/abt_scan_raw.txt"
	# Use iw scan; parse SSID lines. Need to handle hidden and spaces correctly.
	if command -v iw >/dev/null 2>&1; then
		iw dev "$WLAN_IF" scan 2>&1 | tee "$SCAN_RAW" | grep -E '^\s*SSID:' | sed 's/^[[:space:]]*SSID: //' | sort -u > "$SCAN_TMP" || true
		# If scan failed (busy), try once more
		if [ ! -s "$SCAN_TMP" ]; then
			sleep 2
			iw dev "$WLAN_IF" scan 2>&1 | grep -E '^\s*SSID:' | sed 's/^[[:space:]]*SSID: //' | sort -u > "$SCAN_TMP" || true
		fi
	else
		# Fallback: wpa_cli scan if available
		: > "$SCAN_TMP"
	fi

	# Filter empty (hidden networks)
	grep -v '^$' "$SCAN_TMP" > "${SCAN_TMP}.filtered" 2>/dev/null || true
	mv "${SCAN_TMP}.filtered" "$SCAN_TMP" 2>/dev/null || true

	if [ ! -s "$SCAN_TMP" ]; then
		dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "No SSIDs found on $WLAN_IF.\n\n• Move closer to the AP\n• Check: iw dev $WLAN_IF scan\n• Or enter SSID manually." 11 70
		# Offer manual entry
		SSID_MANUAL="$(dialog --backtitle "$DIALOG_BACKTITLE" --inputbox "Enter SSID manually (hidden network):" 8 60 3>&1 1>&2 2>&3 || true)"
		if [ -n "$SSID_MANUAL" ]; then
			CHOSEN_SSID="$SSID_MANUAL"
			return 0
		fi
		return 1
	fi

	# Build tag-based dialog menu (tag = index, item = SSID) — SSID may contain spaces, so never split on whitespace
	MENU_ARGS=""
	i=0
	# Also keep mapping file: tag -> SSID (newline-delimited, index = tag)
	MAP_FILE="/tmp/abt_ssid_map.txt"
	: > "$MAP_FILE"
	while IFS= read -r ssid; do
		i=$((i+1))
		# dialog menu: tag item — item is truncated to ~50 chars for display, tag is numeric
		# Escape single quotes for shell; but we write to file for mapping
		printf '%s\n' "$ssid" >> "$MAP_FILE"
		# Build args: need to handle spaces in SSID for dialog display — dialog takes tag + item as separate args
		# We'll use printf %q-style: just pass as two args via eval later. Simpler: write a temp script.
		# Instead, construct a file with dialog args and use --file
		echo "$i \"$ssid\" \"\"" >> /tmp/abt_dialog_items.txt 2>/dev/null || true
	done < "$SCAN_TMP"

	# If many networks, limit to first 30 to avoid dialog overflow
	head -30 "$MAP_FILE" > "${MAP_FILE}.head"
	mv "${MAP_FILE}.head" "$MAP_FILE"
	# Regenerate display items for 30
	: > /tmp/abt_dialog_items.txt
	i=0; while IFS= read -r ssid; do i=$((i+1)); echo "$i \"$ssid\"" >> /tmp/abt_dialog_items.txt; done < "$MAP_FILE"

	# Build dialog command with tag-based mapping
	# Use a temp file for the menu items to avoid shell splitting issues
	DIALOG_OUT="/tmp/abt_ssid_choice.txt"
	# Construct items array properly: use dialog --menu with tag=item pairs via shell eval with proper quoting
	# Simpler: generate a shell snippet and source it
	{
		echo 'dialog --backtitle "'"$DIALOG_BACKTITLE"'" --title "Wi-Fi — Select Network" --menu "Choose SSID (spaces preserved; hidden: Cancel → manual entry):" 20 70 12 \'
		i=0
		while IFS= read -r ssid; do
			i=$((i+1))
			# Escape double quotes and backslashes for dialog
			esc_ssid="$(printf '%s' "$ssid" | sed 's/\\/\\\\/g; s/"/\\"/g')"
			printf '  "%s" "%s" \\\n' "$i" "$esc_ssid"
		done < "$MAP_FILE"
		echo '  2> "$DIALOG_OUT"'
	} > /tmp/abt_dialog_cmd.sh

	# shellcheck disable=SC1091
	if ! sh /tmp/abt_dialog_cmd.sh; then
		# Cancel → offer manual entry
		SSID_MANUAL="$(dialog --backtitle "$DIALOG_BACKTITLE" --inputbox "Enter SSID manually (or leave empty to cancel):" 8 60 3>&1 1>&2 2>&3 || true)"
		if [ -n "$SSID_MANUAL" ]; then
			CHOSEN_SSID="$SSID_MANUAL"
			return 0
		fi
		return 1
	fi

	TAG="$(cat "$DIALOG_OUT" 2>/dev/null | tr -d '[:space:]' || true)"
	if [ -z "$TAG" ]; then return 1; fi
	# Map tag -> SSID via sed -n "${TAG}p" (1-indexed)
	CHOSEN_SSID="$(sed -n "${TAG}p" "$MAP_FILE" 2>/dev/null || true)"
	if [ -z "$CHOSEN_SSID" ]; then
		dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Failed to map selection tag $TAG to SSID." 7 60
		return 1
	fi
	log "Chosen SSID: [$CHOSEN_SSID]"
	return 0
}

connect_wifi() {
	SSID="$1"
	# Prompt for PSK (insecure echo is okay for MVP; use --insecure for dialog password box)
	PSK="$(dialog --backtitle "$DIALOG_BACKTITLE" --insecure --passwordbox "Enter passphrase for:\n  $SSID\n\n(Leave empty for open network)" 11 60 3>&1 1>&2 2>&3 || true)"
	# User cancelled passwordbox → treat as cancel
	if [ $? -ne 0 ] && [ -z "$PSK" ]; then
		# dialog returns non-zero on cancel; check if user pressed Cancel
		# We already captured output; if empty and dialog failed, user cancelled
		# Re-prompt with yesno
		return 1
	fi

	log "Connecting to [$SSID]…"

	# Kill any prior wpa_supplicant on this iface
	pkill -f "wpa_supplicant.*$WLAN_IF" 2>/dev/null || true
	rm -f "$WPA_CONF" "$WPA_CTRL"/* 2>/dev/null || true
	mkdir -p "$WPA_CTRL"

	# Generate config
	if [ -z "$PSK" ]; then
		cat > "$WPA_CONF" <<EOF
ctrl_interface=DIR=$WPA_CTRL GROUP=netdev
update_config=1
country=$ABT_COUNTRY
network={
	ssid="$SSID"
	key_mgmt=NONE
}
EOF
	else
		# wpa_passphrase hashes the PSK; fall back to plaintext if it fails (injected country=$ABT_COUNTRY)
		if ! wpa_passphrase "$SSID" "$PSK" > "$WPA_CONF" 2>/dev/null; then
			cat > "$WPA_CONF" <<EOF
ctrl_interface=DIR=$WPA_CTRL GROUP=netdev
update_config=1
network={
	ssid="$SSID"
	psk="$PSK"
}
EOF
		else
			# wpa_passphrase includes a plaintext #psk line; keep it for readability but not required
			# Ensure country line present (wpa_passphrase doesn't add it)
			if ! grep -q "^country=" "$WPA_CONF" 2>/dev/null; then
				sed -i "1i country=$ABT_COUNTRY" "$WPA_CONF" 2>/dev/null || {
					tmp_wpa="/tmp/wpa_with_country.conf"
					printf 'country=%s\n' "$ABT_COUNTRY" > "$tmp_wpa"
					cat "$WPA_CONF" >> "$tmp_wpa"
					mv "$tmp_wpa" "$WPA_CONF"
				}
			fi
			# Also ensure ctrl_interface present if wpa_passphrase output lacks it
			if ! grep -q "ctrl_interface" "$WPA_CONF" 2>/dev/null; then
				sed -i "1i ctrl_interface=DIR=$WPA_CTRL GROUP=netdev" "$WPA_CONF" 2>/dev/null || true
			fi
		fi
	fi
	chmod 600 "$WPA_CONF"

	# Start wpa_supplicant
	wpa_supplicant -B -i "$WLAN_IF" -c "$WPA_CONF" -P /tmp/abt_wpa.pid 2>&1 | head -20 || true
	sleep 2

	# DHCP
	log "Requesting DHCP on $WLAN_IF…"
	# -q quit after lease, -n exit if not obtained, -t 10 timeout
	if ! udhcpc -i "$WLAN_IF" -q -n -t 5 2>&1 | tail -20; then
		log "udhcpc failed or timed out"
	fi

	# Wait for network readiness: ping 1.1.1.1 with spinner
	log "Waiting for network readiness…"
	for attempt in 1 2 3 4 5 6 7 8 9 10; do
		if ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; then
			log "Network ready (ping 1.1.1.1 ok)"
			return 0
		fi
		# Also try 8.8.8.8
		if ping -c1 -W2 8.8.8.8 >/dev/null 2>&1; then
			log "Network ready (ping 8.8.8.8 ok)"
			return 0
		fi
		sleep 1
	done

	# Still not ready — check wpa_cli status
	if command -v wpa_cli >/dev/null 2>&1; then
		wpa_cli -i "$WLAN_IF" status 2>&1 | head -20 || true
	fi
	ip addr show "$WLAN_IF" 2>&1 | head -20 || true

	dialog --backtitle "$DIALOG_BACKTITLE" --yesno "Failed to get network connectivity on $WLAN_IF.\n\n• Wrong passphrase?\n• Captive portal? (open http://example.com in a browser?)\n• Try again?" 12 70
	return 1
}

# ---------- 2b. Try preseed before manual scan (Pi Imager style) ----------
WLAN_IF=""
PRESEED_RET=0
if try_preseed_wifi; then
	log "Wi-Fi ready via preseed ($CHOSEN_SSID)"
	# preseed succeeded — skip manual scan entirely
	:
else
	PRESEED_RET=$?
	if [ "$PRESEED_RET" -eq 2 ]; then
		# user declined manual fallback after preseed failure
		dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "No network — cannot fetch images.\n\nPreseeded networks failed and manual scan was declined.\nRe-run abt-menu or fix airboot.json on the Ventoy USB." 10 70
		exit 1
	fi
	# Main Wi-Fi flow with retry loop (manual)
	while true; do
		if scan_wifi; then
			if connect_wifi "$CHOSEN_SSID"; then
				break
			fi
		fi
		dialog --backtitle "$DIALOG_BACKTITLE" --yesno "Wi-Fi setup failed or cancelled.\n\nRetry Wi-Fi scan?" 8 50 || {
		# Offer to proceed offline? No — we need network to fetch. Exit gracefully.
			dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "No network — cannot fetch images.\n\nYou can:\n• Retry Wi-Fi (re-run abt-menu)\n• Or drop to shell and run 'abt-menu' again." 10 70
			exit 1
		}
	done
fi

# ---------- 3. Catalog ----------
# Try to fetch remote manifest (Phase 3); fall back to hard-coded
CATALOG_TMP="/tmp/abt_catalog.json"
CATALOG_SOURCE="fallback"
REMOTE_CATALOG_URL="${ABT_CATALOG_URL:-$CATALOG_URL_DEFAULT}"
if command -v curl >/dev/null 2>&1; then
	if curl -fsSL --max-time 10 "$REMOTE_CATALOG_URL" -o "$CATALOG_TMP" 2>/dev/null && [ -s "$CATALOG_TMP" ]; then
		if jq -e '.images' "$CATALOG_TMP" >/dev/null 2>&1; then
			log "Fetched remote catalog from $REMOTE_CATALOG_URL"
			CATALOG_SOURCE="remote"
		else
			log "Remote catalog invalid JSON — using fallback"
			rm -f "$CATALOG_TMP"
		fi
	else
		log "No remote catalog (offline or 404) — using fallback"
	fi
fi

# Build menu items from catalog
build_catalog_menu() {
	MENU_TMP="/tmp/abt_catalog_menu.txt"
	MAP_URL="/tmp/abt_url_map.txt"
	MAP_NAME="/tmp/abt_name_map.txt"
	: > "$MENU_TMP"; : > "$MAP_URL"; : > "$MAP_NAME"
	idx=0

	if [ "$CATALOG_SOURCE" = "remote" ]; then
		# Parse remote manifest via jq: id|name|url
		jq -r '.images[] | "\(.id)|\(.name) (\(.size_human // "?"))|\(.url)"' "$CATALOG_TMP" 2>/dev/null > /tmp/abt_remote_list.txt || true
		while IFS='|' read -r cid cname curl; do
			[ -z "$cid" ] && continue
			idx=$((idx+1))
			# Truncate display name to 55 chars
			disp="$(printf '%s' "$cname" | cut -c1-55)"
			printf '%s|%s|%s\n' "$idx" "$disp" "$curl" >> "$MENU_TMP"
			printf '%s\n' "$curl" >> "$MAP_URL"
			# Sanitized filename base from id
			printf '%s\n' "$cid" >> "$MAP_NAME"
		done < /tmp/abt_remote_list.txt
	else
		# Fallback hard-coded
		while IFS='|' read -r cid cname curl; do
			[ -z "$cid" ] && continue
			idx=$((idx+1))
			disp="$(printf '%s' "$cname" | cut -c1-55)"
			printf '%s|%s|%s\n' "$idx" "$disp" "$curl" >> "$MENU_TMP"
			printf '%s\n' "$curl" >> "$MAP_URL"
			printf '%s\n' "$cid" >> "$MAP_NAME"
		done <<EOF
$CATALOG_FALLBACK
EOF
	fi

	# Append custom URL entry if not already present (for remote catalogs that lack it)
	if ! grep -q "__CUSTOM__" "$MENU_TMP" 2>/dev/null; then
		idx=$((idx+1))
		printf '%s|%s|%s\n' "$idx" "Custom HTTPS URL…" "__CUSTOM__" >> "$MENU_TMP"
		printf '%s\n' "__CUSTOM__" >> "$MAP_URL"
		printf '%s\n' "custom" >> "$MAP_NAME"
	fi
}

build_catalog_menu

# Show catalog menu
DIALOG_CAT_OUT="/tmp/abt_cat_choice.txt"
{
	echo 'dialog --backtitle "'"$DIALOG_BACKTITLE"'" --title "AirBoot — Select Image" --menu "Choose an image to fetch to Ventoy (cancel to exit):" 20 75 12 \'
	while IFS='|' read -r tag disp url; do
		esc_disp="$(printf '%s' "$disp" | sed 's/\\/\\\\/g; s/"/\\"/g')"
		printf '  "%s" "%s" \\\n' "$tag" "$esc_disp"
	done < "$MENU_TMP"
	echo '  2> "$DIALOG_CAT_OUT"'
} > /tmp/abt_cat_cmd.sh

if ! sh /tmp/abt_cat_cmd.sh; then
	dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Cancelled — no image selected.\n\nRe-run 'abt-menu' when ready." 7 60
	exit 0
fi

CAT_TAG="$(cat "$DIALOG_CAT_OUT" 2>/dev/null | tr -d '[:space:]' || true)"
if [ -z "$CAT_TAG" ]; then exit 0; fi
CHOSEN_URL="$(sed -n "${CAT_TAG}p" "$MAP_URL" 2>/dev/null || true)"
CHOSEN_ID="$(sed -n "${CAT_TAG}p" "$MAP_NAME" 2>/dev/null || true)"

# Handle custom URL
if [ "$CHOSEN_URL" = "__CUSTOM__" ]; then
	CHOSEN_URL="$(dialog --backtitle "$DIALOG_BACKTITLE" --inputbox "Enter custom HTTPS URL for the ISO:\n(must be https:// and end in .iso)" 9 70 3>&1 1>&2 2>&3 || true)"
	if [ -z "$CHOSEN_URL" ]; then
		dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "No URL entered — cancelled." 6 50
		exit 0
	fi
	# Validate scheme
	case "$CHOSEN_URL" in
		https://*) ;;
		http://*) dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Only HTTPS URLs are allowed (no plain HTTP)." 7 60; exit 1 ;;
		*) dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "URL must start with https://" 7 60; exit 1 ;;
	esac
	CHOSEN_ID="custom-$(printf '%s' "$CHOSEN_URL" | sed 's|https://||; s|[^a-zA-Z0-9._-]|_|g' | cut -c1-40)"
fi

if [ -z "$CHOSEN_URL" ] || [ "$CHOSEN_URL" = "__CUSTOM__" ]; then die "No URL selected"; fi
log "Chosen: $CHOSEN_ID -> $CHOSEN_URL"

# ---------- 4. Filename sanitization ----------
# Force .iso extension, strip spaces/specials
sanitize_filename() {
	base="$1"
	# Strip query string
	base="$(printf '%s' "$base" | sed 's/\?.*//')"
	# Basename
	base="$(basename "$base")"
	# If empty, use id
	if [ -z "$base" ] || [ "$base" = ".iso" ]; then base="$CHOSEN_ID.iso"; fi
	# Ensure .iso extension (case-insensitive check)
	case "$base" in
		*.iso|*.ISO|*.Iso) ;;
		*.img|*.IMG) base="${base%.*}.iso" ;;
		*) base="${base}.iso" ;;
	esac
	# Replace spaces and specials with - or _
	base="$(printf '%s' "$base" | tr ' ' '_' | tr -cd 'a-zA-Z0-9._-' | sed 's/__*/_/g; s/--*/-/g')"
	# Collapse leading/trailing _/-
	base="$(printf '%s' "$base" | sed 's/^[_-]//; s/[_-]$//')"
	# Ensure not empty
	if [ -z "$base" ]; then base="$CHOSEN_ID.iso"; fi
	# Enforce .iso suffix again after sanitization
	case "$base" in *.iso) ;; *) base="${base}.iso" ;; esac
	printf '%s' "$base"
}

# Derive filename from URL or id
URL_BASENAME="$(basename "$CHOSEN_URL" | sed 's/\?.*//')"
FILENAME="$(sanitize_filename "${URL_BASENAME:-$CHOSEN_ID}")"
DEST="$VENTOY_MNT/$VENTOY_ISO_DIR/$FILENAME"
log "Destination: $DEST"

# Cache check
if [ -f "$DEST" ]; then
	SIZE_HUMAN="$(du -h "$DEST" 2>/dev/null | awk '{print $1}' || echo "?")"
	if ! dialog --backtitle "$DIALOG_BACKTITLE" --yesno "File already exists:\n  $FILENAME ($SIZE_HUMAN)\n  at $VENTOY_ISO_DIR/\n\nOverwrite / re-download?\n(Choose No to keep existing and reboot)" 11 70; then
		dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Keeping existing file.\n\nRebooting to Ventoy — select the ISO manually from the Ventoy menu.\n\nTip: Ventoy lists ISOs under $VENTOY_ISO_DIR/" 10 70
		# Still validate existing file
		if ! hexdump -s 32769 -n 5 -e '5/1 "%_c"' "$DEST" 2>/dev/null | grep -q "CD001"; then
			dialog --backtitle "$DIALOG_BACKTITLE" --yesno "WARNING: Existing file fails ISO magic check (no CD001 at 32769).\nIt may be a captive-portal HTML page or corrupt.\n\nDelete and re-download?" 11 70 && rm -f "$DEST" || true
			if [ ! -f "$DEST" ]; then
				# User chose to delete — fall through to download
				:
			else
				sync; umount "$VENTOY_MNT" 2>/dev/null || true
				dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Rebooting now. After reboot, select the ISO from Ventoy's menu.\n\nIf the ISO fails to boot, re-run AirBoot to re-fetch." 9 70
				reboot
				exit 0
			fi
		else
			sync; umount "$VENTOY_MNT" 2>/dev/null || true
			dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Rebooting now. Select the ISO from Ventoy's menu." 7 60
			reboot
			exit 0
		fi
	fi
	# User chose to overwrite — remove old + aria2 control
	rm -f "$DEST" "$DEST.aria2" 2>/dev/null || true
fi

# ---------- 5. Download ----------
download_with_aria2() {
	url="$1"; dest="$2"
	log "Downloading via aria2c: $url -> $dest"
	# -x 8 split, -s 8 connections, --continue resume, --console-log-level and summary for progress
	# --check-certificate true (default) — fail on bad TLS
	# --file-allocation=none — avoid fallocate on exFAT which may not support it
	# --auto-file-renaming=false — we control the name
	mkdir -p "$(dirname "$dest")"
	# Use --dir and --out to control output
	DOWNLOAD_DIR="$(dirname "$dest")"
	DOWNLOAD_FILE="$(basename "$dest")"
	# aria2c prints progress to stderr; we let dialog --tailbox or just run inline with console
	# For MVP, run inline so user sees progress; use --summary-interval
	if command -v aria2c >/dev/null 2>&1; then
		if aria2c -x 8 -s 8 --continue=true --auto-file-renaming=false \
			--file-allocation=none --summary-interval=1 --console-log-level=warn \
			--check-certificate=true --max-tries=3 --retry-wait=2 \
			--dir="$DOWNLOAD_DIR" --out="$DOWNLOAD_FILE" \
			"$url"; then
			return 0
		else
			log "aria2c failed with exit $?"
			return 1
		fi
	else
		return 1
	fi
}

download_with_wget() {
	url="$1"; dest="$2"
	log "Fallback: wget $url -> $dest"
	if command -v wget >/dev/null 2>&1; then
		wget --continue --progress=dot:giga -O "$dest" "$url"
		return $?
	elif command -v curl >/dev/null 2>&1; then
		# curl resume: -C - --fail --location
		curl -L -C - --fail --progress-bar -o "$dest" "$url"
		return $?
	else
		return 1
	fi
}

# Show a "Downloading…" msgbox in background? For MVP, just run in foreground with console output visible
# Clear screen so aria2c progress is readable
clear || true
echo "AirBoot — fetching"
echo "  URL : $CHOSEN_URL"
echo "  Dest: $DEST"
echo ""

if ! download_with_aria2 "$CHOSEN_URL" "$DEST"; then
	dialog --backtitle "$DIALOG_BACKTITLE" --yesno "aria2c failed or stalled (enterprise DPI often kills multi-stream).\n\nRetry with single-threaded wget/curl?" 9 70 && {
		rm -f "$DEST.aria2" 2>/dev/null || true
		if ! download_with_wget "$CHOSEN_URL" "$DEST"; then
			dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Download failed with both aria2c and wget.\n\n• Check URL is reachable: curl -I $CHOSEN_URL\n• Check network: ping 1.1.1.1\n• Try a different image." 12 70
			rm -f "$DEST" 2>/dev/null || true
			exit 1
		fi
	} || {
		dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Download failed and fallback declined.\n\nRe-run abt-menu to retry." 8 60
		rm -f "$DEST" 2>/dev/null || true
		exit 1
	}
fi

# ---------- 6. Validate ISO magic bytes ----------
# ISO 9660 magic "CD001" at offset 32769 (0x8001) — defeats captive portals that return HTML
validate_iso() {
	file="$1"
	if [ ! -f "$file" ]; then
		log "validate: file not found: $file"
		return 1
	fi
	# Need at least 32774 bytes
	size="$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || wc -c < "$file" 2>/dev/null || echo 0)"
	if [ "$size" -lt 33000 ]; then
		log "validate: file too small ($size bytes) — likely HTML error page"
		# Show first bytes
		head -c 500 "$file" 2>/dev/null | cat -v | head -20 || true
		return 1
	fi
	magic="$(hexdump -s 32769 -n 5 -e '5/1 "%_c"' "$file" 2>/dev/null || hexdump -s 32769 -n 5 -e '5/1 "%c"' "$file" 2>/dev/null || true)"
	if [ "$magic" = "CD001" ]; then
		log "validate: CD001 found at 32769 — valid ISO 9660"
		return 0
	else
		log "validate: expected CD001 at 32769, got [$magic]"
		# Also check for HTML
		if head -c 1024 "$file" 2>/dev/null | grep -qi "<html"; then
			log "validate: file starts with HTML — captive portal"
		fi
		head -c 200 "$file" 2>/dev/null | cat -v | head -5 || true
		return 1
	fi
}

if ! validate_iso "$DEST"; then
	dialog --backtitle "$DIALOG_BACKTITLE" --msgbox "Downloaded file FAILED validation (no ISO 9660 CD001 at offset 32769).\n\nThis usually means a captive portal returned an HTML login page instead of the ISO.\n\nThe file has been deleted. Connect to a network without a portal and retry.\n\nFile: $FILENAME" 13 70
	rm -f "$DEST" "$DEST.aria2" 2>/dev/null || true
	exit 1
fi

# Optional SHA256 check if catalog provided one
EXPECTED_SHA=""
if [ "$CATALOG_SOURCE" = "remote" ]; then
	EXPECTED_SHA="$(jq -r --arg id "$CHOSEN_ID" '.images[] | select(.id==$id) | .sha256 // empty' "$CATALOG_TMP" 2>/dev/null | head -1 || true)"
fi
if [ -n "$EXPECTED_SHA" ] && [ "$EXPECTED_SHA" != "null" ]; then
	log "Verifying SHA256…"
	ACTUAL_SHA="$(sha256sum "$DEST" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$DEST" 2>/dev/null | awk '{print $1}' || true)"
	if [ -n "$ACTUAL_SHA" ]; then
		if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then
			log "SHA256 OK"
		else
			dialog --backtitle "$DIALOG_BACKTITLE" --yesno "SHA256 mismatch!\n\nExpected: $EXPECTED_SHA\nActual:   $ACTUAL_SHA\n\nThe download may be corrupt or tampered.\n\nDelete and retry?" 13 70 && {
				rm -f "$DEST" "$DEST.aria2" 2>/dev/null || true
				exit 1
			}
		fi
	fi
fi

# Clean aria2 control file on success
rm -f "$DEST.aria2" 2>/dev/null || true

# ---------- 7. Flush & reboot ----------
sync
# Ensure file is visible
ls -lh "$DEST" 2>&1 | head -5 || true

# Unmount before reboot so exFAT is clean
umount "$VENTOY_MNT" 2>/dev/null || true

dialog --backtitle "$DIALOG_BACKTITLE" --title "Success" --msgbox "Download complete and validated:\n  $FILENAME\n  at $VENTOY_ISO_DIR/ on the Ventoy USB\n\nRebooting now.\n\nAfter reboot:\n  1. Select the Ventoy USB again in your boot menu (F12 / Boot Options)\n     (warm-reboot sometimes skips USB — manually re-select it)\n  2. In Ventoy's menu, select:\n     $FILENAME\n  3. Boot the installer.\n\nNo auto-boot — you select the ISO manually." 16 75

log "Rebooting…"
reboot
