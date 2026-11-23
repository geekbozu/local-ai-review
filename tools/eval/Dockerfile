# The eval container: the ingredients a board has, so a sweep runs the real path — sandbox included — instead of a
# bypass. Node for the action, git for the diff, bubblewrap because the review refuses to run without it, ripgrep and fd
# because the agent's search tools use them, and the client the action spawns, installed the way a board installs it.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bubblewrap ripgrep fd-find ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm i -g @earendil-works/pi-coding-agent \
 && command -v pi

WORKDIR /work
CMD ["sleep", "infinity"]
