/**
 * Rewrites an ONNX model so one graph input has symbolic spatial dimensions.
 *
 * YuNet 2023mar declares its input as [1, 3, 640, 640]. OpenCV's FaceDetectorYN calls
 * net.setInputShape("input", {1, 3, padH, padW}) and runs the net at the padded image size.
 * onnxruntime rejects any input whose static dims differ from the declared ones, so the
 * declared shape has to become [1, 3, "height", "width"]. The graph itself is size-agnostic
 * (Reshape targets are [1, -1, C], the two Resize ops use scales), so nothing else changes.
 *
 * Only the few protobuf fields involved are touched; every other byte is copied verbatim.
 * Field numbers are from onnx/onnx.proto: ModelProto.graph = 7, GraphProto.input = 11,
 * .output = 12, .value_info = 13, ValueInfoProto.name = 1, .type = 2, TypeProto.tensor_type = 1,
 * TypeProto.Tensor.elem_type = 1, .shape = 2, TensorShapeProto.dim = 1,
 * Dimension.dim_value = 1, .dim_param = 2.
 */

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

const MODEL_GRAPH = 7;
const GRAPH_INPUT = 11;
const GRAPH_OUTPUT = 12;
const GRAPH_VALUE_INFO = 13;
const VALUE_INFO_NAME = 1;
const VALUE_INFO_TYPE = 2;
const TYPE_TENSOR = 1;
const TENSOR_ELEM_TYPE = 1;
const TENSOR_SHAPE = 2;
const SHAPE_DIM = 1;
const DIM_VALUE = 1;
const DIM_PARAM = 2;

interface RawField {
  no: number;
  wire: number;
  /** Byte range of the whole field, tag included. */
  start: number;
  end: number;
  /** Byte range of the payload (for LEN fields, without the length prefix). */
  payloadStart: number;
  payloadEnd: number;
}

function readVarint(buf: Uint8Array, pos: number): { value: number; pos: number } {
  let value = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error("onnx: truncated varint");
    const b = buf[pos++];
    value += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) return { value, pos };
    mul *= 128;
  }
  throw new Error("onnx: varint longer than 10 bytes");
}

function* fieldsOf(buf: Uint8Array): Generator<RawField> {
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const no = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    let payloadStart = pos;
    if (wire === WIRE_VARINT) {
      pos = readVarint(buf, pos).pos;
    } else if (wire === WIRE_I64) {
      pos += 8;
    } else if (wire === WIRE_I32) {
      pos += 4;
    } else if (wire === WIRE_LEN) {
      const len = readVarint(buf, pos);
      payloadStart = len.pos;
      pos = len.pos + len.value;
    } else {
      throw new Error(`onnx: unsupported protobuf wire type ${wire}`);
    }
    if (pos > buf.length) throw new Error("onnx: field runs past the end of its message");
    yield { no, wire, start, end: pos, payloadStart, payloadEnd: pos };
  }
}

function firstField(buf: Uint8Array, no: number, wire: number): RawField | undefined {
  for (const f of fieldsOf(buf)) if (f.no === no && f.wire === wire) return f;
  return undefined;
}

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
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
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

function valueInfoName(valueInfo: Uint8Array): string {
  const f = firstField(valueInfo, VALUE_INFO_NAME, WIRE_LEN);
  return f ? new TextDecoder().decode(valueInfo.subarray(f.payloadStart, f.payloadEnd)) : "";
}

function valueInfoElemType(valueInfo: Uint8Array): number {
  const type = firstField(valueInfo, VALUE_INFO_TYPE, WIRE_LEN);
  if (!type) throw new Error("onnx: value info without a type");
  const typeBuf = valueInfo.subarray(type.payloadStart, type.payloadEnd);
  const tensor = firstField(typeBuf, TYPE_TENSOR, WIRE_LEN);
  if (!tensor) throw new Error("onnx: value info is not a tensor");
  const tensorBuf = typeBuf.subarray(tensor.payloadStart, tensor.payloadEnd);
  const elem = firstField(tensorBuf, TENSOR_ELEM_TYPE, WIRE_VARINT);
  if (!elem) throw new Error("onnx: tensor type without elem_type");
  return readVarint(tensorBuf, elem.payloadStart).value;
}

/** ValueInfoProto { name, type { tensor_type { elem_type, shape? } } }; shape omitted when dims is null. */
function encodeValueInfo(name: string, elemType: number, dims: ReadonlyArray<number | string> | null): Uint8Array {
  const tensorParts = [varintField(TENSOR_ELEM_TYPE, elemType)];
  if (dims) {
    const dimMsgs = dims.map((d) =>
      lenField(
        SHAPE_DIM,
        typeof d === "number" ? varintField(DIM_VALUE, d) : lenField(DIM_PARAM, new TextEncoder().encode(d))
      )
    );
    tensorParts.push(lenField(TENSOR_SHAPE, concat(dimMsgs)));
  }
  const type = lenField(TYPE_TENSOR, concat(tensorParts));
  return concat([lenField(VALUE_INFO_NAME, new TextEncoder().encode(name)), lenField(VALUE_INFO_TYPE, type)]);
}

/**
 * Returns a copy of `model` where graph input `inputName` has shape `dims` (numbers are fixed,
 * strings are symbolic). Graph outputs lose their declared shapes and intermediate value_info
 * entries are dropped, because both were recorded for 640x640 and onnxruntime re-infers them.
 */
export function withInputShape(model: Uint8Array, inputName: string, dims: ReadonlyArray<number | string>): Uint8Array {
  let found = false;
  const patchGraph = (graph: Uint8Array): Uint8Array => {
    const parts: Uint8Array[] = [];
    for (const f of fieldsOf(graph)) {
      const payload = graph.subarray(f.payloadStart, f.payloadEnd);
      if (f.wire === WIRE_LEN && f.no === GRAPH_INPUT && valueInfoName(payload) === inputName) {
        found = true;
        parts.push(lenField(GRAPH_INPUT, encodeValueInfo(inputName, valueInfoElemType(payload), dims)));
      } else if (f.wire === WIRE_LEN && f.no === GRAPH_OUTPUT) {
        parts.push(lenField(GRAPH_OUTPUT, encodeValueInfo(valueInfoName(payload), valueInfoElemType(payload), null)));
      } else if (f.wire === WIRE_LEN && f.no === GRAPH_VALUE_INFO) {
        continue;
      } else {
        parts.push(graph.subarray(f.start, f.end));
      }
    }
    return concat(parts);
  };

  const parts: Uint8Array[] = [];
  for (const f of fieldsOf(model)) {
    if (f.wire === WIRE_LEN && f.no === MODEL_GRAPH) {
      parts.push(lenField(MODEL_GRAPH, patchGraph(model.subarray(f.payloadStart, f.payloadEnd))));
    } else {
      parts.push(model.subarray(f.start, f.end));
    }
  }
  if (!found) throw new Error(`onnx: graph input "${inputName}" not found`);
  return concat(parts);
}
