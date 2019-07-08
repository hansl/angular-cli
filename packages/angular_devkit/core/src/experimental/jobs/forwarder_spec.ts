/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
// tslint:disable:no-big-function no-non-null-assertion no-any
import { Observable } from "rxjs";
import { toArray } from "rxjs/operators";
import { JobDescription } from "./api";
import { createJobHandler } from './create-job-handler';
import {
  JobForwarderStub,
  createForwardedJob,
  createForwardingJob,
} from "./forwarder";
import { SimpleJobRegistry } from './simple-registry';
import { SimpleScheduler } from "./simple-scheduler";

describe('createForwardingJob', () => {
  let registry: SimpleJobRegistry;
  let scheduler: SimpleScheduler;

  beforeEach(() => {
    registry = new SimpleJobRegistry();
    scheduler = new SimpleScheduler(registry);
  });

  it('works', async () => {
    const job = createJobHandler((arg: number[]) => arg.reduce((a, c) => a + c, 0));

    const stub: JobForwarderStub = bus => createForwardedJob(bus, job);
    registry.register('add', createForwardingJob(stub), {
        argument: { items: { type: 'number' } },
        output: { type: 'number' },
      },
    );

    const run1 = await scheduler.schedule('add', [1, 2, 3]);
    const output = await run1.output.toPromise();
    run1.stop();
    await run1.outboundBus.toPromise();

    expect(output).toBe(6);
  });

  it('works with delayed output', async () => {
    const job = createJobHandler((arg: number[]) => {
      return new Promise<number>(r => r(arg.reduce((a, c) => a + c, 0)));
    });
    const stub: JobForwarderStub = bus => createForwardedJob(bus, job);
    registry.register('add', createForwardingJob(stub), {
        argument: { items: { type: 'number' } },
        output: { type: 'number' },
      },
    );

    const run1 = await scheduler.schedule('add', [1, 2, 3]);
    const output = await run1.output.toPromise();
    run1.stop();
    await run1.outboundBus.toPromise();

    expect(output).toBe(6);
  });

  it('works with multiple outputs', async () => {
    const job = createJobHandler((arg: number[]) => {
      return new Observable<number>(o => {
        let p = Promise.resolve();
        let n = arg.shift();
        while (n !== undefined) {
          const x = n;
          p = p.then(() => o.next(x))
               .then(() => new Promise(r => setTimeout(r, 10)));
          n = arg.shift();
        }
        // tslint:disable-next-line:no-floating-promises
        p.then(() => o.next(0)).then(() => o.complete());
      });
    });

    const stub: JobForwarderStub = bus => createForwardedJob(bus, job);
    registry.register('count', createForwardingJob(stub), {
        argument: { items: { type: 'number' } },
        output: { type: 'number' },
      },
    );

    const run1 = await scheduler.schedule<number[], null, number>('count', [1, 2, 3]);
    const outputs1: number[] = await run1.output.pipe(toArray()).toPromise();
    run1.stop();
    await run1.outboundBus.toPromise();

    expect(outputs1).toEqual([1, 2, 3, 0]);
  });

  it('works with multiple jobs', async () => {
    const job = createJobHandler((arg: number[]) => {
      return new Promise<number>(r => r(arg.reduce((a, c) => a + c, 0)));
    });

    const stub: JobForwarderStub = bus => createForwardedJob(bus, job);
    registry.register('add', createForwardingJob(stub), {
        argument: { items: { type: 'number' } },
        output: { type: 'number' },
      },
    );

    const run1 = await scheduler.schedule('add', [1, 2, 3]);
    const run2 = await scheduler.schedule('add', [4, 5, 6]);
    const [output1, output2] = await Promise.all([
      run1.output.toPromise(),
      run2.output.toPromise(),
    ]);
    run1.stop();
    run2.stop();
    await Promise.all([
      run1.outboundBus.toPromise(),
      run2.outboundBus.toPromise(),
    ]);

    expect(output1).toBe(6);
    expect(output2).toBe(15);
  });

  it('supports inputs', async () => {
    const job = createJobHandler<null, number, number>((arg, context) => {
      return new Observable<number>(o => {
        return context.input.subscribe(i => {
          if (i === 0) {
            o.complete();
          } else {
            o.next(i + 1);
          }
        });
      });
    });
    const stub: JobForwarderStub = bus => createForwardedJob(bus, job);
    registry.register('inc', createForwardingJob(stub), {
        output: { type: 'number' },
        input: { type: 'number' },
      },
    );

    const outputs: number[] = [];
    const run = await scheduler.schedule('inc', [1, 2, 3]);
    run.output.subscribe((x: number) => {
      outputs.push(x);
    });
    run.input.next(1);
    run.input.next(10);
    run.input.next(100);
    run.input.next(1000);
    run.input.next(0);

    run.stop();
    await run.outboundBus.toPromise();

    expect(outputs).toEqual([2, 11, 101, 1001]);
  });

  it('can get description', async () => {
    let desc: JobDescription | null | undefined = undefined;
    const goldenDesc = {
      input: true,
      channels: {},
      argument: { items: { type: 'number' } },
      output: { type: 'number' },
    };

    const add = createJobHandler((arg: number[]) => arg.reduce((a, c) => a + c, 0));
    const info = createJobHandler<string, null, null>(async (arg, context) => {
      desc = await context.scheduler.getDescription(arg).toPromise();

      return null;
    });

    registry.register('add', createForwardingJob(bus => createForwardedJob(bus, add)), goldenDesc);
    registry.register('info', createForwardingJob(bus => createForwardedJob(bus, info)));

    const run1 = await scheduler.schedule('info', 'add');
    run1.stop();
    await run1.outboundBus.toPromise();

    if (desc) {
      expect(desc).toEqual({ name: 'add', ...goldenDesc });
    }

    desc = undefined;
    const run2 = await scheduler.schedule('info', 'non-existent');
    run2.stop();
    await run2.outboundBus.toPromise();

    expect(desc).toBe(null !);
  });
});
