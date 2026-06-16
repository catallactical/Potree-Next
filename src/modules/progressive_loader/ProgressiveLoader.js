import { Vector3, Box3 } from "potree";
import { Geometry, SceneNode, Points } from "potree";
import { WorkerPool } from "potree";

const root = new SceneNode("progressive_root");

const progress = {
	header: null,
	nodes: [],
};

const workerPath = new URL("./LasDecoder_worker.js", import.meta.url).href;
const workers = [
	WorkerPool.getWorker(workerPath, { type: "module" }),
	WorkerPool.getWorker(workerPath, { type: "module" }),
	WorkerPool.getWorker(workerPath, { type: "module" }),
	WorkerPool.getWorker(workerPath, { type: "module" }),
	// WorkerPool.getWorker(workerPath, {type: "module"}),
	// WorkerPool.getWorker(workerPath, {type: "module"}),
];

async function loadHeader(file) {
	if (workers.length == 0) {
		setTimeout(loadHeader, 1, file);

		return;
	}

	const worker = workers.pop();

	worker.onmessage = (e) => {
		const { buffers, numPoints, header, min, max } = e.data;

		const geometry = new Geometry();
		geometry.numElements = numPoints;

		geometry.buffers.push({
			name: "position",
			buffer: buffers.position,
		});

		geometry.buffers.push({
			name: "rgba",
			buffer: buffers.color,
		});

		const node = new Points();
		node.geometry = geometry;

		root.children.push(node);

		console.log("node loaded");

		workers.push(worker);

		console.log("time: ", performance.now());
	};

	worker.postMessage({ file });
}

function load(file) {
	setTimeout(loadHeader, 1, file);
}

function install(element, args = {}) {
	element.addEventListener("dragover", (e) => {
		e.stopPropagation();
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
	});

	element.addEventListener("drop", async (e) => {
		e.stopPropagation();
		e.preventDefault();

		const files = e.dataTransfer.files;

		console.log("start: ", performance.now());

		const promises = [];
		for (const file of files) {
			const blob = file.slice(0, 227);
			const promise = blob.arrayBuffer();

			promises.push(promise);

			// load(file);
		}

		const buffers = await Promise.all(promises);

		const full_aabb = new Box3();

		const boxes = [];
		for (const buffer of buffers) {
			const view = new DataView(buffer);

			const min = new Vector3();
			min.x = view.getFloat64(187, true);
			min.y = view.getFloat64(203, true);
			min.z = view.getFloat64(219, true);

			const max = new Vector3();
			max.x = view.getFloat64(179, true);
			max.y = view.getFloat64(195, true);
			max.z = view.getFloat64(211, true);

			const box = new Box3(min, max);
			boxes.push(box);

			full_aabb.expandByPoint(min);
			full_aabb.expandByPoint(max);
		}

		progress.boundingBox = full_aabb;

		for (const file of files) {
			load(file);
		}

		// load(files.item(0));
		// load(files.item(1));
		// load(files.item(2));

		if (args.onProgress) {
			args.onProgress({ boxes, progress });
		}
	});

	if (args.onSetup) {
		args.onSetup(root);
	}
}

export { load, install };
