import {Potree} from "./Potree.js";
import {PotreeLoader} from "./potree/octree/loader/PotreeLoader.js";
import {installSidebar} from "./modules/sidebar/sidebar.js";

/**
 * High-level viewer facade for embedding Potree Next into any web application.
 *
 * @example
 * const viewer = await PotreeViewer.create(canvas, { hqs: true, edl: true });
 * const cloud  = await viewer.load("/path/to/metadata.json");
 *
 * // Optional controls sidebar
 * await viewer.installSidebar(containerEl);
 */
export class PotreeViewer {

	#potree = null;
	#canvas = null;

	constructor(potree, canvas) {
		this.#potree = potree;
		this.#canvas = canvas;
	}

	/**
	 * Create and initialise a PotreeViewer on the given canvas element.
	 *
	 * @param {HTMLCanvasElement} canvas
	 * @param {object}  [options]
	 * @param {boolean} [options.hqs=true]             High-quality splat rendering
	 * @param {boolean} [options.edl=true]             Eye-dome lighting
	 * @param {number}  [options.pointBudget=2_000_000]
	 * @param {number}  [options.pointSize=1]
	 * @returns {Promise<PotreeViewer>}
	 */
	static async create(canvas, options = {}) {
		const {
			hqs         = true,
			edl         = true,
			pointBudget = 2_000_000,
			pointSize   = 1,
		} = options;

		// Upstream modules reference `Potree` as a browser global rather than
		// importing it (e.g. panel_scene.js uses Potree.instance). Expose it so
		// those references resolve without requiring consumers to do so.
		window.Potree = Potree;

		const potree = await Potree.init(canvas);

		Potree.settings.hqsEnabled  = hqs;
		Potree.settings.edlEnabled  = edl;
		Potree.settings.pointBudget = pointBudget;
		Potree.settings.pointSize   = pointSize;

		return new PotreeViewer(potree, canvas);
	}

	/**
	 * Load a point cloud from a Potree metadata URL and zoom the camera to it.
	 *
	 * @param {string} url  Path to metadata.json
	 * @returns {Promise<PointCloudOctree>}
	 */
	async load(url) {
		const pc = await PotreeLoader.load(url);
		this.#potree.scene.root.children.push(pc);
		this.#potree.controls.zoomTo(pc);
		return pc;
	}

	/**
	 * Install the Potree Next controls sidebar into a container element.
	 * The container is turned into a CSS grid with the sidebar beside the
	 * canvas cell.  Must be called before load() so sidebar panels can
	 * subscribe to the pointcloud_loaded event.
	 *
	 * @param {HTMLElement} containerEl
	 * @returns {Promise<object>} sidebar handle
	 */
	async installSidebar(containerEl) {
		return installSidebar(containerEl, this.#potree);
	}

	// ── Accessors ──────────────────────────────────────────────────────────

	get controls() { return this.#potree.controls; }
	get camera()   { return this.#potree.camera;   }
	get scene()    { return this.#potree.scene;     }
	get settings() { return Potree.settings;        }

	/**
	 * No-op placeholder — Potree Next does not yet expose a way to stop the
	 * internal render loop cleanly.  Override when implementing teardown.
	 */
	dispose() {}

}
