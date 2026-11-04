#!/bin/sh
# Build the Web Store upload: only what the extension needs at runtime.
set -e
cd "$(dirname "$0")/.."
v=$(node -p "require('./manifest.json').version")
rm -f "store/callscribe-$v.zip"
zip -qr "store/callscribe-$v.zip" manifest.json icons src LICENSE
unzip -l "store/callscribe-$v.zip" | tail -1
echo "store/callscribe-$v.zip"
