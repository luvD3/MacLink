export interface PixelDisplay {
  fillRect(x: number, y: number, width: number, height: number, color: ArrayLike<number>, fromQueue?: boolean): void;
  blitImage(x: number, y: number, width: number, height: number, pixels: Uint8Array, offset: number, fromQueue?: boolean): void;
}

/** Reuse a rectangle buffer to upload a large ZRLE update once, instead of
 * creating an ImageData and calling putImageData for every 64×64 tile. */
export class TileBatch implements PixelDisplay {
  private pixels = new Uint8Array(0);
  private words = new Uint32Array(0);
  private x = 0;
  private y = 0;
  private width = 0;
  private height = 0;

  begin(x: number, y: number, width: number, height: number): void {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    const bytes = width * height * 4;
    if (this.pixels.length < bytes) {
      this.pixels = new Uint8Array(bytes);
      this.words = new Uint32Array(this.pixels.buffer);
    }
  }

  fillRect(x: number, y: number, width: number, height: number, color: ArrayLike<number>): void {
    // The supported Windows x64 target stores these RGBA bytes little-endian.
    const rgba = (0xff000000 | (color[2] << 16) | (color[1] << 8) | color[0]) >>> 0;
    let target = (y - this.y) * this.width + x - this.x;
    for (let row = 0; row < height; row++, target += this.width) {
      this.words.fill(rgba, target, target + width);
    }
  }

  blitImage(x: number, y: number, width: number, height: number, pixels: Uint8Array, offset: number): void {
    const rowBytes = width * 4;
    let target = ((y - this.y) * this.width + x - this.x) * 4;
    for (let row = 0; row < height; row++, target += this.width * 4, offset += rowBytes) {
      this.pixels.set(pixels.subarray(offset, offset + rowBytes), target);
    }
  }

  commit(display: PixelDisplay): void {
    display.blitImage(this.x, this.y, this.width, this.height, this.pixels, 0, false);
  }
}
