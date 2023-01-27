import {createLogger, globalAlwatr} from '@alwatr/logger';
import {Stringifyable} from '@alwatr/type';

import type {
  DispatchOptions,
  ListenerFunction,
  ListenerObject,
  SubscribeOptions,
  SignalObject,
  ProviderFunction,
  ProviderOptions,
  SignalStorage,
} from '../type.js';

globalAlwatr.registeredList.push({
  name: '@alwatr/signal',
  version: _ALWATR_VERSION_,
});

/**
 * Listener `id`
 */
let _lastListenerAutoId = 0;

const debounceTimeout = 5;

/**
 * Signal stack database.
 */
const _signalStorage: SignalStorage = {};

/**
 * Signal core manager for access and control all signals under the hood.
 */
export const signalManager = {
  _logger: createLogger('alwatr/signal'),

  /**
   * Get signal object by id, If not available, it will create a new signal with default options.
   *
   * Example:
   *
   * ```ts
   * const signal = x.getSignalObject<ContentType>('content-change');
   * signal.disabled = true;
   * ```
   */
  getSignalObject: <T extends Stringifyable>(id: string): SignalObject<T> => {
    let signal = _signalStorage[id] as SignalObject<T> | undefined;
    if (signal == null) {
      signal = _signalStorage[id] = {
        id,
        disabled: false,
        debounced: false,
        listenerList: [],
      };
    }
    return signal;
  },

  /**
   * Call all listeners callback of special signal.
   *
   * Used inside dispatch, Don't use it directly.
   */
  _callListeners: <T extends Stringifyable>(signal: SignalObject<T>): void => {
    signalManager._logger.logMethodArgs('_callListeners', {signalId: signal.id, signalDetail: signal.detail});

    if (signal.detail === undefined) {
      signalManager._logger.accident('_callListeners', 'no_signal_detail', 'signal must have a detail', {
        signalId: signal.id,
      });
      return;
    }

    const removeList: Array<ListenerObject<T>> = [];

    for (const listener of signal.listenerList) {
      if (listener.disabled) continue;
      if (listener.once) removeList.push(listener);
      try {
        const ret = listener.callback(signal.detail);
        if (ret instanceof Promise) {
          ret.catch((err) =>
            signalManager._logger.error('_callListeners', 'call_listener_failed', err, {
              signalId: signal.id,
            }),
          );
        }
      }
      catch (err) {
        signalManager._logger.error('_callListeners', 'call_listener_failed', err, {
          signalId: signal.id,
        });
      }
    }

    removeList.forEach((listener) => signalManager.unsubscribe(listener));
  },

  /**
   * Subscribe new signal listener to a signal, work like addEventListener.
   *
   * Example:
   *
   * ```ts
   * const listener = x.subscribe<ContentType>('content-change', (content) => console.log(content));
   * ```
   */
  subscribe: <T extends Stringifyable>(
    signalId: string,
    listenerCallback: ListenerFunction<T>,
    options: Partial<SubscribeOptions> = {},
  ): ListenerObject<T> => {
    options.once ??= false;
    options.disabled ??= false;
    options.receivePrevious ??= 'AnimationFrame';
    options.priority ??= false;

    signalManager._logger.logMethodArgs('subscribe', {signalId, options});

    const signal = signalManager.getSignalObject<T>(signalId);

    const listener: ListenerObject<T> = {
      id: ++_lastListenerAutoId,
      signalId: signal.id,
      once: options.once,
      disabled: options.disabled,
      callback: listenerCallback,
    };

    const callbackCall = signal.detail !== undefined && options.receivePrevious !== 'No';
    if (callbackCall) {
      // Run callback for old dispatch signal

      const callback = (): void => {
        try {
          if (signal.detail !== undefined) listenerCallback(signal.detail);
        }
        catch (err) {
          signalManager._logger.error('subscribe', 'call_signal_callback_failed', err, {
            signalId: signal.id,
          });
        }
      };

      if (options.receivePrevious === 'AnimationFrame') {
        requestAnimationFrame(callback);
      }
      else {
        setTimeout(callback, options.receivePrevious === 'NextCycle' ? 0 : debounceTimeout);
      }
    }

    // if once then must remove listener after fist callback called! then why push it to listenerList?!
    if (!(callbackCall && options.once)) {
      if (options.priority === true) {
        signal.listenerList.unshift(listener);
      }
      else {
        signal.listenerList.push(listener);
      }
    }

    return listener;
  },

  /**
   * Unsubscribe listener from a signal, work like removeEventListener.
   *
   * Example:
   *
   * ```ts
   * const listener = x.subscribe<ContentType>('content-change', (content) => console.log(content));
   * ...
   * x.unsubscribe(listener);
   * ```
   */
  unsubscribe: (listener: Pick<ListenerObject<Stringifyable>, 'id' | 'signalId'>): void => {
    signalManager._logger.logMethodArgs('unsubscribe', {
      signalId: listener.signalId,
      listenerId: listener.id,
    });
    const signal = signalManager.getSignalObject(listener.signalId);
    const listenerIndex = signal.listenerList.findIndex((_listener) => _listener.id === listener.id);
    if (listenerIndex !== -1) {
      void signal.listenerList.splice(listenerIndex, 1);
    }
  },

  /**
   * Unsubscribe all listener from a signal, clear all listeners.
   *
   * Example:
   *
   * ```ts
   * x.removeAllListeners('content-change');
   * ```
   */
  removeAllListeners: (signalId: string): void => {
    signalManager._logger.logMethodArgs('removeAllListeners', signalId);
    const signal = signalManager.getSignalObject(signalId);
    if (signal.listenerList.length === 0) return;
    signal.listenerList.length = 0;
    signal.listenerList = [];
  },

  /**
   * Dispatch (send) signal to all listeners.
   *
   * Example:
   *
   * ```ts
   * x.dispatch<ContentType>('content-change', newContent);
   * ```
   */
  dispatch: <T extends Stringifyable>(
    signalId: string,
    detail: T,
    options: Partial<DispatchOptions> = {},
  ): void => {
    options.debounce ??= 'AnimationFrame';

    signalManager._logger.logMethodArgs('dispatch', {signalId, detail, options});

    const signal = signalManager.getSignalObject<T>(signalId);

    // set detail before check signal.debounced for act like throttle (call listeners with last dispatch detail).
    signal.detail = detail;

    if (signal.disabled) return; // signal is disabled.

    // Simple debounce noise filtering
    if (options.debounce !== 'No' && signal.debounced === true) return; // last dispatch in progress.

    if (options.debounce === 'No') {
      return signalManager._callListeners(signal);
    }
    // else
    signal.debounced = true;
    const callListeners = (): void => {
      signalManager._callListeners(signal);
      signal.debounced = false;
    };
    options.debounce === 'AnimationFrame'
      ? requestAnimationFrame(callListeners)
      : setTimeout(callListeners, debounceTimeout);
  },

  /**
   * Get current signal detail/value.
   *
   * Example:
   *
   * ```ts
   * const currentContent = x.getDetail<ContentType>('content-change');
   * ```
   */
  getDetail: <T extends Stringifyable>(signalId: string): T | undefined => {
    return signalManager.getSignalObject<T>(signalId).detail;
  },

  /**
   * Get the detail/value of the next received signal.
   *
   * Example:
   *
   * ```ts
   * const newContent = await x.untilNext<ContentType>('content-change');
   * ```
   */
  untilNext: <T extends Stringifyable>(signalId: string): Promise<T> => {
    return new Promise((resolve) => {
      signalManager._logger.logMethodArgs('untilNext', signalId);
      signalManager.subscribe<T>(signalId, resolve, {
        once: true,
        priority: true,
        receivePrevious: 'No',
      });
    });
  },

  /**
   * Defines the provider of the signal that will be called when the signal requested.
   * Subscribe to `request-signalId`.
   *
   * Example:
   *
   * ```ts
   * x.setProvider('content-change', async (requestParam) => await fetchNewContent(requestParam));
   * ```
   */
  setProvider: <TSignal extends Stringifyable, TRequest extends Stringifyable>(
    signalId: string,
    signalProvider: ProviderFunction<TSignal, TRequest>,
    options: Partial<ProviderOptions> = {},
  ): ListenerObject<TRequest> => {
    options.debounce ??= 'AnimationFrame';
    options.receivePrevious ??= 'AnimationFrame';

    signalManager._logger.logMethodArgs('setProvider', {signalId, options});

    const _callback = async (requestParam: TRequest): Promise<void> => {
      const signalDetail = await signalProvider(requestParam);
      if (signalDetail !== undefined) {
        // null is a valid detail for signal.
        signalManager.dispatch<TSignal>(signalId, signalDetail, {debounce: options.debounce});
      }
    };

    const requestSignalId = 'request-' + signalId;
    signalManager.removeAllListeners(requestSignalId);
    return signalManager.subscribe<TRequest>(requestSignalId, _callback, {
      receivePrevious: options.receivePrevious,
    });
  },

  /**
   * Dispatch request signal with requestParam as detail.
   *
   * Example:
   *
   * ```ts
   * request<RequestParamType>('content-change', {foo: 'bar'});
   * const newContent = await untilNext<ContentType>('content-change');
   * ```
   */
  request: <TRequest extends Stringifyable>(
    signalId: string,
    requestParam: TRequest,
    options: Partial<DispatchOptions> = {},
  ): void => {
    signalManager._logger.logMethodArgs('request', {signalId, requestParam});
    return signalManager.dispatch<TRequest>(signalId, requestParam, options);
  },

  /**
   * Clear current signal detail without dispatch new signal
   *
   * note: receivePrevious not work until new signal
   */
  expire: (signalId: string): void => {
    signalManager._logger.logMethodArgs('expire', signalId);
    delete signalManager.getSignalObject(signalId).detail;
  },
} as const;
