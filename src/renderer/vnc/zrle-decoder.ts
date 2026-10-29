import UpstreamZRLEDecoder from '@maclink/novnc-zrle';

/** Keep noVNC's rectangle framing and streaming inflater; specialize only pixel
 * expansion. Windows x64 is little endian, so one Uint32 store writes RGBA. */
export default class ZRLEDecoder extends UpstreamZRLEDecoder {
  private readonly pixelWords: Uint32Array;
  private readonly tileWords: Uint32Array;

  constructor() {
    super();
    this.pixelWords = new Uint32Array(this._pixelBuffer.buffer, this._pixelBuffer.byteOffset, this._pixelBuffer.byteLength / 4);
    this.tileWords = new Uint32Array(this._tileBuffer.buffer, this._tileBuffer.byteOffset, this._tileBuffer.byteLength / 4);
  }

  override _readPixels(pixels: number): Uint8Array {
    const rgb = this._inflator.inflate(pixels * 3);
    const words = this.pixelWords;
    for (let pixel = 0, byte = 0; pixel < pixels; pixel++, byte += 3) {
      words[pixel] = 0xff000000 | rgb[byte] | (rgb[byte + 1] << 8) | (rgb[byte + 2] << 16);
    }
    return this._pixelBuffer;
  }

  override _decodePaletteTile(paletteSize: number, _tileSize: number, tileWidth: number, tileHeight: number): Uint8Array {
    this._readPixels(paletteSize);
    const palette = this.pixelWords;
    const bits = paletteSize <= 2 ? 1 : paletteSize <= 4 ? 2 : 4;
    const mask = (1 << bits) - 1;
    const rowBytes = (tileWidth * bits + 7) >>> 3;
    const packed = this._inflator.inflate(rowBytes * tileHeight);
    const output = this.tileWords;
    let offset = 0;
    for (let row = 0; row < tileHeight; row++) {
      const rowStart = row * rowBytes;
      for (let pixel = 0, bit = 0; pixel < tileWidth; pixel++, bit += bits) {
        const index = (packed[rowStart + (bit >>> 3)] >>> (8 - bits - (bit & 7))) & mask;
        output[offset++] = palette[index];
      }
    }
    return this._tileBuffer;
  }

  override _decodeRLETile(tileSize: number): Uint8Array {
    let offset = 0;
    while (offset < tileSize) {
      this._readPixels(1);
      const color = this.pixelWords[0];
      const end = offset + this._readRLELength();
      if (end > tileSize) throw new Error('ZRLE run exceeds tile size');
      this.tileWords.fill(color, offset, end);
      offset = end;
    }
    return this._tileBuffer;
  }

  override _decodeRLEPaletteTile(paletteSize: number, tileSize: number): Uint8Array {
    this._readPixels(paletteSize);
    const palette = this.pixelWords;
    let offset = 0;
    while (offset < tileSize) {
      const encoded = this._inflator.inflate(1)[0];
      const index = encoded & 127;
      const length = encoded & 128 ? this._readRLELength() : 1;
      if (index >= paletteSize) throw new Error('ZRLE palette index exceeds palette size');
      const end = offset + length;
      if (end > tileSize) throw new Error('ZRLE palette run exceeds tile size');
      this.tileWords.fill(palette[index], offset, end);
      offset = end;
    }
    return this._tileBuffer;
  }
}
