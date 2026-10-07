# The engine needs two things a static host cannot give it: a process that lives for the length of
# an audit (measured 425-575s) and a held-open connection for live progress. It no longer needs a
# browser, which is what lets it run where one cannot be installed.
FROM node:20-slim

# No browser. The RENDERED profile comes from the fetch transport, which returns the DOM after
# scripts have run - verified against a client-rendered page, where the same URL answered with 645
# bytes without JavaScript and 3157 bytes with it.
#
# Chromium is still supported and still preferred when present: set AUDIT_CHROME_PATH and the
# engine uses it, which keeps innerText and the client-side navigation chain. This image simply does
# not ship one, which removes ~400 MB and the build's most fragile step.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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
# Checking the file exists is not enough: a present binary that cannot start is the same outcome
# as a missing one, and both are invisible until a report comes back short. So the build launches
# the browser through the engine's own code path, with the same flags production will use.
# The render check launched a browser and failed the build if it would not start. There is no
# browser here by design, so that step would now fail every build. Whether the transport can render
# is a question about credentials and a live API, which a build cannot answer; /health reports it at
# runtime instead, where it is actually knowable.

# Reports are written here. Mount a persistent disk at this path to keep them across restarts;
# without one they live only as long as the container, which is fine if you publish to the viewer.
RUN mkdir -p /app/runs
VOLUME ["/app/runs"]

EXPOSE 4317
ENV PORT=4317

# One audit holds a Chromium and parses several MB of HTML. On a 2 GB plan 1024 is comfortable;
# on a 512 MB free plan set NODE_OPTIONS=--max-old-space-size=320 in the dashboard, which makes
# Node collect earlier instead of being killed. It is a real constraint, not a tuning preference:
# Node plus a Chromium rendering ten pages does not comfortably fit in 512 MB.
ENV NODE_OPTIONS=--max-old-space-size=1024

CMD ["node", "src/server.js"]
