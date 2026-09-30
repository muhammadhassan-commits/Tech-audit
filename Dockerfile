# The engine needs three things a static host cannot give it: a process that lives for the length
# of an audit (measured 425-575s), a real Chromium for the RENDERED fetch profile, and a held-open
# connection for live progress. This image provides all three.
FROM node:20-slim

# Chromium for the RENDERED profile (R-FETCH-2). Without it every JavaScript-injected value is
# invisible to the audit, and on a client-rendered site that is most of the page.
# The fonts are not decoration: without them the renderer measures layout against fallback metrics.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation fonts-noto-color-emoji \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# src/net/render.js probes a list of known paths; this is the one it looks for first.
ENV AUDIT_CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# playwright-core ships no browsers of its own; it drives the system Chromium installed above.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# playwright-core is an optionalDependency, and the whole point of "optional" is that npm carries
# on when it fails to install. That would produce an image that boots, serves, audits — and
# silently skips the RENDERED profile on every page. Fail the build here instead, where it is
# visible, rather than shipping an engine that quietly reports less than it should.
RUN node -e "import('playwright-core').then(()=>console.log('playwright-core: ok')).catch(e=>{console.error('playwright-core missing:',e.message);process.exit(1)})"  && node -e "const fs=require('fs');const p=process.env.AUDIT_CHROME_PATH;if(!fs.existsSync(p)){console.error('no browser at '+p);process.exit(1)}console.log('chromium: '+p)"  && node -e "import('./src/net/render.js').then(m=>{const b=m.findBrowser();if(!b){console.error('the engine cannot find a browser');process.exit(1)}console.log('engine resolves browser: '+b)})"

# Reports are written here. Mount a persistent disk at this path to keep them across restarts;
# without one they live only as long as the container, which is fine if you publish to the viewer.
RUN mkdir -p /app/runs
VOLUME ["/app/runs"]

EXPOSE 4317
ENV PORT=4317

# One audit holds a Chromium and parses several MB of HTML; the default heap is tight for that.
ENV NODE_OPTIONS=--max-old-space-size=1024

CMD ["node", "src/server.js"]
