import { Vector3, Matrix4 } from "potree";
import { Timer } from "potree";
import { generate as generatePipeline } from "./octree/pipelineGenerator.js";
import { Gradients } from "potree";

class Allocation {
	constructor(offset, size) {
		this.offset = offset;
		this.size = size;
	}
}

class VboManager {
	constructor(device, capacity) {
		this.device = device;
		this.allocations = new Map();
		this.size = 0;
		this.vbo = device.createBuffer({
			size: capacity,
			usage:
				GPUBufferUsage.VERTEX |
				GPUBufferUsage.INDEX |
				GPUBufferUsage.COPY_DST |
				GPUBufferUsage.STORAGE,
			mappedAtCreation: false,
		});
	}

	getBuffer(typedArray) {
		let allocation = this.allocations.get(typedArray);

		if (!allocation) {
			const offset = this.size;
			const size = typedArray.byteLength;
			this.size = this.size + size;

			allocation = new Allocation(offset, size);

			this.device.queue.writeBuffer(
				this.vbo,
				offset,
				typedArray.buffer,
				0,
				typedArray.byteLength,
			);

			this.allocations.set(typedArray, allocation);
		}

		return allocation;
	}
}

const octreeStates = new Map();
let gradientTexture = null;
let gradientSampler = null;
let initialized = false;
let vboManager = null;

function init(renderer) {
	if (initialized) {
		return;
	}

	const SPECTRAL = Gradients.SPECTRAL;
	gradientTexture = renderer.createTextureFromArray(
		SPECTRAL.steps.flat(),
		SPECTRAL.steps.length,
		1,
	);

	gradientSampler = renderer.device.createSampler({
		magFilter: "linear",
		minFilter: "linear",
		mipmapFilter: "linear",
		addressModeU: "repeat",
		addressModeV: "repeat",
		maxAnisotropy: 1,
	});

	vboManager = new VboManager(renderer.device, 400_000_000);

	initialized = true;
}

function getOctreeState(renderer, octree, attributeName, flags = []) {
	const { device } = renderer;

	const attributes = octree.loader.attributes.attributes;
	const attribute = attributes.find((a) => a.name === attributeName);

	const mapping = attributeName === "rgba" ? "rgba" : "scalar";

	const key = `${attribute.name}_${attribute.numElements}_${attribute.type.name}_${mapping}_${flags.join("_")}`;

	let state = octreeStates.get(key);

	if (!state) {
		const pipeline = generatePipeline(renderer, { attribute, mapping, flags });

		const uniformBuffer = device.createBuffer({
			size: 256,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		const uniformBindGroup = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
		});

		const miscBindGroup = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(1),
			entries: [
				{ binding: 0, resource: gradientSampler },
				{ binding: 1, resource: gradientTexture.createView() },
			],
		});

		state = { pipeline, uniformBuffer, uniformBindGroup, miscBindGroup };

		octreeStates.set(key, state);
	}

	return state;
}

function updateUniforms(octree, octreeState, drawstate, flags) {
	const { uniformBuffer } = octreeState;
	const { renderer, camera } = drawstate;
	const isHqsDepth = flags.includes("hqs-depth");

	const data = new ArrayBuffer(256);
	const f32 = new Float32Array(data);
	const view = new DataView(data);

	const world = octree.world;
	const camView = camera.view;
	const worldView = new Matrix4().multiplyMatrices(camView, world);

	f32.set(worldView.elements, 0);
	f32.set(camera.proj.elements, 16);

	const size = renderer.getSize();

	view.setFloat32(128, size.width, true);
	view.setFloat32(132, size.height, true);
	view.setUint32(136, isHqsDepth ? 1 : 0, true);

	renderer.device.queue.writeBuffer(uniformBuffer, 0, data, 0, 140);
}

function renderOctree(octree, drawstate, flags) {
	const { renderer, camera, pass } = drawstate;

	const attributeName = Potree.settings.attribute;

	const octreeState = getOctreeState(renderer, octree, attributeName, flags);

	updateUniforms(octree, octreeState, drawstate, flags);

	const { pipeline, uniformBindGroup, miscBindGroup } = octreeState;

	pass.passEncoder.setPipeline(pipeline);
	pass.passEncoder.setBindGroup(0, uniformBindGroup);
	pass.passEncoder.setBindGroup(1, miscBindGroup);

	const nodes = octree.visibleNodes;
	let i = 0;
	for (const node of nodes) {
		const allocPosition = vboManager.getBuffer(
			node.geometry.buffers.find((s) => s.name === "position").buffer,
		);
		const allocAttribute = vboManager.getBuffer(
			node.geometry.buffers.find((s) => s.name === attributeName).buffer,
		);

		pass.passEncoder.setVertexBuffer(
			0,
			vboManager.vbo,
			allocPosition.offset,
			allocPosition.size,
		);
		pass.passEncoder.setVertexBuffer(
			1,
			vboManager.vbo,
			allocAttribute.offset,
			allocAttribute.size,
		);

		if (octree.showBoundingBox === true) {
			const box = node.boundingBox.clone().applyMatrix4(octree.world);
			const position = box.min.clone();
			position.add(box.max).multiplyScalar(0.5);
			// position.applyMatrix4(octree.world);
			const size = box.size();
			// let color = new Vector3(...SPECTRAL.get(node.level / 5));
			const color = new Vector3(255, 255, 0);
			renderer.drawBoundingBox(position, size, color);
		}

		const numElements = node.geometry.numElements;
		pass.passEncoder.draw(numElements, 1, 0, i);

		i++;
	}
}

export function render(octrees, drawstate, flags = []) {
	const { renderer, camera } = drawstate;

	init(renderer);

	Timer.timestamp(drawstate.pass.passEncoder, "octree-start");

	for (const octree of octrees) {
		renderOctree(octree, drawstate, flags);
	}

	Timer.timestamp(drawstate.pass.passEncoder, "octree-end");
}
