/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

/**
 * Just a generic Class type.
 */
export interface Class<T = any> {  // tslint:disable-line:no-any
  new (...args: any[]): T;  // tslint:disable-line:no-any
}

/**
 * A value that can be used as a key, and is type-safe when using get() in WeakAnnotationMap.
 */
export class AnnotationToken<T> {}

/**
 * A type-safe annotation map. It accepts either classes or tokens.
 */
export class WeakAnnotationMap {
  private _annotationStore = new WeakMap();

  get<C extends Class>(token: C): InstanceType<C> | undefined;
  get<T>(token: AnnotationToken<T>): T | undefined;
  get<T>(token: Class<T> | AnnotationToken<T>): T | undefined {
    if (typeof token !== 'object' && typeof token !== 'function') {
      return undefined;
    }

    return this._annotationStore.get(token as {} as object) as T;
  }

  set<T>(token: AnnotationToken<T>, value: T): void;
  set<K extends Class, T extends InstanceType<K>>(key: K, value: T): void;
  set<K, V>(token: AnnotationToken<V> | Class, value: V) {
    this._annotationStore.set(token, value);
  }

  delete<T>(toke)

  has<T>(token: T): boolean {
    if (typeof token !== 'object' && typeof token !== 'function') {
      return false;
    }

    return this._annotationStore.has(token as {} as object);
  }

  clear() {
    this._annotationStore = new WeakMap();
  }
}
