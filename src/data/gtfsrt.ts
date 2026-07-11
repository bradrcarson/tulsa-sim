/**
 * Minimal GTFS-Realtime protobuf decoder — VehiclePosition subset only.
 *
 * The Tulsa Transit feed (tulsa.rideralerts.com) serves a standard
 * `FeedMessage`. Rather than pulling in protobufjs (~70 kB) for three
 * message types, this hand-rolled reader walks the wire format directly.
 * Field numbers follow the GTFS-RT reference:
 * https://gtfs.org/documentation/realtime/reference/
 */

export interface BusPosition {
  id: string;
  label: string;
  routeId: string;
  tripId: string;
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null;
  timestamp: number | null; // epoch seconds
}

class Reader {
  private view: DataView;
  pos = 0;
  constructor(
    private buf: Uint8Array,
    public end = buf.length,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      const b = this.buf[this.pos++];
      result += shift < 28 ? (b & 0x7f) << shift : (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
  }

  float(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Skip a field of the given wire type. */
  skip(wireType: number) {
    switch (wireType) {
      case 0:
        this.varint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2: {
        // NB: must read the varint before touching this.pos — `this.pos +=
        // this.varint()` captures the pre-varint position and desyncs.
        const len = this.varint();
        this.pos += len;
        break;
      }
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wireType}`);
    }
  }

  /** Sub-reader over a length-delimited field. */
  sub(): Reader {
    const len = this.varint();
    const r = new Reader(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return r;
  }

  string(): string {
    const len = this.varint();
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }
}

function readPosition(r: Reader, out: BusPosition) {
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) out.lat = r.float();
    else if (field === 2) out.lon = r.float();
    else if (field === 3) out.bearing = r.float();
    else if (field === 5) out.speed = r.float();
    else r.skip(tag & 7);
  }
}

function readTripDescriptor(r: Reader, out: BusPosition) {
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) out.tripId = r.string();
    else if (field === 5) out.routeId = r.string();
    else r.skip(tag & 7);
  }
}

function readVehicleDescriptor(r: Reader, out: BusPosition) {
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) out.id = r.string();
    else if (field === 2) out.label = r.string();
    else r.skip(tag & 7);
  }
}

function readVehiclePosition(r: Reader): BusPosition {
  const out: BusPosition = {
    id: '',
    label: '',
    routeId: '',
    tripId: '',
    lat: NaN,
    lon: NaN,
    bearing: null,
    speed: null,
    timestamp: null,
  };
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) readTripDescriptor(r.sub(), out);
    else if (field === 2) readPosition(r.sub(), out);
    else if (field === 5) out.timestamp = r.varint();
    else if (field === 8) readVehicleDescriptor(r.sub(), out);
    else r.skip(tag & 7);
  }
  return out;
}

/** Decode a FeedMessage buffer into vehicle positions (invalid entries dropped). */
export function decodeVehiclePositions(buf: ArrayBuffer): BusPosition[] {
  const r = new Reader(new Uint8Array(buf));
  const buses: BusPosition[] = [];
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 2) {
      // FeedEntity
      const entity = r.sub();
      let entityId = '';
      while (!entity.done) {
        const etag = entity.varint();
        const efield = etag >> 3;
        if (efield === 1) entityId = entity.string();
        else if (efield === 4) {
          const bus = readVehiclePosition(entity.sub());
          if (!bus.id) bus.id = entityId;
          if (Number.isFinite(bus.lat) && Number.isFinite(bus.lon)) buses.push(bus);
        } else entity.skip(etag & 7);
      }
    } else {
      r.skip(tag & 7);
    }
  }
  return buses;
}
