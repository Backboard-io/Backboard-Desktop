FROM ubuntu:22.04

ARG NODE_VERSION=24.15.0
ARG BUN_VERSION=1.3.14

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/opt/node/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential \
		bubblewrap \
		ca-certificates \
		curl \
		dbus-x11 \
		dpkg-dev \
		fakeroot \
		file \
		fonts-liberation \
		git \
		jq \
		libasound2 \
		libatk-bridge2.0-0 \
		libdrm2 \
		libgbm1 \
		libgtk-3-0 \
		libkrb5-dev \
		libnotify4 \
		libnss3 \
		libsecret-1-0 \
		libsecret-1-dev \
		libu2f-udev \
		libx11-dev \
		libx11-xcb-dev \
		libxdamage1 \
		libxkbcommon-dev \
		libxkbcommon-x11-dev \
		libxkbfile-dev \
		libxrandr2 \
		libxss1 \
		patchelf \
		pkg-config \
		python-is-python3 \
		python3 \
		rpm \
		rsync \
		socat \
		unzip \
		xauth \
		xdg-utils \
		xvfb \
		xz-utils \
		zip \
	&& rm -rf /var/lib/apt/lists/*

RUN set -eux; \
	archive="node-v${NODE_VERSION}-linux-x64.tar.xz"; \
	curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"; \
	curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
	grep " ${archive}$" SHASUMS256.txt | sha256sum -c -; \
	mkdir -p /opt/node; \
	tar -xJf "${archive}" -C /opt/node --strip-components=1; \
	rm -f "${archive}" SHASUMS256.txt; \
	node --version; \
	npm --version

RUN set -eux; \
	curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"; \
	unzip -q /tmp/bun.zip -d /tmp/bun; \
	install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun; \
	rm -rf /tmp/bun /tmp/bun.zip; \
	test "$(bun --version)" = "${BUN_VERSION}"

WORKDIR /work/source

