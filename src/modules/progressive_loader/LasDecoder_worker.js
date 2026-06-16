import { Vector3 } from "potree";
import { Geometry } from "potree";

// from https://stackoverflow.com/questions/2450954/how-to-randomize-shuffle-a-javascript-array
function shuffle(array) {
	var currentIndex = array.length,
		temporaryValue,
		randomIndex;

	// While there remain elements to shuffle...
	while (0 !== currentIndex) {
		// Pick a remaining element...
		randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex -= 1;

		// And swap it with the current element.
		temporaryValue = array[currentIndex];
		array[currentIndex] = array[randomIndex];
		array[randomIndex] = temporaryValue;
	}

	return array;
}

function parsePoints(args) {
	const { buffer, header, batchsize } = args;
	const { pointFormat, recordLength, min, max, scale } = header;

	const view = new DataView(buffer);

	const offsetRGB = {
		0: 0,
		1: 0,
		2: 20,
		3: 28,
		4: 0,
		5: 28,
		6: 0,
		7: 0,
	}[pointFormat];

	const geometry = new Geometry();
	geometry.numElements = batchsize;
	const position = new Float32Array(3 * batchsize);
	const color = new Uint8Array(4 * batchsize);
	for (let i = 0; i < batchsize; i++) {
		const pointOffset = i * recordLength;
		const X = view.getInt32(pointOffset + 0, true);
		const Y = view.getInt32(pointOffset + 4, true);
		const Z = view.getInt32(pointOffset + 8, true);

		const x = X * scale.x + header.offset.x;
		const y = Y * scale.y + header.offset.y;
		const z = Z * scale.z + header.offset.z;

		position[3 * i + 0] = x;
		position[3 * i + 1] = y;
		position[3 * i + 2] = z;

		color[4 * i + 0] = view.getUint16(pointOffset + offsetRGB + 0);
		color[4 * i + 1] = view.getUint16(pointOffset + offsetRGB + 2);
		color[4 * i + 2] = view.getUint16(pointOffset + offsetRGB + 4);
		color[4 * i + 3] = 255;
	}

	const message = {
		numPoints: batchsize,
		buffers: {
			position: position,
			color: color,
		},
		min,
		max,
	};

	const transferables = [];
	for (const property in message.buffers) {
		const buffer = message.buffers[property];

		if (buffer instanceof ArrayBuffer) {
			transferables.push(buffer);
		} else {
			transferables.push(buffer.buffer);
		}
	}

	postMessage(message, transferables);
}

async function readHeader(file) {
	const buffer = await file.slice(0, 375).arrayBuffer();

	const view = new DataView(buffer);
	const versionMajor = view.getUint8(24);
	const versionMinor = view.getUint8(25);

	let numPoints = view.getUint32(107, true);
	if (versionMajor >= 1 && versionMinor >= 4) {
		numPoints = Number(view.getBigInt64(247, true));
	}

	const offsetToPointData = view.getUint32(96, true);
	const recordLength = view.getUint16(105, true);
	const pointFormat = view.getUint8(104);

	const scale = new Vector3(
		view.getFloat64(131, true),
		view.getFloat64(139, true),
		view.getFloat64(147, true),
	);

	const offset = new Vector3(
		view.getFloat64(155, true),
		view.getFloat64(163, true),
		view.getFloat64(171, true),
	);

	const min = new Vector3(
		view.getFloat64(187, true),
		view.getFloat64(203, true),
		view.getFloat64(219, true),
	);

	const max = new Vector3(
		view.getFloat64(179, true),
		view.getFloat64(195, true),
		view.getFloat64(211, true),
	);

	const header = {
		versionMajor,
		versionMinor,
		numPoints,
		pointFormat,
		recordLength,
		offsetToPointData,
		min,
		max,
		scale,
		offset,
	};

	return header;
}

async function loadLAS(file, header, octree_min) {
	// break work down into batches
	const batchSize = 1_000_000;
	const batches = [];
	for (let i = 0; i < header.numPoints; i += batchSize) {
		const batch = {
			start: i,
			count: Math.min(header.numPoints - i, batchSize),
		};

		batches.push(batch);
	}

	// process batches
	for (const batch of batches) {
		const absolute_i = batch.start;

		const start = header.offsetToPointData + absolute_i * header.recordLength;
		const end =
			header.offsetToPointData +
			(absolute_i + batch.count) * header.recordLength;
		const buffer = await file.slice(start, end).arrayBuffer();

		parsePoints({
			buffer,
			header,
			batchsize: batch.count,
		});
	}
}

async function loadLAZ(file, header, octree_min) {
	const arraybuffer = await file.arrayBuffer();

	const { Module } = await import("../../../libs/laz-perf/laz-perf.js");

	// OPEN
	const instance = new Module.LASZip();
	var buf = Module._malloc(arraybuffer.byteLength);

	instance.arraybuffer = arraybuffer;
	instance.buf = buf;
	Module.HEAPU8.set(new Uint8Array(arraybuffer), buf);

	instance.open(buf, arraybuffer.byteLength);
	instance.readOffset = 0;

	console.log("opened!");

	const numExtraBytes =
		header.recordLength -
		{
			0: 20,
			1: 28,
			2: 26,
			3: 34,
			4: 57,
			5: 63,
			6: 30,
			7: 36,
		}[header.pointFormat];

	// HANDLE HEADER
	const laszipHeader = {
		pointsOffset: header.offsetToPointData,
		pointsFormatId: header.pointFormat & 0b111_111,
		pointsStructSize: header.recordLength,
		extraBytes: numExtraBytes,
		pointsCount: header.numPoints,
		scale: new Float64Array(...header.scale.toArray()),
		offset: new Float64Array(...header.offset.toArray()),
		maxs: header.max.toArray(),
		mins: header.min.toArray(),
	};
	const h = laszipHeader;
	instance.header = laszipHeader;

	console.log("headered!");

	// READ
	header.pointFormat = header.pointFormat & 0b111_111;
	const buf_read = Module._malloc(h.pointsStructSize);
	let pointsRead = 0;

	let pointsLeft = h.pointsCount;
	const maxBatchSize = 100_000;

	while (pointsLeft > 0) {
		const batchsize = Math.min(pointsLeft, maxBatchSize);
		const target = new ArrayBuffer(batchsize * h.pointsStructSize);
		const target_u8 = new Uint8Array(target);

		for (let i = 0; i < batchsize; i++) {
			instance.getPoint(buf_read);

			const a = new Uint8Array(
				Module.HEAPU8.buffer,
				buf_read,
				h.pointsStructSize,
			);

			target_u8.set(a, i * h.pointsStructSize, h.pointsStructSize);

			pointsRead++;
			pointsLeft--;
		}

		parsePoints({
			header,
			batchsize,
			buffer: target,
		});
	}

	Module._free(buf_read);

	// CLOSE

	Module._free(instance.buf);
	instance.delete();
}

onmessage = async (e) => {
	const { file } = e.data;

	const header = await readHeader(file);

	const compressed = (header.pointFormat & 0b11000000) > 0;

	if (compressed) {
		loadLAZ(file, header);
	} else {
		loadLAS(file, header);
	}
};
