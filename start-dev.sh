#!/bin/bash
export PATH="/Users/ytmrlwywyys/.nvm/versions/node/v24.16.0/bin:$PATH"
cd "$(dirname "$0")"
npm run dev -- --port 8081
