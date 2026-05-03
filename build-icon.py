#!/usr/bin/env python3
"""Convert logo.svg to macOS icon.icns"""

import subprocess
import os
import sys
from pathlib import Path

# Paths
INPUT_SVG = "src/renderer/assets/logo.svg"
ICONSET_DIR = "assets/Weave.iconset"
OUTPUT_ICNS = "assets/icon.icns"

def run_cmd(cmd):
    """Run shell command"""
    try:
        subprocess.run(cmd, check=True, shell=isinstance(cmd, str))
    except subprocess.CalledProcessError as e:
        print(f"❌ Error: {e}")
        sys.exit(1)

def create_icons():
    """Create icon sizes from SVG"""
    os.makedirs(ICONSET_DIR, exist_ok=True)
    
    # Icon sizes needed for macOS
    sizes = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    
    print(f"Converting {INPUT_SVG} to icon sizes...")
    
    for size, filename in sizes:
        output_path = os.path.join(ICONSET_DIR, filename)
        
        # Try ImageMagick convert (requires: brew install imagemagick)
        cmd = f'convert -background none -density 300 "{INPUT_SVG}" -resize {size}x{size} "{output_path}"'
        print(f"  Creating {size}x{size}... → {filename}")
        run_cmd(cmd)
    
    # Create ICNS file
    print(f"\nConverting iconset to {OUTPUT_ICNS}...")
    run_cmd(f'iconutil -c icns "{ICONSET_DIR}" -o "{OUTPUT_ICNS}"')
    
    print(f"\n✅ Icon created successfully: {OUTPUT_ICNS}")
    print(f"Ready to use with: npm run dmg")

if __name__ == "__main__":
    # Check dependencies
    try:
        subprocess.run(["which", "convert"], check=True, capture_output=True)
    except subprocess.CalledProcessError:
        print("❌ ImageMagick not found. Install with:")
        print("   brew install imagemagick")
        sys.exit(1)
    
    try:
        subprocess.run(["which", "iconutil"], check=True, capture_output=True)
    except subprocess.CalledProcessError:
        print("❌ iconutil not found (comes with Xcode)")
        sys.exit(1)
    
    create_icons()
