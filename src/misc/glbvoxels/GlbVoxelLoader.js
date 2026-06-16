import { Box3, Vector3 } from "potree";

const gridSize = 128;
const numVoxels = gridSize ** 3;
const MAX_TRIANGLES_PER_NODE = 100_000;

let tmpCanvas = null;
let tmpContext = null;
function getTmpContext(width, height) {
	if (tmpCanvas === null) {
		tmpCanvas = document.createElement("canvas");
		tmpCanvas.width = width;
		tmpCanvas.height = height;
		tmpContext = tmpCanvas.getContext("2d");
	}

	return tmpContext;
}

function createChildAABB(aabb, index) {
	const min = aabb.min.clone();
	const max = aabb.max.clone();
	const size = max.clone().sub(min);

	if ((index & 0b0001) > 0) {
		min.z += size.z / 2;
	} else {
		max.z -= size.z / 2;
	}

	if ((index & 0b0010) > 0) {
		min.y += size.y / 2;
	} else {
		max.y -= size.y / 2;
	}

	if ((index & 0b0100) > 0) {
		min.x += size.x / 2;
	} else {
		max.x -= size.x / 2;
	}

	return new Box3(min, max);
}

function toVoxelCoord(voxelIndex, out) {
	out.x = voxelIndex % gridSize;
	out.y = Math.floor((voxelIndex % (gridSize * gridSize)) / gridSize);
	out.z = Math.floor(voxelIndex / (gridSize * gridSize));
}

function toVoxelIndex(x, y, z, min, gridSize, cubeSize) {
	const ux = (x - min.x) / cubeSize;
	const uy = (y - min.y) / cubeSize;
	const uz = (z - min.z) / cubeSize;

	const ix = Math.floor(Math.min(gridSize * ux, gridSize - 1));
	const iy = Math.floor(Math.min(gridSize * uy, gridSize - 1));
	const iz = Math.floor(Math.min(gridSize * uz, gridSize - 1));

	const voxelIndex = ix + gridSize * iy + gridSize * gridSize * iz;

	return voxelIndex;
}

class Node {
	constructor(name, boundingBox) {
		const numVoxels = gridSize ** 3;

		this.boundingBox = boundingBox;
		this.children = new Array(8).fill(null);
		this.grid = new Float32Array(4 * numVoxels);
		this.cubeSize = boundingBox.max.x - boundingBox.min.x;
		this.voxels = [];
		this.childTriangleCounters = new Uint32Array(8);
		this.batches = [];
	}

	addPoint(x, y, z, r, g, b) {
		const voxelIndex = toVoxelIndex(
			x,
			y,
			z,
			this.boundingBox.min,
			gridSize,
			this.cubeSize,
		);

		this.grid[4 * voxelIndex + 0] += r;
		this.grid[4 * voxelIndex + 1] += g;
		this.grid[4 * voxelIndex + 2] += b;
		this.grid[4 * voxelIndex + 3] += 1;
	}

	addBatch(batch) {
		const position = batch.geometry.buffers.find(
			(b) => b.name === "position",
		).buffer;
		const uv = batch.geometry.buffers.find((b) => b.name === "uv").buffer;

		const numVertices = position.length / 3;

		const { imageBitmap, imageData } = batch;
		const { width, height } = imageBitmap;

		let child_index_0 = -1;
		let child_index_1 = -1;
		for (let i = 0; i < numVertices; i++) {
			const x = position[3 * i + 0];
			const y = position[3 * i + 1];
			const z = position[3 * i + 2];

			const u = uv[2 * i + 0];
			const v = uv[2 * i + 1];

			const U = Math.floor(u * width);
			const V = Math.floor(v * height);
			const pixelIndex = U + height * V;

			const r = imageData[4 * pixelIndex + 0] / 255;
			const g = imageData[4 * pixelIndex + 1] / 255;
			const b = imageData[4 * pixelIndex + 2] / 255;
			const a = 255;

			this.addPoint(x, y, z, r, g, b);

			// count triangles in child nodes
			const childIndex = toVoxelIndex(
				x,
				y,
				z,
				this.boundingBox.min,
				2,
				this.cubeSize,
			);

			if (i % 3 === 0) {
				this.childTriangleCounters[childIndex]++;
				child_index_0 = childIndex;
			} else if (i % 3 === 1) {
				if (child_index_0 !== childIndex) {
					this.childTriangleCounters[childIndex]++;
				}
				child_index_1 = childIndex;
			} else {
				if (child_index_0 !== childIndex && child_index_1 !== childIndex) {
					this.childTriangleCounters[childIndex]++;
				}
				child_index_0 = -1;
				child_index_1 = -1;
			}
		}

		this.batches.push(batch);
	}

	split() {
		const childBatches = new Array(8).fill(null);

		for (let childIndex = 0; childIndex < 8; childIndex++) {
			const numTriangles = this.childTriangleCounters[childIndex];

			if (numTriangles < MAX_TRIANGLES_PER_NODE) {
				continue;
			}

			// create child node
			const childCube = createChildAABB(this.boundingBox, childIndex);
			const child = new Node(this.name + childIndex, childCube);
			this.children[childIndex] = child;

			// create batch from triangles in child node boundary
			const childPositions = new Float32Array(3 * numTriangles);
			const childUvs = new Float32Array(2 * numTriangles);

			const geometry = {
				buffers: [
					{ name: "position", buffer: childPositions },
					{ name: "uv", buffer: childUvs },
				],
				buffersByName: {
					position: childPositions,
					uv: childUvs,
				},
				numElements: 3 * numTriangles,
				boundingBox: childCube,
			};

			// HACK
			const { imageBitmap, imageData } = this.batches[0];

			const childBatch = {
				numProcessed: 0,
				geometry,
				imageBitmap,
				imageData,
			};

			childBatches[childIndex] = childBatch;
		}

		const addToChildBatch = (
			batch_position,
			batch_uv,
			childBatchIndex,
			triangleIndex,
		) => {
			const childBatch = childBatches[childBatchIndex];

			const sourcePos = batch_position;
			const sourceUV = batch_uv;
			const targetPos = childBatch.geometry.buffersByName.position;
			const targetUV = childBatch.geometry.buffersByName.uv;

			const sourceIndex = triangleIndex;
			const targetIndex = childBatch.numProcessed;

			targetPos.buffer[9 * targetIndex + 0] = sourcePos[9 * sourceIndex + 0];
			targetPos.buffer[9 * targetIndex + 1] = sourcePos[9 * sourceIndex + 1];
			targetPos.buffer[9 * targetIndex + 2] = sourcePos[9 * sourceIndex + 2];
			targetPos.buffer[9 * targetIndex + 3] = sourcePos[9 * sourceIndex + 3];
			targetPos.buffer[9 * targetIndex + 4] = sourcePos[9 * sourceIndex + 4];
			targetPos.buffer[9 * targetIndex + 5] = sourcePos[9 * sourceIndex + 5];
			targetPos.buffer[9 * targetIndex + 6] = sourcePos[9 * sourceIndex + 6];
			targetPos.buffer[9 * targetIndex + 7] = sourcePos[9 * sourceIndex + 7];
			targetPos.buffer[9 * targetIndex + 8] = sourcePos[9 * sourceIndex + 8];

			targetUV.buffer[6 * targetIndex + 0] = sourceUV[6 * sourceIndex + 0];
			targetUV.buffer[6 * targetIndex + 1] = sourceUV[6 * sourceIndex + 1];
			targetUV.buffer[6 * targetIndex + 2] = sourceUV[6 * sourceIndex + 2];
			targetUV.buffer[6 * targetIndex + 3] = sourceUV[6 * sourceIndex + 3];
			targetUV.buffer[6 * targetIndex + 4] = sourceUV[6 * sourceIndex + 4];
			targetUV.buffer[6 * targetIndex + 5] = sourceUV[6 * sourceIndex + 5];

			childBatch.numProcessed++;
		};

		for (const batch of this.batches) {
			const position = batch.geometry.buffers.find(
				(b) => b.name === "position",
			).buffer;
			const uv = batch.geometry.buffers.find((b) => b.name === "uv").buffer;
			const numVertices = position.length / 3;

			let child_index_0 = -1;
			let child_index_1 = -1;
			for (let i = 0; i < numVertices; i++) {
				const x = position[3 * i + 0];
				const y = position[3 * i + 1];
				const z = position[3 * i + 2];

				const childIndex = toVoxelIndex(
					x,
					y,
					z,
					this.boundingBox.min,
					2,
					this.cubeSize,
				);
				const triangleIndex = Math.floor(i / 3);

				if (!childBatches[childIndex]) {
					continue;
				}

				if (i % 3 === 0) {
					addToChildBatch(position, uv, childIndex, triangleIndex);

					child_index_0 = childIndex;
				} else if (i % 3 === 1) {
					if (child_index_0 !== childIndex) {
						addToChildBatch(position, uv, childIndex, triangleIndex);
					}

					child_index_1 = childIndex;
				} else {
					if (child_index_0 !== childIndex && child_index_1 !== childIndex) {
						addToChildBatch(position, uv, childIndex, triangleIndex);
					}

					child_index_0 = -1;
					child_index_1 = -1;
				}
			}
		}
	}

	finalize() {
		const cube = this.boundingBox;
		const cubeSize = cube.size().x;
		const voxelSize = cubeSize / gridSize;

		const voxelCoord = new Vector3();

		for (let voxelIndex = 0; voxelIndex < numVoxels; voxelIndex++) {
			const a = this.grid[4 * voxelIndex + 3];
			const r = (255 * this.grid[4 * voxelIndex + 0]) / a;
			const g = (255 * this.grid[4 * voxelIndex + 1]) / a;
			const b = (255 * this.grid[4 * voxelIndex + 2]) / a;

			if (a > 0) {
				toVoxelCoord(voxelIndex, voxelCoord);
				const position = new Vector3(
					cubeSize * (voxelCoord.x / gridSize) + cube.min.x,
					cubeSize * (voxelCoord.y / gridSize) + cube.min.y,
					cubeSize * (voxelCoord.z / gridSize) + cube.min.z,
				);
				const color = new Vector3(r, g, b);
				const size = new Vector3(voxelSize, voxelSize, voxelSize);

				this.voxels.push({
					voxelIndex,
					voxelCoord,
					position,
					color,
					size,
				});
			}
		}
	}
}

class VoxelBuilder {
	constructor() {}

	static build(batches) {
		const boundingBox = new Box3();

		for (const batch of batches) {
			boundingBox.expandByBox(batch.geometry.boundingBox);
		}

		// potree.onUpdate(() => {
		// 	potree.renderer.drawBoundingBox(
		// 		boundingBox.center(),
		// 		boundingBox.size(),
		// 		new Vector3(255, 255, 0),
		// 	);
		// });

		const cube = boundingBox.cube();

		const root = new Node("r", cube);

		for (const batch of batches) {
			root.addBatch(batch);
		}

		root.split();
		root.finalize();

		console.log(root);

		potree.onUpdate(() => {
			for (const voxel of root.voxels) {
				potree.renderer.drawBox(voxel.position, voxel.size, voxel.color);
			}
		});

		potree.onUpdate(() => {
			for (let i = 0; i < 8; i++) {
				const child = root.children[i];

				if (child === null) {
					continue;
				}

				const color = new Vector3((255 * i) / 8, 0, 0);

				potree.renderer.drawBoundingBox(
					child.boundingBox.center(),
					child.boundingBox.size(),
					color,
				);
			}
		});

		// console.log(voxels.length);
		// console.log(boundingBox);
	}
}

export class GlbVoxelLoader {
	constructor() {}

	static load(url, callback) {
		console.log("abc", url);

		const workerPath = new URL("../GLBLoaderWorker.js", import.meta.url).href;
		const worker = new Worker(workerPath, { type: "module" });

		const batches = [];
		const images = new Map();

		const image_loaded = (e) => {
			const imageBitmap = e.data.imageBitmap;
			const context = getTmpContext(imageBitmap.width, imageBitmap.height);
			context.drawImage(imageBitmap, 0, 0);
			const imageData = context.getImageData(
				0,
				0,
				imageBitmap.width,
				imageBitmap.height,
			).data;

			// images.set(e.data.imageRef, e.data.imageBitmap);

			images.set(e.data.imageRef, { imageBitmap, imageData });
		};

		const mesh_batch_loaded = (e) => {
			const { imageBitmap, imageData } = images.get(e.data.imageRef);

			batches.push({
				geometry: e.data.geometry,
				// image: images.get(e.data.imageRef),
				imageBitmap,
				imageData,
			});
		};

		const onLoaded = (e) => {
			VoxelBuilder.build(batches);
		};

		worker.onmessage = (e) => {
			if (e.data.type === "mesh_batch_loaded") {
				mesh_batch_loaded(e);
			} else if (e.data.type === "image_loaded") {
				image_loaded(e);
			} else if (e.data.type === "finished") {
				onLoaded(e);
			}
		};

		const absoluteUrl = new URL(url, document.baseURI).href;
		worker.postMessage({ url: absoluteUrl });
	}
}
