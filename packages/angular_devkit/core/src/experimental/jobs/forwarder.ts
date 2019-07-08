/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { Observable, Subject, Subscription, from } from 'rxjs';
import { filter, finalize, first, map, switchMap } from 'rxjs/operators';
import { BaseException } from '../../../src/exception/exception';
import { JsonObject, JsonValue } from '../../../src/json';
import {
  Job,
  JobDescription,
  JobHandler,
  JobHandlerContext,
  JobInboundMessage,
  JobInboundMessageKind,
  JobName,
  JobOutboundMessage, JobOutboundMessageKind,
  ScheduleJobOptions,
  Scheduler
} from './api';


/**
 * The upstream and downstream message bus types. Outside of the handshake these are pretty
 * standard for a Jobs system.
 *
 * The Stream flows down to the actual job handler itself, and up to the scheduler (whichever
 * scheduler it might be). The Parent will always be the Scheduler's "JobHandler" stub, while the
 * Child will be the JobHandler's server.
 *
 * The forwarder is called everytime a job is started, and should create the necessary bus to
 * communicate the messages to the downstream. The downstream client can use createForwardedJob()
 * to handle messages.
 *
 * See the spec files for usage.
 *
 * The handshake is done as follow:
 *     Parent sends `init` to Child;
 *     - Child should load the handler
 *     - Child sends `ready` to Parent;
 *       - Parent should create the Job Handler and start listening for more messages from Child.
 *       - Parent sends `start` to Child with the start argument and description;
 *         - Child starts the handlers.
 *         - Child listens to all events from the Parent.
 *         - Child sends `Started` to Parent.
 *
 * There is an `extra` member in the root objects so the stub/server can tag some information
 * along the messages. These are generic json values and will be `null` by default. They are
 * ignored entirely by the stub/server utility functions.
 */


export class ForwarderDidNotHandshakeException extends BaseException {
  constructor(expected: UpstreamMessageKind, message: UpstreamMessage) {
    super(`Forwarder did not properly handshake. Expected "${expected}", got: "${message.kind}".`);
  }
}


export enum DownstreamMessageKind {
  // Handshake.
  Init = 'init',
  Start = 'start',
  Stop = 'stop',

  // Job messages.
  Inbound = 'in',

  // Scheduling
  Description = 'get-description',
  SubJobOutbound = 'sub-outbound',
  SubJobError = 'sub-error',
  SubJobComplete = 'sub-complete',
}
export interface DownstreamMessageBase extends JsonObject {
  kind: DownstreamMessageKind;
  extra: JsonValue;
}
export interface DownstreamMessageInitial extends DownstreamMessageBase {
  kind: DownstreamMessageKind.Init;
}
export interface DownstreamMessageStop extends DownstreamMessageBase {
  kind: DownstreamMessageKind.Stop;
}
export interface DownstreamMessageStart<
  ArgumentT extends JsonValue,
> extends DownstreamMessageBase {
  kind: DownstreamMessageKind.Start;
  description: JobDescription;
  argument: ArgumentT;
}
export interface DownstreamMessageInbound<
  InputT extends JsonValue,
> extends DownstreamMessageBase {
  kind: DownstreamMessageKind.Inbound;
  message: JobInboundMessage<InputT>;
}
export interface DownstreamMessageDescription extends DownstreamMessageBase {
  kind: DownstreamMessageKind.Description;
  descriptionId: number;
  description: JobDescription | null;
}
export interface DownstreamMessageSubJobOutbound extends DownstreamMessageBase {
  kind: DownstreamMessageKind.SubJobOutbound;
  jobId: number;
  message: JobOutboundMessage<JsonValue>;
}
export interface DownstreamMessageSubJobError extends DownstreamMessageBase {
  kind: DownstreamMessageKind.SubJobError;
  jobId: number;
  error: JsonValue;
}
export interface DownstreamMessageSubJobComplete extends DownstreamMessageBase {
  kind: DownstreamMessageKind.SubJobComplete;
  jobId: number;
}

export type DownstreamMessage<
  A extends JsonValue = JsonValue,
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> =
  DownstreamMessageInitial
  | DownstreamMessageStop
  | DownstreamMessageStart<A>
  | DownstreamMessageInbound<I>
  | DownstreamMessageDescription
  | DownstreamMessageSubJobOutbound
  | DownstreamMessageSubJobError
  | DownstreamMessageSubJobComplete
  ;


export enum UpstreamMessageKind {
  // Handshake.
  Ready = 'ready',
  Started = 'started',

  // Job outputs.
  Outbound = 'out',
  Error = 'error',
  Complete = 'complete',

  // Scheduling.
  GetDescription = 'get-description',
  SubJobInput = 'sub-input',
}
export interface UpstreamMessageBase extends JsonObject {
  kind: UpstreamMessageKind;
  extra: JsonValue;
}
export interface UpstreamMessageReady extends UpstreamMessageBase {
  kind: UpstreamMessageKind.Ready;
}
export interface UpstreamMessageStarted extends UpstreamMessageBase {
  kind: UpstreamMessageKind.Started;
}
export interface UpstreamMessageOutbound<
  OutputT extends JsonValue,
> extends UpstreamMessageBase {
  kind: UpstreamMessageKind.Outbound;
  message: JobOutboundMessage<OutputT>;
}
export interface UpstreamMessageError extends UpstreamMessageBase {
  kind: UpstreamMessageKind.Error;
  error: JsonValue;
}
export interface UpstreamMessageComplete extends UpstreamMessageBase {
  kind: UpstreamMessageKind.Complete;
}
export interface UpstreamMessageGetDescription extends UpstreamMessageBase {
  kind: UpstreamMessageKind.GetDescription;
  descriptionId: number;
  name: JobName;
}
export interface UpstreamMessageSubJobInput extends UpstreamMessageBase {
  kind: UpstreamMessageKind.SubJobInput;
  jobId: number;
  message: JobInboundMessage<JsonValue>;
}

export type UpstreamMessage<
  A extends JsonValue = JsonValue,
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> =
  UpstreamMessageReady
  | UpstreamMessageStarted
  | UpstreamMessageOutbound<O>
  | UpstreamMessageError
  | UpstreamMessageComplete
  | UpstreamMessageGetDescription
  | UpstreamMessageSubJobInput
  ;


export type JobForwarderStub<
  A extends JsonValue = JsonValue,
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> = (
  downstreamBus: Observable<DownstreamMessage<A, I, O>>,
) => Observable<UpstreamMessage<A, I, O>>;


export function createForwardedJob<
  A extends JsonValue = JsonValue,
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
>(
  downstreamBus: Observable<DownstreamMessage<A, I, O>>,
  handler: JobHandler<A, I, O>,
): Observable<UpstreamMessage<A, I, O>> {
  let id = 0;
  const upstreamBus = new Subject<UpstreamMessage<A, I, O>>();

  /**
   * Helps with typings.
   */
  function send(message: Omit<UpstreamMessage<A, I, O>, 'extra'>) {
    upstreamBus.next({ ...message, extra: null } as UpstreamMessage<A, I, O>);
  }
  function next(): Promise<DownstreamMessage<A, I, O>> {
    return downstreamBus.pipe(first()).toPromise();
  }

  async function _handshake(): Promise<void> {
    const initMessage = await next();
    if (initMessage.kind !== DownstreamMessageKind.Init) {
      throw new Error('First message was not "init": ' + JSON.stringify(initMessage));
    }
  }

  function _start(message: DownstreamMessageStart<A>) {
    const inboundBus = new Subject<JobInboundMessage<I>>();
    const scheduler: Scheduler<JsonValue, JsonValue, JsonValue> = {
      getDescription(name: JobName) {
        return new Observable<JobDescription | null>(o => {
          const descriptionId = ++id;

          const result = downstreamBus.pipe(
            filter(msg => {
              return msg.kind === DownstreamMessageKind.Description
                && msg.descriptionId === descriptionId;
            }),
            map(msg => msg.description as JobDescription | null),
            first(),
          ).subscribe(o);

          send({ kind: UpstreamMessageKind.GetDescription, name, descriptionId });

          return result;
        });
      },
      has(name: JobName) {
        return scheduler.getDescription(name).pipe(map(desc => desc !== null));
      },
      pause() { return () => {}; },
      schedule(name: JobName, argument: JsonValue, options?: ScheduleJobOptions) {
        const jobId = ++id;
        const subInboundBus = new Subject<JobInboundMessage<JsonValue>>();
        const subOutboundBus = downstreamBus.pipe(
          filter(msg => msg.kind === DownstreamMessageKind.SubJobOutbound && msg.jobId === jobId),
          map(msg => msg.message),
        ) as Observable<JobOutboundMessage<JsonValue>>;

        const job: Job<JsonValue, JsonValue, JsonValue> = {
          description: new Observable(o => scheduler.getDescription(name).subscribe(o)),
          argument,
          inboundBus: subInboundBus,
          outboundBus: subOutboundBus,
          input: {
            next(value: JsonValue) {
              subInboundBus.next({ kind: JobInboundMessageKind.Input, value });
            },
            error() {},
            complete() {},
          },
          output: subOutboundBus.pipe(
            filter(msg => msg.kind === JobOutboundMessageKind.Output),
            map(msg => msg.value),
          ),
        };

        return job;
      }
    };
    const context: JobHandlerContext<A, I, O> = {
      description: message.description,
      dependencies: [],
      inboundBus: inboundBus.asObservable(),
      scheduler,
    };

    downstreamBus.subscribe(msg => {
      if (msg.kind === DownstreamMessageKind.Inbound) {
        inboundBus.next(msg.message);
      }
    });

    send({ kind: UpstreamMessageKind.Started });

    handler(message.argument, context).subscribe(
      outboundMessage => {
        send({ kind: UpstreamMessageKind.Outbound, message: outboundMessage });
      },
      err => {
        send({ kind: 'error', error: err });
      },
      () => {
        send({ kind: 'complete' });
      },
    );
  }

  async function _loop() {
    downstreamBus.subscribe(message => {
      if (message.kind === DownstreamMessageKind.Start) {
        _start(message);
      }
    });

    // Send ready.
    send({ kind: UpstreamMessageKind.Ready });
    await downstreamBus.pipe(filter(x => x.kind === DownstreamMessageKind.Stop)).toPromise();
  }

  _handshake()
    .then(() => _loop())
    .then(
      () => upstreamBus.complete(),
      err => upstreamBus.error(err),
    );

  return upstreamBus.asObservable();
}


type Omit<T, K extends string> = Pick<T, Exclude<keyof T, K>>;


/**
 * A job handler that forwards messages to a message bus.
 * @param forwarder The forwarder to use.
 * @param options Partial options to fill the job description. Will be forwarded to the job
 *                handler.
 */
export function createForwardingJob<
  A extends JsonValue,
  I extends JsonValue,
  O extends JsonValue,
>(
  forwarder: JobForwarderStub<A, I, O>,
  options: Partial<JobDescription> = {},
): JobHandler<A, I, O> {
  const handler = (argument: A, context: JobHandlerContext<A, I, O>) => {
    // There's only 1 bus. The bus is reused by every forwarder/forwardee.
    const downstreamBus = new Subject<DownstreamMessage<A, I, O>>();
    const upstreamBus = forwarder(downstreamBus);
    let inQueue: DownstreamMessage[] | null = [];
    const subJobs: Job[] = [];

    function send(message: Omit<DownstreamMessage<A, I, O>, 'extra'>) {
      downstreamBus.next({ ...message, extra: null } as DownstreamMessage<A, I, O>);
    }
    function next(): Promise<UpstreamMessage<A, I, O>> {
      return upstreamBus.pipe(first()).toPromise();
    }

    const { description } = context;
    const subscriptions: Subscription[] = [];

    // Hookup the input. This needs to be done as soon as possible, but it's drained after the
    // job is started. That's because inputs can be synchronous.
    context.inboundBus.subscribe(message => {
      if (inQueue) {
        inQueue.push({ kind: DownstreamMessageKind.Inbound, message, extra: null });
      } else {
        send({ kind: DownstreamMessageKind.Inbound, message });
      }
    });

    function _eventLoop(): Observable<JobOutboundMessage<O>> {
      return new Observable(o => {
        // We simply hook into the child messages and loop and send them up.
        upstreamBus.subscribe((message: UpstreamMessage<A, I, O>) => {
          switch (message.kind) {
            case UpstreamMessageKind.Started:
              break;
            case UpstreamMessageKind.Outbound:
              o.next(message.message);
              break;
            case UpstreamMessageKind.Error:
              o.error(message.error);
              break;
            case UpstreamMessageKind.Complete:
              o.complete();
              break;

            case UpstreamMessageKind.GetDescription:
              context.scheduler.getDescription(message.name).pipe(first()).subscribe(description => {
                send({
                  kind: DownstreamMessageKind.Description,
                  description,
                  descriptionId: message.descriptionId,
                });
              });
              break;
          }
        });

        send({ kind: DownstreamMessageKind.Start, description, argument });
        [...(inQueue || [])].forEach(message => send(message));
        inQueue = null;
      });
    }

    async function _handshake(): Promise<void> {
      // Init and wait the next message.
      send({ kind: DownstreamMessageKind.Init });

      const readyMessage = await next();
      if (readyMessage.kind !== UpstreamMessageKind.Ready) {
        throw new ForwarderDidNotHandshakeException(UpstreamMessageKind.Ready, readyMessage);
      }
    }

    return from(_handshake()).pipe(
      switchMap(() => _eventLoop()),
      finalize(() => {
        subscriptions.forEach(x => x.unsubscribe());
        send({ kind: DownstreamMessageKind.Stop });
        downstreamBus.complete();
      }),
    );
  };

  return Object.assign(handler, { jobDescription: options });
}
