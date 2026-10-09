// Like three/examples/jsm/*: a subpath that imports its own package by name.
import { Scene } from 'br-fixture-three';
export class Controls {
  constructor(scene) {
    this.ok = scene instanceof Scene;
    this.scene = scene;
  }
  target() {
    return this.scene;
  }
}
