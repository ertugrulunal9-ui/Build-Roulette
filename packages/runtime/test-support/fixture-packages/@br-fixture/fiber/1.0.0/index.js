// A fiber-like package (T-040 fixture): three is a peer, one of its subpaths is imported
// too, and it has a dependency of its own that is not in the manifest.
import { Scene, VERSION } from 'br-fixture-three';
import { Controls } from 'br-fixture-three/examples/controls.js';
import { label } from '@br-fixture/util';
export function createScene() {
  return new Scene();
}
export function createControls(scene) {
  return new Controls(scene);
}
export const threeVersion = VERSION;
export const utilLabel = label('fiber');
