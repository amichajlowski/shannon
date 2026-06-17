# Installing Shannon on an Ubuntu Server

Step-by-step guide to run Shannon on a fresh Ubuntu server (amd64/x86_64) with zsh.

Shannon runs its workloads in Docker, so the install is portable. The only host
requirements are Docker, Node.js, and pnpm. **Never copy build artifacts
(`node_modules/`, `dist/`, `.turbo/`, Docker images) from another machine** —
architecture and lockfile state differ. Always build on the target.

---

## 1. Install Docker Engine + Compose plugin

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git

# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Run Docker without `sudo`:

```bash
sudo usermod -aG docker $USER
newgrp docker        # applies the new group to the current shell (or log out / back in)
docker run --rm hello-world   # verify
```

---

## 2. Install Node.js 22 + pnpm 10.33.0

Shannon's Docker image uses Node 22; the host needs Node only for the `./shannon`
CLI and local builds. The project pins **pnpm 10.33.0**.

```bash
# nvm (Node Version Manager)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.zshrc                      # reload zsh so nvm is on PATH

nvm install 22
nvm use 22
nvm alias default 22

# pnpm at the exact pinned version, via corepack (ships with Node)
corepack enable
corepack prepare pnpm@10.33.0 --activate

node --version    # v22.x
pnpm --version    # 10.33.0
```

---

## 3. Clone the repository

```bash
git clone https://github.com/amichajlowski/shannon.git ~/shannon
cd ~/shannon
```

> Build artifacts and secrets are gitignored, so a clean clone never carries the
> source machine's `node_modules/`, `dist/`, `.env`, or captured auth files.

---

## 4. Create credentials (`.env`)

Do **not** copy `.env` or `auth-*` files from another machine. Create a fresh
`.env`:

```bash
cat > .env <<'EOF'
ANTHROPIC_API_KEY=your-key-here
CLAUDE_CODE_MAX_OUTPUT_TOKENS=your-value
EOF
chmod 600 .env
```

Captured auth artifacts (`auth-state.json`, `auth-header.txt`, `auth-session.json`)
hold live, short-lived, origin-specific session tokens. Don't migrate them —
recreate per scan with `shannon capture-auth` when you actually run an
authenticated scan.

---

## 5. Install dependencies and build

```bash
cd ~/shannon
pnpm install --frozen-lockfile
pnpm run build          # build all TypeScript packages
./shannon build         # build the shannon-worker Docker image for this host's arch
```

> **Package age policy:** package managers enforce a 7-day minimum release age.
> If `pnpm install` fails because a package is too new, **do not bypass it** —
> report the blocked package and stop.

---

## 6. Smoke test

```bash
./shannon status                                       # show running workers
./shannon start -u <url> -r /path/to/repo -w smoke-test
./shannon logs smoke-test                              # tail the workflow log
```

Temporal Web UI: <http://localhost:8233>

Stop when done:

```bash
./shannon stop            # preserves workflow data
./shannon stop --clean    # full cleanup including volumes (confirms first)
```

---

## Migration notes (macOS arm64 → Ubuntu amd64)

| Concern | Handling |
|---|---|
| Architecture change (arm64 → amd64) | Rebuild `node_modules` and the Docker image on the target. Never copy them. Handled by step 5. |
| Local vs npx mode | `./shannon` sets `SHANNON_LOCAL=1` automatically. No change needed. |
| `host.docker.internal` | On Linux the CLI adds `--add-host=host.docker.internal:host-gateway` automatically. Use this hostname to reach services on the host. |
| `/etc/hosts` forwarding | Works on Linux via `host-gateway`. Disable per-scan with `SHANNON_FORWARD_HOSTS=false` if it causes issues. |
| zsh | Fully supported. `./shannon` is a Node entry point and is shell-agnostic. |
| File permissions | `chmod 600 .env` and any captured auth files. |
| Docker permissions | The `docker` group setup in step 1 avoids needing `sudo` per command. |

No source code changes are required to run Shannon on Ubuntu.
