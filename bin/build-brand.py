"""Export Pocket's single vector master with the FBT logo-design renderer."""
from pathlib import Path
import argparse
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--renderer", type=Path, required=True,
                    help="Absolute path to FBT logo-design/scripts/render_png.py")
args = parser.parse_args()
if not args.renderer.is_file():
    parser.error("The FBT logo renderer must exist")
ET.register_namespace("", "http://www.w3.org/2000/svg")
source = ROOT / "design/brand/symbol.svg"
root = ET.parse(source).getroot()
paths = "".join(ET.tostring(node, encoding="unicode") for node in root
                if node.tag.endswith("}path"))
icons = ROOT / "public/icons"
icon = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><title>Pocket</title><path fill="#315A4A" d="M0 0H64V64H0Z"/><g fill="#F7F5EF" transform="matrix(.86 0 0 .86 4.48 3.62)">' + paths + '</g></svg>\n'
(icons / "pocket-v1.svg").write_text(icon)
for name, color in [("symbol-black.svg", "#000000"), ("symbol-white.svg", "#FFFFFF")]:
    variant = ET.parse(source).getroot()
    variant.set("fill", color)
    (source.parent / name).write_text(ET.tostring(variant, encoding="unicode") + "\n")
for size in [16, 32, 180, 192, 512]:
    subprocess.run([sys.executable, str(args.renderer), str(icons / "pocket-v1.svg"),
                    "--backend", "rsvg-convert", "--size", str(size), "--padding", "0",
                    "-o", str(icons / f"pocket-v1-{size}.png")], check=True)
# Old manifests and already-open pages still have these URLs.
for name, size in [("icon-192.png", 192), ("icon-512.png", 512),
                   ("icon-maskable.png", 512), ("apple-touch-icon.png", 180)]:
    (icons / name).write_bytes((icons / f"pocket-v1-{size}.png").read_bytes())
