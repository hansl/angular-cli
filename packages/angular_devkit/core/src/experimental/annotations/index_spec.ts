/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { AnnotationToken, WeakAnnotationMap } from "./index";

describe('WeakAnnotationMap', () => {
  it('works', () => {
    const map = new WeakAnnotationMap();

    class SomeClass {}
    const instance = new SomeClass();

    map.set(SomeClass, instance);

    expect(map.get(SomeClass)).toBe(instance);
  });

  it('works with tokens', () => {
    const map  =new WeakAnnotationMap();

    const token = new AnnotationToken<string>();
    map.set(token, 'value');

    expect(map.get(token)).toBe('value');
  });
});
