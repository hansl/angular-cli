/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { Observable, Observer, Subscribable, Subscription } from 'rxjs';
import { finalize, retry, switchMap, timeout } from 'rxjs/operators';
import { json } from '../../../src';
import {
  Job,
  JobDescription,
  JobHandler,
  JobHandlerContext,
  JobInboundMessage,
  JobOutboundMessage
} from './api';
import { strategy } from './strategy';


/**
 * The inbound and outbound message bus types. Outside of the handshake these are pretty standard
 * for a Jobs system.
 * Here the outbound and inbound is with regard to the parent; Outbound is from Parent to
 * Child, while Inbound is from Child to Parent.
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
 */


export enum ProcessOutboundMessageKind {
  // Handshake.
  Init = 'init',
  Start = 'start',

  // Job messages.
  Inbound = 'in',

  // Scheduling
  SubJobOutbound = 'sub-outbound',
  SubJobError = 'sub-error',
  SubJobComplete = 'sub-complete',
}
export interface ProcessOutboundMessageBase extends json.JsonObject {
  kind: ProcessOutboundMessageKind;
}
export interface ProcessOutboundMessageInitial extends ProcessOutboundMessageBase {
  kind: ProcessOutboundMessageKind.Init;
  path: string;
  shouldBootstrap: boolean;
  transformFnPath: string | null;
  transformFnOptions: json.JsonValue;
}
export interface ProcessOutboundMessageStart extends ProcessOutboundMessageBase {
  kind: ProcessOutboundMessageKind.Start;
  description: JobDescription;
  argument: json.JsonValue;
}
export interface ProcessOutboundMessageInbound<
  InputT extends json.JsonValue,
  > extends ProcessOutboundMessageBase {
  kind: ProcessOutboundMessageKind.Inbound;
  message: JobInboundMessage<InputT>;
}
export interface ProcessOutboundMessageSubJobOutbound extends ProcessOutboundMessageBase {
  kind: ProcessOutboundMessageKind.SubJobOutbound;
  id: number;
  message: JobOutboundMessage<json.JsonValue>;
}
export interface ProcessOutboundMessageSubJobError extends ProcessOutboundMessageBase {
  kind: ProcessOutboundMessageKind.SubJobError;
  id: number;
  error: json.JsonValue;
}
export interface ProcessOutboundMessageSubJobComplete extends ProcessOutboundMessageBase {
  kind: ProcessOutboundMessageKind.SubJobComplete;
  id: number;
}

export type OutboundProcessMessage<InputT extends json.JsonValue> =
  ProcessOutboundMessageInitial
  | ProcessOutboundMessageStart
  | ProcessOutboundMessageInbound<InputT>
  | ProcessOutboundMessageSubJobOutbound
  | ProcessOutboundMessageSubJobError
  | ProcessOutboundMessageSubJobComplete
  ;


export enum ProcessInboundMessageKind {
  // Handshake.
  Ready = 'ready',
  Started = 'started',

  // Job outputs.
  Outbound = 'out',
  Error = 'error',
  Complete = 'complete',

  // Scheduling
  GetDescription = 'get-description',
  Schedule = 'schedule',
  SubJobInbound = 'sub-inbound',
}
export interface ProcessInboundMessageBase extends json.JsonObject {
  kind: ProcessInboundMessageKind;
}
export interface ProcessInboundMessageReady extends ProcessInboundMessageBase {
  kind: ProcessInboundMessageKind.Ready;
}
export interface ProcessInboundMessageStarted extends ProcessInboundMessageBase {
  kind: ProcessInboundMessageKind.Started;
}
export interface ProcessInboundMessageOutbound<
  OutputT extends json.JsonValue,
  > extends ProcessInboundMessageBase {
  kind: ProcessInboundMessageKind.Outbound;
  message: JobOutboundMessage<OutputT>;
}
export interface ProcessInboundMessageError extends ProcessInboundMessageBase {
  kind: ProcessInboundMessageKind.Error;
  error: json.JsonValue;
}
export interface ProcessInboundMessageComplete extends ProcessInboundMessageBase {
  kind: ProcessInboundMessageKind.Complete;
}
export interface ProcessInboundMessageSubJobSchedule extends ProcessInboundMessageBase {
  kind: ProcessInboundMessageKind.Schedule;
  id: number;  // This must be unique.
  name: string;
  argument: json.JsonValue;
}
export interface ProcessInboundMessageSubJobInbound extends ProcessInboundMessageBase {
  kind: ProcessInboundMessageKind.SubJobInbound;
  id: number;
  message: JobInboundMessage<json.JsonValue>;
}

export type InboundProcessMessage<OutputT extends json.JsonValue> =
  ProcessInboundMessageReady
  | ProcessInboundMessageStarted
  | ProcessInboundMessageOutbound<OutputT>
  | ProcessInboundMessageError
  | ProcessInboundMessageComplete
  | ProcessInboundMessageSubJobSchedule
  | ProcessInboundMessageSubJobInbound
  ;


/**
 * A Job Strategy that forwards messages to a message bus.
 * @param forwarder The forwarder to use.
 * @param options Partial options to fill the job description. Will be forwarded to the job
 *                handler.
 */
export function createForwardingJob<
  A extends json.JsonValue,
  I extends json.JsonValue,
  O extends json.JsonValue,
>(
  forwarder: (inboundBus: Observer<InboundProcessMessage<O>>) => Subscribable<OutboundProcessMessage>,
  options: Partial<JobDescription> = {},
): JobHandler<A, I, O> {
  const handler = (argument: A, context: JobHandlerContext<A, I, O>) => {
    const scheduler = context.scheduler;
    const description = context.description;
    const subscriptions: Subscription[] = [];
    const subJobs: Job[] = [];

    return new Observable<JobOutboundMessage<O>>(jobObserver => {
      const forkOptions: child_process.ForkOptions = {
        silent: !process.env['NG_LOG_JOB_CHILD'],
        execArgv: [],
      };

      // Fork to create a child process. See process-worker.js for the implementation.
      const child = child_process.fork(path.join(__dirname, 'process-worker.js'), [], forkOptions);
      let killed = false;

      /**
       * Helps with typings.
       */
      const send: (message: OutboundProcessMessage<I>) => void = child.send.bind(child);
      function kill() {
        if (killed || !child.pid) {
          return;
        }
        killed = true;
        child.removeAllListeners();
        child.kill('SIGTERM');
      }
      function handleChildProcessExit(_code?: number) {
        kill();
        if (_code !== 0) {
          jobObserver.error(new Error('Something happened in the child.'));
        }
      }
      function handleProcessExit() {
        kill();
      }

      if (!child.connected || child.killed) {
        throw new ProcessDidNotStartException();
      }

      child.once('exit', handleChildProcessExit);
      child.once('SIGINT', handleChildProcessExit);
      child.once('uncaughtException', handleChildProcessExit);

      process.once('exit', handleProcessExit);
      process.once('SIGINT', handleProcessExit);

      function _eventLoop(): Observable<JobOutboundMessage<O>> {
        return new Observable(o => {
          subscriptions.push(context.inboundBus.subscribe(
            inboundMessage => {
              send({ kind: ProcessOutboundMessageKind.Inbound, message: inboundMessage });
            },
          ));

          // We simply hook into the child messages and loop and send them up.
          child.on('message', (message: InboundProcessMessage<O>) => {
            switch (message.kind) {
              case ProcessInboundMessageKind.Outbound:
                o.next(message.message);
                break;
              case ProcessInboundMessageKind.Error:
                o.error(message.error);
                break;
              case ProcessInboundMessageKind.Complete:
                o.complete();
                break;

              case ProcessInboundMessageKind.Schedule: {
                const job = scheduler.schedule(message.name, message.argument);
                const id = message.id;
                subJobs[id] = job;
                subscriptions.push(job.outboundBus.subscribe(
                  message => send({ kind: ProcessOutboundMessageKind.SubJobOutbound, id, message }),
                  error => send({ kind: ProcessOutboundMessageKind.SubJobError, id, error }),
                  () => send({ kind: ProcessOutboundMessageKind.SubJobComplete, id }),
                ));
                break;
              }
              case ProcessInboundMessageKind.SubJobInbound: {
                if (message.id < subJobs.length) {
                  const job = subJobs[message.id];
                  job.inboundBus.next(message.message);
                }
                break;
              }
            }
          });
        });
      }

      function _handshake(): Observable<null> {
        send({
          kind: ProcessOutboundMessageKind.Init,
          shouldBootstrap,
          path: absolutePath,
          transformFnPath: transform.path || null,
          transformFnOptions: transform.options || null,
        });

        return new Observable<null>(o => {
          child.once('message', (message: InboundProcessMessage<O>) => {
            try {
              if (message.kind !== ProcessInboundMessageKind.Ready) {
                return o.error(new ProcessDidNotHandshakeException(message));
              }
              // We don't care about the value.
              o.next(null);
              o.complete();
            } catch (e) {
              o.error(e);
            }
          });
        }).pipe(
          timeout(10000),
          retry(2),
          switchMap(() => {
            // Child is ready. Start listening.
            return new Observable(o => {
              send({
                kind: ProcessOutboundMessageKind.Start,
                description,
                argument,
              });

              child.once('message', (message: InboundProcessMessage<O>) => {
                try {
                  if (message.kind !== ProcessInboundMessageKind.Started) {
                    return o.error(new ProcessDidNotHandshakeException(message));
                  }

                  o.next(null);
                  o.complete();
                } catch (e) {
                  o.error(e);
                }
              });
            });
          }),
        );
      }

      return _handshake().pipe(
        switchMap(() => _eventLoop()),
        finalize(() => {
          subscriptions.forEach(x => x.unsubscribe());
          kill();
        }),
      ).subscribe(jobObserver);
    });
  };

  return Object.assign(handler, { jobDescription: options });
}
