# KaChat Desktop in a container.
#
# This serves a real production build, not Vite's dev server. The dev server was
# never meant to face the public: no minification, and - the one that actually
# bites people - filenames with no content hash, so a returning visitor's browser
# can hold a cached copy of one file and a fresh copy of another and run a mix of
# two versions. `vite build` hashes every asset, which is cache-busting that
# cannot be forgotten, unlike the hand-maintained ?v= numbers index.html carries
# for the dev path.
#
# What used to prevent this: the Nextcloud integration is a connect middleware in
# vite.config.mjs (the /nc-proxy route that works around Nextcloud sending no CORS
# headers on WebDAV/OCS), and connect middleware only ran on the dev server. It is
# now mounted on `configurePreviewServer` too, so the built site keeps it.
#
# The build runs at CONTAINER START rather than image build. Vite inlines every
# VITE_ variable into the bundle at build time, and docker-compose passes
# VITE_CHANGENOW_API_KEY as a run-time environment variable - baking the build
# into the image would silently drop it. The build takes well under a second.

FROM node:22-alpine

# `npm run dev` shells out to tools/check-wasm.sh, and busybox sh is not bash.
RUN apk add --no-cache bash

WORKDIR /app

# Dependencies first, so editing application code does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# kaspa/ and cipher/ are committed, so there is no Rust toolchain here and
# nothing to fetch. check-wasm.sh fails loudly at startup if that changes.

EXPOSE 5173

# --host binds past loopback. Without it Vite listens only inside the
# container's own network namespace and the published port answers nothing.
CMD ["sh", "-c", "npm run build && npm run preview -- --host 0.0.0.0 --port 5173"]
