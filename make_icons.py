import struct, zlib, os

def make_chunk(chunk_type, data):
    c = chunk_type + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

def create_icon(filename, size):
    bg = (0x1e, 0x3a, 0x5f)  # dark blue
    fg = (0xFF, 0xFF, 0xFF)  # white

    pad    = size // 6
    stroke = max(2, size // 40)

    # Box body bounds
    bx1, bx2 = pad, size - pad
    by1, by2 = size // 3, size - pad

    # Lid bounds (narrower, above box)
    lx1, lx2 = bx1 + size // 10, bx2 - size // 10
    ly1, ly2 = pad, by1

    rows = []
    for y in range(size):
        row = [0]  # PNG filter = None
        for x in range(size):
            in_box = (bx1 <= x <= bx2 and by1 <= y <= by2 and
                      (x <= bx1+stroke or x >= bx2-stroke or
                       y <= by1+stroke or y >= by2-stroke))
            in_lid = (lx1 <= x <= lx2 and ly1 <= y <= ly2 and
                      (x <= lx1+stroke or x >= lx2-stroke or
                       y <= ly1+stroke or y >= ly2-stroke))
            r, g, b = fg if (in_box or in_lid) else bg
            row += [r, g, b]
        rows.append(bytes(row))

    raw        = b''.join(rows)
    compressed = zlib.compress(raw, 9)

    png  = b'\x89PNG\r\n\x1a\n'
    png += make_chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += make_chunk(b'IDAT', compressed)
    png += make_chunk(b'IEND', b'')

    with open(filename, 'wb') as f:
        f.write(png)
    print('Created', filename)

os.makedirs('icons', exist_ok=True)
create_icon('icons/icon-192.png', 192)
create_icon('icons/icon-512.png', 512)
