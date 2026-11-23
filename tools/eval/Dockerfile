# The eval container: the same ingredients a board has, so a sweep runs the real path — sandbox included — instead of a
# bypass. Node for the action, git for the diff, bubblewrap because the review refuses to run without it, ripgrep and fd
# because the agent's search tools use them.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bubblewrap ripgrep fd-find ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
CMD ["sleep", "infinity"]
