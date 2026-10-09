// A three-like package (T-040 fixture): a class whose identity matters (`instanceof`).
export const VERSION = '1.0.0';
export class Scene {
  constructor() {
    this.version = VERSION;
  }
}
