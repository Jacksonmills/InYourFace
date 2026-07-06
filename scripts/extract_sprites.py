#!/usr/bin/env python3
"""
Extract individual DOOM face sprites from the spritesheet.
Pure Python - no PIL/Pillow needed. Only uses stdlib (struct, zlib).

DOOM status bar face layout per row (each row = one health state, 0=healthiest, 4=most damaged):
  Col 0: STFST{n}0 - Looking right (eyes looking right)
  Col 1: STFST{n}1 - Looking forward (eyes forward)  
  Col 2: STFST{n}2 - Looking left (eyes looking left)
  Col 3: STFOUCH{n} - Ouch face
  Col 4: STFKILL{n} - Evil grin / rampage
  Col 5: STFEVL{n}  - Evil grin forward
  Col 6: Looking right (wider, with turning)
  Col 7: Looking left (wider, with turning)

Row 5: Col 0 = STFDEAD0 (dead), Col 1 = STFGOD0 (god mode)
"""

import struct
import zlib
import os


class PNGImage:
    def __init__(self, path):
        with open(path, 'rb') as f:
            sig = f.read(8)
            assert sig == b'\x89PNG\r\n\x1a\n', 'Not a PNG'
            self.chunks = []
            while True:
                raw_len = f.read(4)
                if len(raw_len) < 4:
                    break
                length = struct.unpack('>I', raw_len)[0]
                chunk_type = f.read(4)
                data = f.read(length)
                crc = f.read(4)
                self.chunks.append((chunk_type, data))

            ihdr = self.chunks[0][1]
            self.width, self.height, self.bit_depth, self.color_type = struct.unpack('>IIBB', ihdr[:10])
            ct_channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
            self.channels = ct_channels[self.color_type]

            idat_data = b''.join(d for t, d in self.chunks if t == b'IDAT')
            raw = zlib.decompress(idat_data)

            self.pixels = []
            bpp = self.channels * (self.bit_depth // 8)
            stride = self.width * bpp
            pos = 0
            prev_row = bytes(stride)
            for y in range(self.height):
                filt = raw[pos]
                pos += 1
                row_data = bytearray(raw[pos:pos + stride])
                pos += stride
                decoded = bytearray(stride)
                for x in range(stride):
                    a = decoded[x - bpp] if x >= bpp else 0
                    b = prev_row[x]
                    c = prev_row[x - bpp] if x >= bpp else 0
                    if filt == 0:
                        decoded[x] = row_data[x]
                    elif filt == 1:
                        decoded[x] = (row_data[x] + a) & 0xFF
                    elif filt == 2:
                        decoded[x] = (row_data[x] + b) & 0xFF
                    elif filt == 3:
                        decoded[x] = (row_data[x] + (a + b) // 2) & 0xFF
                    elif filt == 4:
                        p = a + b - c
                        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                        pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                        decoded[x] = (row_data[x] + pr) & 0xFF
                self.pixels.append(bytes(decoded))
                prev_row = decoded

    def crop(self, x1, y1, x2, y2):
        """Crop region and return PNG bytes."""
        cw = x2 - x1
        ch = y2 - y1
        bpp = self.channels * (self.bit_depth // 8)

        raw_data = bytearray()
        for y in range(y1, y2):
            raw_data.append(0)  # No filter
            row = self.pixels[y]
            raw_data.extend(row[x1 * bpp: x2 * bpp])

        compressed = zlib.compress(bytes(raw_data))

        out = bytearray(b'\x89PNG\r\n\x1a\n')

        def add_chunk(ctype, cdata):
            out.extend(struct.pack('>I', len(cdata)))
            out.extend(ctype)
            out.extend(cdata)
            out.extend(struct.pack('>I', zlib.crc32(ctype + cdata) & 0xFFFFFFFF))

        ihdr = struct.pack('>IIBBBBB', cw, ch, self.bit_depth, self.color_type, 0, 0, 0)
        add_chunk(b'IHDR', ihdr)
        add_chunk(b'IDAT', compressed)
        add_chunk(b'IEND', b'')

        return bytes(out)


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    assets_dir = os.path.join(project_dir, 'assets')
    faces_dir = os.path.join(assets_dir, 'faces')
    os.makedirs(faces_dir, exist_ok=True)

    spritesheet_path = os.path.join(assets_dir, 'doom_spritesheet.png')
    print(f"Loading spritesheet from {spritesheet_path}...")
    img = PNGImage(spritesheet_path)
    print(f"  Size: {img.width}x{img.height}, RGBA")

    # Detected sprite cell boundaries from spritesheet analysis
    cols = [
        (2, 141),     # Col 0: looking right
        (149, 288),   # Col 1: looking forward
        (296, 435),   # Col 2: looking left
        (443, 582),   # Col 3: ouch
        (590, 729),   # Col 4: evil grin / rampage
        (736, 876),   # Col 5: evil grin forward
        (935, 1109),  # Col 6: looking right (wider)
        (1116, 1279), # Col 7: looking left (wider)
    ]
    rows = [
        (2, 182),     # Row 0: health state 0 (healthiest)
        (187, 369),   # Row 1: health state 1
        (380, 562),   # Row 2: health state 2
        (567, 752),   # Row 3: health state 3
        (757, 942),   # Row 4: health state 4 (most damaged)
        (950, 1129),  # Row 5: special (dead + god)
    ]

    # Extract the 3 look-around faces for each of the 5 health states
    # We use cols 0 (right), 1 (forward), 2 (left) — the standard front-facing set
    angle_names = {0: 'right', 1: 'center', 2: 'left'}

    for state in range(5):
        ry1, ry2 = rows[state]
        for col_idx, angle_name in angle_names.items():
            cx1, cx2 = cols[col_idx]
            filename = f"doom{state}_{angle_name}.png"
            filepath = os.path.join(faces_dir, filename)
            png_data = img.crop(cx1, ry1, cx2, ry2)
            with open(filepath, 'wb') as f:
                f.write(png_data)
            print(f"  Extracted {filename} ({cx2-cx1}x{ry2-ry1})")

    # Also extract special faces
    # Ouch faces (col 3) for each health state
    for state in range(5):
        ry1, ry2 = rows[state]
        cx1, cx2 = cols[3]
        filename = f"doom{state}_ouch.png"
        filepath = os.path.join(faces_dir, filename)
        png_data = img.crop(cx1, ry1, cx2, ry2)
        with open(filepath, 'wb') as f:
            f.write(png_data)
        print(f"  Extracted {filename} ({cx2-cx1}x{ry2-ry1})")

    # Evil grin (col 4) for each health state
    for state in range(5):
        ry1, ry2 = rows[state]
        cx1, cx2 = cols[4]
        filename = f"doom{state}_rampage.png"
        filepath = os.path.join(faces_dir, filename)
        png_data = img.crop(cx1, ry1, cx2, ry2)
        with open(filepath, 'wb') as f:
            f.write(png_data)
        print(f"  Extracted {filename} ({cx2-cx1}x{ry2-ry1})")

    # Dead face (row 5, col 0)
    ry1, ry2 = rows[5]
    cx1, cx2 = cols[0]
    filename = "doom_dead.png"
    filepath = os.path.join(faces_dir, filename)
    png_data = img.crop(cx1, ry1, cx2, ry2)
    with open(filepath, 'wb') as f:
        f.write(png_data)
    print(f"  Extracted {filename}")

    # God mode face (row 5, col 1)
    cx1, cx2 = cols[1]
    filename = "doom_god.png"
    filepath = os.path.join(faces_dir, filename)
    png_data = img.crop(cx1, ry1, cx2, ry2)
    with open(filepath, 'wb') as f:
        f.write(png_data)
    print(f"  Extracted {filename}")

    print(f"\nDone! Extracted sprites to {faces_dir}")
    print(f"  - 15 look-around faces (5 states × 3 angles)")
    print(f"  - 5 ouch faces")
    print(f"  - 5 rampage faces")
    print(f"  - 1 dead face")
    print(f"  - 1 god mode face")


if __name__ == '__main__':
    main()
