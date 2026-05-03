#!/bin/bash

# Build macOS app icon from SVG logo

set -e

INPUT_SVG="src/renderer/assets/logo.svg"
ICONSET_DIR="assets/Weave.iconset"
OUTPUT_ICNS="assets/icon.icns"

# Create iconset directory
mkdir -p "$ICONSET_DIR"

# Function to convert SVG to PNG at specific size
convert_svg_to_png() {
  local size=$1
  local filename=$2
  
  # Using ImageMagick via sips (built-in macOS)
  # First convert SVG to PNG at a larger size, then scale down
  echo "Converting $size x $size..."
  
  # Use sips if available, otherwise try ImageMagick
  if command -v sips &> /dev/null; then
    # Create temp PNG at high res
    python3 << EOF
import subprocess
import os

size = $size
svg_file = "$INPUT_SVG"

# Use simple scaling: create a large version and scale down
# For better quality, we'll use a 4x resolution and scale down
large_size = size * 4
temp_png = "/tmp/temp_${size}.png"

# Use cairosvg or imagemagick if available
try:
    from cairosvg import svg2png
    svg2png(url=svg_file, write_to=temp_png, output_width=large_size, output_height=large_size)
    # Scale down for better quality
    subprocess.run(['sips', '-z', str(size), str(size), temp_png, '--out', '$ICONSET_DIR/$filename'], check=True)
    os.remove(temp_png)
except ImportError:
    print("cairosvg not available, trying alternative method...")
    # Fallback: use a simple approach with ImageMagick convert if available
    try:
        subprocess.run(['convert', '-background', 'none', '-size', f'{large_size}x{large_size}', svg_file, '-gravity', 'center', '-extent', f'{large_size}x{large_size}', temp_png], check=True)
        subprocess.run(['sips', '-z', str(size), str(size), temp_png, '--out', '$ICONSET_DIR/$filename'], check=True)
        os.remove(temp_png)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("Neither cairosvg nor ImageMagick found. Please install one:")
        print("  brew install imagemagick  # or")
        print("  pip install cairosvg")
        sys.exit(1)
EOF
  fi
}

# Create PNG files at all required sizes
echo "Creating iconset from $INPUT_SVG..."

# macOS icon sizes (1x and 2x retina versions)
convert_svg_to_png 16 "icon_16x16.png"
convert_svg_to_png 32 "icon_16x16@2x.png"
convert_svg_to_png 32 "icon_32x32.png"
convert_svg_to_png 64 "icon_32x32@2x.png"
convert_svg_to_png 128 "icon_128x128.png"
convert_svg_to_png 256 "icon_128x128@2x.png"
convert_svg_to_png 256 "icon_256x256.png"
convert_svg_to_png 512 "icon_256x256@2x.png"
convert_svg_to_png 512 "icon_512x512.png"
convert_svg_to_png 1024 "icon_512x512@2x.png"

# Convert iconset to ICNS
echo "Converting iconset to ICNS..."
iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICNS"

echo "✅ Icon created: $OUTPUT_ICNS"
echo "Iconset directory: $ICONSET_DIR"
