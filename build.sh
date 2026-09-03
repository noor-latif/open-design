#!/bin/sh
# build.sh — Docker build driver for AirBoot
# Wraps Alpine aports mkimage.sh to produce out/airboot.iso
#
# Usage:
#   ./build.sh                              # default: x86_64, profile abt, out=./out
#   ./build.sh --arch x86_64 --outdir ./out --workdir ./work
#   ./build.sh --clone-refs                 # re-clone reference repos
#   ./build.sh --help
#
# Requirements: docker (or podman), ~2 GB disk, privileged for loop devices.
# The container is alpine:3.20 with the full ISO toolchain.
#
# What it does:
#   1. (optionally) clones/updates reference repos
#   2. Ensures aports is present (shallow clone)
#   3. Copies aports-patch/mkimg.abt.sh into aports/scripts/
#   4. Copies scripts/genapkovl-abt.sh + scripts/abt-menu.sh into build context
#   5. Runs mkimage.sh --profile abt inside Docker, emitting to ./out/

set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
ARCH="x86_64"
OUTDIR="$ROOT/out"
WORKDIR="$ROOT/work"
PROFILE="abt"
TAG="edge"
CLONE_REFS=0
APORTS_DIR="$ROOT/reference/aports"
DOCKER_BIN=""

# ---------- args ----------
usage() {
	cat <<EOF
build.sh — build AirBoot ISO

Usage:
  ./build.sh [options]

Options:
  --arch ARCH        Target arch (default: x86_64)
  --outdir DIR       Output dir (default: ./out)
  --workdir DIR      Work dir/cache (default: ./work)
  --profile NAME     aports profile (default: abt)
  --tag TAG          Alpine tag (default: edge)
  --clone-refs       (Re-)clone reference repos (netboot.xyz, Ventoy, aports)
  --help             Show this help

Examples:
  ./build.sh
  ./build.sh --arch x86_64 --outdir ./out --workdir ./work
  ./build.sh --clone-refs

Docs: plan.md Phase 0
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--arch) ARCH="$2"; shift 2 ;;
		--arch=*) ARCH="${1#--arch=}"; shift ;;
		--outdir) OUTDIR="$2"; shift 2 ;;
		--outdir=*) OUTDIR="${1#--outdir=}"; shift ;;
		--workdir) WORKDIR="$2"; shift 2 ;;
		--workdir=*) WORKDIR="${1#--workdir=}"; shift ;;
		--profile) PROFILE="$2"; shift 2 ;;
		--profile=*) PROFILE="${1#--profile=}"; shift ;;
		--tag) TAG="$2"; shift 2 ;;
		--tag=*) TAG="${1#--tag=}"; shift ;;
		--clone-refs) CLONE_REFS=1; shift ;;
		--help|-h) usage; exit 0 ;;
		*) echo "Unknown arg: $1" >&2; usage >&2; exit 1 ;;
	esac
done

# ---------- helpers ----------
log() { printf '>>> %s\n' "$*"; }
die() { printf '!!! %s\n' "$*" >&2; exit 1; }

find_docker() {
	if command -v docker >/dev/null 2>&1; then echo "docker"
	elif command -v podman >/dev/null 2>&1; then echo "podman"
	else die "need docker or podman — install from https://docs.docker.com/engine/install/"; fi
}

clone_refs() {
	mkdir -p "$ROOT/reference"
	if [ ! -d "$ROOT/reference/netboot.xyz" ]; then
		log "Cloning netboot.xyz…"
		git clone --depth 1 https://github.com/netbootxyz/netboot.xyz.git "$ROOT/reference/netboot.xyz"
	else
		log "netboot.xyz exists at reference/netboot.xyz (skip; use --clone-refs to force)"
		if [ "$CLONE_REFS" -eq 1 ]; then
			log "Updating netboot.xyz…"
			git -C "$ROOT/reference/netboot.xyz" pull --ff-only 2>&1 | tail -5 || true
		fi
	fi
	if [ ! -d "$ROOT/reference/Ventoy" ]; then
		log "Cloning Ventoy…"
		git clone --depth 1 https://github.com/ventoy/Ventoy.git "$ROOT/reference/Ventoy"
	else
		log "Ventoy exists at reference/Ventoy"
		if [ "$CLONE_REFS" -eq 1 ]; then git -C "$ROOT/reference/Ventoy" pull --ff-only 2>&1 | tail -5 || true; fi
	fi
	if [ ! -d "$APORTS_DIR" ]; then
		log "Cloning aports (shallow, ~500 MB)…"
		git clone --depth 1 https://gitlab.alpinelinux.org/alpine/aports.git "$APORTS_DIR"
	else
		log "aports exists at $APORTS_DIR"
		if [ "$CLONE_REFS" -eq 1 ]; then git -C "$APORTS_DIR" pull --ff-only 2>&1 | tail -5 || true; fi
	fi
	# If user asked --clone-refs and repos existed, we already pulled; if they didn't exist we cloned.
	# Force fresh clones when --clone-refs and repos were already there but user wants clean:
	if [ "$CLONE_REFS" -eq 1 ]; then
		# Ensure Ventoy/netboot.xyz are fresh if --clone-refs was passed with existing dirs
		:
	fi
}

# ---------- main ----------
DOCKER_BIN="$(find_docker)"
log "Using $DOCKER_BIN — arch=$ARCH profile=$PROFILE out=$OUTDIR work=$WORKDIR"

if [ "$CLONE_REFS" -eq 1 ] || [ ! -d "$APORTS_DIR" ]; then
	clone_refs
else
	# Ensure reference dir exists even if not cloning
	mkdir -p "$ROOT/reference"
	if [ ! -d "$APORTS_DIR" ]; then clone_refs; fi
fi

# Validate inputs
[ -f "$ROOT/aports-patch/mkimg.abt.sh" ] || die "missing aports-patch/mkimg.abt.sh"
[ -f "$ROOT/scripts/genapkovl-abt.sh" ] || die "missing scripts/genapkovl-abt.sh"
[ -f "$ROOT/scripts/abt-menu.sh" ] || die "missing scripts/abt-menu.sh"
[ -d "$APORTS_DIR/scripts" ] || die "aports/scripts not found at $APORTS_DIR/scripts"

# Prepare dirs
mkdir -p "$OUTDIR" "$WORKDIR"

# Patch aports with our profile (copy, don't move — keep source clean)
log "Patching aports with mkimg.abt.sh…"
cp -v "$ROOT/aports-patch/mkimg.abt.sh" "$APORTS_DIR/scripts/mkimg.abt.sh"

# Ensure scripts are available at /work inside container (build.sh mounts ROOT as /work)
# The apkovl path in mkimg.abt.sh is /work/genapkovl-abt.sh — so we need it at $ROOT/genapkovl-abt.sh as well
# for the container's /work mount to see it. Copy there (and clean up on exit if we created it).
NEED_CLEANUP=""
if [ ! -f "$ROOT/genapkovl-abt.sh" ]; then
	cp "$ROOT/scripts/genapkovl-abt.sh" "$ROOT/genapkovl-abt.sh"
	NEED_CLEANUP=1
fi
# Also ensure abt-menu.sh is at /work/scripts/abt-menu.sh (it already is) — and at /work root for fallback
# genapkovl-abt.sh checks both $SCRIPT_DIR/abt-menu.sh and /work/scripts/abt-menu.sh

# Check Dockerfile exists
if [ ! -f "$ROOT/Dockerfile" ]; then die "missing Dockerfile at $ROOT/Dockerfile"; fi

log "Building Docker image (alpine:3.20 toolchain)…"
# Build image if not present or if Dockerfile changed
IMAGE="airboot-builder:3.20"
if ! "$DOCKER_BIN" image inspect "$IMAGE" >/dev/null 2>&1; then
	"$DOCKER_BIN" build -t "$IMAGE" -f "$ROOT/Dockerfile" "$ROOT"
else
	log "Image $IMAGE already exists — reusing (docker build to refresh if needed)"
fi

log "Running mkimage.sh inside container (privileged, needs loop devices)…"
# We run mkimage.sh as the builder user inside the container; the container's entrypoint
# handles abuild-keygen etc. See Dockerfile.
#
# Mounts:
#   $ROOT          -> /work   (scripts, genapkovl, catalog, out, work)
#   $APORTS_DIR    -> /aports (patched)
#   $WORKDIR       -> /work/work (cache)
#   $OUTDIR        -> /work/out  (output)
#
# Note: mkimage.sh expects to run from aports/scripts/
set +e
"$DOCKER_BIN" run --rm --privileged \
	-v "$ROOT:/work" \
	-v "$APORTS_DIR:/aports" \
	-v "$WORKDIR:/work/work" \
	-v "$OUTDIR:/work/out" \
	-w /aports/scripts \
	"$IMAGE" \
	sh -c '
		set -e
		echo ">>> Inside container: $(cat /etc/alpine-release) — $(apk --print-arch)"
		echo ">>> mkimage.sh --arch '"$ARCH"' --profile '"$PROFILE"' --outdir /work/out --workdir /work/work --tag '"$TAG"'"
		# Ensure builder keys exist (abuild-keygen needs a user)
		if [ ! -f ~/.abuild/abuild.conf ]; then
			abuild-keygen -a -i -n 2>&1 | tail -5 || true
		fi
		# mkimage.sh is in /aports/scripts/
		./mkimage.sh --arch '"$ARCH"' --profile '"$PROFILE"' --outdir /work/out --workdir /work/work --tag '"$TAG"'
		echo ">>> Done — ls /work/out:"
		ls -lh /work/out || true
	'
RET=$?
set -e

# Cleanup temp genapkovl copy if we created it
if [ -n "$NEED_CLEANUP" ]; then rm -f "$ROOT/genapkovl-abt.sh"; fi

if [ "$RET" -ne 0 ]; then
	die "build failed (exit $RET) — check output above. Common fixes: ensure --privileged, check aports patch, check Docker daemon."
fi

log "Build succeeded."
ISO_PATH="$(find "$OUTDIR" -name "*.iso" -type f 2>/dev/null | head -1 || true)"
if [ -n "$ISO_PATH" ]; then
	ls -lh "$ISO_PATH"
	log "ISO ready: $ISO_PATH"
	log "Deploy: sudo ./abt ventoy --copy /dev/sdX   or   cp $ISO_PATH /run/media/\$USER/Ventoy/ISO/airboot.iso"
else
	warn_msg="no .iso found in $OUTDIR — check $WORKDIR and container logs"
	printf '!!! %s\n' "$warn_msg" >&2
	ls -la "$OUTDIR" 2>/dev/null || true
	exit 1
fi
