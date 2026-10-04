// Test support (3d.4): a stand-in for WebCodecs' `ImageDecoder`, which the test DOM does not have, recording what it is asked, so a
// test can follow the preview's sticker decoding (the init, the frames decoded, the decoders closed). Remove it with `restore`.
// Test-only.

export interface FakeImageDecoders {
  /** The init each decoder was made with, in order. */
  readonly inits: ImageDecoderInit[];
  /** The frame indexes asked of `decode`, in order. */
  readonly decoded: number[];
  /** How many decoders were closed. */
  closed: number;
  /** `isTypeSupported`'s answer. */
  supported: boolean;
  /** Whether a decoder's tracks never get ready (a file it cannot read). */
  readyFails: boolean;
  restore(): void;
}

export function installImageDecoder(frameCount = 24): FakeImageDecoders {
  const control: FakeImageDecoders = {
    inits: [],
    decoded: [],
    closed: 0,
    supported: true,
    readyFails: false,
    restore: () => {
      Reflect.deleteProperty(globalThis, "ImageDecoder");
    },
  };
  class FakeImageDecoder {
    static isTypeSupported(): Promise<boolean> {
      return Promise.resolve(control.supported);
    }
    readonly tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } };
    readonly completed: Promise<void>;
    constructor(init: ImageDecoderInit) {
      control.inits.push(init);
      this.tracks = { ready: control.readyFails ? Promise.reject(new Error("broken file")) : Promise.resolve(), selectedTrack: { frameCount } };
      this.completed = Promise.resolve();
    }
    decode(options: { frameIndex: number }): Promise<{ image: { close(): void } }> {
      control.decoded.push(options.frameIndex);
      return Promise.resolve({ image: { close: () => undefined } });
    }
    close(): void {
      control.closed += 1;
    }
  }
  Object.defineProperty(globalThis, "ImageDecoder", { value: FakeImageDecoder, configurable: true, writable: true });
  return control;
}
