#!/bin/bash
# Clean extended attributes that cause codesign failures on macOS

set -e

APP_PATH="$1"

if [ -z "$APP_PATH" ]; then
  echo "Usage: $0 <path-to-app>"
  exit 1
fi

echo "Cleaning extended attributes from $APP_PATH..."

# Remove extended attributes recursively (including quarantine flags)
xattr -rd com.apple.quarantine "$APP_PATH" 2>/dev/null || true

# Also clean other problematic attributes
find "$APP_PATH" -type f -exec xattr -d com.apple.FinderInfo {} \; 2>/dev/null || true
find "$APP_PATH" -type f -exec xattr -d com.apple.ResourceFork {} \; 2>/dev/null || true

echo "✅ Extended attributes cleaned"
