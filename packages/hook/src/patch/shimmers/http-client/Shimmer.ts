import * as assert from 'assert';
import { DEFAULT_HOST, DEFAULT_PORT, HEADER_SPAN_ID, HEADER_TRACE_ID } from '../../../utils/Constants';
import { nodeVersion } from '../../../utils/Utils';
import { ClientRequest, ServerResponse, IncomingMessage } from 'http';

const debug = require('debug')('PandoraHook:HttpClient:Shimmer');

// TODO: 接受参数，处理或记录请求详情

export type bufferTransformer = (buffer, res?: IncomingMessage) => object | string;

export class HttpClientShimmer {

  options: {
    recordResponse?: boolean
    bufferTransformer?: bufferTransformer
  } = {};
  shimmer = null;
  traceManager = null;

  constructor(shimmer, traceManager, options) {
    assert(shimmer, 'shimmer must given');
    assert(traceManager, 'traceManager must given');

    Object.assign(this.options, options);
    this.shimmer = shimmer;
    this.traceManager = traceManager;
  }

  wrapHttpRequest(target) {
    this.shimmer.wrap(target, 'request', this.httpRequestWrapper);

    if (nodeVersion('>=8')) {
      this.shimmer.wrap(target, 'get', this.httpRequestWrapper);
    }
  }

  remoteTracing(args, tracer, span) {
    const options = args[0];
    const traceId = tracer.traceId || '';
    const spanId = span.context().spanId || '';

    if (options.headers) {
      if (!options.headers[HEADER_TRACE_ID]) {
        debug('set header trace id.');
        options.headers[HEADER_TRACE_ID] = traceId;
      }

      if (!options.headers[HEADER_SPAN_ID]) {
        debug('set header span id.');
        options.headers[HEADER_SPAN_ID] = spanId;
      }
    } else {
      options.headers = {
        [HEADER_TRACE_ID]: traceId,
        [HEADER_SPAN_ID]: spanId
      };
    }

    return args;
  }

  createSpan(tracer) {
    let span = null;

    const currentSpan = tracer.getCurrentSpan();

    if (!currentSpan) {
      debug('No current span, skip trace');
      return span;
    }

    return this._createSpan(tracer, currentSpan);
  }

  protected _createSpan(tracer, currentSpan) {
    const traceId = tracer.traceId;

    return tracer.startSpan('http-client', {
      childOf: currentSpan,
      traceId
    });
  }

  httpRequestWrapper = (request) => {
    const self = this;
    const traceManager = this.traceManager;
    const options = self.options;

    return function wrappedHttpRequest(this: ClientRequest) {
      const tracer = traceManager.getCurrentTracer();
      let args = Array.from(arguments);

      if (!tracer) {
        debug('No current tracer, skip trace');
        return request.apply(this, args);
      }

      const span = self.createSpan(tracer);

      if (!span) {
        debug('Create new span empty, skip trace');
        return request.apply(this, args);
      }

      if ((<any>options).remoteTracing) {
        args = self.remoteTracing(args, tracer, span);
      }

      const _request = request.apply(this, args);

      const tags = self.buildTags(args, _request);

      span.addTags(tags);

      self.wrapRequest(_request, tracer, span);

      return _request;
    };
  }

  wrapRequest = (request, tracer, span) => {
    const traceManager = this.traceManager;
    const shimmer = this.shimmer;
    const self = this;

    shimmer.wrap(request, 'emit', function requestEmitWrapper(emit) {
      const bindRequestEmit = traceManager.bind(emit);

      return function wrappedRequestEmit(this: ServerResponse, event, arg) {
        if (event === 'error') {
          self.handleError(span, arg);
        } else if (event === 'response') {
          self.handleResponse(tracer, span, arg);
        }

        return bindRequestEmit.apply(this, arguments);
      };
    });
  }

  protected _requestError(res, span) {

    // clear cache when request error
    delete res.__responseSize;
    delete res.__chunks;

    span.setTag('http.error_code', {
      type: 'string',
      value: res.code
    });

    span.setTag('http.status_code', {
      type: 'number',
      value: -1 // 请求过程失败
    });
  }

  handleError(this: any, span, arg) {
    if (span) {
      span.error(true);

      this._requestError(arg, span);

      span.finish();
      this._finish(arg, span);
    }
  }

  protected _responseEnd(res, span) {
    const socket = res.socket;
    const remoteIp = socket ? (socket.remoteAddress ? `${socket.remoteAddress}:${socket.remotePort}` : '') : '';
    const responseSize = (res.headers && res.headers['content-length']) || res.__responseSize;

    delete res.__responseSize;
    delete res.__chunks;

    span.setTag('http.status_code', {
      type: 'number',
      value: res.statusCode
    });

    span.setTag('http.remote_ip', {
      type: 'number',
      value: remoteIp
    });

    span.setTag('http.response_size', {
      type: 'number',
      value: responseSize
    });
  }

  protected _finish(res, span) {}

  bufferTransformer(buffer, res?: IncomingMessage): string {
    try {
      return buffer.toString('utf8');
    } catch (error) {
      debug('transform response data error. ', error);
      return '';
    }
  }

  handleResponse(tracer, span, res) {
    const traceManager = this.traceManager;
    const shimmer = this.shimmer;
    const self = this;
    const recordResponse = this.options.recordResponse;
    const bufferTransformer = this.options.bufferTransformer || self.bufferTransformer;

    res.__responseSize = 0;
    res.__chunks = [];

    shimmer.wrap(res, 'emit', function wrapResponseEmit(emit) {
      const bindResponseEmit = traceManager.bind(emit);

      return function wrappedResponseEmit(this: ClientRequest, event) {
        if (event === 'end') {
          if (span) {

            if (recordResponse) {
              const response = bufferTransformer(Buffer.concat(res.__chunks), res);
              span.log({
                response
              });
            }

            span.error(false);

            self._responseEnd(res, span);

            tracer.setCurrentSpan(span);
            span.finish();
            self._finish(res, span);
          }
        } else if (event === 'data') {
          const chunk = arguments[1] || [];
          res.__responseSize += chunk.length;

          if (recordResponse) {
            res.__chunks.push(chunk);
          }
        }

        return bindResponseEmit.apply(this, arguments);
      };
    });
  }

  protected buildTags(args, request) {
    const options = args[0];

    return {
      'http.client': {
        value: true,
        type: 'bool'
      },
      'http.method': {
        value: options.method || 'GET', // use 'GET' default, like node.js
        type: 'string'
      },
      'http.hostname': {
        value: options.hostname || options.host || DEFAULT_HOST,
        type: 'string'
      },
      'http.port': {
        value: options.port || options._defaultAgent && options._defaultAgent.defaultPort || DEFAULT_PORT,
        type: 'string'
      },
      'http.path': {
        value: request.path || '/', // use '/' default, like node.js
        type: 'string'
      }
    };
  }
}