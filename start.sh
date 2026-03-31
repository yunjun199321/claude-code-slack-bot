#!/bin/bash
# CC Slack Bot launcher — sources .env and starts the bot
cd "$(dirname "$0")"

export PATH="/Users/yunjun-mini/.nvm/versions/node/v22.22.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/yunjun-mini"

# Source .env file
set -a
source .env
set +a

exec npx tsx src/index.ts
