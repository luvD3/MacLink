const OUTPUT_BYTES = 128 * 1024;
const INPUT_BYTES = 32 * 1024;
const EMPTY_INPUT = new Uint8Array(0);

interface ZlibExports {
  memory: WebAssembly.Memory;
  malloc(bytes: number): number;
  free(pointer: number): void;
  inflate_new(): number;
  inflate_init(handle: number): number;
  inflate_process(handle: number, input: number, inputBytes: number, output: number, outputBytes: number, flush: number): number;
  inflate_last_consumed(handle: number): number;
  inflate_end(handle: number): number;
}

export function compileInflater(bytes: BufferSource): Promise<WebAssembly.Module> {
  return WebAssembly.compile(bytes);
}

/**
 * Synchronous noVNC Inflate adapter for zlib-streams 1.4.0's WASM exports.
 * Each adapter owns an instance and its heap, so disconnecting needs no shared
 * allocator cleanup. Only the compiled Module is shared between connections.
 * Returned views remain valid until the next inflate() or reset().
 */
export default class WasmInflator {
  private readonly wasm: ZlibExports;
  private readonly heap: Uint8Array;
  private readonly outputPointer: number;
  private handle: number;
  private inputPointer = 0;
  private inputCapacity = 0;
  private input: Uint8Array | null = null;
  private inputOffset = 0;
  private readOffset = 0;
  private writeOffset = 0;

  constructor(module: WebAssembly.Module) {
    this.wasm = new WebAssembly.Instance(module).exports as unknown as ZlibExports;
    this.heap = new Uint8Array(this.wasm.memory.buffer);
    this.outputPointer = this.allocate(OUTPUT_BYTES);
    this.handle = this.createStream();
  }

  setInput(data: Uint8Array | null): void {
    this.input = data;
    this.inputOffset = 0;
  }

  inflate(expected: number): Uint8Array {
    // Keep the WASM heap bounded even if a caller requests a whole rectangle.
    if (expected > OUTPUT_BYTES) {
      const output = new Uint8Array(expected);
      for (let offset = 0; offset < expected; offset += OUTPUT_BYTES) {
        output.set(this.inflate(Math.min(OUTPUT_BYTES, expected - offset)), offset);
      }
      return output;
    }

    if (this.writeOffset - this.readOffset < expected) {
      const remaining = this.writeOffset - this.readOffset;
      if (remaining) {
        this.heap.copyWithin(this.outputPointer, this.outputPointer + this.readOffset, this.outputPointer + this.writeOffset);
      }
      this.readOffset = 0;
      this.writeOffset = remaining;

      while (this.writeOffset < expected) {
        const input = this.input?.subarray(this.inputOffset, this.inputOffset + INPUT_BYTES) ?? EMPTY_INPUT;
        if (input.length > this.inputCapacity) {
          const pointer = this.allocate(input.length);
          if (this.inputPointer) this.wasm.free(this.inputPointer);
          this.inputPointer = pointer;
          this.inputCapacity = input.length;
        }
        this.heap.set(input, this.inputPointer);

        // The WASM ABI copies its input, so feed bounded slices instead of
        // recopying an entire compressed rectangle on every read-ahead call.
        const result = this.wasm.inflate_process(
          this.handle, this.inputPointer, input.length,
          this.outputPointer + this.writeOffset, OUTPUT_BYTES - this.writeOffset, 0,
        );
        const status = result >> 24;
        const produced = result & 0x00ffffff;
        const consumed = this.wasm.inflate_last_consumed(this.handle);
        if (status < 0) throw new Error(status === -5 ? 'Incomplete zlib block' : `zlib inflate failed (${status})`);
        if (!produced && !consumed) throw new Error('Incomplete zlib block');
        this.inputOffset += consumed;
        this.writeOffset += produced;
      }
    }

    const start = this.readOffset;
    this.readOffset += expected;
    return this.heap.subarray(this.outputPointer + start, this.outputPointer + this.readOffset);
  }

  reset(): void {
    this.wasm.inflate_end(this.handle);
    this.handle = this.createStream();
    this.input = null;
    this.inputOffset = 0;
    this.readOffset = 0;
    this.writeOffset = 0;
  }

  private allocate(bytes: number): number {
    const pointer = this.wasm.malloc(bytes);
    if (!pointer) throw new Error('zlib memory allocation failed');
    return pointer;
  }

  private createStream(): number {
    const handle = this.wasm.inflate_new();
    if (!handle) throw new Error('zlib memory allocation failed');
    const status = this.wasm.inflate_init(handle);
    if (status !== 0) throw new Error(`zlib initialization failed (${status})`);
    return handle;
  }
}
