# AirBoot builder — Alpine 3.20 with ISO mastering toolchain
# Mirrors the Phase 0 spec:
#   alpine-sdk xorriso syslinux grub-efi squashfs-tools mtools dosfstools abuild
# plus aports build deps, firmware already handled via profile apks.

FROM alpine:3.20

# Install ISO mastering toolchain + build deps
RUN apk update && apk add --no-cache \
		alpine-sdk \
		xorriso \
		syslinux \
		grub-efi \
		squashfs-tools \
		mtools \
		dosfstools \
		abuild \
		apk-tools \
		busybox \
		fakeroot \
		sudo \
		bash \
		git \
		curl \
		jq \
		ca-certificates \
		abuild-sign \
	&& rm -rf /var/cache/apk/*

# Create unprivileged builder user (aports builds must not run as root for abuild)
RUN adduser -D -G abuild builder && \
	echo "builder ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
	mkdir -p /work /aports /home/builder && \
	chown builder:abuild /work /home/builder

USER builder
WORKDIR /home/builder

# Generate APK signing keys non-interactively
RUN abuild-keygen -a -i -n || true

# Default workdir for the build driver (overridden by `docker run -w`)
WORKDIR /aports/scripts

# Keep container alive for `docker run ... ./mkimage.sh ...`
CMD ["/bin/sh"]
