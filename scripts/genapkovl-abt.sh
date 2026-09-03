#!/bin/sh -e
# genapkovl-abt.sh — Alpine apkovl overlay generator for AirBoot
# Called by mkimage.sh inside the build chroot: genapkovl-abt.sh <hostname>
# Produces an apkovl.tar.gz that autostarts abt-menu.sh via /etc/local.d/
#
# Why /etc/local.d/ and not inittab sed:
#   Direct inittab editing is fragile and caused a double-sed overwrite bug
#   in early iterations. OpenRC's local.d is idempotent, ordered, and survives
#   Alpine upgrades.
#
# overlay layout:
#   etc/
#     local.d/abt-menu.start  (0755, starts after boot)
#     apk/world                (ensures overlay packages are recorded)
#     hostname
#   usr/local/bin/abt-menu.sh
#   root/.profile              (optional convenience)

HOSTNAME="$1"
if [ -z "$HOSTNAME" ]; then
	echo "usage: $0 hostname" >&2
	exit 1
fi

cleanup() { rm -rf "$tmp"; }
makefile() {
	OWNER="$1"; PERMS="$2"; FILENAME="$3"
	cat > "$FILENAME"
	chown "$OWNER" "$FILENAME"
	chmod "$PERMS" "$FILENAME"
}
rc_add() {
	mkdir -p "$tmp"/etc/runlevels/"$2"
	ln -sf /etc/init.d/"$1" "$tmp"/etc/runlevels/"$2"/"$1"
}

tmp="$(mktemp -d)"
trap cleanup EXIT

# -- hostname
mkdir -p "$tmp"/etc
makefile root:root 0644 "$tmp"/etc/hostname <<EOF
$HOSTNAME
EOF

# -- networking stub (we do Wi-Fi manually via wpa_supplicant; eth0 left dhcp for fallback)
mkdir -p "$tmp"/etc/network
makefile root:root 0644 "$tmp"/etc/network/interfaces <<EOF
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
hostname $HOSTNAME
EOF

# -- apk world (keep minimal; real packages come from profile apks)
mkdir -p "$tmp"/etc/apk
makefile root:root 0644 "$tmp"/etc/apk/world <<EOF
alpine-base
EOF

# -- autostart via OpenRC local.d
#    Order: after networking, before login. Use a numbered prefix to run after default local.
mkdir -p "$tmp"/etc/local.d
makefile root:root 0755 "$tmp"/etc/local.d/abt-menu.start <<'EOS'
#!/bin/sh
# /etc/local.d/abt-menu.start — AirBoot autostart
# OpenRC runs this at the end of boot (local service). We want the menu on tty1
# without fighting getty. Strategy: if we're on the first boot and abt-menu.sh exists,
# exec it on the console. On failure, drop to shell.

# Only run on real console (not during mkimage chroot)
if [ ! -c /dev/tty1 ]; then
	exit 0
fi

# Prevent re-entry if user already cancelled and is at a shell
if [ -f /run/abt-menu.done ]; then
	exit 0
fi

# Ensure dialog + deps are present; otherwise log and exit
if ! command -v dialog >/dev/null 2>&1; then
	echo "[abt] dialog not found; skipping autostart" >&2
	exit 0
fi

if [ -x /usr/local/bin/abt-menu.sh ]; then
	# Run on tty1 so dialog renders correctly even if local.d was started without a tty
	# openvt is not always present in minimal Alpine; fall back to direct exec
	if command -v openvt >/dev/null 2>&1; then
		openvt -c 1 -sw -- /usr/local/bin/abt-menu.sh
	else
		# Ensure we have a sane TERM
		export TERM="${TERM:-linux}"
		/usr/local/bin/abt-menu.sh < /dev/tty1 > /dev/tty1 2>&1 || true
	fi
	touch /run/abt-menu.done
fi
exit 0
EOS

# -- enable services we need
rc_add devfs sysinit
rc_add dmesg sysinit
rc_add mdev sysinit
rc_add hwdrivers sysinit
rc_add modloop sysinit

rc_add hwclock boot
rc_add modules boot
rc_add sysctl boot
rc_add hostname boot
rc_add bootmisc boot
rc_add syslog boot
rc_add networking boot
rc_add local default

rc_add mount-ro shutdown
rc_add killprocs shutdown
rc_add savecache shutdown

# -- bundled helper: ensure ca-certificates are trusted
mkdir -p "$tmp"/etc/ssl/certs

# -- copy abt-menu.sh into overlay if it lives next to this script (build.sh does this)
#    Fallback: the live image will have it via the apkovl; if not found at build time
#    we still ship a working overlay (menu will be missing, but image boots).
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
if [ -f "$SCRIPT_DIR/abt-menu.sh" ]; then
	mkdir -p "$tmp"/usr/local/bin
	cp "$SCRIPT_DIR/abt-menu.sh" "$tmp"/usr/local/bin/abt-menu.sh
	chmod 0755 "$tmp"/usr/local/bin/abt-menu.sh
elif [ -f "/work/scripts/abt-menu.sh" ]; then
	mkdir -p "$tmp"/usr/local/bin
	cp /work/scripts/abt-menu.sh "$tmp"/usr/local/bin/abt-menu.sh
	chmod 0755 "$tmp"/usr/local/bin/abt-menu.sh
fi

# -- convenience: root profile
mkdir -p "$tmp"/root
makefile root:root 0644 "$tmp"/root/.profile <<'EOS'
export PATH="/usr/local/bin:$PATH"
alias abt-menu="/usr/local/bin/abt-menu.sh"
echo "AirBoot — run 'abt-menu' to start the fetcher, or wait for autostart on tty1."
EOS

# -- pack
tar -c -C "$tmp" etc usr root 2>/dev/null | gzip -9n > "$HOSTNAME".apkovl.tar.gz

# Also emit to DESTDIR if mkimage.sh set it
if [ -n "$DESTDIR" ] && [ "$DESTDIR" != "$tmp" ]; then
	cp "$HOSTNAME".apkovl.tar.gz "$DESTDIR"/ 2>/dev/null || true
fi
