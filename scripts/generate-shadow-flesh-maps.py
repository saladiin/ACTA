from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


MAP_SIZE = 1024


def smoothstep(edge0: float, edge1: float, value: np.ndarray) -> np.ndarray:
    value = np.clip((value - edge0) / max(edge1 - edge0, 1e-6), 0.0, 1.0)
    return value * value * (3.0 - 2.0 * value)


def to_u8(value: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(value * 255.0), 0, 255).astype(np.uint8)


def save_rgb(path: Path, value: np.ndarray) -> None:
    Image.fromarray(to_u8(value), mode="RGB").save(path, optimize=True)


def save_gray(path: Path, value: np.ndarray) -> None:
    Image.fromarray(to_u8(value), mode="L").save(path, optimize=True)


def periodic_blur(value: np.ndarray, radius: float) -> np.ndarray:
    height, width = value.shape
    tiled = np.tile(to_u8(value), (3, 3))
    blurred = Image.fromarray(tiled, mode="L").filter(
        ImageFilter.GaussianBlur(radius=radius)
    )
    return (
        np.asarray(blurred.crop((width, height, width * 2, height * 2)), dtype=np.float32)
        / 255.0
    )


def make_tileable(source: np.ndarray) -> np.ndarray:
    height, width, _ = source.shape
    mirrored = np.concatenate((source, source[:, ::-1]), axis=1)
    mirrored = np.concatenate((mirrored, mirrored[::-1]), axis=0)
    tile = mirrored[
        height // 2 : height // 2 + height,
        width // 2 : width // 2 + width,
    ]

    # A small periodic warp softens the obvious mirror axes while preserving
    # toroidal continuity for RepeatWrapping.
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    tau = np.pi * 2.0
    dx = 3.2 * np.sin(tau * yy * 2.0 / height)
    dx += 1.6 * np.sin(tau * (xx * 2.0 / width + yy * 3.0 / height))
    dy = 3.0 * np.sin(tau * xx * 2.0 / width + 0.7)
    dy += 1.4 * np.sin(tau * (xx * 3.0 / width - yy * 2.0 / height))
    return sample_wrapped_bilinear(tile, xx + dx, yy + dy)


def sample_wrapped_bilinear(
    image: np.ndarray, x: np.ndarray, y: np.ndarray
) -> np.ndarray:
    height, width, _ = image.shape
    x0 = np.floor(x).astype(np.int32) % width
    y0 = np.floor(y).astype(np.int32) % height
    x1 = (x0 + 1) % width
    y1 = (y0 + 1) % height
    fx = (x - np.floor(x))[..., None]
    fy = (y - np.floor(y))[..., None]
    top = image[y0, x0] * (1.0 - fx) + image[y0, x1] * fx
    bottom = image[y1, x0] * (1.0 - fx) + image[y1, x1] * fx
    return top * (1.0 - fy) + bottom * fy


def normal_from_height(height: np.ndarray, strength: float = 5.5) -> np.ndarray:
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5
    normal = np.stack((-dx * strength, -dy * strength, np.ones_like(height)), axis=2)
    normal /= np.maximum(np.linalg.norm(normal, axis=2, keepdims=True), 1e-6)
    return normal * 0.5 + 0.5


def flow_from_height(height: np.ndarray) -> np.ndarray:
    broad = periodic_blur(height, 7.0)
    gx = (np.roll(broad, -1, axis=1) - np.roll(broad, 1, axis=1)) * 0.5
    gy = (np.roll(broad, -1, axis=0) - np.roll(broad, 1, axis=0)) * 0.5

    # Tangents follow the sinewy contours. Low-gradient areas receive a mild
    # common drift so the shader never encounters undefined direction.
    flow_x = -gy + 0.035
    flow_y = gx + 0.012
    magnitude = np.maximum(np.sqrt(flow_x * flow_x + flow_y * flow_y), 1e-5)
    flow_x /= magnitude
    flow_y /= magnitude
    neutral = np.full_like(flow_x, 0.5)
    return np.stack((flow_x * 0.5 + 0.5, flow_y * 0.5 + 0.5, neutral), axis=2)


def edge_error(image: np.ndarray) -> tuple[float, float]:
    horizontal = float(np.mean(np.abs(image[:, 0] - image[:, -1])) * 255.0)
    vertical = float(np.mean(np.abs(image[0] - image[-1])) * 255.0)
    return horizontal, vertical


def make_preview(output_dir: Path, maps: list[tuple[str, Path]]) -> None:
    cell = 256
    label_height = 30
    columns = 3
    rows = (len(maps) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * cell, rows * (cell + label_height)), "#111318")
    draw = ImageDraw.Draw(sheet)
    for index, (label, path) in enumerate(maps):
        image = Image.open(path).convert("RGB")
        image.thumbnail((cell, cell), Image.Resampling.LANCZOS)
        x = (index % columns) * cell
        y = (index // columns) * (cell + label_height)
        sheet.paste(image, (x, y))
        draw.rectangle((x, y + cell, x + cell, y + cell + label_height), fill="#111318")
        draw.text((x + 8, y + cell + 8), label, fill="#e6edf3")
    sheet.save(output_dir / "shadow_flesh_material_preview.png", optimize=True)


def make_tiling_preview(output_dir: Path, base_path: Path) -> None:
    tile = Image.open(base_path).convert("RGB").resize(
        (MAP_SIZE // 2, MAP_SIZE // 2), Image.Resampling.LANCZOS
    )
    preview = Image.new("RGB", (MAP_SIZE, MAP_SIZE))
    for y in (0, MAP_SIZE // 2):
        for x in (0, MAP_SIZE // 2):
            preview.paste(tile, (x, y))
    preview.save(output_dir / "shadow_flesh_tiling_preview.png", optimize=True)


def generate(source_path: Path, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    source_image = Image.open(source_path).convert("RGB")
    if source_image.size != (MAP_SIZE, MAP_SIZE):
        source_image = source_image.resize((MAP_SIZE, MAP_SIZE), Image.Resampling.LANCZOS)
    source_image.save(output_dir / "shadow_flesh_source.png", optimize=True)
    source = np.asarray(source_image, dtype=np.float32) / 255.0
    tile = make_tileable(source)

    luminance = (
        tile[..., 0] * 0.2126 + tile[..., 1] * 0.7152 + tile[..., 2] * 0.0722
    )
    white_point = max(float(np.percentile(luminance, 99.5)), 0.25)
    height = np.clip((luminance - 0.012) / (white_point - 0.012), 0.0, 1.0)
    height = np.power(height, 0.82)
    height = periodic_blur(height, 0.75)

    alpha = smoothstep(0.08, 0.42, height)
    emissive = smoothstep(0.30, 0.82, periodic_blur(height, 1.4)) * alpha
    roughness = np.clip(0.86 - periodic_blur(height, 2.2) * 0.52, 0.30, 0.90)
    normal = normal_from_height(height)

    low = periodic_blur(height, 10.0)
    broad = periodic_blur(height, 32.0)
    distortion = low * 0.68 + broad * 0.32
    distortion -= distortion.min()
    distortion /= max(float(distortion.max()), 1e-6)
    flow = flow_from_height(height)

    ambient_occlusion = np.clip(0.30 + np.sqrt(alpha) * 0.70, 0.0, 1.0)
    metallic = np.zeros_like(height)
    orm = np.stack((ambient_occlusion, roughness, metallic), axis=2)

    base_path = output_dir / "shadow_flesh_base_tile.png"
    height_path = output_dir / "shadow_flesh_height.png"
    normal_path = output_dir / "shadow_flesh_normal.png"
    roughness_path = output_dir / "shadow_flesh_roughness.png"
    alpha_path = output_dir / "shadow_flesh_alpha.png"
    emissive_path = output_dir / "shadow_flesh_emissive.png"
    distortion_path = output_dir / "shadow_flesh_distortion.png"
    flow_path = output_dir / "shadow_flesh_flow.png"
    orm_path = output_dir / "shadow_flesh_orm.png"

    save_rgb(base_path, tile)
    save_gray(height_path, height)
    save_rgb(normal_path, normal)
    save_gray(roughness_path, roughness)
    save_gray(alpha_path, alpha)
    save_gray(emissive_path, emissive)
    save_gray(distortion_path, distortion)
    save_rgb(flow_path, flow)
    save_rgb(orm_path, orm)

    make_preview(
        output_dir,
        [
            ("Seamless base", base_path),
            ("Height", height_path),
            ("Normal (OpenGL)", normal_path),
            ("Roughness", roughness_path),
            ("Alpha mask", alpha_path),
            ("Emissive mask", emissive_path),
            ("Distortion", distortion_path),
            ("Flow (RG)", flow_path),
            ("ORM packed", orm_path),
        ],
    )
    make_tiling_preview(output_dir, base_path)

    source_lr, source_tb = edge_error(source)
    tile_lr, tile_tb = edge_error(tile)
    print(f"Generated {len(list(output_dir.glob('shadow_flesh_*.png')))} PNG files")
    print(f"Source edge MAE: left/right={source_lr:.2f}, top/bottom={source_tb:.2f}")
    print(f"Tile edge MAE: left/right={tile_lr:.2f}, top/bottom={tile_tb:.2f}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate aligned Shadow flesh PBR maps")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    generate(args.source, args.output)


if __name__ == "__main__":
    main()
