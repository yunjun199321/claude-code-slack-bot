#!/bin/bash
# CC Slack Bot launcher — sources .env and starts the bot
cd "$(dirname "$0")"

export HOME="${HOME:-/Users/yunjun-mini}"

# Load nvm to get the correct Node.js version
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

export PATH="$HOME/.nvm/versions/node/$(node -v 2>/dev/null || echo v22)/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Source .env file
set -a
source .env
set +a

exec npx tsx src/index.ts
