import { expect, test } from "bun:test";
import { withInputShape } from "./onnxShape";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// A minimal protobuf encoder for onnx.proto's ModelProto/GraphProto/ValueInfoProto,
// just enough to build a synthetic model to exercise withInputShape's contract
// without needing a real .onnx file. Field numbers per onnx/onnx.proto, mirrored
// from onnxShape.ts's own doc comment.
const WIRE_LEN = 2;
const WIRE_VARINT = 0;

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function lenField(no: number, payload: Uint8Array): Uint8Array {
  return concat([Uint8Array.from([...varint(no * 8 + WIRE_LEN), ...varint(payload.length)]), payload]);
}
function varintField(no: number, value: number): Uint8Array {
  return Uint8Array.from([...varint(no * 8 + WIRE_VARINT), ...varint(value)]);
}
const str = (s: string) => new TextEncoder().encode(s);

const ELEM_FLOAT = 1;

/** A tensor-typed ValueInfoProto: { name, type { tensor_type { elem_type, shape? } } }. */
function valueInfo(name: string, dims: ReadonlyArray<number | string> | null): Uint8Array {
  const dimMsgs = (dims ?? []).map((d) => lenField(1, typeof d === "number" ? varintField(1, d) : lenField(2, str(d))));
  const tensorParts = [varintField(1, ELEM_FLOAT)];
  if (dims) tensorParts.push(lenField(2, concat(dimMsgs)));
  const type = lenField(1, concat(tensorParts));
  return concat([lenField(1, str(name)), lenField(2, type)]);
}

/** A GraphProto with one input, one output and one value_info, plus a trailing marker field (no. 20) to prove untouched bytes survive. */
function fakeGraph(inputName: string, inputDims: ReadonlyArray<number | string>): Uint8Array {
  return concat([
    lenField(11, valueInfo(inputName, inputDims)),
    lenField(12, valueInfo("out1", [1, 16])),
    lenField(13, valueInfo("mid1", [1, 8])),
    varintField(20, 42),
  ]);
}

function fakeModel(graph: Uint8Array): Uint8Array {
  return concat([varintField(1, 7) /* some unrelated top-level field */, lenField(7, graph)]);
}

function readVarint(buf: Uint8Array, pos: number): { value: number; pos: number } {
  let value = 0;
  let mul = 1;
  for (;;) {
    const b = buf[pos++] ?? 0;
    value += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) return { value, pos };
    mul *= 128;
  }
}

/** Reads back a ValueInfoProto's name and, if present, its shape dims (numbers or symbolic strings). */
function readValueInfo(buf: Uint8Array): { name: string; dims: (number | string)[] | null } {
  let name = "";
  let dims: (number | string)[] | null = null;
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    const no = Math.floor(tag.value / 8);
    pos = tag.pos;
    const len = readVarint(buf, pos);
    pos = len.pos;
    const payload = buf.subarray(pos, pos + len.value);
    pos += len.value;
    if (no === 1) name = new TextDecoder().decode(payload);
    else if (no === 2) dims = readType(payload);
  }
  return { name, dims };
}
function readType(typeBuf: Uint8Array): (number | string)[] | null {
  let pos = 0;
  while (pos < typeBuf.length) {
    const tag = readVarint(typeBuf, pos);
    const no = Math.floor(tag.value / 8);
    pos = tag.pos;
    const len = readVarint(typeBuf, pos);
    pos = len.pos;
    const payload = typeBuf.subarray(pos, pos + len.value);
    pos += len.value;
    if (no === 1) return readTensor(payload);
  }
  return null;
}
function readTensor(tensorBuf: Uint8Array): (number | string)[] | null {
  let pos = 0;
  while (pos < tensorBuf.length) {
    const tag = readVarint(tensorBuf, pos);
    const no = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    pos = tag.pos;
    if (wire === WIRE_VARINT) {
      pos = readVarint(tensorBuf, pos).pos;
      continue;
    }
    const len = readVarint(tensorBuf, pos);
    pos = len.pos;
    const payload = tensorBuf.subarray(pos, pos + len.value);
    pos += len.value;
    if (no === 2) return readShape(payload);
  }
  return null;
}
function readShape(shapeBuf: Uint8Array): (number | string)[] {
  const dims: (number | string)[] = [];
  let pos = 0;
  while (pos < shapeBuf.length) {
    const tag = readVarint(shapeBuf, pos);
    pos = tag.pos;
    const len = readVarint(shapeBuf, pos);
    pos = len.pos;
    const payload = shapeBuf.subarray(pos, pos + len.value);
    pos += len.value;
    // Dimension { dim_value: 1 (varint) | dim_param: 2 (string) }
    const inner = readVarint(payload, 0);
    if (payload.length > 0) {
      const innerTag = readVarint(payload, 0);
      if (innerTag.value % 8 === WIRE_VARINT) dims.push(readVarint(payload, innerTag.pos).value);
      else {
        const innerLen = readVarint(payload, innerTag.pos);
        dims.push(new TextDecoder().decode(payload.subarray(innerLen.pos, innerLen.pos + innerLen.value)));
      }
    }
    void inner;
  }
  return dims;
}

function fields(buf: Uint8Array): { no: number; wire: number; payload: Uint8Array }[] {
  const out: { no: number; wire: number; payload: Uint8Array }[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    const no = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    pos = tag.pos;
    if (wire === WIRE_VARINT) {
      const v = readVarint(buf, pos);
      out.push({ no, wire, payload: buf.subarray(pos, v.pos) });
      pos = v.pos;
    } else {
      const len = readVarint(buf, pos);
      pos = len.pos;
      out.push({ no, wire, payload: buf.subarray(pos, pos + len.value) });
      pos += len.value;
    }
  }
  return out;
}

test("rewrites the named input's shape to the given dims (numbers and symbolic strings)", () => {
  const model = fakeModel(fakeGraph("input", [1, 3, 640, 640]));
  const out = withInputShape(model, "input", [1, 3, "height", "width"]);
  const graphField = fields(out).find((f) => f.no === 7);
  if (!graphField) throw new Error("no graph field");
  const inputField = fields(graphField.payload).find((f) => f.no === 11);
  if (!inputField) throw new Error("no input field");
  const info = readValueInfo(inputField.payload);
  expect(info.name).toBe("input");
  expect(info.dims).toEqual([1, 3, "height", "width"]);
});

test("drops the output's declared shape but keeps its name", () => {
  const model = fakeModel(fakeGraph("input", [1, 3, 640, 640]));
  const out = withInputShape(model, "input", [1, 3, "height", "width"]);
  const graphField = fields(out).find((f) => f.no === 7);
  if (!graphField) throw new Error("no graph field");
  const outputField = fields(graphField.payload).find((f) => f.no === 12);
  if (!outputField) throw new Error("no output field");
  const info = readValueInfo(outputField.payload);
  expect(info.name).toBe("out1");
  expect(info.dims).toBeNull();
});

test("drops every value_info entry", () => {
  const model = fakeModel(fakeGraph("input", [1, 3, 640, 640]));
  const out = withInputShape(model, "input", [1, 3, "height", "width"]);
  const graphField = fields(out).find((f) => f.no === 7);
  if (!graphField) throw new Error("no graph field");
  expect(fields(graphField.payload).filter((f) => f.no === 13)).toEqual([]);
});

test("copies every other field byte-for-byte (the graph's trailing marker, and the model's own top-level field)", () => {
  const model = fakeModel(fakeGraph("input", [1, 3, 640, 640]));
  const out = withInputShape(model, "input", [1, 3, "height", "width"]);
  const topFields = fields(out);
  expect(topFields.find((f) => f.no === 1)?.payload).toEqual(Uint8Array.from(varint(7)));
  const graphField = topFields.find((f) => f.no === 7);
  if (!graphField) throw new Error("no graph field");
  const marker = fields(graphField.payload).find((f) => f.no === 20);
  expect(marker?.payload).toEqual(Uint8Array.from(varint(42)));
});

test("throws when the named input is not found", () => {
  const model = fakeModel(fakeGraph("input", [1, 3, 640, 640]));
  expect(() => withInputShape(model, "nope", [1, 3, "height", "width"])).toThrow();
});
